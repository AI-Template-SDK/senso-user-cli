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
import { addPagingOptions, addWindowOptions, windowParams, type WindowFilters } from "./filters.js";
import {
  count,
  emitContext,
  emitNotes,
  position,
  qualityLine,
  rate,
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
      .option("--domain <domain>", "Restrict to one exact domain")
      .option("--domain-contains <text>", "Substring filter on the domain")
      .option("--url-contains <text>", "Substring filter on the URL")
      .option("--sort <field>", "Sort by: citations | coverage (default: citations)"),
    50,
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
            limit: cmdOpts.limit,
            offset: cmdOpts.offset,
          },
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });

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
                        `     ${pc.dim(`↳ ${truncate(tp.prompt_text, 80)} (${count(tp.cited_run_count)} cited answers)`)}`,
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
