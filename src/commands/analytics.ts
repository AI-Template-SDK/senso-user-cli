import { Command } from "commander";
import pc from "picocolors";
import { apiRequest } from "../lib/api-client.js";
import { emit, outputPlain } from "../lib/output.js";
import { runAction, type Ctx } from "../lib/run-action.js";
import { CliError, EXIT } from "../lib/errors.js";

// ---------------------------------------------------------------------------
// Response shapes (mirror of senso-api internal/api/dto/org_analytics_dto.go)
// ---------------------------------------------------------------------------

/** A 0–1 fraction with the authoritative human string ("2.6%"). */
interface Rate {
  value: number;
  display: string;
}

/** Window-vs-window movement. Direction is semantic (improved/declined/flat). */
interface RateTrend {
  prev: number;
  delta: number;
  direction: string;
  display: string;
}

interface AnalyticsWindow {
  from: string;
  to: string;
  days: number;
  latest_data_day: string | null;
}

interface SentimentCounts {
  positive: number;
  neutral: number;
  negative: number;
}

interface Totals {
  run_count: number;
  answered_count: number;
  mentioned_count: number;
  mention_total: number;
  tracked_mention_total: number;
  brand_mention_total: number;
  rank_sum: number;
  sentiment: SentimentCounts;
  cited_run_count: number;
  primary_cited_run_count: number;
  tracked_cited_run_count: number;
  external_cited_run_count: number;
  cited_total: number;
  primary_cited_total: number;
  tracked_cited_total: number;
  external_cited_total: number;
  prompt_count: number;
  model_count: number;
  location_count: number;
}

interface Metrics {
  mention_rate: Rate | null;
  share_of_voice: Rate | null;
  avg_rank: Rate | null;
  primary_citation_rate: Rate | null;
  tracked_citation_rate: Rate | null;
  external_citation_rate: Rate | null;
  primary_citation_share: Rate | null;
  tracked_citation_share: Rate | null;
  external_citation_share: Rate | null;
  citations_per_answer: Rate | null;
}

interface Deltas {
  mention_rate: RateTrend | null;
  share_of_voice: RateTrend | null;
  primary_citation_rate: RateTrend | null;
}

interface DataQuality {
  level: string;
  answered_count: number;
  reasons: string[];
}

interface MentionSeriesPoint {
  period_start: string;
  run_count: number;
  answered_count: number;
  mentioned_count: number;
  mention_total: number;
  tracked_mention_total: number;
  brand_mention_total: number;
  rank_sum: number;
  sentiment: SentimentCounts;
  mention_rate: Rate | null;
  share_of_voice: Rate | null;
  avg_rank: Rate | null;
}

interface CitationSeriesPoint {
  period_start: string;
  run_count: number;
  answered_count: number;
  cited_run_count: number;
  primary_cited_run_count: number;
  tracked_cited_run_count: number;
  external_cited_run_count: number;
  cited_total: number;
  primary_cited_total: number;
  tracked_cited_total: number;
  external_cited_total: number;
  primary_citation_rate: Rate | null;
  tracked_citation_rate: Rate | null;
  external_citation_rate: Rate | null;
  primary_citation_share: Rate | null;
  tracked_citation_share: Rate | null;
  external_citation_share: Rate | null;
}

interface Denominators {
  cited_run_count: number;
  cited_total: number;
  unique_domains?: number;
  unique_pages?: number;
}

interface CitedDomainItem {
  domain: string;
  tier: string;
  tier_label: string;
  cited_run_count: number;
  cited_total: number;
  citation_coverage: Rate | null;
  citation_share: Rate | null;
  avg_citation_rank: number | null;
  rank_by_citations: number;
}

interface CitedPagePrompt {
  prompt_id: string;
  prompt_text: string;
  cited_run_count: number;
}

interface CitedPageItem {
  url: string;
  domain: string;
  tier: string;
  tier_label: string;
  cited_run_count: number;
  cited_total: number;
  citation_coverage: Rate | null;
  citation_share: Rate | null;
  avg_citation_rank: number | null;
  top_prompts: CitedPagePrompt[];
}

interface PromptPerformanceItem {
  prompt_id: string;
  prompt_text: string;
  prompt_type: string;
  tags: string[];
  run_count: number;
  answered_count: number;
  mentioned_count: number;
  cited_run_count: number;
  primary_cited_run_count: number;
  sentiment: SentimentCounts;
  mention_rate: Rate | null;
  share_of_voice: Rate | null;
  avg_rank: Rate | null;
  primary_citation_rate: Rate | null;
  latest: {
    run_at: string | null;
    answer_count: number;
    mentioned_count: number;
    models: string[];
    // The app's prompt table shows this "right now" figure, not the window
    // aggregate above. Compare against this one when reconciling a single
    // prompt with the app.
    share_of_voice: Rate | null;
  } | null;
}

