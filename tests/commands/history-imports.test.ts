/**
 * Command layer: `senso history-imports`.
 *
 * What is worth protecting here is the reason the group exists at all. The
 * import started by `senso industries import-prompts` returns before the copying
 * finishes, and a `completed` import may have copied nothing — the run seen in
 * live testing came back `completed` with `historic_runs_imported: 0`. So the
 * default table has to carry `prompts_count` and `historic_runs_imported`
 * alongside the status, or a caller reads "completed" and believes it got data.
 *
 * Failure branches come first, as in tests/commands/roles.test.ts.
 */

import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../setup.js";
import { apiUrl, runCli } from "../helpers.js";

const IMPORT_ID = "bf225e94-baad-44b2-9685-be2765979a1c";

const ONE_IMPORT = {
  id: IMPORT_ID,
  days: 7,
  status: "completed",
  prompts_count: 2,
  historic_runs_imported: 0,
  error: null,
  created_at: "2026-09-14T16:56:13.263496Z",
  updated_at: "2026-09-14T16:57:05.456977Z",
  completed_at: "2026-09-14T16:57:05.456977Z",
};

describe("history-imports, when the API refuses", () => {
  it("exits 4 when the import id is unknown", async () => {
    server.use(
      http.get(apiUrl("/org/history-imports/:importId"), () =>
        HttpResponse.json({ message: "Not found" }, { status: 404 }),
      ),
    );

    const res = await runCli(["history-imports", "get", IMPORT_ID]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
  });

  it("exits 3 for an organization without the GEO product", async () => {
    server.use(
      http.get(apiUrl("/org/history-imports"), () =>
        HttpResponse.json(
          { message: "Your organization doesn't have access to this product" },
          { status: 403 },
        ),
      ),
    );

    const res = await runCli(["history-imports", "list"]);

    expect(res.exitCode).toBe(3);
  });

  it("exits 3 on a 401", async () => {
    server.use(
      http.get(apiUrl("/org/history-imports"), () =>
        HttpResponse.json({ message: "Unauthorized" }, { status: 401 }),
      ),
    );

    const res = await runCli(["history-imports", "list"]);

    expect(res.exitCode).toBe(3);
  });
});

describe("history-imports list", () => {
  it("reads /org/history-imports", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/history-imports"), ({ request }) => {
        seen = request;
        return HttpResponse.json({ imports: [ONE_IMPORT] });
      }),
    );

    const res = await runCli(["history-imports", "list"]);

    expect(res.exitCode).toBe(0);
    expect(new URL(seen!.url).pathname).toBe("/api/v1/org/history-imports");
  });

  it("shows the counts next to the status, not the status alone", async () => {
    server.use(
      http.get(apiUrl("/org/history-imports"), () => HttpResponse.json({ imports: [ONE_IMPORT] })),
    );

    const res = await runCli(["history-imports", "list", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("completed");
    expect(res.stdout).toContain("prompts_count");
    expect(res.stdout).toContain("historic_runs_imported");
  });

  it("renders an empty list without failing", async () => {
    server.use(http.get(apiUrl("/org/history-imports"), () => HttpResponse.json({ imports: [] })));

    const res = await runCli(["history-imports", "list"]);

    expect(res.exitCode).toBe(0);
  });
});

describe("history-imports get", () => {
  it("puts the import id in the path, percent-encoded", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/history-imports/:importId"), ({ request }) => {
        seen = request;
        return HttpResponse.json(ONE_IMPORT);
      }),
    );

    const res = await runCli(["history-imports", "get", IMPORT_ID]);

    expect(res.exitCode).toBe(0);
    expect(new URL(seen!.url).pathname).toBe(`/api/v1/org/history-imports/${IMPORT_ID}`);
  });

  it("keeps stdout pure JSON under --output json", async () => {
    server.use(
      http.get(apiUrl("/org/history-imports/:importId"), () => HttpResponse.json(ONE_IMPORT)),
    );

    const res = await runCli(["history-imports", "get", IMPORT_ID, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    const body = JSON.parse(res.stdout);
    expect(body.status).toBe("completed");
    expect(body.historic_runs_imported).toBe(0);
  });
});
