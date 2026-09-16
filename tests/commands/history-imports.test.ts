/**
 * Command layer: `senso history-imports`.
 *
 * WHAT IS WORTH PROTECTING HERE is one false positive and one false negative,
 * both of which an agent hits by reading `status` and nothing else.
 *
 *   - A `completed` import may have copied NOTHING. A job that matched no
 *     prompts finishes successfully with `historic_runs_imported: 0`, which is
 *     what the run seen in live testing actually returned. An agent polling
 *     until status == completed then reported success for an organization whose
 *     analytics window was still empty. So `get` emits a WARNING, and the
 *     warning is asserted through the envelope rather than through stderr,
 *     because `--output json` silences stderr and every published Senso skill
 *     passes `--output json`.
 *   - `failed` is NOT terminal. The API retries a failed job and it can return
 *     to `running`, so a caller that stops there gives up on work that was
 *     still in flight. The help says so and the payload warns.
 *
 * The third thing is the ledger. 501 means this deployment has no
 * history-import integration at all and 502 means Senso could not reach it —
 * two precise answers the generic 5xx branch would replace with "retry
 * shortly", advice that can never work for the first of them.
 *
 * Every fixture below is the API's own `dto.HistoryImport`: nothing is invented,
 * because a made-up field name is how a blank column ships green.
 *
 * Failure branches come first, as in tests/commands/roles.test.ts.
 */

import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../setup.js";
import { apiUrl, envelope, errorEnvelope, runCli } from "../helpers.js";

const IMPORT_ID = "bf225e94-baad-44b2-9685-be2765979a1c";
const OTHER_IMPORT_ID = "0b6f1d43-2c7a-4f18-9f31-8a5e6c4b2d07";

/** One job, exactly as `dto.HistoryImport` serializes it. */
function job(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: IMPORT_ID,
    days: 30,
    status: "completed",
    prompts_count: 12,
    historic_runs_imported: 480,
    error: null,
    created_at: "2026-09-14T16:56:13.263496Z",
    updated_at: "2026-09-14T16:57:05.456977Z",
    completed_at: "2026-09-14T16:57:05.456977Z",
    status_is_terminal: true,
    ...over,
  };
}

/** The job the group exists for: finished, and it copied nothing. */
const HOLLOW = job({ prompts_count: 0, historic_runs_imported: 0 });

/** In flight: the outcome fields are null, which is not zero. */
const RUNNING = job({
  status: "running",
  prompts_count: null,
  historic_runs_imported: null,
  completed_at: null,
  status_is_terminal: false,
});

/** This attempt failed. The job is retried, so it is not over. */
const FAILED = job({
  status: "failed",
  prompts_count: null,
  historic_runs_imported: null,
  completed_at: null,
  status_is_terminal: false,
  error: "The history import failed. Senso has been notified.",
});

