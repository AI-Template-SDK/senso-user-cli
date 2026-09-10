/**
 * Presentation layer: the pure helpers behind every `senso analytics` view.
 *
 * These functions are small, and that is exactly why they are tested directly
 * rather than only through the commands. What is worth protecting here is the
 * one rule the whole analytics group exists to enforce:
 *
 *     a metric whose denominator was zero renders as "—", never as 0%.
 *
 * "—" means "not measured". 0% means "measured, and the answer was none". A
 * reader who confuses the two draws the opposite conclusion from the same
 * table, so the placeholder is asserted on its own, in every helper that can
 * produce it, instead of being left implied by a rendering test.
 *
 * The rest of the file protects the things a rendering test would let drift
 * quietly: that a rate is printed from the server's own display string rather
 * than re-derived from the float, that a trend keeps its semantic direction
 * next to the number, that `notes[]` reaches plain and table output but never
 * json, and that the window and data-quality context travels alongside a table
 * that cannot carry it.
 */

import { describe, expect, it, vi } from "vitest";
import {
  count,
  emitContext,
  emitNotes,
  METRIC_COLUMNS,
  metricPlainLines,
  metricRows,
  NO_VALUE,
  position,
  qualityLine,
  rate,
  ratio,
  trend,
  truncate,
  windowLine,
} from "../../src/commands/analytics/render.js";
import type { Ctx } from "../../src/lib/run-action.js";
import type {
  AnalyticsWindow,
  DataQuality,
  Deltas,
  Metrics,
  Rate,
  RateTrend,
  Totals,
} from "../../src/commands/analytics/types.js";

// ---------------------------------------------------------------------------
// Fixtures, shaped exactly like the API's DTOs
// ---------------------------------------------------------------------------

const r = (value: number, display: string): Rate => ({ value, display });

const WINDOW: AnalyticsWindow = {
  from: "2025-08-01",
  to: "2025-08-30",
  days: 30,
  latest_data_day: "2025-08-29",
};

const QUALITY: DataQuality = { level: "good", answered_count: 1460, reasons: [] };

const TOTALS: Totals = {
  run_count: 480,
  answered_count: 460,
  mentioned_count: 122,
  mention_total: 168,
  tracked_mention_total: 540,
  brand_mention_total: 1400,
  rank_sum: 390,
  sentiment: { positive: 70, neutral: 40, negative: 12 },
  cited_run_count: 300,
  primary_cited_run_count: 45,
  tracked_cited_run_count: 90,
  external_cited_run_count: 280,
  cited_total: 1200,
  primary_cited_total: 60,
  tracked_cited_total: 150,
  external_cited_total: 990,
  prompt_count: 24,
  model_count: 4,
  location_count: 2,
};

const METRICS: Metrics = {
  mention_rate: r(0.2652, "26.5%"),
  share_of_voice: r(0.12, "12.0%"),
  avg_rank: r(3.2, "#3.2"),
  primary_citation_rate: r(0.15, "15.0%"),
  tracked_citation_rate: r(0.3, "30.0%"),
  external_citation_rate: r(0.9333, "93.3%"),
  primary_citation_share: r(0.05, "5.0%"),
  tracked_citation_share: r(0.125, "12.5%"),
  external_citation_share: r(0.825, "82.5%"),
  citations_per_answer: r(4, "4.0"),
};

/** Every metric null: the shape the API returns when nothing was measured. */
const NO_METRICS: Metrics = {
  mention_rate: null,
  share_of_voice: null,
  avg_rank: null,
  primary_citation_rate: null,
  tracked_citation_rate: null,
  external_citation_rate: null,
  primary_citation_share: null,
  tracked_citation_share: null,
  external_citation_share: null,
  citations_per_answer: null,
};

const DELTAS: Deltas = {
  mention_rate: { prev: 0.21, delta: 0.055, direction: "improved", display: "+5.5pp" },
  share_of_voice: { prev: 0.132, delta: -0.012, direction: "declined", display: "-1.2pp" },
  primary_citation_rate: null,
};

/** Captures stdout for one call. outputPlain writes through console.log. */
function capture(fn: () => void): string {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...p: unknown[]) => {
    lines.push(p.map(String).join(" "));
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return lines.join("\n");
}

const ctx = (format: Ctx["format"]): Ctx => ({ format, quiet: format === "json", debug: false });

// ---------------------------------------------------------------------------
// The placeholder itself
// ---------------------------------------------------------------------------

describe("the null-denominator placeholder", () => {
  it("is an em dash and not a zero of any kind", () => {
    // Asserted literally: the one thing that must never happen is this constant
    // being redefined as "0", "0%" or "" to make a table look tidier.
    expect(NO_VALUE).toBe("—");
    expect(NO_VALUE).not.toMatch(/0/);
  });
});

