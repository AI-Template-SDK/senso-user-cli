import { Command } from "commander";
import { ApiError, apiRequest } from "../lib/api-client.js";
import { assertRange, parseDateFlag, parseEnumFlag, parseIntFlag } from "../lib/enum-arg.js";
import { CliError, EXIT, toCliError, usageError } from "../lib/errors.js";
import { apiExits, describeCommand, idExits } from "../lib/help.js";
import { isUuid, parseId, parseIdList } from "../lib/id-arg.js";
import { emit, type EmitOptions, type NextStep, type OutputContext } from "../lib/output.js";
import { runAction, type Ctx } from "../lib/run-action.js";
import * as log from "../utils/logger.js";

/**
 * The org-key view of the industry catalog, under the /org/industries
 * prefix.
 *
 * Not to be confused with `senso partner industries`, which reads `/partner/*`
 * and needs a partner key. The two cover similar ground on purpose: this group
 * is the one almost every caller wants, because it works with the key that
 * `senso login` stores. Reads here accept any industry in the public
 * catalog, not only your organization's own.
 */

/** The catalog's id space: what every `<industry>` resolves to. */
export const INDUSTRY = {
  type: "Industry",
  idField: "industry_id",
  list: "senso industries list",
} as const;

/** The brand registry's id space: stable across industries and endpoints. */
const BRAND = {
  type: "Brand",
  idField: "brand_id",
  list: "senso industries brands <industry>",
} as const;

/** An INDUSTRY prompt, which is not an org prompt and not a geo_question_id. */
const INDUSTRY_PROMPT = {
  type: "Industry prompt",
  idField: "id",
  list: "senso industries prompts <industry>",
} as const;

export function industryResource(id: string) {
  return { ...INDUSTRY, id };
}

/**
 * Resolve an `<industry>` argument that may be a UUID or a human-typed name.
 *
 * A UUID is used as-is — no extra round trip — and anything else costs one
 * search against the catalog first and takes the FIRST match, which is why
 * every command's help says so: "Airlines" resolves to whichever of "Airlines
 * (Canada)" and "Airlines (US)" sorts first, silently.
 *
 * A name that matches nothing is exit 4 rather than a 400 from a path segment
 * the API could not parse, and the hint names the command that lists the ids.
 */
export async function resolveIndustryId(
  industry: string,
  opts: { apiKey?: string; baseUrl?: string },
): Promise<string> {
  if (isUuid(industry)) return industry.trim();

  const name = industry.trim();
  if (name === "") {
    throw usageError("<industry> is empty.", {
      field: "<industry>",
      received: industry,
      hint: "Pass an industry_id UUID or a name, e.g. `senso industries prompts \"Airlines (Canada)\"`. List them with `senso industries list`.",
    });
  }

  const data = await apiRequest<{
    industries?: { industry_id?: string; name?: string }[];
  }>({
    path: "/org/industries",
    params: { search: name },
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
  });

  const match = data.industries?.[0];
  if (!match?.industry_id) {
    throw new CliError(`No industry in the public catalog matches "${industry}".`, EXIT.NOT_FOUND, {
      code: "not_found",
      field: "<industry>",
      received: industry,
      hint: "List the catalog with `senso industries list`, or pass an industry_id UUID. A private partner industry is never in this catalog, even one assigned to your organization.",
    });
  }
  return match.industry_id;
}

/**
 * Re-raise an API refusal with a hint the API itself cannot give.
 *
 * Same device as `refine` in kb.ts, and needed here for the same reason: the
 * three 403s this group can produce — no GEO product, no industry set, not
 * YOUR industry — are one status with three different remedies, and only one
 * of them is anything an org admin can widen.
 */
function refine(err: unknown, rules: { match: RegExp; hint: string }[]): CliError {
  const mapped = toCliError(err);
  const rule = rules.find((r) => r.match.test(mapped.message));
  if (!rule) return mapped;
  return new CliError(mapped.message, mapped.exitCode, {
    code: mapped.code,
    status: mapped.status,
    field: mapped.field,
    received: mapped.received,
    allowed: mapped.allowed,
    details: mapped.details,
    request: mapped.request,
    hint: rule.hint,
    cause: err instanceof ApiError ? err : mapped.cause,
  });
}

/** The GEO entitlement every command here but `list` sits behind. */
const GEO_RULE = {
  match: /product/i,
  hint: "This organization does not have the GEO product, which every `senso industries` command except `list` requires. `senso org get` shows the organization; adding GEO is a plan change at https://app.senso.ai.",
};

/**
 * Every model id `--models` accepts, mirrored from supportedRunModels in
 * senso-api's internal/api/handlers/app_handler.go.
 *
 * The set is small and closed and is discoverable nowhere else in this group:
 * `senso analytics filters` lists the ids that already HAVE data, which is the
 * nearest thing to a discovery command and is what every `--models` help line
 * points at. Checking here turns a typo into exit 2 with the accepted set in
 * `error.allowed` rather than a 400 the caller sees as exit 1.
 */
export const MODEL_VALUES = [
  "gpt-4.1",
  "chatgpt",
  "perplexity",
  "aioverview",
  "gemini",
  "linkup",
  "claude-sonnet-4-6",
  "grok",
] as const;

/** Where an agent reads the model ids that have data. */
export const MODELS_HINT =
  "`senso analytics filters --output json | jq -r '.data.models[].id'` lists the ids that have data.";

/** The longest window these endpoints will answer. 365 on `senso analytics`. */
export const MAX_WINDOW_DAYS = 90;

/**
 * Checks a comma-separated `--models` value against the allow-list.
 *
 * `parseEnumFlag` cannot do this: the flag is one string holding many values.
 */
