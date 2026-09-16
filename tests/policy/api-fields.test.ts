/**
 * Policy: a command may not render a column the API does not return.
 *
 * WHAT IS WORTH PROTECTING HERE. `tags list` asked for `tag_id`, `competitors
 * list` for `competitor_id` and `tracked-sources list` for `source_id`; all
 * three DTOs call that field `id`. Every row printed a blank first column — the
 * one column carrying the id an agent needs for the next command — and the
 * suite stayed green because the MSW fixtures invented the CLI's spelling
 * rather than copying the API's.
 *
 * Two layers catch that now. At runtime `outputTable` warns when a declared
 * column is absent from every row, which is exact but only fires against real
 * data. This test is the static half: it reads the field names out of the
 * senso-api DTOs (checked in as a fixture by `make api-fields`) and fails on a
 * column name that appears nowhere in the API at all.
 *
 * It is deliberately a weak check — `tag_id` IS a real field on a different
 * endpoint, so this test alone would not have caught it. It catches invented
 * names, and the fixture doubles as a record of the API surface that shows up
 * in a diff when a field is renamed.
 *
 * Columns that index rows the CLI builds itself (`emit(ctx, data, { table: {
 * rows, columns } })`) are exempt: those names are the CLI's own, not the
 * API's.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const COMMANDS_DIR = join(process.cwd(), "src", "commands");
const FIXTURE = join(process.cwd(), "tests", "policy", "api-fields.json");

const apiFields = new Set<string>(
  (JSON.parse(readFileSync(FIXTURE, "utf8")) as { fields: string[] }).fields,
);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

interface Declared {
  file: string;
  line: number;
  columns: string[];
}

/** Every `emit(ctx, data, { columns })` that indexes the API payload directly. */
function declaredColumns(file: string): Declared[] {
  const source = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true);
  const found: Declared[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "emit" &&
      node.arguments.length >= 3
    ) {
      const opts = node.arguments[2];
      if (opts && ts.isObjectLiteralExpression(opts)) {
        const names = opts.properties
          .filter(ts.isPropertyAssignment)
          .map((p) => p.name.getText(sf));
        // `table`, `rows` and `plain` mean the command supplied its own rows,
        // so the column names are keys it invented and are not the API's.
        const ownRows =
          names.includes("table") || names.includes("rows") || names.includes("plain");
        const columns = opts.properties
          .filter(ts.isPropertyAssignment)
          .find((p) => p.name.getText(sf) === "columns");
        if (!ownRows && columns && ts.isArrayLiteralExpression(columns.initializer)) {
          found.push({
            file,
            line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1,
            columns: columns.initializer.elements.filter(ts.isStringLiteral).map((e) => e.text),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return found;
}

describe("columns name fields the API actually returns", () => {
  const declarations = sourceFiles(COMMANDS_DIR).flatMap(declaredColumns);

  it("finds the emit() calls that render the API payload directly", () => {
    // A guard on the guard: if this drops to zero the AST walk has stopped
    // matching and every assertion below would pass vacuously.
    expect(declarations.length).toBeGreaterThan(20);
  });

  it("declares no column that appears in no senso-api DTO", () => {
    const offenders = declarations
      .map(({ file, line, columns }) => ({
        where: `${file.replace(process.cwd() + "/", "")}:${String(line)}`,
        unknown: columns.filter((c) => !apiFields.has(c)),
      }))
      .filter((d) => d.unknown.length > 0);

    expect(
      offenders,
      offenders
        .map((o) => `${o.where} renders ${o.unknown.map((u) => `"${u}"`).join(", ")}`)
        .join("\n") +
        "\n\nNo senso-api DTO has these json tags. Either the field was renamed, or the command is naming a field that never existed. Refresh the fixture with `make api-fields` if the API added it.",
    ).toEqual([]);
  });
});
