import { Command } from "commander";
import { ApiError, apiRequest } from "../lib/api-client.js";
import { parseIntFlag } from "../lib/enum-arg.js";
import { CliError, EXIT, toCliError, usageError } from "../lib/errors.js";
import { apiExits, describeCommand, idExits } from "../lib/help.js";
import { isUuid } from "../lib/id-arg.js";
import { emit } from "../lib/output.js";
import { runAction, type Ctx } from "../lib/run-action.js";
import {
  addWindowOptions,
  MAX_WINDOW_DAYS,
  windowParams,
  type WindowFilters,
} from "./industries.js";
import * as log from "../utils/logger.js";

/**
 * Every command in this group calls a /partner/* route. Those routes are gated
 * by partner authentication in senso-api, so the organization API key that
 * `senso login` stores is rejected — and the generic handler would tell the
 * user to log in again, which never fixes it.
 *
 * The exact answer matters, because the two statuses mean different things:
 * an API-key caller with an organization key gets 401 "Authentication
 * required" from RequirePartnerAuth (it is neither a Clerk JWT nor a partner
 * key), while the 403 "Partner access required" belongs to a valid JWT whose
 * user has no partner. Both are exit 3; only the first is what an org key sees.
 */
function partnerError(err: unknown): CliError {
  if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
    return new CliError(
      `This /partner/* route was rejected by the Senso API's partner authentication (HTTP ${String(err.status)}: ${err.message}). The organization key stored by \`senso login\` is not a partner key, and logging in again will not change that. Most of this data is readable with an organization key: \`senso industries\` covers the catalog, brand leaderboards and domain citations, and \`senso analytics\` covers your own organization.`,
      EXIT.AUTH,
      {
        code: err.status === 401 ? "unauthorized" : "forbidden",
        status: err.status,
        // Exactly one hint, and it is runnable. The alternatives are in the
        // message above, where they do not compete with the thing to type.
        hint: "Retry with a partner key: add `--api-key <partner-key>`, or export SENSO_API_KEY=<partner-key>. The CLI never stores a partner key.",
        cause: err,
      },
    );
  }
  return toCliError(err);
}

/**
 * `runAction`, plus the partner-auth translation above.
 *
 * The whole group needs the same treatment, so the narrow catch lives here once
 * rather than in each of the six actions.
 */
function runPartnerAction<Args extends unknown[]>(
  program: Command,
  handler: (ctx: Ctx, ...args: Args) => Promise<void>,
): (...args: Args) => Promise<void> {
  return runAction(program, async (ctx: Ctx, ...args: Args) => {
    try {
      await handler(ctx, ...args);
    } catch (err) {
      throw partnerError(err);
    }
  });
}

/**
 * Resolve an `<industry>` argument that may be a UUID or a human-typed name.
 *
 * The partner twin of `resolveIndustryId` in industries.ts, searching
 * /partner/industries rather than the public catalog — a partner sees the
 * industries it owns plus the ones it subscribes to, which is a different set.
 * A name takes the FIRST search match, so an ambiguous name resolves silently.
 */
async function resolveIndustryId(
  industry: string,
  opts: { apiKey?: string; baseUrl?: string },
): Promise<string> {
  if (isUuid(industry)) return industry.trim();

  const name = industry.trim();
  if (name === "") {
    throw usageError("<industry> is empty.", {
      field: "<industry>",
      received: industry,
      hint: "Pass an industry_id UUID or a name, e.g. `senso partner industries summary Automotive`.",
    });
  }

  const data = await apiRequest<{
    industries?: { industry_id?: string; name?: string }[];
  }>({
    path: "/partner/industries",
    params: { search: name },
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
  });

  const match = data.industries?.[0];
  if (!match?.industry_id) {
    throw new CliError(`No industry this partner key can see matches "${industry}".`, EXIT.NOT_FOUND, {
      code: "not_found",
      field: "<industry>",
      received: industry,
      hint: "List them with `senso partner industries list`, or pass an industry_id UUID.",
    });
  }
  return match.industry_id;
}

