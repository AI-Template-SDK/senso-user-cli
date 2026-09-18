/**
 * Command layer: the one invariant behind everything `senso whoami` says about
 * which API key is in use.
 *
 *   What `whoami` reports MUST be the key every other command sends.
 *
 * `whoami` has no key logic of its own — it calls the same `resolveApiKey` that
 * `apiRequest` calls for every command — so the guarantee holds by construction.
 * This proves it end to end anyway, because "by construction" is exactly what
 * was claimed the last time it was not true.
 *
 * The proof does not read any message text. For each combination of sources it
 * asks `whoami` which key it is using, then runs a DIFFERENT command and checks
 * the key that actually reached the server. Ground truth is the `x-api-key`
 * header, not the CLI's own account of itself.
 */

import { beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { rmSync } from "node:fs";
import { server } from "../setup.js";
import { apiUrl, runCli } from "../helpers.js";
import { writeConfig } from "../../src/lib/config.js";

const CONFIG_DIR = vi.hoisted(() => {
  const tmp = (process.env.TMPDIR ?? process.env.TEMP ?? "/tmp").replace(/[/\\]+$/, "");
  const dir = `${tmp}/senso-key-source-${process.pid}`;
  process.env.SENSO_CONFIG_DIR = dir;
  return dir;
});

/** A distinct key per source, so the key the server sees identifies its origin. */
const KEYS = {
  flag: "tgr_key_from_the_flag",
  env: "tgr_key_from_the_environment",
  config: "tgr_key_from_the_config_file",
} as const;

type Source = keyof typeof KEYS;

const ORG = { org_id: "org-abc", name: "Acme Corp", slug: "acme", is_free_tier: false };

beforeEach(() => {
  rmSync(CONFIG_DIR, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(CONFIG_DIR, { recursive: true, force: true });
});

/** Answers every request, recording the key it was sent. */
function recordsKey(): { keySeen: () => string | null } {
  let seen: string | null = null;
  const handler = ({ request }: { request: Request }): Response => {
    seen = request.headers.get("x-api-key");
    return HttpResponse.json(ORG);
  };
  server.use(http.get(apiUrl("/org/me"), handler));
  return { keySeen: () => seen };
}

function arrange(present: Source[]): string[] {
  if (present.includes("config")) writeConfig({ apiKey: KEYS.config });
  if (present.includes("env")) process.env.SENSO_API_KEY = KEYS.env;
  return present.includes("flag") ? ["--api-key", KEYS.flag] : [];
}

/** Every combination of sources, with the one precedence says must win. */
const CASES: { present: Source[]; expected: Source }[] = [
  { present: ["config"], expected: "config" },
  { present: ["env"], expected: "env" },
  { present: ["flag"], expected: "flag" },
  { present: ["env", "config"], expected: "env" },
  { present: ["flag", "config"], expected: "flag" },
  { present: ["flag", "env"], expected: "flag" },
  { present: ["flag", "env", "config"], expected: "flag" },
];

describe("what whoami reports is the key that is actually sent", () => {
  for (const { present, expected } of CASES) {
    const scenario = present.join(" + ");

    it(`reports ${expected}, and sends the ${expected} key, given ${scenario}`, async () => {
      const { keySeen } = recordsKey();
      const flag = arrange(present);

      const res = await runCli(["whoami", "--output", "json", ...flag], { withKey: false });
      const payload = res.json<{ apiKeySource: string; apiKeyPrefix: string }>();

      // What it claims, and what the server actually received.
      expect(payload.apiKeySource).toBe(expected);
      expect(keySeen()).toBe(KEYS[expected]);
      // The prefix must describe that same key, never another.
      expect(payload.apiKeyPrefix).toBe(`${KEYS[expected].slice(0, 8)}...`);
    });

    it(`sends that same key from a different command, given ${scenario}`, async () => {
      // The claim is about every command, not about `whoami`, so it has to be
      // checked somewhere `whoami`'s own resolution is not what is being read.
      const { keySeen } = recordsKey();
      const flag = arrange(present);

      const res = await runCli(["org", "get", ...flag], { withKey: false });

      expect(res.exitCode).toBe(0);
      expect(keySeen()).toBe(KEYS[expected]);
    });

    it(`never prints any key in full, given ${scenario}`, async () => {
      recordsKey();
      const flag = arrange(present);

      const res = await runCli(["whoami", ...flag], { withKey: false });

      for (const key of Object.values(KEYS)) {
        expect(res.stdout).not.toContain(key);
        expect(res.stderr).not.toContain(key);
      }
    });
  }
});
