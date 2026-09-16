import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";
import { parseEnumFlag, parseIntFlag } from "../lib/enum-arg.js";
import { CliError, EXIT, usageError } from "../lib/errors.js";
import { apiExits, describeCommand, idExits } from "../lib/help.js";
import { parseId } from "../lib/id-arg.js";
import { emit, emitConfirmation } from "../lib/output.js";
import { runAction } from "../lib/run-action.js";
import * as log from "../utils/logger.js";

const MATCH_TYPES = "domain | host | path_prefix | exact_url";
const TIERS = "primary (Owned) | tracked | secondary (External)";
const CATEGORIES = "affiliated_domain | published_content | social | press";

// The values behind the help strings above, for validation. MATCH_TYPES and
// TIERS stay as they are because they are prose the user reads (TIERS glosses
// two of the tiers with their UI names).
const MATCH_TYPE_VALUES = ["domain", "host", "path_prefix", "exact_url"] as const;
const TIER_VALUES = ["primary", "tracked", "secondary"] as const;
const CATEGORY_VALUES = ["affiliated_domain", "published_content", "social", "press"] as const;

/** Match types whose pattern must carry a path; the API answers a 400 otherwise. */
const PATH_REQUIRED = new Set(["path_prefix", "exact_url"]);

/** Where a tracked source id comes from. The argument is <sourceId>; the payload field is `id`. */
const SOURCE_ID = {
  label: "<sourceId>",
  type: "Tracked source",
  idField: "id",
  list: "senso tracked-sources list",
};

/** Said after every mutation, because the effect an agent is waiting for is delayed. */
const RECALC_NOTE =
  "A rollup recalculation was queued: it restates citation history against your rules and runs for minutes on the scheduler, so analytics will not reflect this change straight away.";

interface SourceFlags {
  pattern?: string;
  matchType?: string;
  tier?: string;
  category?: string;
  label?: string;
  priority?: string;
  active?: boolean;
}

/** The subset of dto.TrackedSourceResponse this file reads back. */
interface TrackedSourceResponse {
  id?: string;
  pattern?: string;
  match_type?: string;
  tier?: string;
  category?: string | null;
  label?: string | null;
  priority?: number;
  source_origin?: string;
  active?: boolean;
}

/** What the request actually asked for, so the response can be checked against it. */
interface SourceBody {
  pattern?: string;
  match_type?: string;
  tier?: string;
  category?: string;
  label?: string;
  priority?: number;
  active?: boolean;
}

/**
 * The API's pattern normalization, approximated.
 *
 * citationclass.Normalize lowercases the host, strips a leading "www.", drops
 * the scheme, query, fragment and trailing slash — so "https://WWW.Senso.ai/"
 * is stored as "senso.ai". This copy is not used to send anything; it exists so
 * the CLI can tell "the API normalized my pattern" from "the API ignored my
 * pattern", which are the same 200 otherwise.
 */
function normalizePattern(pattern: string): string {
  return pattern
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "");
}

/** True when the pattern names something beyond the host root. */
function hasPath(pattern: string): boolean {
  const rest = normalizePattern(pattern);
  const slash = rest.indexOf("/");
  return slash !== -1 && rest.slice(slash + 1).length > 0;
}

/**
 * Every flag checked, and only the flags the caller passed put in the body.
 *
 * `--category` used to be forwarded raw although the help printed its closed
 * set, so a typo cost a round trip; and it is DISCARDED by the service for any
 * tier but `tracked`, silently, with a 201. Both are refused here.
 */
