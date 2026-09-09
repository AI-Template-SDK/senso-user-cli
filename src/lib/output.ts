/**
 * Everything the CLI prints goes through here or through utils/logger.ts.
 *
 * The rule this module exists to enforce, in one line:
 *
 *     stdout carries the payload and nothing else; everything else is stderr.
 *
 * That is what makes `senso ... --output json | jq` work without also having to
 * pass `--quiet`, and what lets an agent treat stdout as parseable without
 * filtering banners, spinners and success ticks out of it first. ESLint blocks
 * `console.*` everywhere but this file, utils/logger.ts and utils/branding.ts,
 * so the rule cannot quietly stop being true.
 *
 * Three formats, and the difference between the last two is real:
 *
 *   json   The API payload, pretty-printed, unmodified. The contract for
 *          scripts and agents. Never decorated, never truncated, never colored.
 *   table  Aligned columns, scannable, cells truncated to keep the width sane.
 *          For looking at a list in a terminal.
 *   plain  Human-readable and complete. Nothing is truncated, so it is the one
 *          to use when you need to read a long field.
 */

import pc from "picocolors";

export type OutputFormat = "json" | "table" | "plain";

/** What a command needs in order to print. `Ctx` in run-action.ts satisfies it. */
export interface OutputContext {
  format: OutputFormat;
  quiet: boolean;
}

/** Cells wider than this are truncated in `table`. `plain` never truncates. */
const MAX_CELL_WIDTH = 48;

/** Beyond this many columns a table stops being readable in a terminal. */
const MAX_COLUMNS = 8;

/**
 * Write a fragment of payload to stdout, unbuffered and without a newline.
 *
 * The one legitimate reason to bypass the line-oriented helpers below: a
 * streamed answer, where showing tokens as they arrive is the point. Everything
 * written here is still payload, so the contract holds — this is the exception
 * that proves the stream is stdout's alone.
 */
export function writeStdout(chunk: string): void {
  process.stdout.write(chunk);
}

export function outputJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

export function outputPlain(lines: string | string[]): void {
  for (const line of Array.isArray(lines) ? lines : [lines]) {
    console.log(line);
  }
}

export function outputTable(rows: Record<string, unknown>[], columns?: string[]): void {
  if (rows.length === 0) {
    console.log(pc.dim("  No results."));
    return;
  }

  const cols = (columns ?? unionOfKeys(rows)).slice(0, MAX_COLUMNS);

  // Column width is the widest cell, header included. Paired with its column so
  // the two lists cannot drift apart when one of them is indexed.
  const layout = cols.map((col) => ({
    col,
    width: rows.reduce((max, row) => Math.max(max, cell(row[col]).length), col.length),
  }));

  console.log(`  ${layout.map(({ col, width }) => pc.bold(col.padEnd(width))).join("  ")}`);
  console.log(`  ${layout.map(({ width }) => "─".repeat(width)).join("  ")}`);
  for (const row of rows) {
    console.log(`  ${layout.map(({ col, width }) => cell(row[col]).padEnd(width)).join("  ")}`);
  }
}

/**
 * The union of every row's keys, in first-seen order.
 *
 * Not `Object.keys(rows[0])`: API list responses routinely omit a null field on
 * some rows, so keying off the first row silently drops a column that most of
 * the results have.
 */
function unionOfKeys(rows: Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) seen.add(key);
  }
  return [...seen];
}

/** One table cell: single-line, truncated, never `[object Object]`. */
function cell(value: unknown): string {
  const flat = scalar(value).replace(/\s+/g, " ").trim();
  return flat.length > MAX_CELL_WIDTH ? `${flat.slice(0, MAX_CELL_WIDTH - 1)}…` : flat;
}

/**
 * A value as text, for a cell or a `key: value` line.
 *
 * Nested objects and arrays become JSON rather than "[object Object]", which is
 * what `String(value)` produced before and what made `--output table` useless on
 * any response carrying a nested field.
 */
function scalar(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value) && value.every((v) => typeof v !== "object" || v === null)) {
    return value.map((v) => scalar(v)).join(", ");
  }
  // Always a string here: the checks above have excluded null, undefined and
  // every primitive, and these values come from JSON.parse, so there is no
  // function or symbol left for JSON.stringify to return undefined for.
  return JSON.stringify(value);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Keys a list envelope is allowed to carry besides the list itself.
 *
 * See findRows: this set is what separates "a page of results" from "one object
 * that happens to contain a list".
 */
const ENVELOPE_KEYS = new Set([
  "total",
  "total_count",
  "count",
  "limit",
  "offset",
  "page",
  "page_size",
  "per_page",
  "has_more",
  "next",
  "previous",
  "cursor",
  "next_cursor",
]);