describe("rate, rendering a metric", () => {
  it("prints the server's display string rather than re-deriving it", () => {
    // 0.2652 rounds to 26.5% or 26.52% depending on who does the rounding. The
    // server already decided, and the CLI must not disagree with the app.
    expect(rate(r(0.2652, "26.5%"))).toBe("26.5%");
  });

  it("renders the placeholder when the metric is null", () => {
    expect(rate(null)).toBe(NO_VALUE);
  });

  it("renders the placeholder when the metric is absent altogether", () => {
    expect(rate(undefined)).toBe(NO_VALUE);
  });

  it("renders a genuine zero as zero, not as the placeholder", () => {
    // The distinction the whole file exists for: a measured 0% is data.
    expect(rate(r(0, "0.0%"))).toBe("0.0%");
  });

  it("falls back to the placeholder when display is not a string", () => {
    // A malformed payload must not print "undefined" or "[object Object]" into
    // a column a reader will quote.
    expect(rate({ display: undefined })).toBe(NO_VALUE);
    expect(rate({ display: 26.5 } as unknown as Rate)).toBe(NO_VALUE);
  });
});

describe("count, rendering a raw number", () => {
  it("groups thousands so a long number stays readable", () => {
    expect(count(1234567)).toBe("1,234,567");
  });

  it("renders zero as zero", () => {
    expect(count(0)).toBe("0");
  });

  it("renders the placeholder for a missing count", () => {
    expect(count(null)).toBe(NO_VALUE);
    expect(count(undefined)).toBe(NO_VALUE);
  });
});

describe("position, rendering an average rank", () => {
  it("prints one decimal place behind a hash", () => {
    expect(position(3.24)).toBe("#3.2");
  });

  it("renders the placeholder when no rank was recorded", () => {
    expect(position(null)).toBe(NO_VALUE);
    expect(position(undefined)).toBe(NO_VALUE);
  });
});

describe("trend, rendering window-over-window movement", () => {
  it("keeps the semantic direction next to the number", () => {
    // "-1.2pp" alone is ambiguous for a metric where lower is better, which is
    // why the server sends a direction and the CLI prints it.
    const t: RateTrend = { prev: 0.132, delta: -0.012, direction: "declined", display: "-1.2pp" };
    expect(trend(t)).toBe("-1.2pp (declined)");
  });

  it("renders the placeholder when there is no previous window to compare", () => {
    expect(trend(null)).toBe(NO_VALUE);
    expect(trend(undefined)).toBe(NO_VALUE);
  });
});

describe("ratio, showing the math behind a percentage", () => {
  it("prints numerator, denominator and the unit being counted", () => {
    expect(ratio(45, 300, "cited answers")).toBe("45 / 300 cited answers");
  });

  it("groups both halves", () => {
    expect(ratio(1200, 45000, "citations")).toBe("1,200 / 45,000 citations");
  });

  it("still shows a zero denominator, so the reader can see why the rate is —", () => {
    // The counts column is the explanation for the placeholder next to it.
    expect(ratio(0, 0, "answers")).toBe("0 / 0 answers");
  });
});

describe("truncate", () => {
  it("leaves a short value alone", () => {
    expect(truncate("best crm for startups", 40)).toBe("best crm for startups");
  });

  it("collapses newlines and runs of whitespace into single spaces", () => {
    expect(truncate("what is\n\n  senso   ?", 40)).toBe("what is senso ?");
  });

  it("trims the ends", () => {
    expect(truncate("   padded   ", 40)).toBe("padded");
  });

  it("cuts to exactly the requested width, ellipsis included", () => {
    const out = truncate("abcdefghij", 5);
    expect(out).toBe("abcd…");
    expect(out).toHaveLength(5);
  });

  it("renders a missing value as the empty string rather than 'undefined'", () => {
    expect(truncate(undefined, 20)).toBe("");
  });
});

describe("windowLine", () => {
  it("names the window, its length and the freshest day with data", () => {
    const line = windowLine(WINDOW);
    expect(line).toContain("2025-08-01");
    expect(line).toContain("2025-08-30");
    expect(line).toContain("30 days");
    expect(line).toContain("latest data 2025-08-29");
  });

  it("says outright when the window contains no data days", () => {
    // Silence here would read as a fresh window that happened to be all zeros.
    const line = windowLine({ ...WINDOW, latest_data_day: null });
    expect(line).toContain("no data days in window");
    expect(line).not.toContain("latest data");
  });

  it("renders nothing when the response carried no window", () => {
    expect(windowLine(undefined)).toBe("");
  });
});