interface AnswerCitation {
  url: string;
  domain: string;
  citation_type: string;
}

interface LatestAnswerItem {
  prompt_id: string;
  prompt_text: string;
  prompt_type: string;
  provider: string;
  model: string;
  location: string;
  run_at: string;
  response_text: string;
  empty: boolean;
  mentioned: boolean;
  rank: number | null;
  sentiment: string | null;
  sov_pct: number | null;
  citations: AnswerCitation[];
  competitor_mentions: Record<string, number>;
  has_primary_citation: boolean;
  has_tracked_citation: boolean;
  has_external_citation: boolean;
}

interface GlossaryEntry {
  metric: string;
  definition: string;
  denominator?: string;
  gotcha?: string;
}

interface FilterOption {
  id: string;
  display_name: string;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Rendered where a metric is null because its denominator was zero. Never 0%. */
const NO_VALUE = "—";

/** Renders a {value, display} object — the display string is authoritative. */
function rate(r?: { display?: string } | null): string {
  return r && typeof r.display === "string" ? r.display : NO_VALUE;
}

/** Renders a raw count, grouped for readability. */
function count(v?: number | null): string {
  return v === undefined || v === null ? NO_VALUE : v.toLocaleString("en-US");
}

/** Renders a raw average ordinal position as "#3.2". */
function position(v?: number | null): string {
  return v === undefined || v === null ? NO_VALUE : `#${v.toFixed(1)}`;
}

/** Renders a window-over-window trend with its semantic direction. */
function trend(t?: RateTrend | null): string {
  return t ? `${t.display} (${t.direction})` : NO_VALUE;
}

/** Renders "numerator / denominator unit" so a reader can redo the math. */
function ratio(numerator: number, denominator: number, unit: string): string {
  return `${count(numerator)} / ${count(denominator)} ${unit}`;
}

function truncate(value: string | undefined, max: number): string {
  const flat = (value ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function windowLine(w?: AnalyticsWindow): string {
  if (!w) return "";
  const fresh = w.latest_data_day
    ? `, latest data ${w.latest_data_day}`
    : ", no data days in window";
  return `  ${pc.dim(`Window ${w.from} → ${w.to} (${w.days} days${fresh})`)}`;
}

function qualityLine(dq?: DataQuality): string {
  if (!dq) return "";
  return `  ${pc.dim(`Data quality: ${dq.level} — ${count(dq.answered_count)} answered runs`)}`;
}

/**
 * Prints the window / data-quality context that a table alone cannot carry.
 * Plain output builds these lines into its own payload, so this only fires for
 * `--output table`; `--output json` gets the payload untouched.
 */
function emitContext(ctx: Ctx, lines: string[]): void {
  if (ctx.format !== "table") return;
  const visible = lines.filter(Boolean);
  if (visible.length === 0) return;
  outputPlain([...visible, ""]);
}

/**
 * Surfaces the response's notes[] — the caveats that stop a reader misreading
 * the numbers (null denominators, truncated windows, tracking-set dependence).
 * Hidden only in `--output json`, where they are already in the payload.
 */
function emitNotes(ctx: Ctx, notes?: string[]): void {
  if (ctx.format === "json" || !notes || notes.length === 0) return;
  outputPlain(["", `  ${pc.bold("Notes")}`, ...notes.map((note) => `  ${pc.dim("•")} ${note}`)]);
}

// ---------------------------------------------------------------------------
// Shared filter options
// ---------------------------------------------------------------------------

interface WindowFilters {
  from?: string;
  to?: string;
  models?: string;
  location?: string;
  promptType?: string;
  tag?: string;
}

function windowParams(o: WindowFilters): Record<string, string | undefined> {
  return {
    from: o.from,
    to: o.to,
    models: o.models,
    location: o.location,
    prompt_type: o.promptType,
    tag: o.tag,
  };
}

/**
 * Shared window/filter options.
 *
 * `tag` is opt-out because the cited-source endpoints (domains, pages) cannot
 * honor it — the domain and webpage rollups have no prompt grain to resolve a
 * tag through. Offering the flag there would advertise a filter that silently
 * does nothing, which is the one failure mode this CLI works hardest to avoid:
 * an unapplied filter returns MORE data, so the mistake is invisible.
 */
function addWindowOptions(cmd: Command, opts: { tag?: boolean } = {}): Command {
  const withTag = opts.tag !== false;
  const base = cmd
    .option(
      "--from <date>",
      "Window start, YYYY-MM-DD (default: 30 days ending at the most recent day with data)",
    )
    .option("--to <date>", "Window end, YYYY-MM-DD (max window: 365 days)")
    .option("--models <list>", "Comma-separated model filter — see 'senso analytics filters'")
    .option(
      "--location <list>",
      "Comma-separated location filter, case-sensitive (e.g. US, US/California)",
    )
    .option(
      "--prompt-type <type>",
      "Funnel stage: awareness | consideration | evaluation | decision",
    );
  return withTag ? base.option("--tag <tag>", "Restrict to prompts carrying this tag") : base;
}

function addPagingOptions(cmd: Command, defaultLimit: number): Command {
  return cmd
    .option("--limit <n>", `Maximum rows to return (default: ${defaultLimit}, max: 100)`)
    .option("--offset <n>", "Rows to skip (for pagination)");
}

const BOOL_VALUES = new Set(["true", "false", "1", "0", "yes", "no"]);

function normalizeBool(flag: string, raw?: string): string | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase();
  if (!BOOL_VALUES.has(value)) {
    throw new CliError(`Invalid --${flag}: expected true or false.`, EXIT.USAGE, {
      code: "usage",
      hint: `Accepted values: ${[...BOOL_VALUES].join(", ")}.`,
    });
  }
  return value;
}

/** The headline metric table, shared by `summary` and `prompt <promptId>`. */
function metricRows(
  totals: Totals,
  metrics: Metrics,
  deltas?: Deltas | null,
): Record<string, unknown>[] {
  return [
    {
      metric: "Mention Rate",
      value: rate(metrics.mention_rate),
      counts: ratio(totals.mentioned_count, totals.answered_count, "answers"),
      "vs prev": trend(deltas?.mention_rate),
    },
    {
      metric: "Share of Voice",
      value: rate(metrics.share_of_voice),
      counts: ratio(totals.mention_total, totals.brand_mention_total, "mentions (all brands)"),
      "vs prev": trend(deltas?.share_of_voice),
    },
    {
      metric: "Avg Rank",
      value: rate(metrics.avg_rank),
      counts: `over ${count(totals.mentioned_count)} mentioned answers`,
      "vs prev": NO_VALUE,
    },
    {
      metric: "Citation Rate (Owned)",
      value: rate(metrics.primary_citation_rate),
      counts: ratio(totals.primary_cited_run_count, totals.cited_run_count, "cited answers"),
      "vs prev": trend(deltas?.primary_citation_rate),
    },
    {
      metric: "Citation Rate (Tracked)",
      value: rate(metrics.tracked_citation_rate),
      counts: ratio(totals.tracked_cited_run_count, totals.cited_run_count, "cited answers"),
      "vs prev": NO_VALUE,
    },
    {
      metric: "Citation Rate (External)",
      value: rate(metrics.external_citation_rate),
      counts: ratio(totals.external_cited_run_count, totals.cited_run_count, "cited answers"),
      "vs prev": NO_VALUE,
    },
    {
      metric: "Citation Share (Owned)",
      value: rate(metrics.primary_citation_share),
      counts: ratio(totals.primary_cited_total, totals.cited_total, "citations"),
      "vs prev": NO_VALUE,
    },
    {
      metric: "Citation Share (Tracked)",
      value: rate(metrics.tracked_citation_share),
      counts: ratio(totals.tracked_cited_total, totals.cited_total, "citations"),
      "vs prev": NO_VALUE,
    },
    {
      metric: "Citation Share (External)",
      value: rate(metrics.external_citation_share),
      counts: ratio(totals.external_cited_total, totals.cited_total, "citations"),
      "vs prev": NO_VALUE,
    },
    {
      metric: "Citations per Answer",
      value: rate(metrics.citations_per_answer),
      counts: ratio(totals.cited_total, totals.cited_run_count, "cited answers"),
      "vs prev": NO_VALUE,
    },
    {
      metric: "Sentiment (pos/neu/neg)",
      value: `${count(totals.sentiment?.positive)} / ${count(totals.sentiment?.neutral)} / ${count(totals.sentiment?.negative)}`,
      counts: `sums to ${count(totals.mentioned_count)} mentioned answers`,
      "vs prev": NO_VALUE,
    },
  ];
}

const METRIC_COLUMNS = ["metric", "value", "counts", "vs prev"];

function metricPlainLines(rows: Record<string, unknown>[]): string[] {
  const width = rows.reduce((max, r) => Math.max(max, String(r.metric).length), 0);
  return rows.map(
    (r) =>
      `  ${pc.bold(String(r.metric).padEnd(width))}  ${String(r.value)}  ${pc.dim(`(${String(r.counts)})`)}` +
      (r["vs prev"] !== NO_VALUE ? `  ${pc.dim(`vs prev: ${String(r["vs prev"])}`)}` : ""),
  );
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerAnalyticsCommands(program: Command): void {
  const analytics = program
    .command("analytics")
    .description(
      "GEO analytics for your organization — brand visibility, share of voice, and citations across the AI models you monitor. Every payload ships raw counts alongside the rates, and a rate is null (shown as “—”) when its denominator is zero, never a silent 0%. Run 'senso analytics glossary' for the canonical definition and denominator of every metric.",
    );

  // ── summary ──────────────────────────────────────────────────────────────
  addWindowOptions(
    analytics
      .command("summary")
      .description(
        "One-call dashboard: every headline metric with its raw counts, plus the preceding equal-length window and the deltas between them.",
      ),
  ).action(
    runAction(program, async (ctx, cmdOpts: WindowFilters) => {
      const data = await apiRequest<{
        window: AnalyticsWindow;
        totals: Totals;
        metrics: Metrics;
        deltas: Deltas | null;
        data_quality: DataQuality;
        notes: string[];
      }>({
        path: "/org/analytics/summary",
        params: windowParams(cmdOpts),
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
      });

      const rows = metricRows(data.totals, data.metrics, data.deltas);
      emitContext(ctx, [
        "",
        `  ${pc.bold("Analytics summary")}`,
        windowLine(data.window),
        qualityLine(data.data_quality),
      ]);
      emit(ctx, data, {
        table: { rows, columns: METRIC_COLUMNS },
        plain: [
          "",
          `  ${pc.bold("Analytics summary")}`,
          windowLine(data.window),
          qualityLine(data.data_quality),
          "",
          ...metricPlainLines(rows),
          "",
          `  ${pc.dim(`Monitoring ${count(data.totals.prompt_count)} prompts × ${count(data.totals.model_count)} models × ${count(data.totals.location_count)} locations — ${count(data.totals.answered_count)} of ${count(data.totals.run_count)} runs answered`)}`,
        ],
      });
      emitNotes(ctx, data.notes);
    }),
  );

  // ── mentions ─────────────────────────────────────────────────────────────
  addWindowOptions(
    analytics
      .command("mentions")
      .description(
        "Visibility time series: mention counts, share of voice (your mentions ÷ mentions of every brand), average rank and sentiment, bucketed by day or week.",
      ),
  )
    .option("--group-by <bucket>", "Time bucket: day | week (default: day)")
    .action(
      runAction(program, async (ctx, cmdOpts: WindowFilters & { groupBy?: string }) => {
        const data = await apiRequest<{
          window: AnalyticsWindow;
          group_by: string;
          totals: Totals;
          metrics: Metrics;
          series: MentionSeriesPoint[];
          data_quality: DataQuality;
          notes: string[];
        }>({
          path: "/org/analytics/mentions",
          params: { ...windowParams(cmdOpts), group_by: cmdOpts.groupBy },
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });

        const series = data.series ?? [];
        const context = [
          "",
          `  ${pc.bold("Mentions")} ${pc.dim(`by ${data.group_by}`)}`,
          windowLine(data.window),
          qualityLine(data.data_quality),
          `  ${pc.dim(`Window totals — mention rate ${rate(data.metrics.mention_rate)}, share of voice ${rate(data.metrics.share_of_voice)}, avg rank ${rate(data.metrics.avg_rank)}`)}`,
        ];
        emitContext(ctx, context);
        emit(ctx, data, {
          table: {
            rows: series.map((p) => ({
              period: p.period_start,
              answered: count(p.answered_count),
              mentioned: count(p.mentioned_count),
              mention_rate: rate(p.mention_rate),
              sov: rate(p.share_of_voice),
              avg_rank: rate(p.avg_rank),
            })),
            columns: ["period", "answered", "mentioned", "mention_rate", "sov", "avg_rank"],
          },
          plain: [
            ...context,
            "",
            ...(series.length
              ? series.map(
                  (p) =>
                    `  ${pc.bold(p.period_start)}  answered ${count(p.answered_count)}  mentioned ${count(p.mentioned_count)}  rate ${rate(p.mention_rate)}  SoV ${rate(p.share_of_voice)}  rank ${rate(p.avg_rank)}`,
                )
              : ["  No rollup days in this window."]),
          ],
        });
        emitNotes(ctx, data.notes);
      }),
    );

  // ── citations ────────────────────────────────────────────────────────────
  addWindowOptions(
    analytics
      .command("citations")
      .description(
        "Citation overview: both denominators (D = cited answers, S = citation instances), every tier numerator, the tier rates (÷D) and tier shares (÷S), and the series underneath.",
      ),
  )
    .option("--group-by <bucket>", "Time bucket: day | week (default: day)")
    .action(
      runAction(program, async (ctx, cmdOpts: WindowFilters & { groupBy?: string }) => {
        const data = await apiRequest<{
          window: AnalyticsWindow;
          group_by: string;
          totals: Totals;
          metrics: Metrics;
          series: CitationSeriesPoint[];
          data_quality: DataQuality;
          notes: string[];
        }>({
          path: "/org/analytics/citations",
          params: { ...windowParams(cmdOpts), group_by: cmdOpts.groupBy },
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });

        const series = data.series ?? [];
        const context = [
          "",
          `  ${pc.bold("Citations")} ${pc.dim(`by ${data.group_by}`)}`,
          windowLine(data.window),
          qualityLine(data.data_quality),
          `  ${pc.dim(`D = ${count(data.totals.cited_run_count)} cited answers, S = ${count(data.totals.cited_total)} citation instances`)}`,
          `  ${pc.dim(`Owned rate ${rate(data.metrics.primary_citation_rate)} (÷D) · Owned share ${rate(data.metrics.primary_citation_share)} (÷S) · ${rate(data.metrics.citations_per_answer)}`)}`,
        ];
        emitContext(ctx, context);
        emit(ctx, data, {
          table: {
            rows: series.map((p) => ({
              period: p.period_start,
              cited_answers: count(p.cited_run_count),
              citations: count(p.cited_total),
              owned_rate: rate(p.primary_citation_rate),
              tracked_rate: rate(p.tracked_citation_rate),
              external_rate: rate(p.external_citation_rate),
              owned_share: rate(p.primary_citation_share),
            })),
            columns: [
              "period",
              "cited_answers",
              "citations",
              "owned_rate",
              "tracked_rate",
              "external_rate",
              "owned_share",
            ],
          },
          plain: [
            ...context,
            "",
            ...(series.length
              ? series.map(
                  (p) =>
                    `  ${pc.bold(p.period_start)}  cited answers ${count(p.cited_run_count)}  citations ${count(p.cited_total)}  owned ${rate(p.primary_citation_rate)}  tracked ${rate(p.tracked_citation_rate)}  external ${rate(p.external_citation_rate)}`,
                )
              : ["  No rollup days in this window."]),
          ],
        });
        emitNotes(ctx, data.notes);
      }),
    );

  // ── domains ──────────────────────────────────────────────────────────────
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
            tier: cmdOpts.tier,
            domain_contains: cmdOpts.domainContains,
            sort: cmdOpts.sort,
            limit: cmdOpts.limit,
            offset: cmdOpts.offset,
          },
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });

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
            tier: cmdOpts.tier,
            domain: cmdOpts.domain,
            domain_contains: cmdOpts.domainContains,
            url_contains: cmdOpts.urlContains,
            sort: cmdOpts.sort,
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

