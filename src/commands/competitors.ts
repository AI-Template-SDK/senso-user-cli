import { Command } from "commander";
import { ApiError, apiRequest } from "../lib/api-client.js";
import { CliError, EXIT, usageError } from "../lib/errors.js";
import { apiExits, describeCommand, idExits } from "../lib/help.js";
import { parseId } from "../lib/id-arg.js";
import { parseJsonFlag } from "../lib/json-arg.js";
import { emit, emitConfirmation } from "../lib/output.js";
import { runAction } from "../lib/run-action.js";
import { asText } from "../lib/text.js";
import * as log from "../utils/logger.js";

/** Where a competitor id comes from. The argument is <competitorId>; the payload field is `id`. */
const COMPETITOR_ID = {
  label: "<competitorId>",
  type: "Competitor",
  idField: "id",
  list: "senso competitors list",
};

/** services.MaxTrackedCompetitorsPerOrg. Not the same 50 as the batch item limit. */
const ORG_CAP = 50;

/** dto.CompetitorBatchRequest: items is required, min=1, max=50. */
const MAX_BATCH_ITEMS = 50;

/** dto.CompetitorRequest / CompetitorBatchItem field bounds. */
const MAX_NAME_LENGTH = 255;
const MAX_URL_LENGTH = 2048;
const MAX_RATIONALE_LENGTH = 280;

const SOURCES = ["manual", "suggested_run_text", "suggested_web_search"] as const;

/** The keys an item of `--data.items` may carry. Anything else the API ignores silently. */
const ITEM_KEYS = ["name", "url", "source", "rationale", "confidence"];

interface CompetitorRow {
  id?: string;
  name?: string;
  created_at?: string;
}

interface CompetitorListResponse {
  competitors?: CompetitorRow[];
  total?: number;
}

/**
 * dto.CompetitorBatchResponse: the list, plus what the call actually did.
 *
 * The counts are not derivable from the rows — an already-tracked item comes
 * back looking exactly like one that was just inserted, and an item dropped at
 * the organization cap does not come back at all — which is why the API reports
 * them, and why they are preferred over the timestamp heuristic below.
 */
interface CompetitorBatchResponse extends CompetitorListResponse {
  created_count?: number;
  already_present_count?: number;
  skipped_count?: number;
  skipped_over_cap_count?: number;
  skipped_invalid_count?: number;
  competitor_cap?: number;
  remaining_capacity?: number;
}

interface BatchItem {
  name?: unknown;
  url?: unknown;
  source?: unknown;
  rationale?: unknown;
  confidence?: unknown;
}

function parseCompetitorName(field: string, value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw usageError(`Invalid ${field}: the competitor name is empty.`, {
      field,
      received: typeof value === "string" ? value : JSON.stringify(value),
      hint: `Pass a brand name of 1-${String(MAX_NAME_LENGTH)} characters.`,
    });
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw usageError(
      `Invalid ${field}: ${String(trimmed.length)} characters, the maximum is ${String(MAX_NAME_LENGTH)}.`,
      { field, hint: `Shorten the name to ${String(MAX_NAME_LENGTH)} characters or fewer.` },
    );
  }
  return trimmed;
}

/**
 * A competitor URL, checked the way go-playground's `url` rule checks it.
 *
 * That rule requires a scheme, so "acme.example.com" is rejected — and the API
 * reports the rejection as "url: Invalid value", because the `url` tag has no
 * case in middleware.getErrorMessage. An agent told "Invalid value" about a
 * value that looks fine to it has nothing to act on.
 */
function parseCompetitorUrl(field: string, value: unknown): string {
  if (typeof value !== "string") {
    throw usageError(`Invalid ${field}: expected a string URL.`, {
      field,
      received: JSON.stringify(value),
      hint: "Pass an absolute URL including the scheme: https://acme.example.com",
    });
  }
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw usageError(`Invalid ${field}: "${trimmed}" is not an absolute URL.`, {
      field,
      received: trimmed,
      hint: `Include the scheme: https://${trimmed.replace(/^\/+/, "")}`,
    });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw usageError(`Invalid ${field}: "${trimmed}" is not an http or https URL.`, {
      field,
      received: trimmed,
      allowed: ["http://…", "https://…"],
      hint: "Use https://acme.example.com",
    });
  }
  if (trimmed.length > MAX_URL_LENGTH) {
    throw usageError(
      `Invalid ${field}: ${String(trimmed.length)} characters, the maximum is ${String(MAX_URL_LENGTH)}.`,
      { field, hint: `Shorten the URL to ${String(MAX_URL_LENGTH)} characters or fewer.` },
    );
  }
  return trimmed;
}