function buildSourceBody(cmdOpts: SourceFlags): SourceBody {
  const body: SourceBody = {};
  if (cmdOpts.pattern !== undefined) {
    const pattern = cmdOpts.pattern.trim();
    if (pattern.length === 0) {
      throw usageError("Invalid --pattern: the pattern is empty.", {
        field: "--pattern",
        received: cmdOpts.pattern,
        hint: "Pass what cited URLs should match, e.g. --pattern senso.ai",
      });
    }
    body.pattern = pattern;
  }
  if (cmdOpts.matchType !== undefined) {
    body.match_type = parseEnumFlag("--match-type", cmdOpts.matchType, MATCH_TYPE_VALUES);
  }
  if (cmdOpts.tier !== undefined) {
    body.tier = parseEnumFlag("--tier", cmdOpts.tier, TIER_VALUES);
  }
  if (cmdOpts.category !== undefined) {
    body.category = parseEnumFlag("--category", cmdOpts.category, CATEGORY_VALUES);
    if (body.tier !== "tracked") {
      throw usageError(
        `--category only applies to --tier tracked; the API would discard it for tier "${body.tier ?? "unset"}" and answer 201 anyway.`,
        {
          field: "--category",
          received: cmdOpts.category,
          hint: "Drop --category, or use --tier tracked.",
        },
      );
    }
  }
  if (cmdOpts.label !== undefined) body.label = cmdOpts.label;
  // Checked rather than coerced: `Number("high")` is NaN and JSON.stringify
  // writes NaN as null, so an unchecked typo told the API to CLEAR the priority
  // instead of failing.
  if (cmdOpts.priority !== undefined) {
    body.priority = parseIntFlag("--priority", cmdOpts.priority);
  }
  if (cmdOpts.active !== undefined) body.active = cmdOpts.active;

  if (body.match_type !== undefined && PATH_REQUIRED.has(body.match_type)) {
    const pattern = body.pattern ?? "";
    if (!hasPath(pattern)) {
      throw usageError(
        `--match-type ${body.match_type} needs a path in --pattern: "${pattern}" has none.`,
        {
          field: "--pattern",
          received: pattern,
          hint: `Use a pattern with a path, e.g. --pattern ${normalizePattern(pattern) || "senso.ai"}/blog/geo-guide, or --match-type domain.`,
        },
      );
    }
  }
  return body;
}

/** "pattern was normalized from X to Y", when the API stored something else. */
function normalizationWarning(sent: string | undefined, stored: string | undefined): string[] {
  if (sent === undefined || stored === undefined || sent === stored) return [];
  return [
    `--pattern was normalized from "${sent}" to "${stored}"; that stored form is what \`list\` and \`--search\` match.`,
  ];
}