  // ── prompts ──────────────────────────────────────────────────────────────
  addPagingOptions(
    addWindowOptions(
      analytics
        .command("prompts")
        .description(
          "Per-prompt performance over the window — sort ascending by mention_rate to find the prompts where you are invisible. Drill into one with 'senso analytics prompt <promptId>'.",
        ),
    )
      .option("--search <query>", "Filter prompts by question text")
      .option(
        "--sort <field>",
        "Sort by: mention_rate | share_of_voice | citations | answered | text (default: mention_rate)",
      )
      .option("--order <dir>", "Sort direction: asc | desc (default: desc)"),
    50,
  ).action(
    runAction(
      program,
      async (
        ctx: Ctx,
        cmdOpts: WindowFilters & {
          search?: string;
          sort?: string;
          order?: string;
          limit?: string;
          offset?: string;
        },
      ) => {
        const data = await apiRequest<{
          window: AnalyticsWindow;
          totals: Totals;
          metrics: Metrics;
          total: number;
          limit: number;
          offset: number;
          prompts: PromptPerformanceItem[];
          data_quality: DataQuality;
          notes: string[];
        }>({
          path: "/org/analytics/prompts",
          params: {
            ...windowParams(cmdOpts),
            search: cmdOpts.search,
            sort: cmdOpts.sort,
            order: cmdOpts.order,
            limit: cmdOpts.limit,
            offset: cmdOpts.offset,
          },
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });

        const prompts = data.prompts ?? [];
        const context = [
          "",
          `  ${pc.bold("Prompt performance")} ${pc.dim(`${prompts.length} of ${count(data.total)} (offset ${count(data.offset)})`)}`,
          windowLine(data.window),
          qualityLine(data.data_quality),
          `  ${pc.dim(`Org-wide over the same window — mention rate ${rate(data.metrics.mention_rate)}, share of voice ${rate(data.metrics.share_of_voice)}`)}`,
        ];
        emitContext(ctx, context);
        emit(ctx, data, {
          table: {
            rows: prompts.map((p) => ({
              prompt_id: p.prompt_id,
              prompt: truncate(p.prompt_text, 40),
              answered: count(p.answered_count),
              mention_rate: rate(p.mention_rate),
              sov: rate(p.share_of_voice),
              latest_sov: rate(p.latest?.share_of_voice ?? null),
              avg_rank: rate(p.avg_rank),
              owned_cite_rate: rate(p.primary_citation_rate),
            })),
            columns: [
              "prompt_id",
              "prompt",
              "answered",
              "mention_rate",
              "sov",
              "latest_sov",
              "avg_rank",
              "owned_cite_rate",
            ],
          },
          plain: [
            ...context,
            "",
            ...(prompts.length
              ? prompts.map((p) =>
                  [
                    `  ${pc.bold(truncate(p.prompt_text, 100))} ${pc.dim(`[${p.prompt_type}]`)}`,
                    `     mention rate ${rate(p.mention_rate)} (${count(p.mentioned_count)}/${count(p.answered_count)}) · SoV ${rate(p.share_of_voice)} (window) · ${rate(p.latest?.share_of_voice ?? null)} (latest) · avg rank ${rate(p.avg_rank)} · owned citation rate ${rate(p.primary_citation_rate)}`,
                    `     ${pc.dim(`ID: ${p.prompt_id}${p.tags?.length ? ` · tags: ${p.tags.join(", ")}` : ""}`)}`,
                  ].join("\n"),
                )
              : ["  No prompts matched this filter."]),
          ],
        });
        emitNotes(ctx, data.notes);
      },
    ),
  );