export function parseModelsFlag(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const parts = value
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) {
    throw usageError("Invalid --models: no value given.", {
      field: "--models",
      received: value,
      allowed: MODEL_VALUES,
      hint: `Must be one or more of: ${MODEL_VALUES.join(", ")}. ${MODELS_HINT}`,
    });
  }
  return parts
    .map((part) => {
      const match = MODEL_VALUES.find((m) => m === part.toLowerCase());
      if (!match) {
        throw usageError(`Invalid --models: "${part}" is not a model id.`, {
          field: "--models",
          received: part,
          allowed: MODEL_VALUES,
          hint: `Must be one or more of: ${MODEL_VALUES.join(", ")}. ${MODELS_HINT}`,
        });
      }
      return match;
    })
    .join(",");
}

/** The date-window and model/location filters every metrics read shares. */
export interface WindowFilters {
  from?: string;
  to?: string;
  models?: string;
  location?: string;
}

/**
 * The window filters as query parameters, each checked before the request.
 *
 * The dates are the reason this exists. This API takes two different formats
 * under the same two flag names — `YYYY-MM-DD` here and on `senso analytics`,
 * RFC 3339 instants on `senso evals` — and a caller carrying a timestamp
 * between the groups should learn that from exit 2 and a named format, not
 * from a 400. The 90-day cap and the from <= to rule are the API's, enforced
 * here so they cost nothing.
 */
export function windowParams(o: WindowFilters): Record<string, string | undefined> {
  const from = parseDateFlag("--from", o.from);
  const to = parseDateFlag("--to", o.to);
  assertRange("--from", from, "--to", to, { maxDays: MAX_WINDOW_DAYS });
  return { from, to, models: parseModelsFlag(o.models), location: o.location };
}

/** Attach the four window filters to a command, in one place. */
export function addWindowOptions(cmd: Command): Command {
  return cmd
    .option(
      "--from <date>",
      "Start of the window, YYYY-MM-DD and inclusive (default: 30 days ago). NOT an RFC 3339 instant — `senso evals` takes those",
    )
    .option(
      "--to <date>",
      `End of the window, YYYY-MM-DD and inclusive (default: today, UTC). The span may not exceed ${String(MAX_WINDOW_DAYS)} days`,
    )
    .option(
      "--models <list>",
      `Comma-separated model ids to keep: ${MODEL_VALUES.join(", ")}. Omit for every model. ${MODELS_HINT}`,
    )
    .option(
      "--location <code>",
      "2-letter country code, e.g. US. Omit for every location the industry runs in",
    );
}

/** The window contract, repeated in the help of every command that takes it. */
const WINDOW_NOTE = `--from and --to are YYYY-MM-DD (\`senso evals\` takes RFC 3339 instants instead), inclusive, defaulting to the last 30 days, and the span may not exceed ${String(MAX_WINDOW_DAYS)} days. --models takes the ids listed by \`senso analytics filters\`.`;

const ENTITY_TYPES = [
  "brand",
  "regulator",
  "publisher",
  "government",
  "generic_term",
  "product_model",
  "forum_social",
] as const;

/**
 * `--entity-type` is a comma-separated list, so `parseEnumFlag` cannot check it
 * directly. Validating each member here keeps a typo a usage error: the filter
 * is applied server-side before paging, so `--entity-type brnad` would
 * otherwise come back as a perfectly plausible empty leaderboard.
 */
function parseEntityTypes(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const parts = value
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0);
  if (parts.length === 0) {
    throw usageError("Invalid --entity-type: no value given.", {
      field: "--entity-type",
      received: value,
      allowed: ENTITY_TYPES,
      hint: `Must be one or more of: ${ENTITY_TYPES.join(", ")}.`,
    });
  }
  for (const part of parts) {
    if (!ENTITY_TYPES.includes(part as (typeof ENTITY_TYPES)[number])) {
      throw usageError(`Invalid --entity-type: "${part}".`, {
        field: "--entity-type",
        received: part,
        allowed: ENTITY_TYPES,
        hint: `Must be one or more of: ${ENTITY_TYPES.join(", ")}.`,
      });
    }
  }
  return parts.join(",");
}

const SORTS = ["name_asc", "name_desc", "created_asc", "created_desc"] as const;

/** What `<industry>` accepts, in the words every command in this group uses. */
const INDUSTRY_ARG =
  'An industry_id UUID from `senso industries list`, or an industry name such as "Airlines (Canada)". A name costs one extra lookup and resolves to the FIRST search match, so pass the UUID when more than one industry shares a word';

/** The fuzzy-match fields, spelled out wherever a brand payload carries them. */
const BRAND_RETURNS = [
  "resolved.brand_id — the stable id, identical for this brand in every industry and endpoint. Store THIS, not brand_key, and pass it to `industries brand-by-id`.",
  "resolved.brand_key — a display and merge artifact that curation may change. Never key on it.",
  "resolved.matched_on — the spelling the fuzzy match actually hit.",
  "resolved.match_confidence — 0..1. A low value means the numbers may belong to a different brand.",
  "resolved.surface_forms[] — every spelling merged into these numbers.",
  "mentioned — true | false. false means the brand was never named in this industry and window; metrics is then null and the command still exits 0.",
  "metrics.mention_rate / share_of_voice / owned_citation_share — each {value, display}, or null when the denominator was zero. null is never 0%.",
  "metrics.avg_position — the mean position when named; 1 is first and lower is better.",
  "metrics.rank_in_industry — out of metrics.brands_ranked.",
  "by_model[] — the same mention_rate per model.",
  "by_stage — always null for now; the funnel-stage dimension has not shipped.",
  "data_quality.level — low | medium | high, with reasons[]. low means too few answered runs to quote.",
  "definitions — what each metric measured, the same content as `senso partner glossary`.",
];

