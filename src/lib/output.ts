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
 *   json   One envelope, every time: { ok, command, data, page?, next?,
 *          warnings? }. `data` is the API payload, unmodified. The envelope
 *          exists because the guidance this CLI writes to stderr — what to run
 *          next, where you are in a list, what was quietly replaced — was
 *          invisible to the one audience that needed it most: `--output json`
 *          implies `--quiet`, and every Senso agent skill passes it.
 *   table  Aligned columns, scannable, cells truncated to keep the width sane.
 *          For looking at a list in a terminal.
 *   plain  Human-readable and complete. Nothing is truncated, and nested
 *          objects are indented sub-blocks rather than one line of JSON.
 */

import type { Command } from "commander";
import pc from "picocolors";
import { commandLine, hasOption } from "./command-line.js";
import * as log from "../utils/logger.js";

export type OutputFormat = "json" | "table" | "plain";

/** What a command needs in order to print. `Ctx` in run-action.ts satisfies it. */
export interface OutputContext {
  format: OutputFormat;
  quiet: boolean;
  /** "kb my-files" — echoed in the JSON envelope so a log line identifies itself. */
  command?: string;
  /** The Commander instance, used to rebuild an accurate next-page command. */
  commandRef?: Command;
}

/** One thing worth doing after this command, as a command that can be run. */
export interface NextStep {
  /** Why an agent would do this. One clause, no trailing period needed. */
  why: string;
  /** The exact command, with real ids substituted. */
  command: string;
}

/** Where this page sits in the full result set. */
export interface PageInfo {
  offset?: number;
  limit?: number;
  returned: number;
  total?: number;
  has_more?: boolean;
  /** The command that fetches the next page, with the caller's own filters. */
  next?: string;
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