  // ── prompt <promptId> ────────────────────────────────────────────────────
  analytics
    .command("prompt <promptId>")
    .description(
      "One prompt end to end: its metric history over the window plus the latest full answer from every model × location.",
    )
    .option("--from <date>", "Window start, YYYY-MM-DD")
    .option("--to <date>", "Window end, YYYY-MM-DD")
    .option("--models <list>", "Comma-separated model filter")
    .option("--location <list>", "Comma-separated location filter, case-sensitive")
    .option("--no-include-answers", "Omit the latest answer bodies (included by default)")
    .action(
      runAction(
        program,
        async (
          ctx: Ctx,
          promptId: string,
          cmdOpts: {
            from?: string;
            to?: string;
            models?: string;
            location?: string;
            includeAnswers?: boolean;
          },
        ) => {
          const data = await apiRequest<{
            prompt_id: string;
            prompt_text: string;
            prompt_type: string;
            tags: string[];
            window: AnalyticsWindow;
            totals: Totals;
            metrics: Metrics;
            series: MentionSeriesPoint[];
            latest_answers: LatestAnswerItem[];
            data_quality: DataQuality;
            notes: string[];
          }>({
            path: `/org/analytics/prompts/${promptId}`,
            params: {
              from: cmdOpts.from,
              to: cmdOpts.to,
              models: cmdOpts.models,
              location: cmdOpts.location,
              include_answers: cmdOpts.includeAnswers === false ? "false" : undefined,
            },
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });

          const series = data.series ?? [];
          const answers = data.latest_answers ?? [];
          const rows = metricRows(data.totals, data.metrics);
          const context = [
            "",
            `  ${pc.bold(data.prompt_text)} ${pc.dim(`[${data.prompt_type}]`)}`,
            `  ${pc.dim(`ID: ${data.prompt_id}${data.tags?.length ? ` · tags: ${data.tags.join(", ")}` : ""}`)}`,
            windowLine(data.window),
            qualityLine(data.data_quality),
          ];
          emitContext(ctx, context);
          emit(ctx, data, {
            table: {
              rows: series.map((p) => ({
                period: p.period_start,
                answered: count(p.answered_count),
                mentioned: count(p.mentioned_count),
                mention_rate: rate(p.mention_rate),
                sov: rate(p.share_of_voice),
                avg_rank: rate(p.avg_rank),
              })),
              columns: ["period", "answered", "mentioned", "mention_rate", "sov", "avg_rank"],
            },
            plain: [
              ...context,
              "",
              ...metricPlainLines(rows),
              "",
              `  ${pc.bold("Series")}`,
              ...(series.length
                ? series.map(
                    (p) =>
                      `  ${p.period_start}  answered ${count(p.answered_count)}  mentioned ${count(p.mentioned_count)}  rate ${rate(p.mention_rate)}  SoV ${rate(p.share_of_voice)}  rank ${rate(p.avg_rank)}`,
                  )
                : ["  No rollup days in this window."]),
              ...(answers.length
                ? [
                    "",
                    `  ${pc.bold("Latest answers")}`,
                    ...answers.map((a) =>
                      [
                        `  ${pc.bold(`${a.model} · ${a.location}`)} ${pc.dim(a.run_at)}`,
                        `     mentioned ${a.mentioned ? "yes" : "no"} · rank ${a.rank === null || a.rank === undefined ? NO_VALUE : `#${a.rank}`} · sentiment ${a.sentiment ?? NO_VALUE} · ${count(a.citations?.length ?? 0)} citations`,
                        `     ${pc.dim(truncate(a.response_text, 200))}`,
                      ].join("\n"),
                    ),
                  ]
                : []),
            ],
          });
          emitNotes(ctx, data.notes);
        },
      ),
    );

