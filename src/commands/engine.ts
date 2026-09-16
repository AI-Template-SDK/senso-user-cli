/**
 * Writing content through the content engine.
 *
 * Two commands, one body, and three things about them that the help used to get
 * wrong or leave out — each of which costs an agent a real mistake:
 *
 *   1. `content_id` is the create-vs-update switch. Without it every call mints
 *      a NEW content item, so an agent iterating on a draft in a loop produces a
 *      pile of duplicates and never touches the one it meant to edit. It was not
 *      mentioned anywhere.
 *   2. `geo_question_id` was advertised as required and is not. The DTO declares
 *      it as a pointer, the handler folds an explicit nil UUID to absent, and its
 *      comment is explicit that content with no originating prompt must not mint
 *      one. Only `raw_markdown` and `seo_title` are enforced.
 *   3. A publish that EVERY destination refused comes back 200, not 201 —
 *      `publish_status` is "failed" and `editorial_status` drops back to "draft"
 *      (content_handler.go, near line 1715). Any 2xx read as success meant the
 *      CLI printed "✓ Content published." and exited 0 for a publish that
 *      reached nobody. That case now exits 1 and names each destination's reason.
 */

import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";
import { parseInstantFlag } from "../lib/enum-arg.js";
import { CliError, EXIT, usageError } from "../lib/errors.js";
import { apiExits, describeCommand } from "../lib/help.js";
import { parseId, parseIdList, type IdSpec } from "../lib/id-arg.js";
import { parseJsonFlag } from "../lib/json-arg.js";
import { emit, type NextStep } from "../lib/output.js";
import { runAction } from "../lib/run-action.js";
import { asText } from "../lib/text.js";
import * as log from "../utils/logger.js";

/** The two keys the handler actually enforces, for both endpoints. */
const REQUIRED_KEYS = ["raw_markdown", "seo_title"] as const;

/** Keys both endpoints accept beyond the required pair. */
const SHARED_OPTIONAL_KEYS = [
  "geo_question_id",
  "content_id",
  "summary",
  "generation_run_id",
  "generation_receipt_id",
  "builder_workspace_id",
  "expected_workspace_version_id",
] as const;

/** `engine publish` accepts everything above plus the destination controls. */
const PUBLISH_OPTIONAL_KEYS = [
  ...SHARED_OPTIONAL_KEYS,
  "publisher_ids",
  "mark_as_published",
  "manual_published_at",
  "manual_published_url",
  "ever_published",
] as const;

/**
 * Every UUID-shaped key in the body, with the command that produces it.
 *
 * The API answers a malformed one with a hand-rolled 400 that names neither the
 * key nor the value, so each of these used to cost a round trip and exit 1 where
 * every other flag in the CLI exits 2.
 */
const UUID_KEYS: Record<string, IdSpec> = {
  geo_question_id: {
    label: "--data geo_question_id",
    type: "GEO question",
    idField: "geo_question_id",
    list: "senso questions list",
  },
  content_id: {
    label: "--data content_id",
    type: "Content",
    idField: "content_id",
    list: "senso generated-content list --status drafts",
  },
  generation_run_id: {
    label: "--data generation_run_id",
    type: "Generation run",
    idField: "generation_run_id",
    list: "senso generate runs-list",
  },
  generation_receipt_id: {
    label: "--data generation_receipt_id",
    type: "Generation receipt",
    idField: "generation_receipt_id",
  },
  builder_workspace_id: {
    label: "--data builder_workspace_id",
    type: "Builder workspace",
    idField: "builder_workspace_id",
  },
  expected_workspace_version_id: {
    label: "--data expected_workspace_version_id",
    type: "Builder workspace version",
    idField: "expected_workspace_version_id",
  },
};

/** Where a publisher id comes from, for both the flag and the body key. */
const PUBLISHER: Omit<IdSpec, "label"> = {
  type: "Publisher",
  idField: "publisher_id",
  list: "senso destinations list",
};

