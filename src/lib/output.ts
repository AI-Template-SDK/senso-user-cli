import pc from "picocolors";

export type OutputFormat = "json" | "table" | "plain";

export function outputJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

export function outputTable(
  rows: Record<string, unknown>[],
  columns?: string[],
): void {
  if (rows.length === 0) {
    console.log(pc.dim("  No results."));
    return;
  }

  const cols = columns || Object.keys(rows[0]);
  const widths = cols.map((col) => {
    const maxVal = rows.reduce(
      (max, row) => Math.max(max, String(row[col] ?? "").length),
      0,
    );
    return Math.max(col.length, maxVal);
  });

  // Header
  const header = cols
    .map((col, i) => pc.bold(col.padEnd(widths[i])))
    .join("  ");
  console.log(`  ${header}`);
  console.log(`  ${widths.map((w) => "─".repeat(w)).join("  ")}`);

  // Rows
  for (const row of rows) {
    const line = cols
      .map((col, i) => String(row[col] ?? "").padEnd(widths[i]))
      .join("  ");
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