describe("qualityLine", () => {
  it("names the level and the sample it was judged on", () => {
    const line = qualityLine(QUALITY);
    expect(line).toContain("good");
    expect(line).toContain("1,460");
    expect(line).toContain("answered runs");
  });

  it("renders nothing when the response carried no data quality block", () => {
    expect(qualityLine(undefined)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// The context lines a table cannot carry
// ---------------------------------------------------------------------------

describe("emitContext", () => {
  it("prints the context above a table, which has nowhere else to put it", () => {
    const out = capture(() => {
      emitContext(ctx("table"), ["  Analytics summary", windowLine(WINDOW)]);
    });

    expect(out).toContain("Analytics summary");
    expect(out).toContain("2025-08-01");
  });

  it("prints nothing in plain, where the command builds the same lines itself", () => {
    // Otherwise every plain run would show the window twice.
    const out = capture(() => {
      emitContext(ctx("plain"), ["  Analytics summary", windowLine(WINDOW)]);
    });

    expect(out).toBe("");
  });

  it("prints nothing in json, which must stay a parseable payload", () => {
    const out = capture(() => {
      emitContext(ctx("json"), ["  Analytics summary", windowLine(WINDOW)]);
    });

    expect(out).toBe("");
  });

  it("drops empty lines and prints nothing at all when every line is empty", () => {
    // windowLine and qualityLine both return "" for an absent block, so a
    // response without them must not open with a run of blank lines.
    const out = capture(() => {
      emitContext(ctx("table"), ["", windowLine(undefined), qualityLine(undefined)]);
    });

    expect(out).toBe("");
  });
});

// ---------------------------------------------------------------------------
// notes[] — the caveats that stop a reader misreading the numbers
// ---------------------------------------------------------------------------

describe("emitNotes", () => {
  const NOTES = [
    "Share of voice divides by mentions of every brand, not only tracked competitors.",
    "A metric is null when its denominator was zero.",
  ];

  it("prints every note under a Notes heading in plain output", () => {
    const out = capture(() => {
      emitNotes(ctx("plain"), NOTES);
    });

    expect(out).toContain("Notes");
    for (const note of NOTES) expect(out).toContain(note);
  });

  it("prints them in table output too, where the table itself cannot carry them", () => {
    const out = capture(() => {
      emitNotes(ctx("table"), NOTES);
    });

    expect(out).toContain("Notes");
    expect(out).toContain(NOTES[0]!);
  });

  it("prints nothing in json, where they are already part of the payload", () => {
    // Printing them here would put prose after the JSON document and break
    // every caller piping stdout into a parser.
    const out = capture(() => {
      emitNotes(ctx("json"), NOTES);
    });

    expect(out).toBe("");
  });

  it("prints no empty heading when the response carried no notes", () => {
    expect(
      capture(() => {
        emitNotes(ctx("plain"), []);
      }),
    ).toBe("");
    expect(
      capture(() => {
        emitNotes(ctx("plain"), undefined);
      }),
    ).toBe("");
  });
});

// ---------------------------------------------------------------------------
// The headline metric table
// ---------------------------------------------------------------------------

describe("metricRows", () => {
  const byMetric = (rows: Record<string, unknown>[]): Record<string, Record<string, unknown>> =>
    Object.fromEntries(rows.map((row) => [String(row.metric), row]));

  it("emits one row per headline metric, in a fixed order", () => {
    const rows = metricRows(TOTALS, METRICS, DELTAS);

    expect(rows.map((row) => row.metric)).toEqual([
      "Mention Rate",
      "Share of Voice",
      "Avg Rank",
      "Citation Rate (Owned)",
      "Citation Rate (Tracked)",
      "Citation Rate (External)",
      "Citation Share (Owned)",
      "Citation Share (Tracked)",
      "Citation Share (External)",
      "Citations per Answer",
      "Sentiment (pos/neu/neg)",
    ]);
  });

  it("puts every rate next to the counts it was computed from", () => {
    const rows = byMetric(metricRows(TOTALS, METRICS, DELTAS));

    expect(rows["Mention Rate"]).toMatchObject({
      value: "26.5%",
      counts: "122 / 460 answers",
    });
  });

  it("names the share-of-voice denominator as every brand, not the tracked set", () => {
    // brand_mention_total, not tracked_mention_total. Using the tracked set
    // would inflate the figure and disagree with the app.
    const rows = byMetric(metricRows(TOTALS, METRICS, DELTAS));

    expect(rows["Share of Voice"]!.counts).toBe("168 / 1,400 mentions (all brands)");
  });

  it("divides the citation rates by D and the citation shares by S", () => {
    // The distinction the README spells out: rates are per cited answer,
    // shares are per citation instance. Swapping them is a silent wrong number.
    const rows = byMetric(metricRows(TOTALS, METRICS, DELTAS));

    expect(rows["Citation Rate (Owned)"]!.counts).toBe("45 / 300 cited answers");
    expect(rows["Citation Share (Owned)"]!.counts).toBe("60 / 1,200 citations");
  });

  it("attaches a trend only to the three metrics the API sends deltas for", () => {
    const rows = byMetric(metricRows(TOTALS, METRICS, DELTAS));

    expect(rows["Mention Rate"]!["vs prev"]).toBe("+5.5pp (improved)");
    expect(rows["Share of Voice"]!["vs prev"]).toBe("-1.2pp (declined)");
    // Sent as null by this fixture, and never sent at all for the rest.
    expect(rows["Citation Rate (Owned)"]!["vs prev"]).toBe(NO_VALUE);
    expect(rows["Avg Rank"]!["vs prev"]).toBe(NO_VALUE);
  });

  it("renders every trend as the placeholder when no deltas were supplied", () => {
    // `prompt <promptId>` prints the same table without a comparison window.
    const rows = metricRows(TOTALS, METRICS);

    for (const row of rows) expect(row["vs prev"]).toBe(NO_VALUE);
  });

  it("renders every value as the placeholder when nothing was measured", () => {
    const rows = byMetric(metricRows(TOTALS, NO_METRICS, null));

    for (const name of Object.keys(rows)) {
      if (name === "Sentiment (pos/neu/neg)") continue;
      expect(rows[name]!.value, `${name} should render as "not measured"`).toBe(NO_VALUE);
    }
  });

  it("keeps the counts visible even when the value is the placeholder", () => {
    // The row still has to explain itself: "— (0 / 0 answers)" tells the reader
    // there was no denominator, where "—" alone looks like a bug.
    const empty: Totals = { ...TOTALS, mentioned_count: 0, answered_count: 0 };
    const rows = metricRows(empty, NO_METRICS, null);

    expect(rows[0]).toMatchObject({ value: NO_VALUE, counts: "0 / 0 answers" });
  });

  it("prints sentiment as three counts that sum to the mentioned answers", () => {
    const rows = byMetric(metricRows(TOTALS, METRICS, DELTAS));

    expect(rows["Sentiment (pos/neu/neg)"]!.value).toBe("70 / 40 / 12");
    expect(rows["Sentiment (pos/neu/neg)"]!.counts).toContain("122");
  });

  it("survives a response with no sentiment block rather than throwing", () => {
    const partial = { ...TOTALS, sentiment: undefined } as unknown as Totals;
    const rows = metricRows(partial, METRICS, DELTAS);

    expect(rows[10]!.value).toBe(`${NO_VALUE} / ${NO_VALUE} / ${NO_VALUE}`);
  });

  it("declares the columns the table renders, in order", () => {
    expect(METRIC_COLUMNS).toEqual(["metric", "value", "counts", "vs prev"]);
    // Every column named must exist on every row, or the cell renders blank.
    for (const row of metricRows(TOTALS, METRICS, DELTAS)) {
      for (const col of METRIC_COLUMNS) expect(row).toHaveProperty(col);
    }
  });
});

describe("metricPlainLines", () => {
  it("pads the metric names to a common width so the values line up", () => {
    const rows = metricRows(TOTALS, METRICS, DELTAS);
    const lines = metricPlainLines(rows);
    // The widest name in the table decides the column, whatever it happens to be.
    const width = Math.max(...rows.map((row) => String(row.metric).length));

    expect(lines).toHaveLength(rows.length);
    for (const [i, line] of lines.entries()) {
      expect(line).toContain(String(rows[i]!.metric).padEnd(width));
    }
  });

  it("puts the counts in parentheses after the value", () => {
    const [first] = metricPlainLines(metricRows(TOTALS, METRICS, DELTAS));

    expect(first).toContain("Mention Rate");
    expect(first).toContain("26.5%");
    expect(first).toContain("(122 / 460 answers)");
  });

  it("appends the comparison only where there is one", () => {
    const lines = metricPlainLines(metricRows(TOTALS, METRICS, DELTAS));

    expect(lines[0]).toContain("vs prev: +5.5pp (improved)");
    // Avg Rank has no delta, so the trailing clause is omitted entirely rather
    // than printed as "vs prev: —".
    expect(lines[2]).not.toContain("vs prev");
  });

  it("prints the placeholder as the value when nothing was measured", () => {
    const lines = metricPlainLines(metricRows(TOTALS, NO_METRICS, null));

    expect(lines[0]).toContain(NO_VALUE);
    expect(lines[0]).not.toContain("0%");
  });
});