/**
 * The placeholder the evidence-sufficiency tool leaves in a draft.
 *
 * Mirrored from `evidencePlaceholderPattern` in senso-api
 * (internal/api/handlers/agent_tool_evidence_sufficiency_output.go). `publish`
 * refuses a body containing one; `draft` accepts it on purpose, because a draft
 * is allowed to be incomplete. Checking it here turns a round trip into exit 2
 * and, more importantly, is the only place that says the two commands differ.
 */
const EVIDENCE_PLACEHOLDER = /\[Missing approved evidence: [^\]\r\n]+\]/;

/** One destination's outcome, as `publish_destinations[]` reports it. */
interface PublishDest {
  publisher?: string;
  display_url?: string;
  status?: string;
  error_msg?: string;
}

interface PublishResponse {
  content_id?: string;
  version_id?: string;
  version_num?: number;
  publish_status?: string;
  editorial_status?: string;
  publish_destinations?: PublishDest[] | null;
  marked_as_published?: boolean;
}

interface DraftResponse {
  content_id?: string;
  version_id?: string;
  version_num?: number;
  editorial_status?: string;
}

/** A required key that must be present AND non-blank, not merely present. */
function requireText(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string") {
    throw usageError(`--data ${key} must be a string.`, {
      field: `--data ${key}`,
      received: asText(value),
      hint: `${key} is required. Example: --data '{"raw_markdown":"# ...","seo_title":"..."}'`,
    });
  }
  if (value.trim() === "") {
    throw usageError(`--data ${key} is blank.`, {
      field: `--data ${key}`,
      received: value,
      hint: `The API rejects a blank ${key} with a 400. Give it real content.`,
    });
  }
  return value;
}

/** Every UUID-shaped key present in the body, checked before the request. */
function assertUuidKeys(body: Record<string, unknown>): void {
  for (const [key, spec] of Object.entries(UUID_KEYS)) {
    const value = body[key];
    // null is how JSON spells "absent" for these pointer fields, and the API
    // reads it that way, so it is not an error.
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") {
      throw usageError(`--data ${key} must be a UUID string.`, {
        field: `--data ${key}`,
        received: asText(value),
        hint: spec.list ? `${spec.type} ids come from \`${spec.list}\`.` : `Pass a UUID string.`,
      });
    }
    parseId(value, spec);
  }
}

/**
 * The Builder provenance pair, which the handler rejects unless both are set.
 *
 * Checked locally because the API's message — "builder_workspace_id and
 * expected_workspace_version_id must be provided together" — arrives as a
 * generic 400 and exit 1, and the fix is entirely on the caller's side.
 */
function assertWorkspacePairing(body: Record<string, unknown>): void {
  const hasWorkspace = body.builder_workspace_id !== undefined;
  const hasVersion = body.expected_workspace_version_id !== undefined;
  if (hasWorkspace === hasVersion) return;
  const missing = hasWorkspace ? "expected_workspace_version_id" : "builder_workspace_id";
  throw usageError(
    `--data must set builder_workspace_id and expected_workspace_version_id together; ${missing} is missing.`,
    {
      field: `--data ${missing}`,
      allowed: ["builder_workspace_id", "expected_workspace_version_id"],
      hint: "Builder provenance is a pair. Send both, or neither.",
    },
  );
}

/** `publisher_ids` inside `--data`, which the API takes as a list of UUIDs. */
function assertPublisherIds(body: Record<string, unknown>): void {
  const value = body.publisher_ids;
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) {
    throw usageError("--data publisher_ids must be an array of publisher UUIDs.", {
      field: "--data publisher_ids",
      received: asText(value),
      hint: "Ids come from `senso destinations list`. Omit the key to publish to every configured destination.",
    });
  }
  if (value.length === 0) {
    throw usageError("--data publisher_ids is an empty array.", {
      field: "--data publisher_ids",
      received: "[]",
      // The API reads [] as "all destinations", which is the opposite of what
      // an empty explicit selection looks like it means.
      hint: "The API treats an empty list as EVERY destination. Omit the key if that is what you want, or name the publishers from `senso destinations list`.",
    });
  }
  const nonStrings = value.filter((v) => typeof v !== "string");
  if (nonStrings.length > 0) {
    throw usageError("--data publisher_ids must contain UUID strings.", {
      field: "--data publisher_ids",
      received: asText(nonStrings),
      hint: "Ids come from `senso destinations list`.",
    });
  }
  parseIdList(value as string[], { label: "--data publisher_ids", ...PUBLISHER });
}