  // ── answers ──────────────────────────────────────────────────────────────
  addPagingOptions(
    analytics
      .command("answers")
      .description(
        "The newest stored answer per prompt × model × location, with its citations and competitor mentions. This is a snapshot, not a window: --from/--to filter on when each answer was collected, so narrowing them hides combinations instead of returning older answers. Historical answer text is not retained.",
      )
      .option(
        "--from <date>",
        "Answers collected on or after this date, YYYY-MM-DD (hides rows, never reveals older answers)",
      )
      .option(
        "--to <date>",
        "Answers collected on or before this date, YYYY-MM-DD (hides rows, never reveals older answers)",
      )
      .option("--models <list>", "Comma-separated model filter")
      .option("--location <list>", "Comma-separated location filter, case-sensitive")
      .option(
        "--prompt-type <type>",
        "Funnel stage: awareness | consideration | evaluation | decision",
      )
      .option("--tag <tag>", "Restrict to prompts carrying this tag")
      .option(
        "--mentioned <bool>",
        "Only answers that did (true) or did not (false) name your brand",
      )
      .option("--cited <bool>", "Only answers that did (true) or did not (false) cite anything")
      .option(
        "--citation-tier <tier>",
        "Only answers citing this tier: primary | tracked | secondary",
      ),
    25,
  ).action(
    runAction(
      program,
      async (
        ctx: Ctx,
        cmdOpts: {
          from?: string;
          to?: string;
          models?: string;
          location?: string;
          promptType?: string;
          tag?: string;
          mentioned?: string;
          cited?: string;
          citationTier?: string;
          limit?: string;
          offset?: string;
        },
      ) => {
        const mentioned = normalizeBool("mentioned", cmdOpts.mentioned);
        const cited = normalizeBool("cited", cmdOpts.cited);
        const data = await apiRequest<{
          total: number;
          limit: number;
          offset: number;
          answers: LatestAnswerItem[];
          notes: string[];
        }>({
          path: "/org/analytics/answers/latest",
          params: {
            from: cmdOpts.from,
            to: cmdOpts.to,
            models: cmdOpts.models,
            location: cmdOpts.location,
            prompt_type: cmdOpts.promptType,
            tag: cmdOpts.tag,
            mentioned,
            cited,
            citation_tier: cmdOpts.citationTier,
            limit: cmdOpts.limit,
            offset: cmdOpts.offset,
          },
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });

        const answers = data.answers ?? [];
        const collectedLine =
          cmdOpts.from || cmdOpts.to
            ? `  ${pc.dim(`Collected ${cmdOpts.from ?? "any"} → ${cmdOpts.to ?? "any"} — combinations whose newest answer falls outside this window are hidden, not replaced by older answers.`)}`
            : "";
        const context = [
          "",
          `  ${pc.bold("Latest answers")} ${pc.dim(`${answers.length} of ${count(data.total)} (offset ${count(data.offset)})`)}`,
          `  ${pc.dim("Snapshot of the newest answer per prompt × model × location — not a sample of any window.")}`,
          ...(collectedLine ? [collectedLine] : []),
        ];
        emitContext(ctx, context);
        emit(ctx, data, {
          table: {
            rows: answers.map((a) => ({
              run_at: (a.run_at || "").slice(0, 10),
              model: a.model,
              location: a.location,
              prompt: truncate(a.prompt_text, 40),
              mentioned: a.mentioned ? "yes" : "no",
              rank: a.rank === null || a.rank === undefined ? NO_VALUE : `#${a.rank}`,
              sentiment: a.sentiment ?? NO_VALUE,
              citations: count(a.citations?.length ?? 0),
            })),
            columns: [
              "run_at",
              "model",
              "location",
              "prompt",
              "mentioned",
              "rank",
              "sentiment",
              "citations",
            ],
          },
          plain: [
            ...context,
            "",
            ...(answers.length
              ? answers.map((a) =>
                  [
                    `  ${pc.bold(truncate(a.prompt_text, 100))} ${pc.dim(`[${a.prompt_type}]`)}`,
                    `     ${a.model} · ${a.location} · ${pc.dim(a.run_at)}`,
                    `     mentioned ${a.mentioned ? "yes" : "no"} · rank ${a.rank === null || a.rank === undefined ? NO_VALUE : `#${a.rank}`} · sentiment ${a.sentiment ?? NO_VALUE} · ${count(a.citations?.length ?? 0)} citations`,
                    `     ${pc.dim(truncate(a.response_text, 200))}`,
                    `     ${pc.dim(`ID: ${a.prompt_id}`)}`,
                  ].join("\n"),
                )
              : ["  No answers matched this filter."]),
          ],
        });
        emitNotes(ctx, data.notes);
      },
    ),
  );

