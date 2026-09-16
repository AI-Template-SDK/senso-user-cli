/**
 * Extracts every `senso …` command the published agent skills tell an agent to
 * run, into a fixture.
 *
 * `tests/policy/skill-commands.test.ts` checks each one against the real
 * command tree. That direction matters: the skills are instructions a model
 * follows literally, so a command renamed or removed here silently breaks
 * every agent that reads them. Four skills called `senso credits`, which is a
 * group and not a command, and two sent agents to `senso content get` for
 * knowledge base documents, which the API rejects by design.
 *
 * The fixture is committed so the test never depends on a sibling checkout,
 * and so a command disappearing from the skills shows up in a diff.
 *
 * Usage:  node scripts/gen-skill-commands.mjs [--check]
 *         SENSO_SKILLS_DIR=/path/to/senso-contextos/skills node scripts/gen-skill-commands.mjs
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const SKILLS_DIR =
  process.env.SENSO_SKILLS_DIR ?? resolve(process.cwd(), "..", "senso-contextos", "skills");
const OUT = resolve(process.cwd(), "tests", "policy", "skill-commands.json");
const check = process.argv.includes("--check");

if (!existsSync(SKILLS_DIR)) {
  console.error(
    `Skills not found at ${SKILLS_DIR}.\n` +
      "Clone senso-contextos beside this repo, or set SENSO_SKILLS_DIR. The committed fixture stays valid; this script only refreshes it.",
  );
  process.exit(1);
}

function markdownFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...markdownFiles(full));
    else if (entry.endsWith(".md")) out.push(full);
  }
  return out;
}

// `senso kb get <id>` → "kb get". Two words at most: a third is an argument,
// and Commander's tree is only ever three levels deep including the program.
const INVOCATION = /\bsenso ([a-z][a-z0-9-]*)(?: ([a-z][a-z0-9-]*))?/g;

const commands = new Set();
for (const file of markdownFiles(SKILLS_DIR)) {
  for (const match of readFileSync(file, "utf8").matchAll(INVOCATION)) {
    commands.add([match[1], match[2]].filter(Boolean).join(" "));
  }
}

const sorted = [...commands].sort();
const payload =
  JSON.stringify(
    { generated_from: "senso-contextos/skills", count: sorted.length, commands: sorted },
    null,
    2,
  ) + "\n";

if (check) {
  const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  if (current !== payload) {
    console.error("tests/policy/skill-commands.json is stale. Run: make skill-commands");
    process.exit(1);
  }
  console.log(`skill-commands.json is current (${sorted.length} commands).`);
} else {
  writeFileSync(OUT, payload);
  console.log(`wrote ${OUT}: ${sorted.length} commands`);
}
