/**
 * `senso analytics pages` — the URL-grain cited-source table.
 *
 * Its own file for the same reason as domains.ts: same denominators, different
 * grain, and the extra per-page "prompts driving this citation" block only
 * exists here.
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
  truncate,
  windowLine,
} from "./render.js";
import type { AnalyticsWindow, CitedPageItem, DataQuality, Denominators } from "./types.js";

// The values --tier and --sort accept, as their help text lists them. The
// cited-source rollups (domains, pages) offer the same two flags, but each
// declares its own options, so each checks its own.
const TIER_VALUES = ["primary", "tracked", "secondary"] as const;
const SORT_VALUES = ["citations", "coverage"] as const;

export function addPagesCommand(analytics: Command, program: Command): void {
  // ── pages ────────────────────────────────────────────────────────────────
  describeCommand(
    addPagingOptions(
      addWindowOptions(
        analytics
          .command("pages")
          .description(
            "URL-grain citation table plus the prompts driving each page's citations. Same Coverage (÷D) and Share (÷S) denominators as 'analytics domains'.",
          ),
        { tag: false },
      )
        .option("--tier <tier>", "Filter by tier: primary | tracked | secondary")
        .option("--domain <domain>", "Restrict to one exact domain (exact match, not a substring)")
        .option("--domain-contains <text>", "Substring filter on the domain; combines with --domain")
        .option("--url-contains <text>", "Substring filter on the URL")
        .option("--sort <field>", "Sort by: citations | coverage (default: citations)"),
      50,
    ),
    {
      returns: [
        "denominators.cited_run_count — D, the answers that cited anything; denominators.cited_total — S, the citation instances",
        "pages[].citation_coverage — this URL's cited answers ÷ D, as {value, display} or null when D is zero",
        "pages[].citation_share — this URL's citation instances ÷ S, as {value, display} or null when S is zero",
        "pages[].tier — primary | tracked | secondary (tier_label: Owned | Tracked | External)",
        "pages[].avg_citation_rank — average position in an answer's citation list; null when never cited",
        "pages[].top_prompts[] — prompt_id, prompt_text, cited_run_count. The prompt_id is an org prompt id: pass it to `senso analytics prompt <promptId>`",
        "total / limit / offset — the page; `page.next` in the JSON envelope is the runnable next call",
      ],
      exitCodes: {
        ...apiExits,
        2: "a date that is not YYYY-MM-DD, a window longer than 365 days, an unknown model or tier, or a --limit outside 1-100",
        3: "no key, the organization lacks the GEO product, or the key lacks read:prompt",
      },
      examples: [
        { comment: "The URLs the models cite most", command: "senso analytics pages" },
        {
          comment: "One competitor's pages, and the prompts that surface them",
          command: "senso analytics pages --domain example.com",
        },
      ],
      seeAlso: ["senso analytics domains", "senso analytics prompt <promptId>"],
    },
  ).action(
    runAction(
      program,
      async (
        ctx: Ctx,
        cmdOpts: WindowFilters & {
          tier?: string;
          domain?: string;
          domainContains?: string;
          urlContains?: string;
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
          pages: CitedPageItem[];
          data_quality: DataQuality;
          notes: string[];
        }>({
          path: "/org/analytics/citations/pages",
          params: {
            ...windowParams(cmdOpts),
            tier: parseEnumFlag("--tier", cmdOpts.tier, TIER_VALUES),
            domain: cmdOpts.domain,
            domain_contains: cmdOpts.domainContains,
            url_contains: cmdOpts.urlContains,
            sort: parseEnumFlag("--sort", cmdOpts.sort, SORT_VALUES),
            ...pagingParams(cmdOpts),
          },
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });

        requireBlocks("/org/analytics/citations/pages", { denominators: data.denominators });

        const pages = data.pages ?? [];
        const context = [
          "",
          `  ${pc.bold("Cited pages")} ${pc.dim(`${pages.length} of ${count(data.total)} (offset ${count(data.offset)})`)}`,
          windowLine(data.window),
          qualityLine(data.data_quality),
          `  ${pc.dim(`D = ${count(data.denominators?.cited_run_count)} cited answers, S = ${count(data.denominators?.cited_total)} citation instances`)}`,
        ];
        emitContext(ctx, context);
        emit(ctx, data, {
          table: {
            rows: pages.map((p) => ({
              url: truncate(p.url, 70),
              tier: p.tier_label || p.tier,
              answers: count(p.cited_run_count),
              citations: count(p.cited_total),
              coverage: rate(p.citation_coverage),
              share: rate(p.citation_share),
              avg_pos: position(p.avg_citation_rank),
            })),
            columns: ["url", "tier", "answers", "citations", "coverage", "share", "avg_pos"],
          },
          empty: "cited pages",
          emptyHint:
            "No page was cited in this window. Widen --from/--to, drop --tier/--domain, or check `senso analytics filters` for the days that have data.",
          plain: [
            ...context,
            "",
            ...(pages.length
              ? pages.map((p) =>
                  [
                    `  ${pc.bold(p.url)} ${pc.dim(`[${p.tier_label || p.tier}]`)}`,
                    `     coverage ${rate(p.citation_coverage)} · share ${rate(p.citation_share)} · ${count(p.cited_run_count)} cited answers · ${count(p.cited_total)} citations`,
                    ...(p.top_prompts ?? []).map(
                      (tp) =>
                        // Plain never truncates, and the prompt_id is the whole
                        // point of the block: it is what `analytics prompt`
                        // takes.
                        `     ${pc.dim(`↳ ${tp.prompt_text} (${count(tp.cited_run_count)} cited answers) · prompt_id ${tp.prompt_id}`)}`,
                    ),
                  ].join("\n"),
                )
              : ["  No cited pages in this window."]),
          ],
        });
        emitNotes(ctx, data.notes);
      },
    ),
  );
}