describe("history-imports get, when the id is not an id", () => {
  it("exits 2 without making a request when <importId> is not a UUID", async () => {
    // No handler is registered, so a request would fail the test outright:
    // tests/setup.ts errors on anything unmocked. That is the assertion.
    const res = await runCli(["history-imports", "get", "imp-1", "--output", "json"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(errorEnvelope(res).error).toMatchObject({
      code: "usage",
      field: "<importId>",
      received: "imp-1",
    });
    expect(errorEnvelope(res).error.message).toContain("not a UUID");
    expect(errorEnvelope(res).error.hint).toContain("senso history-imports list");
  });
});

describe("history-imports, when the API refuses", () => {
  it("exits 4 naming the resource and the command that lists them", async () => {
    server.use(
      http.get(apiUrl("/org/history-imports/:importId"), () =>
        HttpResponse.json({ status: 404, message: "History import not found" }, { status: 404 }),
      ),
    );

    const res = await runCli(["history-imports", "get", IMPORT_ID, "--output", "json"]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
    const { error } = errorEnvelope(res);
    expect(error).toMatchObject({
      code: "not_found",
      status: 404,
      field: "import_id",
      received: IMPORT_ID,
    });
    expect(error.message).toContain("History import");
    expect(error.message).toContain(IMPORT_ID);
    expect(error.hint).toContain("senso history-imports list");
  });

  it("exits 3 for an organization without the GEO product", async () => {
    server.use(
      http.get(apiUrl("/org/history-imports"), () =>
        HttpResponse.json(
          { status: 403, message: "Your organization doesn't have access to this product" },
          { status: 403 },
        ),
      ),
    );

    const res = await runCli(["history-imports", "list"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Permission denied");
  });

  it("exits 3 when the key is rejected", async () => {
    server.use(
      http.get(apiUrl("/org/history-imports"), () =>
        HttpResponse.json({ status: 401, message: "Authentication required" }, { status: 401 }),
      ),
    );

    const res = await runCli(["history-imports", "list"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
  });

  it("exits 1 on a 501, saying the deployment has no history-import integration", async () => {
    // The one 5xx where "retry shortly" is guaranteed wrong: nothing will ever
    // answer this call on this deployment.
    server.use(
      http.get(apiUrl("/org/history-imports"), () =>
        HttpResponse.json({ status: 501, message: "Not implemented" }, { status: 501 }),
      ),
    );

    const res = await runCli(["history-imports", "list", "--output", "json"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    const { error } = errorEnvelope(res);
    expect(error.status).toBe(501);
    expect(error.message).toContain("no history-import integration");
    expect(error.hint).toContain("Nothing to retry");
    expect(error.hint).not.toContain("Retry shortly");
  });

  it("exits 1 on a 502, saying Senso could not reach the ledger, and offers a retry", async () => {
    server.use(
      http.get(apiUrl("/org/history-imports/:importId"), () =>
        HttpResponse.json({ status: 502, message: "Bad gateway" }, { status: 502 }),
      ),
    );

    const res = await runCli(["history-imports", "get", IMPORT_ID, "--output", "json"]);

    expect(res.exitCode).toBe(1);
    const { error } = errorEnvelope(res);
    expect(error.status).toBe(502);
    expect(error.message).toContain("history-import ledger");
    expect(error.hint).toContain("Retry in a minute");
  });

  it("exits 1 on a 503 and says it is not a transient failure", async () => {
    server.use(
      http.get(apiUrl("/org/history-imports"), () =>
        HttpResponse.json({ status: 503, message: "Service unavailable" }, { status: 503 }),
      ),
    );

    const res = await runCli(["history-imports", "list"]);

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("not a transient failure");
  });

  it("exits 1 on a 500 and keeps the retry hint", async () => {
    server.use(
      http.get(apiUrl("/org/history-imports"), () =>
        HttpResponse.json({ status: 500, message: "boom" }, { status: 500 }),
      ),
    );

    const res = await runCli(["history-imports", "list", "--output", "json"]);

    expect(res.exitCode).toBe(1);
    expect(errorEnvelope(res).error.hint).toContain("Retry shortly");
  });

  it("reports a malformed body rather than throwing a parse error at the user", async () => {
    server.use(
      http.get(apiUrl("/org/history-imports"), () => new HttpResponse("<html>nope</html>")),
    );

    const res = await runCli(["history-imports", "list"]);

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("Invalid JSON response");
  });
});

describe("history-imports get, when the job completed but copied nothing", () => {
  it("warns that it is not success, in the envelope where a JSON caller can read it", async () => {
    // The regression this whole group exists to prevent. Under --output json
    // stderr is silent, so a warning written only to stderr reaches nobody.
    server.use(http.get(apiUrl("/org/history-imports/:importId"), () => HttpResponse.json(HOLLOW)));

    const res = await runCli(["history-imports", "get", IMPORT_ID, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    const env = envelope(res);
    expect(env.warnings?.join(" ")).toContain("NO historic runs were imported");
    expect(env.warnings?.join(" ")).toContain("not success");
    expect(res.stderr).toBe("");
  });

  it("sends the same warning to stderr in plain output, with the payload on stdout", async () => {
    server.use(http.get(apiUrl("/org/history-imports/:importId"), () => HttpResponse.json(HOLLOW)));

    const res = await runCli(["history-imports", "get", IMPORT_ID]);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain("NO historic runs were imported");
    expect(res.stdout).toContain("historic_runs_imported");
  });

  it("points at the org's own prompts rather than at analytics", async () => {
    server.use(http.get(apiUrl("/org/history-imports/:importId"), () => HttpResponse.json(HOLLOW)));

    const res = await runCli(["history-imports", "get", IMPORT_ID, "--output", "json"]);

    expect(envelope(res).next).toContainEqual({
      why: expect.stringContaining("Nothing was copied"),
      command: "senso prompts list",
    });
  });
});

describe("history-imports get, when the job failed", () => {
  it("exits 0 and says failed is not terminal, because the job is retried", async () => {
    server.use(http.get(apiUrl("/org/history-imports/:importId"), () => HttpResponse.json(FAILED)));

    const res = await runCli(["history-imports", "get", IMPORT_ID, "--output", "json"]);

    // Reading the job succeeded. Branch on the payload, not the exit code.
    expect(res.exitCode).toBe(0);
    const env = envelope<{ status: string }>(res);
    expect(env.data.status).toBe("failed");
    expect(env.warnings?.join(" ")).toContain("not terminal");
    expect(env.warnings?.join(" ")).toContain("retried");
  });

  it("tells the caller to poll again rather than to give up", async () => {
    server.use(http.get(apiUrl("/org/history-imports/:importId"), () => HttpResponse.json(FAILED)));

    const res = await runCli(["history-imports", "get", IMPORT_ID, "--output", "json"]);

    expect(envelope(res).next).toContainEqual({
      why: expect.stringContaining("Failed is not terminal"),
      command: `senso history-imports get ${IMPORT_ID}`,
    });
  });

  it("says so in --help too, where an agent reads the status set before it polls", async () => {
    const res = await runCli(["history-imports", "get", "--help"]);

    expect(res.stdout).toContain("Not terminal");
    expect(res.stdout).toContain("retried");
    expect(res.stdout).toContain("poll again before giving up");
  });
});

describe("history-imports get, while the job is still running", () => {
  it("warns that the null counts are “not yet known”, not zero", async () => {
    server.use(
      http.get(apiUrl("/org/history-imports/:importId"), () => HttpResponse.json(RUNNING)),
    );

    const res = await runCli(["history-imports", "get", IMPORT_ID, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(envelope(res).warnings?.join(" ")).toContain("null until the job completes");
  });

  it("hands back the exact poll command, with the real id in it", async () => {
    server.use(
      http.get(apiUrl("/org/history-imports/:importId"), () => HttpResponse.json(RUNNING)),
    );

    const res = await runCli(["history-imports", "get", IMPORT_ID, "--output", "json"]);

    expect(envelope(res).next).toContainEqual({
      why: expect.stringContaining("historic_runs_imported is above 0"),
      command: `senso history-imports get ${IMPORT_ID}`,
    });
  });
});

describe("history-imports get, on a job that really did copy history", () => {
  it("reads /org/history-imports/<id> and returns the payload unmodified", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/history-imports/:importId"), ({ request }) => {
        seen = request;
        return HttpResponse.json(job());
      }),
    );

    const res = await runCli(["history-imports", "get", IMPORT_ID, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(new URL(seen!.url).pathname).toBe(`/api/v1/org/history-imports/${IMPORT_ID}`);
    expect(res.data()).toEqual(job());
  });

  it("warns about nothing, and sends the caller on to analytics", async () => {
    server.use(http.get(apiUrl("/org/history-imports/:importId"), () => HttpResponse.json(job())));

    const res = await runCli(["history-imports", "get", IMPORT_ID, "--output", "json"]);

    const env = envelope(res);
    expect(env.warnings).toBeUndefined();
    expect(env.next).toContainEqual({
      why: expect.stringContaining("analytics window"),
      command: "senso analytics summary",
    });
  });
});

describe("history-imports list", () => {
  it("reads /org/history-imports with no filters, because it takes none", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/history-imports"), ({ request }) => {
        seen = request;
        return HttpResponse.json({ imports: [job()] });
      }),
    );

    const res = await runCli(["history-imports", "list", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(new URL(seen!.url).pathname).toBe("/api/v1/org/history-imports");
    expect(new URL(seen!.url).search).toBe("");
  });

  it("puts the counts in the table beside the status, all of them populated", async () => {
    server.use(
      http.get(apiUrl("/org/history-imports"), () =>
        HttpResponse.json({ imports: [job(), job({ id: OTHER_IMPORT_ID })] }),
      ),
    );

    const res = await runCli(["history-imports", "list", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    for (const column of [
      "id",
      "status",
      "days",
      "prompts_count",
      "historic_runs_imported",
      "created_at",
      "completed_at",
    ]) {
      expect(res.stdout).toContain(column);
    }
    expect(res.stdout).toContain("480");
    expect(res.stdout).toContain(OTHER_IMPORT_ID);
    // A real header row, in the declared order.
    expect(res.stdout).toMatch(
      /id\s+status\s+days\s+prompts_count\s+historic_runs_imported\s+created_at\s+completed_at/,
    );
    // Every declared column is a real field of dto.HistoryImport, so the
    // absent-column warning must stay silent.
    expect(res.stderr).not.toContain("which the API did not return");
  });

  it("names the completed imports that copied nothing, and how many", async () => {
    server.use(
      http.get(apiUrl("/org/history-imports"), () =>
        HttpResponse.json({ imports: [HOLLOW, job({ id: OTHER_IMPORT_ID })] }),
      ),
    );

    const res = await runCli(["history-imports", "list", "--output", "json"]);

    const warnings = envelope(res).warnings?.join(" ") ?? "";
    expect(warnings).toContain("1 completed import(s) copied no historic runs");
    expect(warnings).toContain(IMPORT_ID);
    expect(warnings).not.toContain(OTHER_IMPORT_ID);
  });

  it("says nothing about hollow imports when every job actually got data", async () => {
    server.use(
      http.get(apiUrl("/org/history-imports"), () => HttpResponse.json({ imports: [job()] })),
    );

    const res = await runCli(["history-imports", "list", "--output", "json"]);

    expect(envelope(res).warnings).toBeUndefined();
  });

  it("explains an empty list by naming the command that starts an import", async () => {
    server.use(http.get(apiUrl("/org/history-imports"), () => HttpResponse.json({ imports: [] })));

    const res = await runCli(["history-imports", "list"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("No history imports found.");
    expect(res.stderr).toContain("senso industries import-prompts");
  });

  it("offers to read the newest job in full", async () => {
    server.use(
      http.get(apiUrl("/org/history-imports"), () =>
        HttpResponse.json({ imports: [job({ id: OTHER_IMPORT_ID }), job()] }),
      ),
    );

    const res = await runCli(["history-imports", "list", "--output", "json"]);

    expect(envelope(res).next).toContainEqual({
      why: "Read one job in full",
      command: `senso history-imports get ${OTHER_IMPORT_ID}`,
    });
  });

  it("renders a readable block per job by default, with nothing on stdout but the payload", async () => {
    server.use(
      http.get(apiUrl("/org/history-imports"), () => HttpResponse.json({ imports: [job()] })),
    );

    const res = await runCli(["history-imports", "list"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(IMPORT_ID);
    expect(res.stdout).toContain("completed");
    expect(res.stdout).not.toContain("✓");
  });
});
