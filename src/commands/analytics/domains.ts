/**
 * `senso analytics domains` — the domain-grain cited-source table.
 *
 * Its own file, and the sibling of pages.ts: both read the cited-source
 * rollups, both drop `--tag` (see addWindowOptions), and both are large enough
 * that sharing a file would bury the difference between a domain row and a URL
 * row.
 */

import { Command } from "commander";
import pc from "picocolors";
import { apiRequest } from "../../lib/api-client.js";
import { emit } from "../../lib/output.js";
import { runAction, type Ctx } from "../../lib/run-action.js";
import { parseEnumFlag } from "../../lib/enum-arg.js";
import { apiExits, describeCommand } from "../../lib/help.js";
import {
  addPagingOptions,
  addWindowOptions,
  pagingParams,
  windowParams,
  type WindowFilters,
} from "./filters.js";
import {
  count,
  emitContext,
  emitNotes,
  position,
  qualityLine,
  rate,
  requireBlocks,
  windowLine,
} from "./render.js";
import type { AnalyticsWindow, CitedDomainItem, DataQuality, Denominators } from "./types.js";

// The values --tier and --sort accept, as their help text lists them. The
// cited-source rollups (domains, pages) offer the same two flags, but each
// declares its own options, so each checks its own.
const TIER_VALUES = ["primary", "tracked", "secondary"] as const;
const SORT_VALUES = ["citations", "coverage"] as const;

export function addDomainsCommand(analytics: Command, program: Command): void {
  // ── domains ──────────────────────────────────────────────────────────────
  describeCommand(
    addPagingOptions(
      addWindowOptions(
        analytics
          .command("domains")
          .description(
            "Every domain the models cited, ranked. Citation Coverage is this domain's cited answers ÷ D; Citation Share is its citation instances ÷ S. Tiers: primary (Owned) | tracked | secondary (External).",
          ),
        { tag: false },
      )
        .option("--tier <tier>", "Filter by tier: primary | tracked | secondary")
        .option("--domain-contains <text>", "Substring filter on the domain")
        .option("--sort <field>", "Sort by: citations | coverage (default: citations)"),
      50,
    ),
    {
      returns: [
        "denominators.cited_run_count — D, the answers that cited anything",
        "denominators.cited_total — S, the citation instances",
        "domains[].citation_coverage — this domain's cited answers ÷ D, as {value, display} or null when D is zero",
        "domains[].citation_share — this domain's citation instances ÷ S, as {value, display} or null when S is zero",
        "domains[].tier — primary | tracked | secondary, the API's value; tier_label is the same thing in product words (Owned | Tracked | External)",
        "domains[].avg_citation_rank — the average position the domain held in an answer's citation list; null when it was never cited",
        "domains[].rank_by_citations — global rank over the whole result set, so page two still shows real ranks",
        "total / limit / offset — the page; `page.next` in the JSON envelope is the runnable next call",
      ],
      exitCodes: {
        ...apiExits,
        2: "a date that is not YYYY-MM-DD, a window longer than 365 days, an unknown model or tier, or a --limit outside 1-100",
        3: "no key, the organization lacks the GEO product, or the key lacks read:prompt",
      },
      examples: [
        { comment: "Who the models cite most", command: "senso analytics domains" },
        {
          comment: "Only the sources you own",
          command: "senso analytics domains --tier primary --sort coverage",
        },
      ],
      seeAlso: ["senso analytics pages", "senso analytics citations", "senso analytics glossary"],
    },
  ).action(
    runAction(
      program,
      async (
        ctx: Ctx,
        cmdOpts: WindowFilters & {
          tier?: string;
          domainContains?: string;
          sort?: string;
          limit?: string;
          offset?: string;
        },
      ) => {
        const data = await apiRequest<{
          window: AnalyticsWindow;
          denominators: Denominators;
          total: number;
          limit: number;
          offset: number;
          domains: CitedDomainItem[];
          data_quality: DataQuality;
          notes: string[];
        }>({
          path: "/org/analytics/citations/domains",
          params: {
            ...windowParams(cmdOpts),
            tier: parseEnumFlag("--tier", cmdOpts.tier, TIER_VALUES),
            domain_contains: cmdOpts.domainContains,
            sort: parseEnumFlag("--sort", cmdOpts.sort, SORT_VALUES),
            ...pagingParams(cmdOpts),
          },
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });

        requireBlocks("/org/analytics/citations/domains", { denominators: data.denominators });

        const domains = data.domains ?? [];
        const context = [
          "",
          `  ${pc.bold("Cited domains")} ${pc.dim(`${domains.length} of ${count(data.total)} (offset ${count(data.offset)})`)}`,
          windowLine(data.window),
          qualityLine(data.data_quality),
          `  ${pc.dim(`D = ${count(data.denominators?.cited_run_count)} cited answers, S = ${count(data.denominators?.cited_total)} citation instances`)}`,
        ];
        emitContext(ctx, context);
        emit(ctx, data, {
          table: {
            rows: domains.map((d) => ({
              rank: d.rank_by_citations,
              domain: d.domain,
              tier: d.tier_label || d.tier,
              answers: count(d.cited_run_count),
              citations: count(d.cited_total),
              coverage: rate(d.citation_coverage),
              share: rate(d.citation_share),
              avg_pos: position(d.avg_citation_rank),
            })),
            columns: [
              "rank",
              "domain",
              "tier",
              "answers",
              "citations",
              "coverage",
              "share",
              "avg_pos",
            ],
          },
          empty: "cited domains",
          emptyHint:
            "No domain was cited in this window. Widen --from/--to, drop --tier, or check `senso analytics filters` for the days that have data.",
          plain: [
            ...context,
            "",
            ...(domains.length
              ? domains.map(
                  (d) =>
                    `  ${pc.dim(`#${d.rank_by_citations}`)} ${pc.bold(d.domain)} ${pc.dim(`[${d.tier_label || d.tier}]`)}\n     coverage ${rate(d.citation_coverage)} · share ${rate(d.citation_share)} · ${count(d.cited_run_count)} cited answers · ${count(d.cited_total)} citations · avg position ${position(d.avg_citation_rank)}`,
                )
              : ["  No cited domains in this window."]),
          ],
        });
        emitNotes(ctx, data.notes);
      },
    ),
  );
}