/** Said in every leaf command's help, because every one of them needs it. */
const PARTNER_KEY_NOTE =
  "REQUIRES A PARTNER API KEY. An organization key — the one `senso login` stores — is answered with HTTP 401 “Authentication required” by the partner auth middleware, and logging in again cannot fix it. Pass a partner key with `--api-key <partner-key>` or SENSO_API_KEY. For the same data under an organization key, use `senso industries`; for your own organization's metrics, `senso analytics`.";

/** What `<industry>` accepts, in the words every command in this group uses. */
const INDUSTRY_ARG =
  'An industry_id UUID from `senso partner industries list`, or an industry name such as "Automotive". A name costs one extra lookup and resolves to the FIRST search match, so pass the UUID when more than one industry shares a word';

/** The window contract, repeated wherever the window flags are accepted. */
const WINDOW_NOTE = `--from and --to are YYYY-MM-DD (\`senso evals\` takes RFC 3339 instants instead), inclusive, defaulting to the last 30 days, and the span may not exceed ${String(MAX_WINDOW_DAYS)} days. --models takes the ids listed by \`senso analytics filters\`.`;

/** Exit 3 means one thing on every command here. */
const partnerExits = {
  3: "the key is not a partner key — an organization key is answered with 401 by the partner auth middleware",
};