  // ── glossary ─────────────────────────────────────────────────────────────
  analytics
    .command("glossary")
    .description(
      "Canonical definition, denominator and gotcha for every metric these endpoints emit. Read this before quoting a number — a Citation Rate divides by cited answers (D), a Citation Share divides by citation instances (S), and they are not interchangeable.",
    )
    .action(
      runAction(program, async (ctx) => {
        const data = await apiRequest<{ entries: GlossaryEntry[] }>({
          path: "/org/analytics/glossary",
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });

        const entries = data.entries ?? [];
        emitContext(ctx, [
          "",
          `  ${pc.bold("Metric glossary")} ${pc.dim(`${entries.length} metrics — gotchas shown in plain and json output`)}`,
        ]);
        emit(ctx, data, {
          table: {
            rows: entries.map((e) => ({
              metric: e.metric,
              // `||` not `??`: an empty denominator string is as absent as a
              // missing one, and should render as the placeholder.
              // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
              denominator: e.denominator || NO_VALUE,
              definition: e.definition,
            })),
            columns: ["metric", "denominator", "definition"],
          },
          plain: [
            "",
            `  ${pc.bold("Metric glossary")}`,
            "",
            ...entries.map((e) =>
              [
                `  ${pc.bold(e.metric)}`,
                `     ${e.definition}`,
                ...(e.denominator ? [`     ${pc.dim(`Denominator: ${e.denominator}`)}`] : []),
                ...(e.gotcha ? [`     ${pc.yellow("Gotcha:")} ${e.gotcha}`] : []),
              ].join("\n"),
            ),
          ],
        });
      }),
    );