/**
 * Finds the list inside a response, or decides there is not one.
 *
 * The API is not consistent about how it wraps a list — some endpoints return a
 * bare array, most wrap it (`{ items: [...], total }`, `{ nodes: [...] }`,
 * `{ data: [...] }`), and the key differs per endpoint. Rather than teach ~150
 * commands their own shape, this looks for the list.
 *
 * The subtlety, and the reason this is not simply "the first array property":
 * a single object often CONTAINS a list without being one. `/org/me` returns the
 * organization with a `locations: [...]` field, and an earlier version of this
 * function treated that as the payload — so `senso org get` rendered the
 * locations and silently dropped the organization's name, slug and tier from
 * both `plain` and `table`. Only `--output json` was unaffected, which is why it
 * went unnoticed.
 *
 * So a payload counts as a list only when it is *nothing but* a list plus
 * pagination metadata. Anything carrying its own fields is a single object with
 * a nested list, and renders as key/value.
 *
 * Returns null for "render this as a single object".
 */
function findRows(data: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(data)) {
    return data.every(isPlainObject) ? data : null;
  }
  if (!isPlainObject(data)) return null;

  const entries = Object.entries(data);
  const arrays = entries.filter(
    ([, v]) => Array.isArray(v) && v.length > 0 && v.every(isPlainObject),
  );

  // Exactly one candidate list, and every other key is pagination metadata.
  if (arrays.length !== 1) return null;
  const [listKey, list] = arrays[0] as [string, Record<string, unknown>[]];

  const otherKeys = entries.map(([k]) => k).filter((k) => k !== listKey);
  if (!otherKeys.every((k) => ENVELOPE_KEYS.has(k))) return null;

  return list;
}

/** `key: value` lines for a single object, one per line, nothing truncated. */
function keyValueLines(data: Record<string, unknown>): string[] {
  const width = Math.max(0, ...Object.keys(data).map((k) => k.length));
  return Object.entries(data).map(
    ([key, value]) => `  ${pc.bold(key.padEnd(width))}  ${scalar(value)}`,
  );
}

/** A readable block per item, for `plain` output of a list. */
function itemBlocks(rows: Record<string, unknown>[]): string[] {
  const lines: string[] = [];
  rows.forEach((row, i) => {
    if (i > 0) lines.push("");
    lines.push(...keyValueLines(row));
  });
  return lines;
}

/**
 * Per-command overrides.
 *
 * The generic renderer below is good enough for the great majority of commands,
 * which is the point — every command gets all three formats without 150 bespoke
 * renderers. Where a command has something better to say (search results,
 * analytics tables with their denominators), it passes its own.
 */
export interface EmitOptions {
  /** Columns, in order, for `table`. Defaults to the union of the rows' keys. */
  columns?: string[];
  /** A handcrafted `table` rendering. */
  table?: { rows: Record<string, unknown>[]; columns?: string[] };
  /** A handcrafted `plain` rendering. */
  plain?: string | string[];
}

/**
 * Print a payload in whichever format the user asked for.
 *
 * This is the only function most commands need. `json` is always the raw
 * payload, so a command that supplies a nicer `plain` cannot accidentally change
 * what a script sees.
 */
export function emit(ctx: OutputContext, data: unknown, opts: EmitOptions = {}): void {
  if (ctx.format === "json") {
    outputJson(data);
    return;
  }

  const rows = opts.table?.rows ?? findRows(data);

  if (ctx.format === "table") {
    if (rows) {
      outputTable(rows, opts.table?.columns ?? opts.columns);
      return;
    }
    // A single object still has a useful table rendering: two columns, one row
    // per field. Falling back to JSON here — which is what this used to do —
    // meant `--output table` silently ignored the flag on most commands.
    if (isPlainObject(data)) {
      outputTable(
        Object.entries(data).map(([field, value]) => ({ field, value: scalar(value) })),
        ["field", "value"],
      );
      return;
    }
    outputPlain(scalar(data));
    return;
  }

  // plain
  if (opts.plain !== undefined) {
    outputPlain(opts.plain);
    return;
  }
  if (rows) {
    outputPlain(rows.length === 0 ? pc.dim("  No results.") : itemBlocks(rows));
    return;
  }
  if (isPlainObject(data)) {
    outputPlain(keyValueLines(data));
    return;
  }
  if (data === undefined) return;
  outputPlain(scalar(data));
}

/**
 * Confirmation for a command that changed something but has no payload to show.
 *
 * Deletes and other 204s used to print a success tick to stdout, which meant
 * `--output json` emitted an unparseable line. Now the tick is a stderr
 * diagnostic and JSON callers get a real object to check.
 */
export function emitConfirmation(ctx: OutputContext, message: string, data?: unknown): void {
  if (ctx.format === "json") {
    outputJson(data ?? { ok: true, message });
    return;
  }
  // Not stdout: there is no payload here, and a caller piping this command
  // should receive an empty stream rather than a sentence.
  if (!ctx.quiet) {
    console.error(`  ${pc.green("✓")} ${message}`);
  }
}