export function registerPartnerCommands(program: Command): void {
  const partner = program
    .command("partner")
    .description(
      "Partner-network commands. REQUIRES A PARTNER API KEY: every command here reads a /partner/* endpoint, and the organization key stored by `senso login` gets HTTP 401 “Authentication required” from the partner auth middleware — running `senso login` again will not help. Pass a partner key per command with `--api-key <partner-key>` or SENSO_API_KEY; the CLI never stores one. Under an organization key instead: `partner industries list` → `senso industries list`, `partner industries brand` → `senso industries brand`, `partner industries domain` → `senso industries domain`, and the brand leaderboard is `senso industries brands`, which has no partner equivalent here. `partner industries summary`, `partner industries prompt-metrics` and `partner glossary` have no organization-key equivalent. For metrics about your own organization, use `senso analytics`.",
    );

  const industries = partner
    .command("industries")
    .description(
      'Industry-level competitive intelligence for a partner — share-of-voice, domain citations and per-prompt metrics. Requires a partner API key. `list` returns the industries this partner OWNS plus the public ones it SUBSCRIBES to; the reads are gated only on the industry existing, so an industry_id obtained elsewhere also works even though `list` does not show it. The <industry> argument takes a UUID or a name (e.g. "Automotive"), and a name takes the first search match. There is no brand-leaderboard command here: that is `senso industries brands`, under an organization key.',
    );

  describeCommand(
    industries
      .command("list")
      .description(
        "List the industries this partner key can act on: the industries the partner owns, plus the public industries it subscribes to.",
      )
      .option("--search <q>", "Case-insensitive filter by industry name")
      .option(
        "--limit <n>",
        "Page size, 1-100. The API defaults to 10 and silently ignores a value it cannot use, so pass this whenever you want more than 10",
      )
      .option("--offset <n>", "Industries to skip (default 0)")
      .action(
        runPartnerAction(
          program,
          async (ctx, cmdOpts: { search?: string; limit?: string; offset?: string }) => {
            const limit = parseIntFlag("--limit", cmdOpts.limit, { min: 1, max: 100 });
            const offset = parseIntFlag("--offset", cmdOpts.offset, { min: 0 });
            const data = await apiRequest<{ industries?: { industry_id?: string }[] }>({
              path: "/partner/industries",
              params: {
                search: cmdOpts.search,
                limit: limit?.toString(),
                offset: offset?.toString(),
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
                "relationship",
                "active_prompt_count",
                "model_count",
                "location_count",
              ],
              empty: "industries",
              emptyHint:
                "This partner owns no industries and subscribes to none, or --search matched nothing. Drop --search to see the whole set.",
              next:
                first?.industry_id === undefined
                  ? []
                  : [
                      {
                        why: "Read one industry's headline numbers",
                        command: `senso partner industries summary ${first.industry_id}`,
                      },
                    ],
            });
          },
        ),
      ),
    {
      returns: [
        "industries[].industry_id — the <industry> argument for every other command here, and for `senso industries` under an organization key.",
        "industries[].relationship — owned | subscribed: owned means this partner owns it and may edit it; subscribed is a public industry it subscribes to, read-only.",
        "industries[].editable — true only when relationship is owned.",
        "industries[].is_public — true when the industry has no owning partner.",
        "industries[].enable_runs — false means the industry's runs are paused, so no new data is arriving.",
        "industries[].active_prompt_count — active prompts. 0 means nothing is being asked.",
        "industries[].model_count — opted-in models. 0 means the industry has never run.",
        "industries[].location_count — countries it runs in; the values --location takes on the reads below.",
        "total / limit / offset — the page window. total counts every matching industry, not just this page.",
      ],
      exitCodes: { ...apiExits, 2: "--limit is outside 1-100, or --offset is negative", ...partnerExits },
      notes: [
        PARTNER_KEY_NOTE,
        "The API defaults to 10 rows here, where `senso industries list` defaults to 50. Pass --limit explicitly, and page with --offset: `total` will tell you how many were left behind.",
      ],
      examples: [
        { command: "senso partner industries list --api-key $SENSO_PARTNER_KEY" },
        {
          comment: "Only the industries this partner owns",
          command:
            "senso partner industries list --limit 100 --output json | jq -r '.data.industries[] | select(.relationship==\"owned\") | .industry_id'",
        },
      ],
      seeAlso: [
        "senso partner industries summary",
        "senso partner industries prompt-metrics",
        "senso industries list",
      ],
    },
  );

  describeCommand(
    addWindowOptions(
      industries
        .command("summary")
        .description(
          "One-call overview of an industry: how many answers were analyzed, the single most-mentioned brand, and the citation split between official brand domains and everything else.",
        )
        .argument("<industry>", INDUSTRY_ARG),
    ).action(
      runPartnerAction(program, async (ctx, industry: string, cmdOpts: WindowFilters) => {
        const params = windowParams(cmdOpts);
        const industryId = await resolveIndustryId(industry, ctx);
        const data = await apiRequest<{
          citation_summary?: { official_brand_domain_share?: unknown };
        }>({
          path: `/partner/industries/${industryId}/summary`,
          params,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data, {
          warnings:
            data.citation_summary?.official_brand_domain_share === null
              ? [
                  "official_brand_domain_share is null, not 0%: the official-domain registry has not been seeded for this industry, so the owned-vs-external split cannot be computed.",
                ]
              : [],
          next: [
            {
              why: "Per-prompt detail behind these totals",
              command: `senso partner industries prompt-metrics ${industryId}`,
            },
            { why: "What each metric above actually measured", command: "senso partner glossary" },
          ],
        });
      }),
    ),
    {
      returns: [
        "industry_id / industry_name — the industry this is about.",
        "window.from / to / days — the window actually applied, which is week-aligned.",
        "answers_analyzed — answers in the window.",
        "top_brand — ONE brand, not a list: brand_id, brand_name, mention_rate and entity_type. The full leaderboard is `senso industries brands` (organization key).",
        "citation_summary.citation_references — OCCURRENCES, not unique pages and not answers carrying a citation.",
        "citation_summary.unique_domains / official_brand_domain_citations / external_citations — the raw counts.",
        "citation_summary.official_brand_domain_share / external_share — {value, display}, or NULL when the industry's official-domain registry has no rows. null is not 0%.",
        "top_external_citers[] — the most-cited non-official domains, with a citation_references count each.",
        "prompts_by_stage — always null for now; the funnel-stage rollup has not shipped.",
        "data_quality.level — low | medium | high, with reasons[].",
        "definitions — the same content as `senso partner glossary`.",
      ],
      exitCodes: {
        ...idExits,
        2: `<industry> is empty, a date is not YYYY-MM-DD, the window is longer than ${String(MAX_WINDOW_DAYS)} days, or --models names an unknown model`,
        ...partnerExits,
        4: "no industry this key can see matches the name given",
      },
      notes: [PARTNER_KEY_NOTE, WINDOW_NOTE],
      examples: [
        { command: "senso partner industries summary Automotive --api-key $SENSO_PARTNER_KEY" },
        {
          comment: "One month, one metric",
          command:
            "senso partner industries summary 5d6e7f80-9a0b-4c1d-8e2f-3a4b5c6d7e8f --from 2026-08-01 --to 2026-08-31 --output json | jq -r .data.top_brand.brand_name",
        },
      ],
      seeAlso: [
        "senso partner glossary",
        "senso partner industries prompt-metrics",
        "senso industries brands",
      ],
    },
  );

  describeCommand(
    addWindowOptions(
      industries
        .command("brand")
        .description(
          "Everything about one brand within an industry, with its spelling variants merged before any metric is computed. The match is FUZZY: read resolved.matched_on and resolved.match_confidence before trusting the numbers. A brand that was never named comes back as mentioned=false and exits 0 — an answer, not an error.",
        )
        .argument("<industry>", INDUSTRY_ARG)
        .argument(
          "<brandName>",
          'The brand as a person would write it, e.g. "Toyota". Free text, fuzzy-matched — not a brand_id',
        ),
    ).action(
      runPartnerAction(
        program,
        async (ctx, industry: string, brandName: string, cmdOpts: WindowFilters) => {
          const name = brandName.trim();
          if (name === "") {
            throw usageError("<brandName> is empty.", {
              field: "<brandName>",
              received: brandName,
              hint: 'Pass the brand as a person would write it, e.g. senso partner industries brand <industry> "Toyota".',
            });
          }
          const params = windowParams(cmdOpts);
          const industryId = await resolveIndustryId(industry, ctx);
          const data = await apiRequest<{ mentioned?: boolean; resolved?: { brand_id?: string } }>({
            path: `/partner/industries/${industryId}/brands/${encodeURIComponent(name)}`,
            params,
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });
          emit(ctx, data, {
            warnings:
              data.mentioned === false
                ? [
                    `"${name}" was not named in this industry over the window. That is an answer, not an error: metrics is null and the exit code is 0. Check the spelling, or widen --from/--to.`,
                  ]
                : [],
            next: [
              {
                why: "The industry totals these numbers are a share of",
                command: `senso partner industries summary ${industryId}`,
              },
              { why: "What each metric above actually measured", command: "senso partner glossary" },
            ],
          });
        },
      ),
    ),
    {
      returns: [
        "resolved.brand_id — the stable id, identical for this brand in every industry and endpoint. Store this, not brand_key.",
        "resolved.matched_on — the spelling the fuzzy match hit; resolved.match_confidence — 0..1, low means it may be the wrong brand.",
        "resolved.surface_forms[] — every spelling merged into these numbers.",
        "mentioned — true | false. false means never named in this industry and window; metrics is then null.",
        "metrics.mention_rate — {value, display}: the share of ANSWERED runs naming the brand. The denominator is the whole INDUSTRY prompt set, so it is not comparable with an organization dashboard's mention_rate.",
        "metrics.share_of_voice — this brand's share of all brand-mention occurrences.",
        "metrics.avg_position — the mean position when named; 1 is first and lower is better.",
        "metrics.rank_in_industry — out of metrics.brands_ranked.",
        "metrics.owned_citation_share — null until the industry's official-domain registry is seeded. null is not 0%.",
        "by_model[] — the same mention_rate per model.",
        "by_stage — always null for now.",
        "data_quality.level — low | medium | high, with reasons[].",
      ],
      exitCodes: {
        ...idExits,
        2: `<brandName> is empty, a date is not YYYY-MM-DD, the window is longer than ${String(MAX_WINDOW_DAYS)} days, or --models names an unknown model`,
        ...partnerExits,
        4: "no industry this key can see matches the name given",
      },
      notes: [
        PARTNER_KEY_NOTE,
        "SIDE EFFECT on a read: a brand name Senso has never seen is added to the brand registry on first lookup, which includes a model call to generate its alias spellings.",
        "This group has no brand-by-id command. The repeatable, no-write form is `senso industries brand-by-id`, under an organization key.",
        WINDOW_NOTE,
      ],
      examples: [
        { command: "senso partner industries brand Automotive Toyota --api-key $SENSO_PARTNER_KEY" },
        {
          comment: "Where the brand ranks in its industry",
          command:
            "senso partner industries brand 5d6e7f80-9a0b-4c1d-8e2f-3a4b5c6d7e8f Toyota --output json | jq -r .data.metrics.rank_in_industry",
        },
      ],
      seeAlso: [
        "senso partner industries summary",
        "senso partner glossary",
        "senso industries brand",
      ],
    },
  );

  describeCommand(
    addWindowOptions(
      industries
        .command("domain")
        .description(
          "How often one domain — or one URL — was cited in an industry's AI answers over the window, and which brands were named alongside it. A domain that was never cited comes back as cited=false and exits 0.",
        )
        .argument("<industry>", INDUSTRY_ARG)
        .argument(
          "<domain>",
          "A bare hostname, e.g. toyota.com. Matched as eTLD+1, so www.toyota.com and toyota.com are the same row. Pass --url for a full URL: a URL given HERE is treated as a domain string and will not match",
        ),
    )
      .option(
        "--url <url>",
        "Look up this full URL INSTEAD of <domain>. It replaces the argument entirely; <domain> is still required because the API path needs a segment, but its value is discarded",
      )
      .action(
        runPartnerAction(
          program,
          async (
            ctx,
            industry: string,
            domain: string,
            cmdOpts: WindowFilters & { url?: string },
          ) => {
            const host = domain.trim();
            if (host === "") {
              throw usageError("<domain> is empty.", {
                field: "<domain>",
                received: domain,
                hint: "Pass a bare hostname, e.g. senso partner industries domain <industry> toyota.com.",
              });
            }
            const params = windowParams(cmdOpts);
            const industryId = await resolveIndustryId(industry, ctx);
            const data = await apiRequest<{ cited?: boolean }>({
              path: `/partner/industries/${industryId}/domains/${encodeURIComponent(host)}`,
              params: { ...params, url: cmdOpts.url },
              apiKey: ctx.apiKey,
              baseUrl: ctx.baseUrl,
            });
            emit(ctx, data, {
              warnings: [
                ...(cmdOpts.url === undefined
                  ? []
                  : [`--url replaced <domain>: this reports on ${cmdOpts.url}, not on ${host}.`]),
                ...(data.cited === false
                  ? [
                      `${cmdOpts.url ?? host} was not cited in this industry over the window. That is an answer, not an error. Widen --from/--to, or see the most-cited domains in \`senso partner industries summary ${industryId}\` (top_external_citers).`,
                    ]
                  : []),
              ],
              next: [
                {
                  why: "The domains that WERE cited, as the industry's top external citers",
                  command: `senso partner industries summary ${industryId}`,
                },
              ],
            });
          },
        ),
      ),
    {
      returns: [
        "resolved.domain — the eTLD+1 form matched; resolved.host — what you asked for.",
        "resolved.ownership — official | external | unknown: official is a registry-verified brand domain, external is somebody else's, unknown is unclassified.",
        "resolved.owned_by_brand — set only when ownership is official.",
        "cited — true | false. false means never cited in this industry and window.",
        "citation_references — OCCURRENCES, not unique pages and not answers carrying a citation; the two differ by an order of magnitude.",
        "rank_in_industry — 1 is the most-cited domain in the window.",
        "share_of_citations — {value, display}: this domain's share of all citation references.",
        "co_mentioned_brands[] — brands named in the same answers, with a cooccurrence count each.",
        "data_quality.level — low | medium | high, with reasons[].",
      ],
      exitCodes: {
        ...idExits,
        2: `<domain> is empty, a date is not YYYY-MM-DD, the window is longer than ${String(MAX_WINDOW_DAYS)} days, or --models names an unknown model`,
        ...partnerExits,
        4: "no industry this key can see matches the name given",
      },
      notes: [
        PARTNER_KEY_NOTE,
        "--url REPLACES <domain> rather than refining it. Passing both is reported as a warning, because the answer is about the URL.",
        WINDOW_NOTE,
      ],
      examples: [
        {
          command:
            "senso partner industries domain Automotive toyota.com --api-key $SENSO_PARTNER_KEY",
        },
        {
          comment: "One URL rather than the whole domain",
          command:
            "senso partner industries domain 5d6e7f80-9a0b-4c1d-8e2f-3a4b5c6d7e8f toyota.com --url https://toyota.com/build --output json | jq -r .data.citation_references",
        },
      ],
      seeAlso: [
        "senso partner industries summary",
        "senso partner glossary",
        "senso industries domain",
      ],
    },
  );

  describeCommand(
    addWindowOptions(
      industries
        .command("prompt-metrics")
        .description(
          "Per-prompt metrics across a whole industry, with no single-organization overlay: for each tracked prompt, how every model answered it and the brands most named in those answers.",
        )
        .argument("<industry>", INDUSTRY_ARG),
    )
      .option("--limit <n>", "Page size, 1-100 (the API defaults to 100)")
      .option("--offset <n>", "Prompts to skip (default 0)")
      .action(
        runPartnerAction(
          program,
          async (ctx, industry: string, cmdOpts: WindowFilters & { limit?: string; offset?: string }) => {
            const limit = parseIntFlag("--limit", cmdOpts.limit, { min: 1, max: 100 });
            const offset = parseIntFlag("--offset", cmdOpts.offset, { min: 0 });
            const params = windowParams(cmdOpts);
            const industryId = await resolveIndustryId(industry, ctx);
            const data = await apiRequest<{
              window?: { from?: string; to?: string; days?: number };
              industry_prompts?: Record<string, unknown>[];
            }>({
              path: `/partner/industries/${industryId}/prompt-metrics`,
              params: { ...params, limit: limit?.toString(), offset: offset?.toString() },
              apiKey: ctx.apiKey,
              baseUrl: ctx.baseUrl,
            });
            const rows = data.industry_prompts ?? [];
            // `industry_prompts` travels beside `window`, which the shared
            // renderer cannot classify as pagination, so the rows are passed
            // explicitly and the window is reported as context on stderr.
            if (!ctx.quiet && data.window) {
              log.info(
                `Window: ${data.window.from ?? "?"} to ${data.window.to ?? "?"} (${String(data.window.days ?? "?")} days).`,
              );
            }
            emit(ctx, data, {
              rows,
              columns: [
                "industry_prompt_id",
                "industry_prompt",
                "funnel_stage",
                "persona",
                "category",
              ],
              warnings:
                rows.length === 0
                  ? [
                      "An empty list here does NOT mean the industry is wrong: this endpoint never returns 404, so an industry_id that does not exist answers with an empty list too. Confirm the id with `senso partner industries list`.",
                    ]
                  : [],
              empty: "industry prompts",
              emptyHint:
                "Either this industry ran no prompts in the window, or the industry_id does not exist — this endpoint does not 404. Widen --from/--to, and confirm the id with `senso partner industries list`.",
              next:
                rows.length === 0
                  ? []
                  : [
                      {
                        why: "The industry totals these prompts add up to",
                        command: `senso partner industries summary ${industryId}`,
                      },
                    ],
            });
          },
        ),
      ),
    {
      returns: [
        "industry_prompts[].industry_prompt_id — an INDUSTRY prompt id. Industry prompts are a separate table from organization prompts, so this is NOT a geo_question_id.",
        "industry_prompts[].industry_prompt — the prompt text.",
        "industry_prompts[].funnel_stage / persona / category — how the prompt is classified; empty strings when the scheduler never recorded them.",
        "industry_prompts[].models[] — per-model run and answer counts for this prompt.",
        "industry_prompts[].top_three_mentioned[] — the three brands most named in its answers.",
        "window.from / to / days — the window actually applied (reported on stderr in plain and table output).",
        "total / limit / offset — the page window. total is every active prompt in the industry before paging.",
      ],
      exitCodes: {
        ...apiExits,
        2: `a date is not YYYY-MM-DD, the window is longer than ${String(MAX_WINDOW_DAYS)} days, --models names an unknown model, --limit is outside 1-100, or --offset is negative`,
        ...partnerExits,
        4: "no industry this key can see matches the NAME given (an industry_id that does not exist returns an empty list, not a 404)",
      },
      notes: [
        PARTNER_KEY_NOTE,
        "This endpoint has no 404: a well-formed industry_id that belongs to nothing returns an empty list, indistinguishable from an industry with no prompts in the window. Confirm ids with `senso partner industries list`.",
        "No organization overlay: the counts are the industry's own. Metrics for one organization are `senso analytics`.",
        WINDOW_NOTE,
      ],
      examples: [
        {
          command: "senso partner industries prompt-metrics Automotive --api-key $SENSO_PARTNER_KEY",
        },
        {
          comment: "Prompt text and id, one per line",
          command:
            "senso partner industries prompt-metrics 5d6e7f80-9a0b-4c1d-8e2f-3a4b5c6d7e8f --limit 100 --output json | jq -r '.data.industry_prompts[] | \"\\(.industry_prompt_id)\\t\\(.industry_prompt)\"'",
        },
      ],
      seeAlso: [
        "senso partner industries summary",
        "senso industries prompts",
        "senso analytics prompts",
      ],
    },
  );

  describeCommand(
    partner
      .command("glossary")
      .description(
        "The canonical, citable definition of every competitive-intelligence metric these endpoints return — what it measures, what it divides by, and the way it is most often misread. Static content: it does not depend on your data.",
      )
      .action(
        runPartnerAction(program, async (ctx) => {
          const data = await apiRequest({
            path: "/partner/glossary",
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });
          emit(ctx, data, {
            columns: ["metric", "definition", "denominator", "gotcha"],
            // A table cell is truncated at 48 characters, and `gotcha` is the
            // longest and most load-bearing field in the payload.
            warnings:
              ctx.format === "table"
                ? [
                    "--output table truncates each cell at 48 characters, which cuts every definition and gotcha short. Use --output plain or --output json for this command.",
                  ]
                : [],
            next: [
              {
                why: "The metrics these definitions describe, for one industry",
                command: "senso partner industries summary <industry>",
              },
            ],
          });
        }),
      ),
    {
      returns: [
        "entries[] — eight metrics: mention_rate, share_of_voice, avg_position, rank_in_industry, official_brand_domain_share, owned_citation_share, citation_references, window.",
        "entries[].metric — the key exactly as it appears in the payloads.",
        "entries[].definition — what it measures.",
        "entries[].denominator — what it divides by; absent when the metric is not a rate.",
        "entries[].gotcha — the way the metric is most often misread. This is the field worth reading: mention_rate uses the BROAD industry prompt set as its denominator and is not comparable with an organization dashboard's, and official_brand_domain_share must never be estimated from a top-N domain list.",
      ],
      exitCodes: { ...apiExits, ...partnerExits },
      notes: [
        PARTNER_KEY_NOTE,
        "The same definitions apply to `senso industries` and to `senso analytics` output, but this endpoint is partner-only. Under an organization key, `senso analytics glossary` is the equivalent.",
        "Use --output plain or json: --output table truncates cells at 48 characters.",
      ],
      examples: [
        { command: "senso partner glossary --api-key $SENSO_PARTNER_KEY" },
        {
          comment: "One metric's gotcha",
          command:
            "senso partner glossary --output json | jq -r '.data.entries[] | select(.metric==\"mention_rate\") | .gotcha'",
        },
      ],
      seeAlso: [
        "senso partner industries summary",
        "senso analytics glossary",
        "senso industries brands",
      ],
    },
  );
}