  // ── filters ──────────────────────────────────────────────────────────────
  analytics
    .command("filters")
    .description(
      "The models, locations, prompt types, tags and tracked competitors that actually have data for this org, plus the span of rollup days available — so you never guess a model spelling or query an empty window.",
    )
    .action(
      runAction(program, async (ctx) => {
        const data = await apiRequest<{
          models: FilterOption[];
          locations: string[];
          prompt_types: string[];
          tags: string[];
          tracked_competitors: FilterOption[];
          date_range: { earliest_day: string | null; latest_day: string | null };
          notes: string[];
        }>({
          path: "/org/analytics/filters",
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });

        const models = (data.models ?? []).map((m) => m.display_name || m.id);
        const competitors = (data.tracked_competitors ?? []).map((c) => c.display_name || c.id);
        const range = data.date_range;
        const rangeText =
          range?.earliest_day && range?.latest_day
            ? `${range.earliest_day} → ${range.latest_day}`
            : "no rollup days yet";

        const list = (values: string[]): string => (values.length ? values.join(", ") : NO_VALUE);

        emitContext(ctx, ["", `  ${pc.bold("Available filters")}`]);
        emit(ctx, data, {
          table: {
            rows: [
              { filter: "--models", values: list(models) },
              { filter: "--location", values: list(data.locations ?? []) },
              { filter: "--prompt-type", values: list(data.prompt_types ?? []) },
              { filter: "--tag", values: list(data.tags ?? []) },
              { filter: "tracked competitors", values: list(competitors) },
              { filter: "date range", values: rangeText },
            ],
            columns: ["filter", "values"],
          },
          plain: [
            "",
            `  ${pc.bold("Available filters")}`,
            "",
            `  ${pc.bold("--models")}        ${list(models)}`,
            `  ${pc.bold("--location")}      ${list(data.locations ?? [])}`,
            `  ${pc.bold("--prompt-type")}   ${list(data.prompt_types ?? [])}`,
            `  ${pc.bold("--tag")}           ${list(data.tags ?? [])}`,
            "",
            `  ${pc.bold("Tracked competitors")}  ${list(competitors)}`,
            `  ${pc.bold("Date range")}           ${rangeText}`,
          ],
        });
        emitNotes(ctx, data.notes);
      }),
    );
}