/**
 * One item of a batch, with the item's INDEX in every message.
 *
 * The API's field-level errors name the leaf field and not the index — "source:
 * Must be one of: …" for a 50-item batch — so a caller cannot tell which item
 * it means.
 */
function parseBatchItem(item: unknown, index: number): void {
  const at = `--data.items[${String(index)}]`;
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    throw usageError(`${at} must be a JSON object.`, {
      field: at,
      received: JSON.stringify(item),
      hint: `Each item is { "name": "Acme Analytics", "url": "https://acme.example.com" }.`,
    });
  }
  const it = item as BatchItem;

  const unknownKeys = Object.keys(it).filter((k) => !ITEM_KEYS.includes(k));
  if (unknownKeys.length > 0) {
    throw usageError(`${at} has unknown keys: ${unknownKeys.join(", ")}.`, {
      field: at,
      received: unknownKeys.join(", "),
      allowed: ITEM_KEYS,
      // Silently dropped by the API, so a typo'd field would read as a write
      // that succeeded and stored nothing.
      hint: `The API ignores keys it does not recognize. Accepted keys: ${ITEM_KEYS.join(", ")}.`,
    });
  }

  parseCompetitorName(`${at}.name`, it.name);
  if (it.url !== undefined) parseCompetitorUrl(`${at}.url`, it.url);

  if (it.source !== undefined) {
    if (typeof it.source !== "string" || !SOURCES.includes(it.source as (typeof SOURCES)[number])) {
      throw usageError(`Invalid ${at}.source: ${JSON.stringify(it.source)}.`, {
        field: `${at}.source`,
        received: asText(it.source),
        allowed: SOURCES,
        hint: `Must be one of: ${SOURCES.join(", ")}. Copy it from the suggestion you are accepting.`,
      });
    }
  }

  if (it.rationale !== undefined) {
    if (typeof it.rationale !== "string") {
      throw usageError(`Invalid ${at}.rationale: expected a string.`, {
        field: `${at}.rationale`,
        received: JSON.stringify(it.rationale),
      });
    }
    if (it.rationale.length > MAX_RATIONALE_LENGTH) {
      throw usageError(
        `${at}.rationale is ${String(it.rationale.length)} characters; the maximum is ${String(MAX_RATIONALE_LENGTH)}.`,
        {
          field: `${at}.rationale`,
          // `competitors suggest` returns rationale with no length bound, so the
          // documented accept flow can fail on the API's own output.
          hint: "`competitors suggest` can return longer text. Truncate it: jq '.rationale[0:280]'",
        },
      );
    }
  }

  if (it.confidence !== undefined) {
    if (typeof it.confidence !== "number" || !Number.isFinite(it.confidence)) {
      throw usageError(`Invalid ${at}.confidence: expected a number between 0 and 1.`, {
        field: `${at}.confidence`,
        received: JSON.stringify(it.confidence),
      });
    }
    if (it.confidence < 0 || it.confidence > 1) {
      throw usageError(
        `Invalid ${at}.confidence: ${String(it.confidence)}. Must be between 0 and 1.`,
        { field: `${at}.confidence`, received: String(it.confidence), hint: "0.86, not 86." },
      );
    }
  }
}

/**
 * A mutation's 500, which is where the organization cap surfaces.
 *
 * The service returns a plain `fmt.Errorf("competitor cap of 50 reached…")`,
 * which matches no sentinel in respondToServiceError and so falls to the default
 * 500 branch. Left alone, the CLI answers "This is a server-side failure. Retry
 * shortly" — advice that can never work, for the one failure an agent is most
 * likely to hit while accepting suggestions.
 */