/**
 * The mark-as-published trio.
 *
 * `manual_published_at` and `manual_published_url` are read ONLY when
 * `mark_as_published` is true — the handler ignores them otherwise, silently, so
 * a caller who sets a URL without the flag gets a 200 and no record of it.
 */
function assertManualPublish(body: Record<string, unknown>): void {
  const mark = body.mark_as_published;
  if (mark !== undefined && typeof mark !== "boolean") {
    throw usageError("--data mark_as_published must be true or false.", {
      field: "--data mark_as_published",
      received: asText(mark),
      hint: "true records the content as already live somewhere else instead of pushing it anywhere.",
    });
  }

  for (const key of ["manual_published_at", "manual_published_url"] as const) {
    const value = body[key];
    if (value === undefined) continue;
    if (mark !== true) {
      throw usageError(`--data ${key} needs mark_as_published: true.`, {
        field: `--data ${key}`,
        received: asText(value),
        hint: "The API ignores this key unless mark_as_published is set, so it would have looked like a successful write.",
      });
    }
    if (typeof value !== "string" || value.trim() === "") {
      throw usageError(`--data ${key} must be a non-empty string.`, {
        field: `--data ${key}`,
        received: asText(value),
      });
    }
    // RFC 3339 with an offset, which is what time.Time unmarshals here.
    if (key === "manual_published_at") parseInstantFlag(`--data ${key}`, value);
  }
}

/** Parse and check a `--data` body for whichever of the two endpoints it is for. */
function engineBody(data: string, mode: "publish" | "draft"): Record<string, unknown> {
  const body = parseJsonFlag(data, {
    flag: "--data",
    required: REQUIRED_KEYS,
    optional: mode === "publish" ? PUBLISH_OPTIONAL_KEYS : SHARED_OPTIONAL_KEYS,
  });

  const markdown = requireText(body, "raw_markdown");
  requireText(body, "seo_title");
  assertUuidKeys(body);
  assertWorkspacePairing(body);

  if (mode === "publish") {
    const placeholder = EVIDENCE_PLACEHOLDER.exec(markdown);
    if (placeholder) {
      throw usageError(
        `--data raw_markdown still contains a missing-evidence placeholder: ${placeholder[0]}`,
        {
          field: "--data raw_markdown",
          received: placeholder[0],
          hint: "Replace every `[Missing approved evidence: ...]` with approved information before publishing. `senso engine draft` accepts them; publish does not.",
        },
      );
    }
    assertPublisherIds(body);
    assertManualPublish(body);
  }

  return body;
}

/** "citeables: 502 from adapter; webflow: unauthorized" — one clause each. */
function describeDestinations(destinations: PublishDest[]): string {
  return destinations
    .map((d) => `${d.publisher ?? "unknown"}: ${d.error_msg ?? d.status ?? "no reason given"}`)
    .join("; ");
}

/**
 * The 200 that means nothing was published.
 *
 * `publish_status` is "failed" exactly when at least one publisher was tried and
 * none of them accepted the content; the handler then downgrades 201 to 200 and
 * the item stays a draft. Nothing is emitted on stdout for this: it is a
 * failure, and the contract keeps stdout empty for those. Everything a caller
 * needs — the ids, and every destination's reason — is in `error.details`.
 */
function publishFailure(data: PublishResponse, destinations: PublishDest[]): CliError {
  const reasons = destinations.length > 0 ? ` ${describeDestinations(destinations)}` : "";
  const retry =
    data.content_id === undefined
      ? ""
      : ` Retry the same item rather than creating a duplicate: senso engine publish --data '{"content_id":"${data.content_id}","raw_markdown":"…","seo_title":"…"}'.`;
  return new CliError(
    `Publish failed: no destination accepted the content, so it is still a draft.${reasons}`,
    EXIT.ERROR,
    {
      code: "error",
      details: {
        http_status: 200,
        publish_status: data.publish_status,
        editorial_status: data.editorial_status,
        content_id: data.content_id,
        version_id: data.version_id,
        publish_destinations: destinations,
      },
      hint: `Check the destinations with: senso destinations list.${retry}`,
    },
  );
}

