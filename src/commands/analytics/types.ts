/**
 * The response shapes every `senso analytics` subcommand narrows its payload
 * to.
 *
 * They live in one file because the subcommands share most of them — a window,
 * a totals block and a metrics block appear in nearly every response — and a
 * shape that drifts between two files is a shape that silently stops matching
 * the API.
 */

// ---------------------------------------------------------------------------
// Response shapes (mirror of senso-api internal/api/dto/org_analytics_dto.go)
// ---------------------------------------------------------------------------

/** A 0–1 fraction with the authoritative human string ("2.6%"). */
export interface Rate {
  value: number;
  display: string;
}

/** Window-vs-window movement. Direction is semantic (improved/declined/flat). */
export interface RateTrend {
  prev: number;
  delta: number;
  direction: string;
  display: string;
}

export interface AnalyticsWindow {
  from: string;
  to: string;
  days: number;
  latest_data_day: string | null;
}

export interface SentimentCounts {
  positive: number;
  neutral: number;
  negative: number;
}

export interface Totals {
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

export interface Metrics {
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

export interface Deltas {
  mention_rate: RateTrend | null;
  share_of_voice: RateTrend | null;
  primary_citation_rate: RateTrend | null;
}

export interface DataQuality {
  level: string;
  answered_count: number;
  reasons: string[];
}

export interface MentionSeriesPoint {
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

export interface CitationSeriesPoint {
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

export interface Denominators {
  cited_run_count: number;
  cited_total: number;
  unique_domains?: number;
  unique_pages?: number;
}

export interface CitedDomainItem {
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

export interface CitedPagePrompt {
  prompt_id: string;
  prompt_text: string;
  cited_run_count: number;
}

export interface CitedPageItem {
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

export interface PromptPerformanceItem {
  prompt_id: string;
  prompt_text: string;
  prompt_type: string;
  tags: string[];
  run_count: number;
  answered_count: number;
  mentioned_count: number;
  // The SoV numerator and its two denominators, per prompt. Present in
  // dto.PromptPerformanceItem and previously missing from this mirror, which
  // made an honest fixture fail to typecheck.
  mention_total: number;
  tracked_mention_total: number;
  brand_mention_total: number;
  rank_sum: number;
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

export interface AnswerCitation {
  url: string;
  domain: string;
  citation_type: string;
}

export interface LatestAnswerItem {
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

export interface GlossaryEntry {
  metric: string;
  definition: string;
  denominator?: string;
  gotcha?: string;
}

export interface FilterOption {
  id: string;
  display_name: string;
}