export function registerIndustriesCommands(program: Command): void {
  const industries = program
    .command("industries")
    .description(
      'Browse the public industry catalog and the competitive intelligence Senso collects for it — brand leaderboards, domain citations and the prompts each industry runs. Works with the organization key stored by `senso login`; `senso partner` is the same data under a partner key. Three id spaces meet here: industry_id (from `industries list`), an INDUSTRY prompt id (the `id` of `industries prompts`, which is not a geo_question_id), and brand_id (from `industries brands`). Every <industry> takes a UUID or a name (e.g. "Airlines (Canada)"), and a name takes the first search match. Every command except `list` requires the GEO product. Workflow: list → org set-industry (once) → prompts → import-prompts → history-imports get → brands.',
    );

  describeCommand(
    industries
      .command("list")
      .description(
        "List the public industry catalog — every industry any organization may browse and choose as its own, with the counts that say whether it has anything worth importing.",
      )
      .option("--search <q>", "Case-insensitive substring match against name and slug")
      .option("--limit <n>", "Page size, 1-100 (default 50)")
      .option("--offset <n>", "Industries to skip (default 0)")
      .option("--sort <order>", `Sort order: ${SORTS.join(" | ")} (default name_asc)`)
      .option(
        "--live",
        "Only industries that can actually run: at least one opted-in model AND at least one active prompt",
      )
      .action(
        runAction(
          program,
          async (
            ctx: Ctx,
            cmdOpts: {
              search?: string;
              limit?: string;
              offset?: string;
              sort?: string;
              live?: boolean;
            },
          ) => {
            const limit = parseIntFlag("--limit", cmdOpts.limit, { min: 1, max: 100 });
            const offset = parseIntFlag("--offset", cmdOpts.offset, { min: 0 });
            const sort = parseEnumFlag("--sort", cmdOpts.sort, SORTS);

            const data = await apiRequest<{ industries?: { industry_id?: string }[] }>({
              path: "/org/industries",
              params: {
                search: cmdOpts.search,
                limit: limit?.toString(),
                offset: offset?.toString(),
                sort,
                live: cmdOpts.live ? "true" : undefined,
              },
              apiKey: ctx.apiKey,
              baseUrl: ctx.baseUrl,
            });
            const first = (data.industries ?? [])[0];
            emit(ctx, data, {
              columns: [
                "industry_id",
                "name",
                "slug",
                "active_prompt_count",
                "model_count",
                "location_count",
              ],
              empty: "industries",
              emptyHint:
                "The catalog itself is never empty, so this is a filter: drop --search and --live to see all of it. A private partner industry is never listed here, even one assigned to your organization.",
              next:
                first?.industry_id === undefined
                  ? []
                  : [
                      {
                        why: "See the prompts one of them runs",
                        command: `senso industries prompts ${first.industry_id}`,
                      },
                      {
                        why: "Make it this organization's industry — once, and only once",
                        command: `senso org set-industry ${first.industry_id}`,
                      },
                    ],
            });
          },
        ),
      ),
    {
      returns: [
        "industries[].industry_id — the <industry> argument for every other command in this group, and the argument to `senso org set-industry`.",
        "industries[].name / slug / description — the display name, the url-safe key, and what the industry covers.",
        "industries[].active_prompt_count — active industry prompts. 0 means `industries import-prompts` has nothing to copy.",
        "industries[].model_count — opted-in AI models. 0 means the industry has never run, so there is no history to import and no leaderboard to read.",
        "industries[].location_count — how many countries it runs in; the values --location takes.",
        "total / limit / offset — the page window. total counts every industry matching --search, not just this page.",
      ],
      exitCodes: {
        ...apiExits,
        2: "--limit is outside 1-100, --offset is negative, or --sort is not one of the four orders",
      },
      notes: [
        "Public industries only (partner_id IS NULL). A private partner industry never appears here, even one your organization has been assigned — which matters, because `import-prompts` accepts only your own industry.",
        "This is the one command in the group that does NOT require the GEO product: browsing the catalog precedes any GEO setup.",
      ],
      examples: [
        { command: "senso industries list --search airlines" },
        {
          comment: "Only the industries that are actually running",
          command:
            "senso industries list --live --output json | jq -r '.data.industries[] | \"\\(.industry_id)  \\(.name)\"'",
        },
        { comment: "The second page", command: "senso industries list --offset 50" },
      ],
      seeAlso: [
        "senso org set-industry",
        "senso industries prompts",
        "senso industries brands",
        "senso partner industries list",
      ],
    },
  );

  describeCommand(
    industries
      .command("prompts")
      .description(
        "List the prompts an industry runs — the questions Senso asks the AI models on the industry's behalf. Their ids are what `industries import-prompts` and `senso generate industry-draft` accept.",
      )
      .argument("<industry>", INDUSTRY_ARG)
      .option("--limit <n>", "Page size, 1-100 (default 50)")
      .option("--offset <n>", "Prompts to skip (default 0)")
      .action(
        runAction(
          program,
          async (ctx: Ctx, industry: string, cmdOpts: { limit?: string; offset?: string }) => {
            const limit = parseIntFlag("--limit", cmdOpts.limit, { min: 1, max: 100 });
            const offset = parseIntFlag("--offset", cmdOpts.offset, { min: 0 });
            const industryId = await resolveIndustryId(industry, ctx);

            let data: { prompts?: { id?: string }[] };
            try {
              data = await apiRequest<{ prompts?: { id?: string }[] }>({
                path: `/org/industries/${industryId}/prompts`,
                params: { limit: limit?.toString(), offset: offset?.toString() },
                resource: industryResource(industryId),
                apiKey: ctx.apiKey,
                baseUrl: ctx.baseUrl,
              });
            } catch (err) {
              throw refine(err, [GEO_RULE]);
            }
            const first = (data.prompts ?? [])[0];
            emit(ctx, data, {
              columns: ["id", "text", "funnel_stage"],
              empty: "prompts",
              emptyHint: `This industry has no active prompts, so there is nothing to import from it. Check its active_prompt_count with: senso industries list --search "${industry}"`,
              next:
                first?.id === undefined
                  ? []
                  : [
                      {
                        why: "Copy prompts into your organization (your own industry only)",
                        command: `senso industries import-prompts ${industryId} --prompt-ids ${first.id}`,
                      },
                    ],
            });
          },
        ),
      ),
    {
      returns: [
        "prompts[].id — the INDUSTRY prompt id. Pass it to `industries import-prompts --prompt-ids`. It is NOT a geo_question_id and `senso prompts get` will not take it.",
        "prompts[].text — the prompt as it is sent to the models, at most 255 characters.",
        "prompts[].funnel_stage — where the question sits in the buying funnel (awareness, consideration, evaluation, decision); empty when the industry never classified it.",
        "total / limit / offset — the page window. total counts every active prompt in the industry, so a default page of 50 can hide the rest.",
      ],
      exitCodes: {
        ...idExits,
        2: "<industry> is empty, --limit is outside 1-100, or --offset is negative",
        3: "the organization does not have the GEO product, or the key lacks read:prompt",
        4: "no industry with this id or name is readable by your organization — a private industry that is not yours is a 404, not a 403",
      },
      notes: [
        "These are the INDUSTRY's prompts. Your organization's own prompts are `senso prompts list`, and the two id spaces are not interchangeable.",
        "Page with --offset before importing: `import-prompts` takes at most 100 ids, and a default page shows 50 of however many total says.",
      ],
      examples: [
        { command: 'senso industries prompts "Airlines (Canada)"' },
        {
          comment: "The ids import-prompts takes",
          command:
            "senso industries prompts 5d6e7f80-9a0b-4c1d-8e2f-3a4b5c6d7e8f --output json | jq -r '.data.prompts[].id'",
        },
      ],
      seeAlso: [
        "senso industries import-prompts",
        "senso industries list",
        "senso prompts list",
        "senso generate industry-draft",
      ],
    },
  );

  describeCommand(
    addWindowOptions(
      industries
        .command("brands")
        .description(
          "Brand leaderboard for an industry — every brand the AI answers named over the window, ranked by mentions. The figures are raw COUNTS: divide by the `totals` block to get shares. Ranks are global, so --offset 100 still shows ranks 101 and up.",
        )
        .argument("<industry>", INDUSTRY_ARG),
    )
      .option("--limit <n>", "Page size, 1-100 (default 100)")
      .option("--offset <n>", "Brands to skip (default 0)")
      .option(
        "--no-canonicalize",
        "Do not merge spelling variants — one row per spelling. Turns off --rollup, which needs canonicalization",
      )
      .option(
        "--rollup <mode>",
        "Set to `parent` to fold sub-brands into their parent company (Gemini into Google). Ignored with --no-canonicalize",
      )
      .option(
        "--entity-type <list>",
        `Comma-separated types to keep: ${ENTITY_TYPES.join(", ")}. Applied before paging, so total reflects it`,
      )
      .action(
        runAction(
          program,
          async (
            ctx: Ctx,
            industry: string,
            cmdOpts: WindowFilters & {
              limit?: string;
              offset?: string;
              canonicalize?: boolean;
              rollup?: string;
              entityType?: string;
            },
          ) => {
            const limit = parseIntFlag("--limit", cmdOpts.limit, { min: 1, max: 100 });
            const offset = parseIntFlag("--offset", cmdOpts.offset, { min: 0 });
            const rollup = parseEnumFlag("--rollup", cmdOpts.rollup, ["parent"] as const);
            const entityType = parseEntityTypes(cmdOpts.entityType);
            const params = windowParams(cmdOpts);
            const industryId = await resolveIndustryId(industry, ctx);

            let data: { brands?: { brand_id?: string; brand_name?: string }[] };
            try {
              data = await apiRequest<{ brands?: { brand_id?: string; brand_name?: string }[] }>({
                path: `/org/industries/${industryId}/brands`,
                params: {
                  ...params,
                  limit: limit?.toString(),
                  offset: offset?.toString(),
                  // Commander gives `canonicalize: false` only when --no-canonicalize
                  // is passed; the server default is true, so say nothing otherwise.
                  canonicalize: cmdOpts.canonicalize === false ? "false" : undefined,
                  rollup,
                  entity_type: entityType,
                },
                resource: industryResource(industryId),
                apiKey: ctx.apiKey,
                baseUrl: ctx.baseUrl,
              });
            } catch (err) {
              throw refine(err, [GEO_RULE]);
            }
            const first = (data.brands ?? [])[0];
            emit(ctx, data, {
              columns: [
                "mentions_rank",
                "brand_name",
                "mentions_count",
                "mention_total",
                "average_position",
                "top_cited_domain",
                "entity_type",
              ],
              // The server drops --rollup silently when canonicalization is off,
              // so the page that comes back is not the page that was asked for.
              warnings:
                rollup === "parent" && cmdOpts.canonicalize === false
                  ? [
                      "--rollup parent was ignored: folding sub-brands into a parent needs canonicalization, which --no-canonicalize turned off.",
                    ]
                  : [],
              empty: "brands",
              emptyHint:
                "Nothing was named in this window. Widen it with --from/--to (up to 90 days), drop --entity-type and --location, or check that the industry has run at all: model_count in `senso industries list`.",
              next:
                first?.brand_id === undefined
                  ? []
                  : [
                      {
                        why: "Everything about the top brand, without the fuzzy name match",
                        command: `senso industries brand-by-id ${industryId} ${first.brand_id}`,
                      },
                    ],
            });
          },
        ),
      ),
    {
      returns: [
        "totals.run_count / answered_count / brand_mention_total — the denominators. share_of_voice = brands[].mention_total ÷ totals.brand_mention_total; mention_rate = brands[].mentions_count ÷ totals.answered_count.",
        "window.from / to / days — the window actually applied, which is week-aligned and so may be wider than the dates you passed.",
        "brands[].brand_id — the stable id. Store this, not brand_key, and pass it to `industries brand-by-id`. Null when the registry has no row yet.",
        "brands[].mentions_count — answers that named the brand at least once.",
        "brands[].mention_total — occurrences: an answer naming the brand twice counts twice.",
        "brands[].mentions_rank — 1 is the most mentioned in the whole window, not on this page.",
        "brands[].average_position — the mean position when named; 1 is first, lower is better, 0 means never mentioned.",
        "brands[].entity_type — brand | regulator | publisher | government | generic_term | product_model | forum_social. Filter regulators out with --entity-type brand.",
        "brands[].surface_forms[] — the spellings merged into the row; present only in canonicalized responses.",
        "brands[].sentiment — the additive positive / neutral / negative split.",
        "brands[].mentions_rank_trend / mentions_count_trend / mentions_percent_trend — against the preceding equal-length window; null when the brand had no rows in it.",
        "total / limit / offset — the page window. total is every brand matching the filters before paging.",
      ],
      exitCodes: {
        ...idExits,
        2: `a date that is not YYYY-MM-DD, a window longer than ${String(MAX_WINDOW_DAYS)} days, an unknown --models or --entity-type value, --rollup that is not \`parent\`, or --limit outside 1-100`,
        3: "the organization does not have the GEO product",
        4: "no industry with this id or name is readable by your organization",
      },
      notes: [
        WINDOW_NOTE,
        "Counts, not rates: nothing here is a percentage. Every share is computed from `totals`, and `senso partner glossary` is the canonical definition of each one (partner key).",
        "--rollup parent needs canonicalization; passing it with --no-canonicalize is reported as a warning and changes nothing.",
      ],
      examples: [
        { command: 'senso industries brands "Airlines (Canada)"' },
        {
          comment: "One month, brands only, as a ranked table",
          command:
            "senso industries brands 5d6e7f80-9a0b-4c1d-8e2f-3a4b5c6d7e8f --from 2026-08-01 --to 2026-08-31 --entity-type brand --output table",
        },
        {
          comment: "Share of voice for the top brand",
          command:
            "senso industries brands 5d6e7f80-9a0b-4c1d-8e2f-3a4b5c6d7e8f --output json | jq '.data.brands[0].mention_total / .data.totals.brand_mention_total'",
        },
      ],
      seeAlso: [
        "senso industries brand",
        "senso industries brand-by-id",
        "senso industries domain",
        "senso analytics summary",
      ],
    },
  );

  describeCommand(
    addWindowOptions(
      industries
        .command("brand")
        .description(
          "Everything about one brand in an industry, with its spelling variants merged before any metric is computed. The match is FUZZY: read resolved.matched_on and resolved.match_confidence before trusting the numbers. A brand that was never named comes back as mentioned=false and exits 0 — an answer, not an error.",
        )
        .argument("<industry>", INDUSTRY_ARG)
        .argument(
          "<brandName>",
          'The brand as a person would write it, e.g. "Air Canada". Free text, fuzzy-matched — not a brand_id, which is what `industries brand-by-id` takes',
        ),
    ).action(
      runAction(
        program,
        async (ctx: Ctx, industry: string, brandName: string, cmdOpts: WindowFilters) => {
          const name = brandName.trim();
          if (name === "") {
            throw usageError("<brandName> is empty.", {
              field: "<brandName>",
              received: brandName,
              hint: 'Pass the brand as a person would write it, e.g. senso industries brand <industry> "Air Canada".',
            });
          }
          const params = windowParams(cmdOpts);
          const industryId = await resolveIndustryId(industry, ctx);
          let data: { mentioned?: boolean; resolved?: { brand_id?: string } };
          try {
            data = await apiRequest<{ mentioned?: boolean; resolved?: { brand_id?: string } }>({
              path: `/org/industries/${industryId}/brands/${encodeURIComponent(name)}`,
              params,
              resource: industryResource(industryId),
              apiKey: ctx.apiKey,
              baseUrl: ctx.baseUrl,
            });
          } catch (err) {
            throw refine(err, [GEO_RULE]);
          }
          const brandId = data.resolved?.brand_id;
          emit(ctx, data, {
            warnings:
              data.mentioned === false
                ? [
                    `"${name}" was not named in this industry over the window. That is an answer, not an error: metrics is null and the exit code is 0. Check the spelling against \`senso industries brands ${industryId}\`, or widen --from/--to.`,
                  ]
                : [],
            next:
              brandId === undefined
                ? []
                : [
                    {
                      why: "Repeat this lookup without the fuzzy match, and without minting a registry row",
                      command: `senso industries brand-by-id ${industryId} ${brandId}`,
                    },
                  ],
          });
        },
      ),
    ),
    {
      returns: BRAND_RETURNS,
      exitCodes: {
        ...idExits,
        2: `<brandName> is empty, a date is not YYYY-MM-DD, the window is longer than ${String(MAX_WINDOW_DAYS)} days, or --models names an unknown model`,
        3: "the organization does not have the GEO product",
        4: "no industry with this id or name is readable by your organization",
      },
      notes: [
        "SIDE EFFECT on a read: a brand name Senso has never seen is added to the brand registry on first lookup, which includes a model call to generate its alias spellings. Use `industries brand-by-id` for repeat lookups.",
        "mentioned=false is a valid answer and exits 0. Nothing about it is a failure.",
        WINDOW_NOTE,
      ],
      examples: [
        { command: 'senso industries brand "Airlines (Canada)" "Air Canada"' },
        {
          comment: "Capture the stable id for later calls",
          command:
            'senso industries brand 5d6e7f80-9a0b-4c1d-8e2f-3a4b5c6d7e8f "Air Canada" --output json | jq -r .data.resolved.brand_id',
        },
        {
          comment: "Check the fuzzy match landed on the right brand",
          command:
            'senso industries brand 5d6e7f80-9a0b-4c1d-8e2f-3a4b5c6d7e8f "Air Canada" --output json | jq \'.data.resolved | {matched_on, match_confidence, surface_forms}\'',
        },
      ],
      seeAlso: ["senso industries brand-by-id", "senso industries brands", "senso industries domain"],
    },
  );

  describeCommand(
    addWindowOptions(
      industries
        .command("brand-by-id")
        .description(
          "The repeatable form of `industries brand`: the same payload addressed by the stable brand_id, with no fuzzy match and no registry write.",
        )
        .argument("<industry>", INDUSTRY_ARG)
        .argument(
          "<brandId>",
          "A brand_id UUID — brands[].brand_id from `industries brands`, or resolved.brand_id from `industries brand`. NOT brand_key (\"air-canada\"), which is a display artifact",
        ),
    ).action(
      runAction(
        program,
        async (ctx: Ctx, industry: string, brandIdArg: string, cmdOpts: WindowFilters) => {
          const brandId = parseId(brandIdArg, { label: "<brandId>", ...BRAND });
          const params = windowParams(cmdOpts);
          const industryId = await resolveIndustryId(industry, ctx);
          let data: { mentioned?: boolean; resolved?: { brand_id?: string } };
          try {
            data = await apiRequest<{ mentioned?: boolean; resolved?: { brand_id?: string } }>({
              path: `/org/industries/${industryId}/brands-by-id/${encodeURIComponent(brandId)}`,
              params,
              // One 404 covers both ids — the API will not say which — so the
              // error names both rather than implying it knows.
              resource: {
                type: "Industry or brand",
                id: `${industryId} / ${brandId}`,
                idField: "brand_id",
                list: `senso industries brands ${industryId}`,
              },
              apiKey: ctx.apiKey,
              baseUrl: ctx.baseUrl,
            });
          } catch (err) {
            throw refine(err, [GEO_RULE]);
          }
          const survivor = data.resolved?.brand_id;
          emit(ctx, data, {
            warnings: [
              ...(data.mentioned === false
                ? [
                    "This brand exists but was not named in this industry over the window. That is an answer, not an error: metrics is null and the exit code is 0.",
                  ]
                : []),
              ...(survivor !== undefined && survivor.toLowerCase() !== brandId.toLowerCase()
                ? [
                    `This brand_id was merged into ${survivor}. The payload is the SURVIVOR's — store resolved.brand_id and use that from now on.`,
                  ]
                : []),
            ],
            next: [
              {
                why: "See where this brand sits against the rest of the industry",
                command: `senso industries brands ${industryId}`,
              },
            ],
          });
        },
      ),
    ),
    {
      returns: [
        ...BRAND_RETURNS,
        "resolved.brand_id can differ from the id you passed: a brand merged into another returns the SURVIVOR's data and id. Write it back after every call.",
      ],
      exitCodes: {
        ...idExits,
        2: `<brandId> is not a UUID, a date is not YYYY-MM-DD, the window is longer than ${String(MAX_WINDOW_DAYS)} days, or --models names an unknown model`,
        3: "the organization does not have the GEO product",
        4: "the industry is not readable by your organization, or no brand was ever issued this id — the API does not say which",
      },
      notes: [
        "No registry write and no model call, unlike `industries brand` — this is the call to make repeatedly.",
        "Self-healing: a brand_id that was merged away still answers 200, with the survivor's numbers and the survivor's id.",
        WINDOW_NOTE,
      ],
      examples: [
        {
          command:
            "senso industries brand-by-id 5d6e7f80-9a0b-4c1d-8e2f-3a4b5c6d7e8f 9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d",
        },
        {
          comment: "Where the brand ranks",
          command:
            "senso industries brand-by-id 5d6e7f80-9a0b-4c1d-8e2f-3a4b5c6d7e8f 9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d --output json | jq -r .data.metrics.rank_in_industry",
        },
      ],
      seeAlso: ["senso industries brand", "senso industries brands"],
    },
  );

  describeCommand(
    addWindowOptions(
      industries
        .command("domain")
        .description(
          "How often one domain — or one URL — was cited in an industry's AI answers over the window, and which brands were named alongside it. A domain that was never cited comes back as cited=false and exits 0: an answer, not an error.",
        )
        .argument("<industry>", INDUSTRY_ARG)
        .argument(
          "<domain>",
          "A bare hostname, e.g. aircanada.com. Matched as eTLD+1, so www.aircanada.com and aircanada.com are the same row. IGNORED when --url is given, though the API still requires the path segment",
        ),
    )
      .option(
        "--url <url>",
        "Look up this full URL INSTEAD of <domain>. It replaces the argument entirely; <domain> is still required because the API path needs a segment, but its value is discarded",
      )
      .action(
        runAction(
          program,
          async (
            ctx: Ctx,
            industry: string,
            domain: string,
            cmdOpts: WindowFilters & { url?: string },
          ) => {
            const host = domain.trim();
            if (host === "") {
              throw usageError("<domain> is empty.", {
                field: "<domain>",
                received: domain,
                hint: "Pass a bare hostname, e.g. senso industries domain <industry> aircanada.com.",
              });
            }
            const params = windowParams(cmdOpts);
            const industryId = await resolveIndustryId(industry, ctx);
            let data: { cited?: boolean };
            try {
              data = await apiRequest<{ cited?: boolean }>({
                path: `/org/industries/${industryId}/domains/${encodeURIComponent(host)}`,
                params: { ...params, url: cmdOpts.url },
                resource: industryResource(industryId),
                apiKey: ctx.apiKey,
                baseUrl: ctx.baseUrl,
              });
            } catch (err) {
              throw refine(err, [GEO_RULE]);
            }
            emit(ctx, data, {
              warnings: [
                ...(cmdOpts.url === undefined
                  ? []
                  : [
                      `--url replaced <domain>: this reports on ${cmdOpts.url}, not on ${host}.`,
                    ]),
                ...(data.cited === false
                  ? [
                      `${cmdOpts.url ?? host} was not cited in this industry over the window. That is an answer, not an error. Widen --from/--to, or see which domains were cited with \`senso industries brands ${industryId}\` (top_cited_domain per brand).`,
                    ]
                  : []),
              ],
              next: [
                {
                  why: "The brands whose answers carry these citations",
                  command: `senso industries brands ${industryId}`,
                },
              ],
            });
          },
        ),
      ),
    {
      returns: [
        "resolved.domain — the eTLD+1 form that was matched; resolved.host — what you asked for.",
        "resolved.ownership — official | external | unknown: official is a registry-verified brand domain, external is somebody else's, unknown is unclassified.",
        "resolved.owned_by_brand — set only when ownership is official.",
        "cited — true | false. false means never cited in this industry and window; citation_references is then 0 and the exit code is still 0.",
        "citation_references — OCCURRENCES, not unique pages and not the number of answers carrying a citation. It differs from an answer count by an order of magnitude.",
        "rank_in_industry — 1 is the most-cited domain in the window.",
        "share_of_citations — {value, display}: this domain's share of all citation references.",
        "co_mentioned_brands[] — brands named in the same answers, with a cooccurrence count each.",
        "data_quality.level — low | medium | high, with reasons[].",
        "definitions — what each metric measured.",
      ],
      exitCodes: {
        ...idExits,
        2: `<domain> is empty, a date is not YYYY-MM-DD, the window is longer than ${String(MAX_WINDOW_DAYS)} days, or --models names an unknown model`,
        3: "the organization does not have the GEO product",
        4: "no industry with this id or name is readable by your organization",
      },
      notes: [
        "--url REPLACES <domain> rather than refining it. Passing both is reported as a warning, because the answer is about the URL and nothing in the payload says which one you meant.",
        "There is no org-key command that lists an industry's cited domains; the nearest thing is top_cited_domain per brand in `senso industries brands`.",
        WINDOW_NOTE,
      ],
      examples: [
        { command: 'senso industries domain "Airlines (Canada)" aircanada.com' },
        {
          comment: "One URL, not the whole domain",
          command:
            "senso industries domain 5d6e7f80-9a0b-4c1d-8e2f-3a4b5c6d7e8f aircanada.com --url https://aircanada.com/aeroplan --output json | jq -r .data.citation_references",
        },
      ],
      seeAlso: ["senso industries brands", "senso analytics citations", "senso analytics domains"],
    },
  );

  describeCommand(
    industries
      .command("import-prompts")
      .description(
        "Copy prompts from YOUR OWN industry into your organization and start importing the run history already collected for them. THIS ACTIVATES THE ORGANIZATION: scheduled runs start, for these prompts and for any prompt already saved but not yet running, and an organization with no models, schedule or locations of its own has defaults written for it. There is no dry run. Only your own industry is accepted — any other is a 403. Prompts whose text you already hold are skipped, so re-running is safe.",
      )
      .argument(
        "<industry>",
        "Your organization's OWN industry: the industry_id `senso org get` reports. A name is accepted and resolved against the public catalog, but it must still resolve to your own industry",
      )
      .requiredOption(
        "--prompt-ids <ids>",
        "Comma-separated INDUSTRY prompt ids, 1-100, no duplicates — the `id` values of `senso industries prompts <industry>`, not geo_question_ids",
      )
      .action(
        runAction(program, async (ctx: Ctx, industry: string, cmdOpts: { promptIds: string }) => {
          const ids = cmdOpts.promptIds
            .split(",")
            .map((p) => p.trim())
            .filter((p) => p.length > 0);

          // Checked here because the API rejects the whole request on any bad id
          // and changes nothing — a round trip to learn about a typo, and for a
          // duplicate, a 400 that names ids the caller has to go match up by hand.
          if (ids.length === 0) {
            throw usageError("Invalid --prompt-ids: no ids given.", {
              field: "--prompt-ids",
              received: cmdOpts.promptIds,
              hint: "Pass 1 to 100 industry prompt ids, comma separated, from `senso industries prompts <industry>`.",
            });
          }
          if (ids.length > 100) {
            throw usageError(
              `Invalid --prompt-ids: ${ids.length.toString()} ids given, the maximum is 100.`,
              {
                field: "--prompt-ids",
                received: `${ids.length.toString()} ids`,
                hint: "Split them across several calls; this command is safe to re-run, because prompts you already hold are skipped.",
              },
            );
          }
          parseIdList(ids, { label: "--prompt-ids", ...INDUSTRY_PROMPT });
          const seen = new Set<string>();
          for (const id of ids) {
            if (seen.has(id.toLowerCase())) {
              throw usageError(`Invalid --prompt-ids: "${id}" appears more than once.`, {
                field: "--prompt-ids",
                received: id,
                hint: "The API rejects the whole request on a duplicate. Send each id once.",
              });
            }
            seen.add(id.toLowerCase());
          }

          const industryId = await resolveIndustryId(industry, ctx);
          let data: ImportResponse;
          try {
            data = await apiRequest<ImportResponse>({
              method: "POST",
              path: `/org/industries/${industryId}/prompts/import`,
              body: { prompt_ids: ids },
              resource: industryResource(industryId),
              apiKey: ctx.apiKey,
              baseUrl: ctx.baseUrl,
            });
          } catch (err) {
            throw refine(err, [
              {
                match: /does not match the organization/i,
                hint: `This is not your organization's industry, and only your own can be imported from. \`senso org get\` reports your industry_id; \`senso org set-industry <industry_id>\` sets it, once.`,
              },
              {
                match: /no industry set/i,
                hint: "Pick one from `senso industries list` and run `senso org set-industry <industry_id>` first — it can be done only once.",
              },
              GEO_RULE,
              {
                match: /inactive|empty text|exceeds 255|identical text/i,
                hint: `Only active prompts can be copied. List the ids this accepts with: senso industries prompts ${industryId}`,
              },
            ]);
          }

          const importId = data.history_import?.import_id;
          const skippedHistory = data.history_import?.status === "skipped";
          if (!ctx.quiet) {
            log.success(
              `Imported ${String(data.created ?? 0)} prompt(s); ${String(data.skipped ?? 0)} already present.`,
            );
          }
          emit(ctx, data, {
            ...outcomeTable(ctx, data),
            warnings: [
              ...((data.skipped ?? 0) > 0
                ? [
                    `${String(data.skipped ?? 0)} prompt(s) were skipped because your organization already holds prompts with that text; outcomes[].reason says so per prompt.`,
                  ]
                : []),
              ...(skippedHistory
                ? [
                    `No history import started: ${data.history_import?.reason ?? "the scheduler did not accept it"}. The prompts themselves ARE copied — re-run this same command to retry the history import.`,
                  ]
                : []),
              ...((data.defaults_seeded?.models ?? []).length > 0 ||
              (data.defaults_seeded?.locations ?? []).length > 0 ||
              (data.defaults_seeded?.schedule_dows ?? []).length > 0
                ? [
                    "Activation wrote run defaults onto this organization because it had none; defaults_seeded lists the models, schedule days and locations it chose. Change them with `senso run-config`.",
                  ]
                : []),
            ],
            next: importSteps(importId, skippedHistory),
          });
        }),
      ),
    {
      returns: [
        "created / skipped — counts that sum to the number of ids sent.",
        "outcomes[] — one per requested id, in request order.",
        "outcomes[].status — created | skipped: created means a new org prompt was made, skipped means you already hold a prompt with that text.",
        "outcomes[].geo_question_id — the ORG prompt id this industry prompt now corresponds to. THIS is what `senso prompts` takes.",
        "outcomes[].reason — set only when skipped.",
        "defaults_seeded.models / schedule_dows / locations — what activation had to write onto the organization because it had none. Empty arrays mean it was already configured.",
        "history_import.status — queued | already_running | skipped:",
        "  queued           a new background import started; import_id is set.",
        "  already_running  one was already in flight; import_id is that job.",
        "  skipped          none started and import_id is NULL. The prompts are still copied; re-run this command to retry.",
        "history_import.import_id — pass it to `senso history-imports get`. Null when status is skipped.",
        "history_import.days — how many days of history are being copied.",
      ],
      exitCodes: {
        ...idExits,
        1: "the API refused: an id is not an active prompt of this industry, two share identical text, or a prompt's text is empty or over 255 characters",
        2: "--prompt-ids is empty, holds more than 100 ids, contains something that is not a UUID, or repeats one",
        3: "the organization has no industry set, <industry> is not its industry, the key lacks update:prompt, or the organization does not have the GEO product",
        4: "the organization record was not found",
      },
      notes: [
        "Activation is the part to be sure about: scheduled runs start for every prompt the organization holds, not only the ones imported here, and runs are billed.",
        "The history import is asynchronous. This returns as soon as it is queued — poll `senso history-imports get <import_id>`, and do not treat status=completed alone as success: a completed import may have copied nothing.",
        "A foreign, unknown or private industry all return the same 403, deliberately: nothing about another organization's industry is disclosed.",
      ],
      examples: [
        {
          comment: "Your own industry, from the organization record",
          command:
            "senso industries import-prompts \"$(senso org get --output json | jq -r .data.industry_id)\" --prompt-ids 3f2a8d10-61b4-4b0e-9a55-8c0d2e4f6a91",
        },
        {
          comment: "Capture the job to poll",
          command:
            "senso industries import-prompts 5d6e7f80-9a0b-4c1d-8e2f-3a4b5c6d7e8f --prompt-ids 3f2a8d10-61b4-4b0e-9a55-8c0d2e4f6a91 --output json | jq -r .data.history_import.import_id",
        },
      ],
      seeAlso: [
        "senso industries prompts",
        "senso org set-industry",
        "senso org get",
        "senso history-imports get",
        "senso prompts list",
      ],
    },
  );
}