function competitorFailure(err: unknown, attempted: string): unknown {
  if (err instanceof ApiError && err.status === 500) {
    return new CliError(
      `Could not ${attempted}: the API refused with "${err.message}". The commonest cause is the ${String(ORG_CAP)}-competitor per-organization cap, which this API reports as a 500.`,
      EXIT.ERROR,
      {
        code: "server_error",
        status: 500,
        hint: `Check the count with \`senso competitors list\`. If it is at ${String(ORG_CAP)}, free a slot with \`senso competitors delete <competitorId>\` — retrying will not clear the cap.`,
        request: err.request,
        cause: err,
      },
    );
  }
  return err;
}

/** The two suggest-specific failures whose generic wording points the wrong way. */
function suggestFailure(err: unknown): unknown {
  if (err instanceof ApiError && err.status === 429) {
    return new CliError(
      "Competitor suggestions are limited to 5 per hour for this organization.",
      EXIT.NETWORK,
      {
        code: "rate_limited",
        status: 429,
        hint: "A successful result is cached for 10 minutes, so an immediate retry would have returned the same list anyway. Wait for the hour to roll over, or work from `senso competitors list`.",
        request: err.request,
        cause: err,
      },
    );
  }
  if (err instanceof ApiError && err.status === 422) {
    return new CliError(`Cannot generate competitor suggestions: ${err.message}`, EXIT.ERROR, {
      code: "validation",
      status: 422,
      hint: "Set a website with `senso org update --website https://your-company.com`, or run some prompts first so there is run text to extract from.",
      request: err.request,
      cause: err,
    });
  }
  return err;
}

/**
 * A row that existed before this request started.
 *
 * batch-add returns the row that now exists for each accepted name, which for a
 * name already tracked is the ORIGINAL row — same id, same source, same
 * created_at. There is no `created` flag to read, so the only signal the
 * response carries is that timestamp. The minute of slack is for clock skew
 * between this machine and the API; a row created by this very call is seconds
 * old, so the two cases are not close together.
 */
const PREEXISTING_SKEW_MS = 60_000;

function existedBefore(row: CompetitorRow, startedAt: number): boolean {
  if (!row.created_at) return false;
  const created = Date.parse(row.created_at);
  return Number.isFinite(created) && created < startedAt - PREEXISTING_SKEW_MS;
}