/**
 * Say so when a call created a new item rather than updating one.
 *
 * Correct on a first save and a duplicate on every call after it, and the
 * payload looks identical either way — which is exactly why it is worth saying.
 */
function createdNew(body: Record<string, unknown>, contentId: string | undefined): string[] {
  if (body.content_id !== undefined) return [];
  return [
    `No content_id was sent, so this created a NEW content item${contentId === undefined ? "" : ` (${contentId})`}. That is right for a first save; pass content_id back in --data on the next call to update this one instead of creating another.`,
  ];
}

/** What to do with a content item that now exists. */
function itemSteps(contentId: string | undefined, published: boolean): NextStep[] {
  if (contentId === undefined) return [];
  if (published) {
    return [
      {
        why: "Confirm where it landed and how often it is cited",
        command: `senso content citation-details ${contentId}`,
      },
      {
        why: "Read the per-destination publish records",
        command: "senso content verification --status published",
      },
    ];
  }
  return [
    { why: "Review the body that was saved", command: `senso generated-content get ${contentId}` },
    {
      why: "Publish this draft — keep content_id so it updates rather than duplicating",
      command: `senso engine publish --data '{"content_id":"${contentId}","raw_markdown":"…","seo_title":"…"}'`,
    },
  ];
}

/** The `--data` keys, spelled out once for both commands' help. */
const BODY_RETURNS = [
  "content_id — the item. Pass it to `senso generated-content get`, `senso content get`, and BACK into --data as content_id on the next call.",
  "version_id — the version just written; `senso content reject` and `senso content restore` take this one.",
  "version_num — the new revision number.",
];