/** As much of the import response as the rendering below needs. */
interface ImportResponse {
  created?: number;
  skipped?: number;
  outcomes?: {
    industry_prompt_id?: string;
    status?: string;
    geo_question_id?: string | null;
    reason?: string | null;
  }[];
  defaults_seeded?: { models?: string[]; schedule_dows?: number[]; locations?: string[] };
  history_import?: { status?: string; import_id?: string | null; days?: number; reason?: string | null };
}

/**
 * The per-prompt outcomes as a table, and only for `table`.
 *
 * `plain` must keep the whole payload: history_import and defaults_seeded are
 * the two things a caller acts on next, and passing rows here would render the
 * outcomes alone and drop both. The generic renderer cannot classify this
 * payload as a list — `outcomes` travels with counts and two objects — so
 * `plain` falls through to the key/value rendering, which shows all of it.
 */
function outcomeTable(ctx: OutputContext, data: ImportResponse): EmitOptions {
  if (ctx.format !== "table") return {};
  return {
    table: {
      rows: (data.outcomes ?? []).map((o) => ({
        industry_prompt_id: o.industry_prompt_id,
        status: o.status,
        geo_question_id: o.geo_question_id ?? "",
        reason: o.reason ?? "",
      })),
      columns: ["industry_prompt_id", "status", "geo_question_id", "reason"],
    },
  };
}

/** What to do next about the background history import this call started. */
function importSteps(importId: string | null | undefined, skipped: boolean): NextStep[] {
  if (typeof importId === "string" && importId !== "") {
    return [
      {
        why: "Poll the history import until status is completed AND historic_runs_imported is above 0",
        command: `senso history-imports get ${importId}`,
      },
      { why: "See the org prompts this created", command: "senso prompts list" },
    ];
  }
  if (skipped) {
    return [
      {
        why: "No history import started — re-run the same import to retry it; the prompts are already copied",
        command: "senso history-imports list",
      },
      { why: "See the org prompts this created", command: "senso prompts list" },
    ];
  }
  return [{ why: "See the org prompts this created", command: "senso prompts list" }];
}