  // A declared column that exists on no row is a bug in the command, not in the
  // data: it means the CLI is naming a field the API does not return, which is
  // how `tags list` shipped an empty first column for every row. Say so on
  // stderr rather than printing a blank column and looking finished.
  const absent = cols.filter((c) => !rows.some((r) => r[c] !== undefined));
  if (absent.length > 0) {
    log.warn(
      `This command asked for ${absent.map((c) => `\`${c}\``).join(", ")}, which the API did not return. Use --output json to see the real fields.`,
    );
  }

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
 * any response carrying a nested field. `plain` does not rely on this for
 * objects — it renders them as sub-blocks — but a table cell has one line.
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
 * Keys this API uses for "the list this endpoint returns".
 *
 * The strict envelope rule below is right about `/org/me` and wrong about every
 * endpoint that returns a page plus a scalar describing it: `questions list`
 * adds `sort_by`, `run-config model-options` adds `scope`, `competitors
 * suggest` adds `mode` and `cached`, `industries brands` adds `window` and
 * `totals`. None of those are pagination keys, so the whole list was being
 * stringified onto one line and the command's declared columns ignored.
 *
 * Naming the list keys explicitly keeps both behaviors: a payload whose array
 * sits under one of these IS the payload, whatever else travels with it, while
 * an organization that merely contains `locations` is still an organization.
 */
/*
 * Two names are deliberately absent, for the same reason.
 *
 * `tags` — every KBNodeResponse and ContentResponse carries one, so naming it a
 * list key made `kb get`, `kb create-folder`, `kb rename`, `kb move` and
 * `content get` render the record's TAGS and drop the record. An untagged node
 * — which is every node at creation — printed "No tags found." where the
 * kb_node_id should have been.
 *
 * `models` — `/org/me` returns the organization with a `models` array beside
 * its own fields, which demoted the organization to a header block.
 *
 * Both endpoints that really do return one of these lists return it alone, so
 * the "one candidate plus nothing but pagination" rule already covers them.
 * This is the same mistake the envelope rule was written to stop, and it is
 * worth being conservative about what counts as a list key.
 */
const LIST_KEYS = new Set([
  "items",
  "nodes",
  "data",
  "results",
  "contents",
  "rows",
  "records",
  "entries",
  "gaps",
  "prompts",
  "questions",
  "competitors",
  "destinations",
  "publishers",
  "runs",
  "claims",
  "evaluators",
  "versions",
  "owners",
  "brands",
  "domains",
  "pages",
  "industries",
  "suggestions",
  "model_options",
  "users",
  "members",
  "roles",
  "permissions",
  "grants",
  "content_types",
  "product_lines",
  "tracked_sources",
  "publish_records",
  "ctas",
  "logs",
  "sources",
  "imports",
  "history_imports",
  "generated_content",
  "citations",
  "mentions",
  "answers",
  "files",
  "folders",
  "occurrences",
  "resolutions",
  "industry_prompts",
  "children",
  "ancestors",
]);

/** The list inside a response, its key, and whatever else travelled with it. */
interface FoundList {
  key: string;
  rows: Record<string, unknown>[];
  /** Fields that are not the list and not pagination: a header worth printing. */
  extras: Record<string, unknown>;
}

/**
 * Finds the list inside a response, or decides there is not one.
 *
 * The API is not consistent about how it wraps a list — some endpoints return a
 * bare array, most wrap it (`{ items: [...], total }`, `{ nodes: [...] }`,
 * `{ data: [...] }`), and the key differs per endpoint. Rather than teach ~200
 * commands their own shape, this looks for the list.
 *
 * The subtlety, and the reason this is not simply "the first array property":
 * a single object often CONTAINS a list without being one. `/org/me` returns the
 * organization with a `locations: [...]` field, and an earlier version of this
 * function treated that as the payload — so `senso org get` rendered the
 * locations and silently dropped the organization's name, slug and tier from
 * both `plain` and `table`.
 *
 * So a payload counts as a list when its array sits under a known list key, or
 * when everything else in the object is pagination metadata. An empty array
 * still counts: "no results" is a result, and rendering the envelope as
 * key/value with one blank line is how an empty list used to look.
 */
function findList(data: unknown): FoundList | null {
  if (Array.isArray(data)) {
    return data.every(isPlainObject) ? { key: "results", rows: data, extras: {} } : null;
  }
  if (!isPlainObject(data)) return null;

  const entries = Object.entries(data);
  const candidates = entries.filter(([, v]) => Array.isArray(v) && v.every(isPlainObject)) as [
    string,
    Record<string, unknown>[],
  ][];
  if (candidates.length === 0) return null;

  // One array under a known list key wins outright; otherwise a single
  // candidate is only a list when everything beside it is pagination.
  const named = candidates.filter(([k]) => LIST_KEYS.has(k));
  let picked: [string, Record<string, unknown>[]] | undefined;
  if (named.length === 1) {
    picked = named[0];
  } else if (candidates.length === 1) {
    const [only] = candidates;
    if (!only) return null;
    const otherKeys = entries.map(([k]) => k).filter((k) => k !== only[0]);
    if (!otherKeys.every((k) => ENVELOPE_KEYS.has(k))) return null;
    picked = only;
  }
  if (!picked) return null;

  const [key, rows] = picked;
  const extras: Record<string, unknown> = {};
  for (const [k, v] of entries) {
    if (k === key || ENVELOPE_KEYS.has(k)) continue;
    extras[k] = v;
  }
  return { key, rows, extras };
}

/** Kept for callers that only need the rows. */
function findRows(data: unknown): Record<string, unknown>[] | null {
  return findList(data)?.rows ?? null;
}

/**
 * A single object as indented lines.
 *
 * Nested objects become sub-blocks and arrays of objects become numbered
 * sub-blocks, because the alternative — one line of JSON per nested field — put
 * exactly the fields an agent needs inside a string it then has to parse.
 * `kb get` is the case that matters: `content.processing_status` is the whole
 * point of the command and it was buried in an inline blob.
 */
function objectLines(data: Record<string, unknown>, indent = "  "): string[] {
  const keys = Object.keys(data);
  const flatKeys = keys.filter((k) => !isNested(data[k]));
  const width = Math.max(0, ...flatKeys.map((k) => k.length));
  const lines: string[] = [];

  for (const key of keys) {
    const value = data[key];
    if (Array.isArray(value) && value.length > 0 && value.every(isPlainObject)) {
      lines.push(`${indent}${pc.bold(key)} ${pc.dim(`(${String(value.length)})`)}`);
      value.forEach((item, i) => {
        lines.push(`${indent}  ${pc.dim(`${String(i + 1)}.`)}`);
        lines.push(...objectLines(item, `${indent}     `));
      });
      continue;
    }
    if (isPlainObject(value)) {
      if (Object.keys(value).length === 0) {
        lines.push(`${indent}${pc.bold(key.padEnd(width))}  ${pc.dim("(empty)")}`);
        continue;
      }
      lines.push(`${indent}${pc.bold(key)}`);
      lines.push(...objectLines(value, `${indent}  `));
      continue;
    }
    if (Array.isArray(value) && value.length === 0) {
      lines.push(`${indent}${pc.bold(key.padEnd(width))}  ${pc.dim("(none)")}`);
      continue;
    }
    lines.push(`${indent}${pc.bold(key.padEnd(width))}  ${scalar(value)}`);
  }
  return lines;
}

function isNested(value: unknown): boolean {
  if (isPlainObject(value)) return true;
  return Array.isArray(value) && value.length > 0 && value.every(isPlainObject);
}

/** A readable block per item, for `plain` output of a list. */
function itemBlocks(rows: Record<string, unknown>[], offset = 0): string[] {
  const lines: string[] = [];
  rows.forEach((row, i) => {
    if (i > 0) lines.push("");
    lines.push(`  ${pc.dim(`${String(offset + i + 1)}.`)}`);
    lines.push(...objectLines(row, "     "));
  });
  return lines;
}

/**
 * Per-command overrides.
 *
 * The generic renderer below is good enough for the great majority of commands,
 * which is the point — every command gets all three formats without 200 bespoke
 * renderers. Where a command has something better to say (search results,
 * analytics tables with their denominators), it passes its own.
 */
export interface EmitOptions {
  /** Columns, in order, for `table`. Defaults to the union of the rows' keys. */
  columns?: string[];
  /** Explicit rows, used by BOTH `table` and `plain` when the payload is a list. */
  rows?: Record<string, unknown>[];
  /** A handcrafted `table` rendering. */
  table?: { rows: Record<string, unknown>[]; columns?: string[] };
  /** A handcrafted `plain` rendering. */
  plain?: string | string[];
  /** Where this page sits. Derived from the payload when the API says. */
  page?: PageInfo;
  /** What to run next, with real ids substituted. */
  next?: NextStep[];
  /** Anything the caller may not expect: a replaced list, skipped items. */
  warnings?: string[];
  /** The plural noun for the empty case: "No documents found." */
  empty?: string;
  /** Why an empty list may be empty: a default filter, a hidden status. */
  emptyHint?: string;
}

/**
 * Print a payload in whichever format the user asked for.
 *
 * This is the only function most commands need. `json` always carries the raw
 * payload under `data`, so a command that supplies a nicer `plain` cannot
 * accidentally change what a script sees.
 */
export function emit(ctx: OutputContext, data: unknown, opts: EmitOptions = {}): void {
  const list = findList(data);
  const rows = opts.rows ?? opts.table?.rows ?? list?.rows ?? null;
  const page = opts.page ?? derivePage(ctx, data, rows);

  if (ctx.format === "json") {
    const envelope: Record<string, unknown> = {
      ok: true,
      command: ctx.command ?? "",
      data,
    };
    if (page) envelope.page = page;
    if (opts.next && opts.next.length > 0) envelope.next = opts.next;
    if (opts.warnings && opts.warnings.length > 0) envelope.warnings = opts.warnings;
    outputJson(envelope);
    return;
  }

  if (ctx.format === "table") {
    if (rows) {
      if (rows.length === 0) {
        outputPlain(`  ${emptyLine(opts, list)}`);
      } else {
        if (list && Object.keys(list.extras).length > 0) {
          outputPlain([...objectLines(list.extras), ""]);
        }
        outputTable(rows, opts.table?.columns ?? opts.columns);
      }
    } else if (isPlainObject(data)) {
      // A single object still has a useful table rendering: two columns, one row
      // per field. Falling back to JSON here — which is what this used to do —
      // meant `--output table` silently ignored the flag on most commands.
      outputTable(
        Object.entries(data).map(([field, value]) => ({ field, value: scalar(value) })),
        ["field", "value"],
      );
    } else if (data !== undefined) {
      outputPlain(scalar(data));
    }
    emitGuidance(ctx, page, opts, rows);
    return;
  }

  // plain
  if (opts.plain !== undefined) {
    outputPlain(opts.plain);
  } else if (rows) {
    const header =
      list && Object.keys(list.extras).length > 0 ? [...objectLines(list.extras), ""] : [];
    if (rows.length === 0) {
      outputPlain([...header, `  ${emptyLine(opts, list)}`]);
    } else {
      outputPlain([...header, ...itemBlocks(rows, page?.offset ?? 0)]);
    }
  } else if (isPlainObject(data)) {
    outputPlain(objectLines(data));
  } else if (data !== undefined) {
    outputPlain(scalar(data));
  }
  emitGuidance(ctx, page, opts, rows);
}

/** "No gaps found." — the noun comes from the command, or from the list key. */
function emptyLine(opts: EmitOptions, list: FoundList | null): string {
  const noun = opts.empty ?? list?.key.replace(/_/g, " ") ?? "results";
  return `No ${noun} found.`;
}

/**
 * The stderr half of an answer: where you are, what to run next, what to know.
 *
 * Never stdout — this is commentary, not payload. Under `--output json` it is
 * not printed at all, because the same information is in the envelope, where a
 * program can actually read it.
 */
function emitGuidance(
  ctx: OutputContext,
  page: PageInfo | undefined,
  opts: EmitOptions,
  rows: Record<string, unknown>[] | null,
): void {
  if (ctx.quiet) return;

  for (const warning of opts.warnings ?? []) {
    log.warn(warning);
  }

  if (rows?.length === 0 && opts.emptyHint) {
    log.hint(opts.emptyHint);
  }

  if (page?.returned && page.total !== undefined) {
    const from = (page.offset ?? 0) + 1;
    const to = (page.offset ?? 0) + page.returned;
    log.info(`Showing ${String(from)}–${String(to)} of ${String(page.total)}.`);
    if (page.next) log.hint(`Next page: ${page.next}`);
  }

  if (opts.next && opts.next.length > 0) {
    log.info("What you can do next:");
    for (const step of opts.next) {
      log.hint(`${step.why}: ${step.command}`);
    }
  }
}

/**
 * Where this page sits, read off the payload the API already sends.
 *
 * Derived rather than declared, so every list command reports its position
 * without 100 call sites remembering to. The next-page command is rebuilt from
 * the caller's own invocation, so it carries the filters they typed.
 */
function derivePage(
  ctx: OutputContext,
  data: unknown,
  rows: Record<string, unknown>[] | null,
): PageInfo | undefined {
  if (!rows || !isPlainObject(data)) return undefined;
  const d = data;
  const total = asNumber(d.total ?? d.total_count);
  const limit = asNumber(d.limit ?? d.page_size ?? d.per_page);
  const offset = asNumber(d.offset) ?? 0;
  const declaredMore = d.has_more === true;
  if (total === undefined && limit === undefined && !declaredMore) return undefined;

  const page: PageInfo = { returned: rows.length, offset };
  if (limit !== undefined) page.limit = limit;
  if (total !== undefined) page.total = total;
  page.has_more = total !== undefined ? offset + rows.length < total : declaredMore;

  if (page.has_more && ctx.commandRef && hasOption(ctx.commandRef, "offset")) {
    page.next = commandLine(ctx.commandRef, { offset: offset + rows.length });
  }
  return page;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** What a mutation changed, for the JSON envelope's `data`. */
export interface Confirmation {
  /** Past tense, lowercase: "deleted", "renamed", "published". */
  action: string;
  /** The resource type as a wire noun: "kb_node", "content", "gap". */
  resource: string;
  /** The id or ids affected. */
  id?: string | string[];
  [key: string]: unknown;
}

/**
 * Confirmation for a command that changed something but has no payload to show.
 *
 * Deletes and other 204s used to print a success tick to stdout, which meant
 * `--output json` emitted an unparseable line. Now the tick is a stderr
 * diagnostic and JSON callers get a real object naming what changed, rather
 * than a sentence they would have to parse to learn the id.
 */
export function emitConfirmation(
  ctx: OutputContext,
  message: string,
  data?: Confirmation,
  opts: { next?: NextStep[]; warnings?: string[] } = {},
): void {
  if (ctx.format === "json") {
    const envelope: Record<string, unknown> = {
      ok: true,
      command: ctx.command ?? "",
      data: data ?? { action: "ok", message },
    };
    if (opts.next && opts.next.length > 0) envelope.next = opts.next;
    if (opts.warnings && opts.warnings.length > 0) envelope.warnings = opts.warnings;
    outputJson(envelope);
    return;
  }
  // Not stdout: there is no payload here, and a caller piping this command
  // should receive an empty stream rather than a sentence.
  if (!ctx.quiet) {
    for (const warning of opts.warnings ?? []) log.warn(warning);
    console.error(`  ${pc.green("✓")} ${message}`);
    for (const step of opts.next ?? []) log.hint(`${step.why}: ${step.command}`);
  }
}

/** Exported for the few commands that need to know whether a payload is a list. */
export { findRows };