export function registerEngineCommands(program: Command): void {
  const engine = program
    .command("engine")
    .description(
      "Create, update and publish content through the content engine. Requires the GEO product and update:content. BOTH commands create a NEW content item when --data has no content_id, and update that item when it does — omitting content_id while iterating on a draft silently produces duplicates. Ids: geo_question_id (optional) from `senso questions list`, content_id from `senso generated-content list --status drafts`, publisher_ids from `senso destinations list`. Workflow: questions list → engine draft → generated-content get → engine publish → content verification.",
    );

  describeCommand(
    engine
      .command("publish")
      .description(
        'Publish content to external destinations, or record content that was published somewhere else. Only raw_markdown and seo_title are required; geo_question_id is OPTIONAL despite what older help said. With content_id in --data this publishes a new version of that item; without it a brand-new item is created on every call. A publish that reaches the API but is refused by EVERY destination comes back as publish_status "failed" with editorial_status "draft" — this command exits 1 in that case and names each destination\'s error.',
      )
      .requiredOption(
        "--data <json>",
        'JSON body. REQUIRED: raw_markdown (non-blank; may not contain a `[Missing approved evidence: ...]` placeholder), seo_title (non-blank). OPTIONAL: content_id (update this item instead of creating one), geo_question_id (the prompt this answers, from `senso questions list`), summary, publisher_ids (array of UUIDs; see --publisher-ids), mark_as_published (true records the content as already live elsewhere and first UNPUBLISHES every live destination for the item), manual_published_url (with mark_as_published: where it went live — WITHOUT it the item is published but UNTRACKED and can never be cited), manual_published_at (RFC 3339), generation_run_id, generation_receipt_id, builder_workspace_id and expected_workspace_version_id (Builder provenance; the last two must be sent together), ever_published (legacy, ignored by the server). Example: \'{"content_id":"<uuid>","raw_markdown":"# ...","seo_title":"..."}\'',
      )
      .option(
        "--publisher-ids <ids...>",
        "Restrict publishing to these publisher UUIDs, from `senso destinations list`. Overrides any publisher_ids inside --data. Omit to publish to every destination selected for generation",
      )
      .action(
        runAction(program, async (ctx, cmdOpts: { data: string; publisherIds?: string[] }) => {
          const body = engineBody(cmdOpts.data, "publish");
          if (cmdOpts.publisherIds && cmdOpts.publisherIds.length > 0) {
            body.publisher_ids = parseIdList(cmdOpts.publisherIds, {
              label: "--publisher-ids",
              ...PUBLISHER,
            });
          }

          const data = await apiRequest<PublishResponse>({
            method: "POST",
            path: "/org/content-engine/publish",
            body,
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });

          const destinations = data.publish_destinations ?? [];
          if (data.publish_status === "failed") {
            throw publishFailure(data, destinations);
          }

          const refused = destinations.filter((d) => d.status !== "success");
          const warnings: string[] = createdNew(body, data.content_id);
          if (refused.length > 0) {
            warnings.push(
              `${refused.length} of ${destinations.length} destination(s) refused the content: ${describeDestinations(refused)}. Retry one with \`senso publish-records retry <publish_record_id>\` — ids are in \`senso content verification --status published\`.`,
            );
          }
          if (destinations.length === 0 && data.marked_as_published !== true) {
            warnings.push(
              "No destination was configured, so nothing was pushed anywhere — the item is marked published but is not live. Add one with `senso destinations add`, then re-publish.",
            );
          }
          if (data.marked_as_published === true && body.manual_published_url === undefined) {
            warnings.push(
              "Recorded as published with no manual_published_url, so it is published but UNTRACKED: nothing is matched against AI answers and it can never be cited.",
            );
          }

          if (!ctx.quiet) {
            log.success(`Content published${data.content_id ? ` (${data.content_id})` : ""}.`);
          }
          emit(ctx, data, {
            warnings,
            next: itemSteps(data.content_id, true),
          });
        }),
      ),
    {
      returns: [
        ...BODY_RETURNS,
        "publish_status — success | failed. `failed` means NO destination accepted it and editorial_status is back to draft; the CLI exits 1 for that.",
        "editorial_status — published | draft.",
        "publish_destinations[] — one entry per destination: publisher, display_url, status (success | failed) and error_msg. This is the only place a partial failure is visible.",
        "marked_as_published — true when this recorded an external publish rather than pushing anywhere.",
        "citeables_action, publish_destination — legacy single-destination compatibility fields. Read publish_destinations instead.",
      ],
      exitCodes: {
        ...apiExits,
        1: "every destination refused the content (HTTP 200, publish_status failed), no destinations are configured (400), a publisher is not available to this organization (400), publish operations are already in flight (409 — retryable), or a version/workspace/receipt conflict (409)",
        2: "--data is not JSON, raw_markdown or seo_title is missing or blank, a UUID-shaped key is malformed, the Builder workspace keys are not paired, or raw_markdown still holds a missing-evidence placeholder",
        3: "the organization lacks the GEO product, or the key lacks update:content",
        4: "the geo question, content, Builder workspace or generation receipt does not exist",
      },
      notes: [
        "content_id is the create-vs-update switch. Publishing the same draft twice without it creates a second content item.",
        "A 409 saying publish operations are in flight is normal for a caller publishing in a loop; wait a moment and retry the same body.",
        "mark_as_published UNPUBLISHES every currently live destination for the item before recording the external publish.",
        "`[Missing approved evidence: ...]` placeholders are refused here and accepted by `senso engine draft`.",
      ],
      examples: [
        {
          comment: "Create and publish in one call",
          command:
            'senso engine publish --data \'{"geo_question_id":"7f4c2d10-88ab-4e39-9c51-3d6e0b7a2f18","raw_markdown":"# How refunds work","seo_title":"How do refunds work at Acme?"}\'',
        },
        {
          comment: "Publish an existing draft to one destination",
          command:
            'senso engine publish --data \'{"content_id":"9d7e1c40-5b3a-4c22-8f16-0a3b7e5d2c81","raw_markdown":"# ...","seo_title":"..."}\' --publisher-ids 61e0a2c7-4b93-4f18-a7d2-0c5e9b3f18a6',
        },
        {
          comment: "Record something already live elsewhere, trackably",
          command:
            'senso engine publish --data \'{"raw_markdown":"# ...","seo_title":"...","mark_as_published":true,"manual_published_url":"https://acme.com/refunds"}\'',
        },
        {
          comment: "Read the per-destination outcome",
          command:
            "senso engine publish --data '{...}' --output json | jq -r '.data.publish_destinations[] | \"\\(.publisher) \\(.status) \\(.error_msg // \"\")\"'",
        },
      ],
      seeAlso: [
        "senso engine draft",
        "senso destinations list",
        "senso generated-content list",
        "senso content verification",
        "senso publish-records retry",
      ],
    },
  );

  describeCommand(
    engine
      .command("draft")
      .description(
        "Save content as a draft. Nothing reaches any destination until `senso engine publish` runs on it. Only raw_markdown and seo_title are required; geo_question_id is OPTIONAL. With content_id in --data this saves a new VERSION of that item; without it a brand-new item is created on every call, which is how a generation loop ends up with duplicate drafts. Unlike publish, a draft MAY contain `[Missing approved evidence: ...]` placeholders — publishing it later will refuse them.",
      )
      .requiredOption(
        "--data <json>",
        'JSON body. REQUIRED: raw_markdown (non-blank), seo_title (non-blank). OPTIONAL: content_id (update this draft instead of creating a new item), geo_question_id (from `senso questions list`), summary, generation_run_id, generation_receipt_id, builder_workspace_id and expected_workspace_version_id (Builder provenance; the last two must be sent together). Example: \'{"content_id":"<uuid>","raw_markdown":"# ...","seo_title":"..."}\'',
      )
      .action(
        runAction(program, async (ctx, cmdOpts: { data: string }) => {
          const body = engineBody(cmdOpts.data, "draft");
          const data = await apiRequest<DraftResponse>({
            method: "POST",
            path: "/org/content-engine/draft",
            body,
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });
          if (!ctx.quiet) {
            // The id is the thing the next call needs, and under `plain` it is
            // only on stdout — which a caller piping the payload never reads.
            const id = data.content_id === undefined ? "" : ` ${data.content_id}`;
            const version = data.version_num === undefined ? "" : ` (version ${data.version_num})`;
            log.success(`Content saved as draft${id}${version}.`);
          }
          emit(ctx, data, {
            warnings: createdNew(body, data.content_id),
            next: itemSteps(data.content_id, false),
          });
        }),
      ),
    {
      returns: [
        ...BODY_RETURNS,
        'editorial_status — always "draft" here: the handler sets it, it is not read back from the record.',
        "source_workspace_version_id — present when Builder provenance was supplied.",
      ],
      exitCodes: {
        ...apiExits,
        1: "the API refused: a version, workspace or receipt conflict (409), or the draft could not be saved",
        2: "--data is not JSON, raw_markdown or seo_title is missing or blank, a UUID-shaped key is malformed, or the Builder workspace keys are not paired",
        3: "the organization lacks the GEO product, or the key lacks update:content",
        4: "the geo question, content, Builder workspace or generation receipt does not exist",
      },
      notes: [
        "content_id is the update switch. Without it this creates a new item every time it runs.",
        "A draft may contain `[Missing approved evidence: ...]` placeholders; `senso engine publish` refuses them.",
        "Metadata (url_slug, meta_data, json_ld) is generated server-side from the title and body — there is nothing to pass for it.",
      ],
      examples: [
        {
          comment: "First draft for a prompt",
          command:
            'senso engine draft --data \'{"geo_question_id":"7f4c2d10-88ab-4e39-9c51-3d6e0b7a2f18","raw_markdown":"# How refunds work","seo_title":"How do refunds work at Acme?"}\'',
        },
        {
          comment: "Revise that draft, and keep the id for the next step",
          command:
            'senso engine draft --data \'{"content_id":"9d7e1c40-5b3a-4c22-8f16-0a3b7e5d2c81","raw_markdown":"# ...","seo_title":"..."}\' --output json | jq -r .data.content_id',
        },
      ],
      seeAlso: [
        "senso engine publish",
        "senso generated-content list",
        "senso generated-content get",
        "senso questions list",
      ],
    },
  );
}
