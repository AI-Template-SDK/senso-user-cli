/**
 * Extracts every response field name the API can return, into a fixture.
 *
 * `tests/policy/api-fields.test.ts` uses it to fail a command that renders a
 * column the API does not produce. That is not hypothetical: `tags list`,
 * `competitors list` and `tracked-sources list` all asked for `<thing>_id`
 * while the DTOs return `id`, so the first column of every row was blank — and
 * the MSW fixtures invented the CLI's spelling, so the suite stayed green.
 *
 * The fixture is committed. Tests never read the sibling repository, both
 * because they must not depend on a checkout that may not exist and because a
 * generated file in git makes a field name disappearing from the API visible in
 * a diff.
 *
 * Usage:  node scripts/gen-api-fields.mjs [--check]
 *         SENSO_API_DIR=/path/to/senso-api node scripts/gen-api-fields.mjs
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const API_DIR = process.env.SENSO_API_DIR ?? resolve(process.cwd(), "..", "senso-api");
const DTO_DIR = join(API_DIR, "internal", "api", "dto");
const OUT = resolve(process.cwd(), "tests", "policy", "api-fields.json");
const check = process.argv.includes("--check");

if (!existsSync(DTO_DIR)) {
  console.error(
    `senso-api DTOs not found at ${DTO_DIR}.\n` +
      "Clone senso-api beside this repo, or set SENSO_API_DIR. The committed fixture is still valid; this script only refreshes it.",
  );
  process.exit(1);
}

/** `json:"kb_node_id,omitempty"` → kb_node_id. */
const JSON_TAG = /json:"([^",]+)/g;

const fields = new Set();
for (const file of readdirSync(DTO_DIR).filter(
  (f) => f.endsWith(".go") && !f.endsWith("_test.go"),
)) {
  const source = readFileSync(join(DTO_DIR, file), "utf8");
  for (const match of source.matchAll(JSON_TAG)) {
    const name = match[1];
    if (name && name !== "-") fields.add(name);
  }
}

// Models are serialized directly by a few handlers, so their tags count too.
const MODEL_DIR = join(API_DIR, "pkg", "models");
if (existsSync(MODEL_DIR)) {
  for (const file of readdirSync(MODEL_DIR).filter(
    (f) => f.endsWith(".go") && !f.endsWith("_test.go"),
  )) {
    const source = readFileSync(join(MODEL_DIR, file), "utf8");
    for (const match of source.matchAll(JSON_TAG)) {
      const name = match[1];
      if (name && name !== "-") fields.add(name);
    }
  }
}

const sorted = [...fields].sort();
const payload =
  JSON.stringify({ generated_from: "senso-api", count: sorted.length, fields: sorted }, null, 2) +
  "\n";

if (check) {
  const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  if (current !== payload) {
    console.error("tests/policy/api-fields.json is stale. Run: make api-fields");
    process.exit(1);
  }
  console.log(`api-fields.json is current (${sorted.length} fields).`);
} else {
  writeFileSync(OUT, payload);
  console.log(`wrote ${OUT}: ${sorted.length} fields`);
}