export function registerTrackedSourcesCommands(program: Command): void {
  const sources = program.command("tracked-sources").description(
    `Manage the rules that classify every URL an AI answer cites into one of three tiers. The tier is what share-of-voice and citation analytics count.

  primary    UI label "Owned"    — your own properties.
  tracked    UI label "Tracked"  — third parties you watch. Only this tier carries a --category.
  secondary  UI label "External" — everything else, and the default for a citation that matches no rule.

When two rules match one URL the more specific match type wins (exact_url > path_prefix > host > domain); between two rules of the same match type the higher --priority wins.

Every rule carries a source_origin: manual and onboarding rules are fully editable and deletable; a published rule — created automatically when content was published to a URL — accepts only an active toggle and cannot be deleted.

Changing any rule queues a rollup recalculation that restates citation history. It runs for minutes, so analytics lag a rule change. Reads need no permission; every mutation needs update:org.

Id space: a tracked source id is the \`id\` field of \`senso tracked-sources list\`, and it is the <sourceId> argument of update and delete.

Typical workflow: tracked-sources list --search <domain> → tracked-sources add → tracked-sources update <sourceId> --no-active to retire a rule → senso analytics once the recalc lands.

See also: senso analytics, senso competitors, senso publish-records`,
  );

  describeCommand(
    sources
      .command("list")
      .description(
        "List the organization's citation-classification rules. This list grows on its own — publishing content creates a `published` rule per live URL — so it is paged, 50 at a time by default. Page or search rather than assuming what you see is everything. Reading needs no permission.",
      )
      .option("--limit <n>", "Rows per page. Integer 1-100. Default 50. Maps to `limit`")
      .option("--offset <n>", "Rows to skip. Integer >= 0. Default 0. Maps to `offset`")
      .option(
        "--search <term>",
        'Substring filter on the pattern, normalized the same way patterns are stored, so "https://www.senso.ai/" matches the row stored as "senso.ai". Maps to `search`',
      )
      .action(
        runAction(
          program,
          async (ctx, cmdOpts: { limit?: string; offset?: string; search?: string }) => {
            // The API's own bounds, checked here so a typo costs exit 2 rather
            // than a round trip: limit is 1-100 and offset is >= 0.
            const limit = parseIntFlag("--limit", cmdOpts.limit, { min: 1, max: 100 });
            const offset = parseIntFlag("--offset", cmdOpts.offset, { min: 0 });

            const data = await apiRequest({
              path: "/org/tracked-sources",
              params: { limit, offset, search: cmdOpts.search },
              apiKey: ctx.apiKey,
              baseUrl: ctx.baseUrl,
              resource: { type: "Tracked source", list: "senso tracked-sources list" },
            });
            // `id`, not `source_id`: dto.TrackedSourceResponse marshals `id`.
            // `source_origin` is here because it is what says whether a rule can
            // be edited at all.
            emit(ctx, data, {
              columns: [
                "id",
                "pattern",
                "match_type",
                "tier",
                "source_origin",
                "active",
                "priority",
              ],
              empty: "tracked source rules",
              emptyHint:
                "With no rules, every cited URL is classified External (secondary). Claim your own domain: senso tracked-sources add --pattern your-company.com --match-type domain --tier primary",
            });
          },
        ),
      ),
    {
      returns: [
        "tracked_sources[].id — the <sourceId> for update and delete",
        'tracked_sources[].pattern — the stored, normalized pattern (lowercased, "www." stripped, scheme, query and fragment removed)',
        "tracked_sources[].match_type — domain (eTLD+1 and every subdomain) | host (that exact host) | path_prefix (host + path prefix) | exact_url (host + that exact path)",
        'tracked_sources[].tier — primary (UI "Owned") | tracked (UI "Tracked") | secondary (UI "External", and the default for an unmatched citation)',
        `tracked_sources[].category — sub-label, only ever set on the tracked tier: ${CATEGORIES}`,
        "tracked_sources[].label — free-text human label, if any",
        "tracked_sources[].priority — tiebreaker between rules of the same match type; higher wins. Default 0",
        "tracked_sources[].source_origin — manual | onboarding | published. A published rule accepts only an active toggle and cannot be deleted",
        "tracked_sources[].active — false means the rule is ignored during classification",
        "total — the organization's full row count for this filter, NOT the size of this page",
        "limit, offset — echoed back",
      ],
      exitCodes: {
        ...apiExits,
        2: "--limit is outside 1-100, or --offset is negative or not a whole number",
        3: "no organization could be resolved from the credential",
      },
      examples: [
        { command: "senso tracked-sources list --search senso.ai" },
        {
          comment: "The rules you are allowed to edit",
          command:
            'senso tracked-sources list --limit 100 --output json | jq -r \'.data.tracked_sources[] | select(.source_origin=="manual") | "\\(.id) \\(.pattern) \\(.tier)"\'',
        },
      ],
      seeAlso: ["senso tracked-sources add", "senso tracked-sources update <sourceId>"],
    },
  );

  describeCommand(
    sources
      .command("add")
      .description(
        'Create a citation-classification rule. New rules are always active and always get source_origin="manual". The pattern is NORMALIZED before storage — "https://WWW.Senso.ai/" is stored as "senso.ai" — and that stored form is what `list` shows. Requires update:org.',
      )
      .requiredOption(
        "--pattern <pattern>",
        "Value to match cited URLs against, interpreted per --match-type. At most 2048 characters",
      )
      .requiredOption("--match-type <type>", `Match strategy: ${MATCH_TYPES}`)
      .requiredOption("--tier <tier>", `Classification tier: ${TIERS}`)
      .option(
        "--category <category>",
        `Sub-category, and ONLY for --tier tracked — the API discards it for any other tier: ${CATEGORIES}`,
      )
      .option("--label <label>", "Optional human-readable label, at most 255 characters")
      .option(
        "--priority <n>",
        "Optional integer, default 0. Breaks ties between rules of the SAME match type; higher wins",
      )
      .action(
        runAction(program, async (ctx, cmdOpts: SourceFlags) => {
          const body = buildSourceBody(cmdOpts);
          const data = await apiRequest<TrackedSourceResponse>({
            method: "POST",
            path: "/org/tracked-sources",
            body,
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
            resource: { type: "Tracked source", list: "senso tracked-sources list" },
          });
          if (!ctx.quiet) log.success(`Created tracked source ${data.id ?? "<sourceId>"}.`);
          emit(ctx, data, {
            warnings: [...normalizationWarning(body.pattern, data.pattern), RECALC_NOTE],
            next: [
              {
                why: "Confirm the stored pattern",
                command: `senso tracked-sources list --search ${data.pattern ?? body.pattern ?? ""}`,
              },
            ],
          });
        }),
      ),
    {
      returns: [
        "id — the rule id, the <sourceId> for update and delete",
        "pattern — the NORMALIZED pattern as stored, which may differ from what you sent",
        "match_type — domain | host | path_prefix | exact_url. domain matches the eTLD+1 and every subdomain; host matches that exact host; path_prefix and exact_url need a path in the pattern",
        'tier — primary (UI "Owned", your own properties) | tracked (UI "Tracked", third parties you watch) | secondary (UI "External", everything else)',
        `category — ${CATEGORIES}, and only ever stored on the tracked tier`,
        "label, priority — as sent; priority defaults to 0",
        'source_origin — always "manual" here',
        "active — always true on creation",
        "created_at, updated_at",
      ],
      exitCodes: {
        ...apiExits,
        1: "409 — a rule with this normalized pattern and match type already exists",
        2: "--match-type, --tier or --category is not one of its allowed values; --priority is not a whole number; --pattern is empty; --match-type is path_prefix or exact_url and --pattern has no path; or --category was given with a tier other than tracked",
        3: "the role lacks update:org",
      },
      notes: [RECALC_NOTE],
      examples: [
        {
          command:
            "senso tracked-sources add --pattern senso.ai --match-type domain --tier primary --priority 10",
        },
        {
          command:
            "senso tracked-sources add --pattern reddit.com/r/artificial --match-type path_prefix --tier tracked --category social",
        },
      ],
      seeAlso: ["senso tracked-sources list", "senso tracked-sources update <sourceId>"],
    },
  );

  describeCommand(
    sources
      .command("update")
      .description(
        "REPLACE a citation-classification rule (PUT). What happens depends on the rule's source_origin: a manual or onboarding rule takes every field, while a published rule accepts ONLY --active/--no-active — the API takes a new pattern, match type or tier, answers 200, and silently keeps the old values, so this command reports that as a failure rather than letting it look like a write. Omission is not uniform: --label and --category are CLEARED when you omit them, while --priority and the active flag are KEPT. Requires update:org.",
      )
      .argument(
        "<sourceId>",
        "A tracked source id (UUID) — the `id` field of `senso tracked-sources list`",
      )
      .requiredOption(
        "--pattern <pattern>",
        "Value to match cited URLs against, interpreted per --match-type. Normalized before storage",
      )
      .requiredOption("--match-type <type>", `Match strategy: ${MATCH_TYPES}`)
      .requiredOption("--tier <tier>", `Classification tier: ${TIERS}`)
      .option(
        "--category <category>",
        `Sub-category, tracked tier only. OMITTING IT CLEARS THE STORED CATEGORY: ${CATEGORIES}`,
      )
      .option("--label <label>", "Human-readable label. OMITTING IT CLEARS THE STORED LABEL")
      .option("--priority <n>", "Ordering priority (integer). Omitting it keeps the current value")
      .option("--active", "Mark the rule active")
      .option("--no-active", "Mark the rule inactive, so it stops classifying")
      .action(
        runAction(program, async (ctx, rawId: string, cmdOpts: SourceFlags) => {
          const sourceId = parseId(rawId, SOURCE_ID);
          const body = buildSourceBody(cmdOpts);

          const data = await apiRequest<TrackedSourceResponse>({
            method: "PUT",
            path: `/org/tracked-sources/${sourceId}`,
            body,
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
            resource: { ...SOURCE_ID, id: sourceId },
          });

          // The silent no-op. For source_origin="published" the service applies
          // `active`, saves, and returns 200 with everything else untouched —
          // there is no status, header or field that says so, so the only
          // detection available is the returned row against what was sent.
          const ignored = fieldsTheApiIgnored(body, data);
          if (data.source_origin === "published" && ignored.length > 0) {
            throw new CliError(
              `Tracked source ${sourceId} has source_origin "published": the API answered 200 and applied none of ${ignored.join(", ")}.`,
              EXIT.ERROR,
              {
                code: "conflict",
                field: ignored[0],
                hint: `Only --active/--no-active can change a published rule, and it cannot be deleted. Retire it with its own stored values: senso tracked-sources update ${sourceId} --pattern ${data.pattern ?? "<pattern>"} --match-type ${data.match_type ?? "<match_type>"} --tier ${data.tier ?? "<tier>"} --no-active`,
                details: { source_origin: data.source_origin, ignored },
                request: { method: "PUT", path: `/org/tracked-sources/${sourceId}` },
              },
            );
          }

          const warnings = [...normalizationWarning(body.pattern, data.pattern)];
          if (data.source_origin !== "published") {
            if (cmdOpts.label === undefined) {
              warnings.push(
                "The stored label was cleared: this PUT clears `label` when --label is not given.",
              );
            }
            if (cmdOpts.category === undefined) {
              warnings.push(
                "The stored category was cleared: this PUT clears `category` when --category is not given.",
              );
            }
          }
          warnings.push(RECALC_NOTE);

          if (!ctx.quiet) log.success(`Updated tracked source ${sourceId}.`);
          emit(ctx, data, {
            warnings,
            next: [
              {
                why: "Confirm what the rule now says",
                command: `senso tracked-sources list --search ${data.pattern ?? ""}`,
              },
            ],
          });
        }),
      ),
    {
      returns: [
        "The rule as it now stands: id, pattern (normalized), match_type, tier, category, label, priority, source_origin, active, created_at, updated_at",
        "match_type — domain (eTLD+1 and every subdomain) | host | path_prefix | exact_url; the last two need a path in the pattern",
        'tier — primary (UI "Owned") | tracked (UI "Tracked") | secondary (UI "External")',
        "source_origin — manual | onboarding | published. It is what decided how much of your request was honored",
      ],
      exitCodes: {
        ...idExits,
        1: "409 — the new pattern and match type collide with another rule; or the rule is `published` and the API accepted and ignored the change",
        2: "<sourceId> is not a UUID; an enum flag is invalid; --priority is not a whole number; --pattern is empty or has no path for path_prefix/exact_url; or --category was given with a tier other than tracked",
        3: "the role lacks update:org",
        4: "no rule with this id in your organization",
      },
      notes: [
        RECALC_NOTE,
        'The API cannot express "leave the label alone" on this endpoint: `label` and `category` are reassigned on every PUT, so omitting them clears them. Send them back to keep them.',
      ],
      examples: [
        {
          command:
            "senso tracked-sources update 2f7b8c1d-9e04-4a55-8b77-6c1d3e9f0a21 --pattern senso.ai --match-type domain --tier primary --priority 20",
        },
        {
          comment: "Retire a published rule — the only change it accepts",
          command:
            "senso tracked-sources update 81c0a4f6-2b39-4d70-91ee-5a0b7c2d8e43 --pattern senso.ai/blog/geo-guide --match-type exact_url --tier primary --no-active",
        },
      ],
      seeAlso: ["senso tracked-sources list", "senso tracked-sources delete <sourceId>"],
    },
  );

  describeCommand(
    sources
      .command("delete")
      .description(
        'Delete a citation-classification rule. A rule with source_origin="published" CANNOT be deleted — the publishing pipeline maintains it and would recreate it — so deactivate it instead with `tracked-sources update <sourceId> --pattern <its pattern> --match-type <its match_type> --tier <its tier> --no-active`. Citations that only this rule matched fall back to the External (secondary) tier. Requires update:org.',
      )
      .argument(
        "<sourceId>",
        "A tracked source id (UUID) — the `id` field of `senso tracked-sources list`",
      )
      .action(
        runAction(program, async (ctx, rawId: string) => {
          const sourceId = parseId(rawId, SOURCE_ID);
          await apiRequest({
            method: "DELETE",
            path: `/org/tracked-sources/${sourceId}`,
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
            resource: { ...SOURCE_ID, id: sourceId },
          });
          emitConfirmation(
            ctx,
            `Removed tracked source ${sourceId}.`,
            { action: "deleted", resource: "tracked_source", id: sourceId },
            {
              warnings: [
                "Citations that only this rule matched now fall back to the External (secondary) tier.",
                RECALC_NOTE,
              ],
              next: [{ why: "Confirm the remaining rules", command: "senso tracked-sources list" }],
            },
          );
        }),
      ),
    {
      returns: [
        'Nothing useful; the API answers 200 { "deleted": true }. Under --output json the CLI reports { "action": "deleted", "resource": "tracked_source", "id": "<sourceId>" }.',
      ],
      exitCodes: {
        ...idExits,
        1: "409 — the rule was created by publishing and cannot be deleted; deactivate it instead",
        2: "<sourceId> is not a UUID",
        3: "the role lacks update:org",
        4: "no rule with this id in your organization — it may already be removed",
      },
      notes: [RECALC_NOTE],
      examples: [
        {
          comment: "The rules you are allowed to delete",
          command:
            "senso tracked-sources list --search senso.ai --output json | jq -r '.data.tracked_sources[] | select(.source_origin==\"manual\") | .id'",
        },
        { command: "senso tracked-sources delete 2f7b8c1d-9e04-4a55-8b77-6c1d3e9f0a21" },
      ],
      seeAlso: ["senso tracked-sources update <sourceId>", "senso tracked-sources list"],
    },
  );
}

/**
 * The fields the caller asked to change and the API did not.
 *
 * Pattern is compared through the normalizer, because a stored value that
 * differs only by case or a stripped "www." was honored, not dropped.
 */
function fieldsTheApiIgnored(sent: SourceBody, got: TrackedSourceResponse): string[] {
  const ignored: string[] = [];
  if (
    sent.pattern !== undefined &&
    normalizePattern(sent.pattern) !== normalizePattern(got.pattern ?? "")
  ) {
    ignored.push("--pattern");
  }
  if (sent.match_type !== undefined && sent.match_type !== got.match_type) {
    ignored.push("--match-type");
  }
  if (sent.tier !== undefined && sent.tier !== got.tier) ignored.push("--tier");
  if (sent.category !== undefined && sent.category !== (got.category ?? undefined)) {
    ignored.push("--category");
  }
  if (sent.label !== undefined && sent.label !== (got.label ?? undefined)) ignored.push("--label");
  if (sent.priority !== undefined && sent.priority !== got.priority) ignored.push("--priority");
  return ignored;
}