export function registerCompetitorsCommands(program: Command): void {
  const competitors = program.command("competitors").description(
    `Manage the organization's curated competitor list. Tracked competitors are what share-of-voice analytics measure you against, and they are fed into content-generation prompts as the brands to position against.

An organization may track at most ${String(ORG_CAP)} competitors. Adding past that limit fails, and the API reports the refusal as a 500 rather than a 409.

Reading the list needs no permission; every mutation — add, batch-add, suggest, update, delete — requires update:org.

Id space: a competitor id is the \`id\` field of \`senso competitors list\`, and it is the <competitorId> argument of update and delete.

Typical workflow: competitors suggest → filter out already_tracked → competitors batch-add → competitors list.

See also: senso analytics, senso tracked-sources`,
  );

  describeCommand(
    competitors
      .command("list")
      .description(
        `List every competitor the organization tracks. The list is complete — there is no paging — and an org may hold at most ${String(ORG_CAP)}. Unlike the rest of this group, reading needs no special permission.`,
      )
      .action(
        runAction(program, async (ctx) => {
          const data = await apiRequest({
            path: "/org/competitors",
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
            resource: { type: "Competitor", list: "senso competitors list" },
          });
          // `id`, not `competitor_id`: dto.CompetitorResponse marshals `id`.
          emit(ctx, data, {
            columns: ["id", "name", "url", "source", "confidence", "created_at"],
            empty: "tracked competitors",
            emptyHint: "Ask for candidates with: senso competitors suggest",
            next: [
              {
                why: "Find competitors you are not tracking yet",
                command: "senso competitors suggest",
              },
            ],
          });
        }),
      ),
    {
      returns: [
        "competitors[].id — the <competitorId> argument of `competitors update` and `competitors delete`",
        "competitors[].name — unique per organization, case-insensitively",
        "competitors[].url — website, if one was recorded. May be absent",
        "competitors[].source — where the entry came from: manual (added by a person or `competitors add`) | suggested_run_text (accepted from a suggestion extracted from AI run text) | suggested_web_search (accepted from a suggestion found by web search)",
        "competitors[].rationale — why the model proposed it, when it came from a suggestion. Absent for manual entries",
        "competitors[].confidence — 0 to 1, the model's confidence. Absent for manual entries",
        `total — the number returned, which is the organization's full count (capped at ${String(ORG_CAP)})`,
      ],
      exitCodes: { ...apiExits, 3: "no organization could be resolved from the credential" },
      examples: [
        { command: "senso competitors list" },
        {
          command:
            "senso competitors list --output json | jq -r '.data.competitors[] | \"\\(.id) \\(.name)\"'",
        },
      ],
      seeAlso: ["senso competitors suggest", "senso competitors batch-add"],
    },
  );

  describeCommand(
    competitors
      .command("add")
      .description(
        `Add one competitor, recorded with source="manual". Names are unique per organization, case-insensitively: adding an existing name is a conflict, not an update. An organization may track at most ${String(ORG_CAP)}. Requires update:org.`,
      )
      .requiredOption("--name <name>", "Competitor brand name. 1-255 characters after trimming")
      .option(
        "--url <url>",
        "Competitor website. An absolute URL WITH a scheme (https://acme.example.com), at most 2048 characters",
      )
      .action(
        runAction(program, async (ctx, cmdOpts: { name: string; url?: string }) => {
          const name = parseCompetitorName("--name", cmdOpts.name);
          const body: Record<string, unknown> = { name };
          // Only the fields the caller passed: an absent `url` leaves the stored
          // value null rather than writing one.
          if (cmdOpts.url !== undefined) body.url = parseCompetitorUrl("--url", cmdOpts.url);

          let data: { id?: string };
          try {
            data = await apiRequest<{ id?: string }>({
              method: "POST",
              path: "/org/competitors",
              body,
              apiKey: ctx.apiKey,
              baseUrl: ctx.baseUrl,
              resource: { type: "Competitor", list: "senso competitors list" },
            });
          } catch (err) {
            throw competitorFailure(err, `add competitor "${name}"`);
          }

          const id = data.id ?? "<competitorId>";
          if (!ctx.quiet) log.success(`Added competitor ${id} ("${name}").`);
          emit(ctx, data, {
            next: [{ why: "Confirm the tracked list", command: "senso competitors list" }],
          });
        }),
      ),
    {
      returns: [
        "id — the new competitor id, the <competitorId> for update and delete",
        "name, url — as stored, both trimmed. `url` is absent when none was given",
        'source — always "manual" here; only batch-add can record suggestion provenance',
        "created_at, updated_at",
      ],
      exitCodes: {
        ...apiExits,
        1: `409 — a competitor with that name is already tracked; or the organization already tracks ${String(ORG_CAP)}, which the API reports as a 500`,
        2: "--name is missing, blank or over 255 characters, or --url is not an absolute http(s) URL or is over 2048 characters",
        3: "the role lacks update:org",
      },
      examples: [
        { command: 'senso competitors add --name "Acme Analytics" --url https://acme.example.com' },
        { command: 'senso competitors add --name "Acme Analytics" --output json | jq -r .data.id' },
      ],
      seeAlso: [
        "senso competitors suggest",
        "senso competitors batch-add",
        "senso competitors list",
      ],
    },
  );

  describeCommand(
    competitors
      .command("batch-add")
      .description(
        `Accept a set of competitors in one call, preserving the provenance fields \`competitors suggest\` returns. Two different limits of ${String(MAX_BATCH_ITEMS)} apply: at most ${String(MAX_BATCH_ITEMS)} ITEMS per request, and at most ${String(ORG_CAP)} competitors per ORGANIZATION. If the org has room for fewer than you send, the API keeps the first that fit and discards the rest without saying so — this command reports which in warnings. A name already tracked is not re-created; the existing row is returned instead.`,
      )
      .requiredOption(
        "--data <json>",
        'JSON: { "items": [{ "name": "...", "url": "...", "source": "manual|suggested_run_text|suggested_web_search", "rationale": "...", "confidence": 0.85 }, ...] }',
      )
      .action(
        runAction(program, async (ctx, cmdOpts: { data: string }) => {
          const body = parseJsonFlag<{ items?: unknown }>(cmdOpts.data, { required: ["items"] });
          if (!Array.isArray(body.items)) {
            throw usageError("--data.items must be an array.", {
              field: "--data.items",
              received: JSON.stringify(body.items),
              hint: `--data '{"items":[{"name":"Acme Analytics"}]}'`,
            });
          }
          if (body.items.length === 0) {
            throw usageError("--data.items is empty.", {
              field: "--data.items",
              hint: "Send at least one item.",
            });
          }
          if (body.items.length > MAX_BATCH_ITEMS) {
            throw usageError(
              `--data.items has ${String(body.items.length)} entries; the maximum is ${String(MAX_BATCH_ITEMS)} per request.`,
              {
                field: "--data.items",
                received: String(body.items.length),
                hint: `Split the batch, and note the organization can track only ${String(ORG_CAP)} in total.`,
              },
            );
          }
          body.items.forEach(parseBatchItem);

          const sent = body.items.map((item) => asText((item as BatchItem).name).trim());
          const startedAt = Date.now();

          let data: CompetitorBatchResponse;
          try {
            data = await apiRequest<CompetitorBatchResponse>({
              method: "POST",
              path: "/org/competitors/batch",
              body,
              apiKey: ctx.apiKey,
              baseUrl: ctx.baseUrl,
              resource: { type: "Competitor", list: "senso competitors list" },
            });
          } catch (err) {
            throw competitorFailure(err, "add competitors");
          }

          // The response is "the rows that now exist for the names you sent",
          // which is not the same as "the rows this call created". Reconciled
          // against the request so a batch that was 90% discarded cannot report
          // itself as a clean success.
          const rows = data.competitors ?? [];
          const returnedNames = new Set(rows.map((r) => (r.name ?? "").trim().toLowerCase()));
          const dropped = sent.filter((name) => !returnedNames.has(name.toLowerCase()));

          // What the call DID, taken from the API's own counts when it reports
          // them. The created_at heuristic is the fallback for a deployment
          // that does not: it makes the answer depend on the clock, and a row
          // this org created seconds earlier by another command reads as new.
          const preexisting = rows.filter((r) => existedBefore(r, startedAt));
          const counted =
            typeof data.created_count === "number" &&
            typeof data.already_present_count === "number";
          const alreadyPresent = counted ? (data.already_present_count ?? 0) : preexisting.length;
          const created = counted ? (data.created_count ?? 0) : rows.length - preexisting.length;
          const overCap = data.skipped_over_cap_count ?? 0;
          const invalid = data.skipped_invalid_count ?? 0;

          const warnings: string[] = [];
          if (alreadyPresent > 0) {
            // Named only when the timestamps agree with the count. They cannot
            // say WHICH rows the API counted, so a disagreement would put a
            // list in the warning that contradicts the number beside it.
            const named =
              preexisting.length === alreadyPresent
                ? preexisting.map((r) => `"${r.name ?? r.id ?? "?"}"`).join(", ")
                : "";
            warnings.push(
              `${String(alreadyPresent)} item(s) were already tracked and came back unchanged, with their original id, source and created_at${named ? `: ${named}` : ""}.`,
            );
          }
          if (overCap > 0) {
            const room =
              typeof data.remaining_capacity === "number"
                ? ` (${String(data.remaining_capacity)} slot(s) left)`
                : "";
            warnings.push(
              `${String(overCap)} item(s) were discarded because the organization is at its ${String(ORG_CAP)}-competitor cap${room}. Free a slot with \`senso competitors delete <competitorId>\`, then send them again.`,
            );
          }
          if (invalid > 0) {
            warnings.push(`${String(invalid)} item(s) were dropped for a blank name.`);
          }
          if (dropped.length > 0) {
            warnings.push(
              `Not in the response, so not created: ${dropped.map((n) => `"${n}"`).join(", ")}. The API discards the items past the ${String(ORG_CAP)}-competitor organization cap, and drops an item whose name is blank.`,
            );
          }

          if (!ctx.quiet) {
            log.success(
              `Added ${String(created)} competitor(s). ${String(alreadyPresent)} already tracked, ${String(dropped.length)} not created.`,
            );
          }
          emit(ctx, data, {
            columns: ["id", "name", "url", "source", "confidence", "created_at"],
            warnings,
            next: [{ why: "Confirm the tracked list", command: "senso competitors list" }],
          });
        }),
      ),
    {
      returns: [
        "competitors[] — the rows that now exist for the names you sent. A row you already tracked comes back with its ORIGINAL id, source and created_at, not the ones you sent",
        "total — the number of rows returned, not the number created",
        "warnings (CLI) — every name that came back pre-existing, and every name the API did not return at all",
      ],
      notes: [
        `\`rationale\` is capped at ${String(MAX_RATIONALE_LENGTH)} characters here but is unbounded in \`competitors suggest\`, so piping one straight into the other can fail. Truncate with jq '.rationale[0:280]'.`,
      ],
      exitCodes: {
        ...apiExits,
        0: "accepted — check warnings, because a 0 can still mean most items were discarded",
        1: `the organization is already at the ${String(ORG_CAP)}-competitor cap (the API reports this as a 500)`,
        2: "--data is not an object; `items` is missing, empty or over 50; an item has no `name`, an unknown key, a `source` outside the enum, a `confidence` outside 0-1, or a `rationale` over 280 characters",
        3: "the role lacks update:org",
      },
      examples: [
        {
          comment: "Accept every suggestion you do not already track",
          command:
            "senso competitors suggest --output json | jq -c '{items: [.data.suggestions[] | select(.already_tracked|not) | {name, url, source, confidence, rationale: (.rationale[0:280])}]}' | xargs -0 -I{} senso competitors batch-add --data {}",
        },
        {
          command:
            'senso competitors batch-add --data \'{"items":[{"name":"Acme Analytics","url":"https://acme.example.com","source":"suggested_web_search","confidence":0.86}]}\'',
        },
      ],
      seeAlso: ["senso competitors suggest", "senso competitors list"],
    },
  );

  describeCommand(
    competitors
      .command("suggest")
      .description(
        "Ask the model for competitor candidates and return them WITHOUT tracking any of them; accepting is a separate call. This costs model tokens, is limited to 5 calls per rolling hour per organization, and a successful result is cached for 10 minutes — a repeat inside that window returns the same suggestions with cached=true. Requires update:org, even though it changes nothing.",
      )
      .action(
        runAction(program, async (ctx) => {
          let data: { suggestions?: { already_tracked?: boolean }[]; cached?: boolean };
          try {
            data = await apiRequest<{
              suggestions?: { already_tracked?: boolean }[];
              cached?: boolean;
            }>({
              method: "POST",
              path: "/org/competitors/suggest",
              apiKey: ctx.apiKey,
              baseUrl: ctx.baseUrl,
              resource: { type: "Competitor", list: "senso competitors list" },
            });
          } catch (err) {
            throw suggestFailure(err);
          }

          const suggestions = data.suggestions ?? [];
          const untracked = suggestions.filter((s) => s.already_tracked !== true).length;

          // The payload carries `mode`, `duration_ms` and `cached` alongside the
          // list; the shared renderer treats `suggestions` as the payload and
          // prints the rest as a header, so these columns do apply.
          emit(ctx, data, {
            columns: ["name", "confidence", "already_tracked", "source", "url"],
            empty: "suggestions",
            emptyHint:
              'The model found no candidates. Add one by hand with `senso competitors add --name "…"`.',
            warnings: data.cached
              ? [
                  "cached=true: this is a replay of a call made in the last 10 minutes, not a fresh one.",
                ]
              : [],
            next: [
              {
                why: `Accept the ${String(untracked)} suggestion(s) you do not already track`,
                command:
                  "senso competitors suggest --output json | jq -c '{items: [.data.suggestions[] | select(.already_tracked|not) | {name, url, source, confidence, rationale: (.rationale[0:280])}]}' | xargs -0 -I{} senso competitors batch-add --data {}",
              },
            ],
          });
        }),
      ),
    {
      returns: [
        "mode — how the suggestions were produced: run_text (extracted from at least 5 recent prompt runs, and grounded in what models actually said about you; `sampled_run_ids` lists the runs) | web_search (too few runs, so the model searched the web from your organization's name and website — less grounded)",
        "suggestions[].name — the proposed brand name",
        "suggestions[].url — website, when the model found one",
        "suggestions[].source — suggested_run_text | suggested_web_search. Pass it to batch-add unchanged",
        "suggestions[].confidence — 0 to 1",
        `suggestions[].rationale — why it was proposed. MAY EXCEED the ${String(MAX_RATIONALE_LENGTH)}-character limit batch-add enforces, so truncate before accepting`,
        "suggestions[].already_tracked — true when a competitor with this name is already on your list. Filter these out before accepting",
        "sampled_run_ids — the prompt runs the suggestions were drawn from (run_text mode only). This is the provenance to cite",
        "duration_ms — how long the call took",
        "cached — true when this is a replay of a result from the last 10 minutes rather than a fresh model call",
      ],
      exitCodes: {
        ...apiExits,
        1: "422 — the organization has no website and no prompt runs, so there is nothing to seed from; or 503 — suggestions are not enabled on this deployment",
        3: "no organization on the credential, or the role lacks update:org",
        5: "429 — more than 5 suggest calls in the last hour for this organization",
      },
      examples: [
        { command: "senso competitors suggest" },
        {
          comment: "Shape the untracked suggestions into a batch-add body",
          command:
            "senso competitors suggest --output json | jq -c '{items: [.data.suggestions[] | select(.already_tracked|not) | {name, url, source, confidence, rationale: (.rationale[0:280])}]}'",
        },
      ],
      seeAlso: ["senso competitors batch-add", "senso competitors list"],
    },
  );

  describeCommand(
    competitors
      .command("update")
      .description(
        'REPLACE a tracked competitor\'s name and URL. This is a PUT and the API cannot express "leave the URL alone": a request without a URL deletes the stored one, so this command requires either --url or --clear-url. Provenance is preserved — source, rationale and confidence keep whatever they were set to and cannot be changed here. Requires update:org.',
      )
      .argument(
        "<competitorId>",
        "A competitor id (UUID) — the `id` field of `senso competitors list`",
      )
      .requiredOption("--name <name>", "Competitor brand name. 1-255 characters after trimming")
      .option(
        "--url <url>",
        "The website to store. Absolute URL with a scheme, at most 2048 characters",
      )
      .option(
        "--clear-url",
        "Delete the stored URL, which is what the API does with a request that omits it",
      )
      .action(
        runAction(
          program,
          async (
            ctx,
            rawId: string,
            cmdOpts: { name: string; url?: string; clearUrl?: boolean },
          ) => {
            const competitorId = parseId(rawId, COMPETITOR_ID);
            const name = parseCompetitorName("--name", cmdOpts.name);

            if (cmdOpts.url !== undefined && cmdOpts.clearUrl) {
              throw usageError("--url and --clear-url contradict each other.", {
                field: "--clear-url",
                hint: "Pass --url to set a URL, or --clear-url to delete the stored one.",
              });
            }
            // The silent data loss this command used to ship: with no --url the
            // body carried no `url`, the DTO's *string stayed nil, and the
            // service assigned nil — deleting the stored URL, with a 200 and a
            // response that omits `url` entirely so nothing said so.
            if (cmdOpts.url === undefined && !cmdOpts.clearUrl) {
              throw usageError(
                "--url is required: this endpoint is a PUT, and a request without a URL deletes the stored one.",
                {
                  field: "--url",
                  hint: `Keep it: --url "$(senso competitors list --output json | jq -r '.data.competitors[] | select(.id=="${competitorId}") | .url')". Delete it deliberately: --clear-url.`,
                },
              );
            }

            const body: Record<string, unknown> = { name };
            if (cmdOpts.url !== undefined) body.url = parseCompetitorUrl("--url", cmdOpts.url);

            let data: unknown;
            try {
              data = await apiRequest({
                method: "PUT",
                path: `/org/competitors/${competitorId}`,
                body,
                apiKey: ctx.apiKey,
                baseUrl: ctx.baseUrl,
                resource: { ...COMPETITOR_ID, id: competitorId },
              });
            } catch (err) {
              throw competitorFailure(err, `update competitor ${competitorId}`);
            }

            if (!ctx.quiet) log.success(`Updated competitor ${competitorId}.`);
            emit(ctx, data, {
              warnings: cmdOpts.clearUrl
                ? ["The stored URL was deleted, as --clear-url asked."]
                : [],
              next: [{ why: "Confirm the tracked list", command: "senso competitors list" }],
            });
          },
        ),
      ),
    {
      returns: [
        "The competitor as it now stands: id, name, url, source, rationale, confidence, created_at, updated_at",
        "url is absent when there is none — including when this call just removed it",
      ],
      exitCodes: {
        ...idExits,
        1: "409 — another competitor already has that name",
        2: "<competitorId> is not a UUID; --name is missing, blank or over 255 characters; --url is not an absolute http(s) URL; or neither --url nor --clear-url was given",
        3: "the role lacks update:org",
        4: "no competitor with this id in your organization — one belonging to another organization also reads as not found",
      },
      examples: [
        {
          comment: "Keep the URL: read it back and resend it",
          command:
            'senso competitors update 6b1f0a92-4c33-4c8e-9a5d-1e7f2b3c4d55 --name "Acme Analytics Inc" --url "$(senso competitors list --output json | jq -r \'.data.competitors[] | select(.id=="6b1f0a92-4c33-4c8e-9a5d-1e7f2b3c4d55") | .url\')"',
        },
        {
          comment: "Deliberately drop the URL",
          command:
            'senso competitors update 6b1f0a92-4c33-4c8e-9a5d-1e7f2b3c4d55 --name "Acme Analytics Inc" --clear-url',
        },
      ],
      seeAlso: ["senso competitors list", "senso competitors delete <competitorId>"],
    },
  );

  describeCommand(
    competitors
      .command("delete")
      .description(
        `Remove a competitor from the tracked list. The row is soft-deleted: it disappears from \`competitors list\` and from the analytics that read the list, and it frees a slot against the ${String(ORG_CAP)}-competitor per-organization cap. Requires update:org.`,
      )
      .argument(
        "<competitorId>",
        "A competitor id (UUID) — the `id` field of `senso competitors list`",
      )
      .action(
        runAction(program, async (ctx, rawId: string) => {
          const competitorId = parseId(rawId, COMPETITOR_ID);
          await apiRequest({
            method: "DELETE",
            path: `/org/competitors/${competitorId}`,
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
            resource: { ...COMPETITOR_ID, id: competitorId },
          });
          // The API answers 200 { deleted: true }, which carries nothing the
          // caller does not already know; the id it does need is echoed here.
          emitConfirmation(
            ctx,
            `Removed competitor ${competitorId}.`,
            { action: "deleted", resource: "competitor", id: competitorId },
            { next: [{ why: "Confirm the tracked list", command: "senso competitors list" }] },
          );
        }),
      ),
    {
      returns: [
        'Nothing useful; the API answers 200 { "deleted": true }. Under --output json the CLI reports { "action": "deleted", "resource": "competitor", "id": "<competitorId>" }.',
      ],
      exitCodes: {
        ...idExits,
        2: "<competitorId> is not a UUID",
        3: "the role lacks update:org",
        4: "no competitor with this id in your organization — it may already be removed",
      },
      examples: [
        {
          comment: "Find the low-confidence suggestions you accepted",
          command:
            "senso competitors list --output json | jq -r '.data.competitors[] | select(.confidence != null and .confidence < 0.5) | .id'",
        },
        { command: "senso competitors delete 6b1f0a92-4c33-4c8e-9a5d-1e7f2b3c4d55" },
      ],
      seeAlso: ["senso competitors list", "senso competitors add"],
    },
  );
}
