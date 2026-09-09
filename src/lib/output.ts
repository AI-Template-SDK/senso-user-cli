import pc from "picocolors";

export type OutputFormat = "json" | "table" | "plain";

export function outputJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

export function outputTable(rows: Record<string, unknown>[], columns?: string[]): void {
  if (rows.length === 0) {
    console.log(pc.dim("  No results."));
    return;
  }

  // rows[0] is always present here — the empty case returned above — but the
  // compiler cannot see that through the length check. `?? {}` yields the same
  // empty column list the caller would get from an empty row, without a
  // non-null assertion that would silently lie if the guard above ever moved.
  const cols = columns ?? Object.keys(rows[0] ?? {});

  // Column width is the widest cell, header included. Paired with its column so
  // the two lists cannot drift apart when one of them is indexed.
  const layout = cols.map((col) => ({
    col,
    width: rows.reduce((max, row) => Math.max(max, String(row[col] ?? "").length), col.length),
  }));

  const header = layout.map(({ col, width }) => pc.bold(col.padEnd(width))).join("  ");
  console.log(`  ${header}`);
  console.log(`  ${layout.map(({ width }) => "─".repeat(width)).join("  ")}`);

  for (const row of rows) {
    const line = layout.map(({ col, width }) => String(row[col] ?? "").padEnd(width)).join("  ");
    console.log(`  ${line}`);
  }
}

export function outputPlain(lines: string | string[]): void {
  const arr = Array.isArray(lines) ? lines : [lines];
  for (const line of arr) {
    console.log(line);
  }
}

export function output(
  format: OutputFormat,
  data: {
    json: unknown;
    table?: { rows: Record<string, unknown>[]; columns?: string[] };
    plain: string | string[];
  },
): void {
  switch (format) {
    case "json":
      outputJson(data.json);
      break;
    case "table":
      if (data.table) {
        outputTable(data.table.rows, data.table.columns);
      } else {
        outputJson(data.json);
      }
      break;
    case "plain":
      outputPlain(data.plain);
      break;
  }
}
