/**
 * Command layer: `senso generate`.
 *
 * Every other command group is one request and one rendering. This one has a
 * job: `generate sample` submits work, then polls
 * `/org/content-generation/sample-jobs/{id}` every two seconds for up to three
 * minutes and reports whatever the job finally became. That loop is the only
 * place in the CLI where the exit code depends on a response the user never
 * sees, so it is where a regression is hardest to notice and most expensive:
 *
 *   - a `failed` job must exit non-zero carrying the job's OWN message, not a
 *     generic "request failed" — the reason the generation failed is the only
 *     useful thing the command can say;
 *   - a job that never finishes must exit 5 (retryable) rather than 1, and must
 *     name the URL to poll by hand, because the work is still running
 *     server-side;
 *   - the status commentary must stay on stderr, so `--output json | jq` sees
 *     only the generated content;
 *   - `--no-wait` must poll exactly zero times, which is the whole point of it.
 *
 * The polling tests run on fake timers and advance them, so three minutes of
 * waiting costs nothing. They are written against `advanceTimersByTimeAsync`
 * rather than the synchronous form: each tick has to interleave with an awaited
 * fetch, and the synchronous version would run the sleep without ever letting
 * the response promise settle.
 *
 * Failure branches come first, as in tests/commands/roles.test.ts.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server, TEST_API_KEY } from "../setup.js";
import { apiUrl, runCli, type CliResult } from "../helpers.js";

/** Mirrors SAMPLE_JOB_POLL_INTERVAL_MS in src/commands/generate.ts. */
const POLL_INTERVAL_MS = 2_000;

/** Mirrors SAMPLE_JOB_TIMEOUT_MS in src/commands/generate.ts. */
const TIMEOUT_MS = 180_000;

const SETTINGS = {
  enable_content_generation: true,
  content_auto_publish: false,
  content_schedule: [1, 3, 5],
  selected_content_type_id: "ct-1",
};

const SUBMITTED = {
  message: "Sample job accepted",
  sample_job_id: "sj-1",
  org_id: "org-1",
  status: "queued",
};

const SAMPLE_RESULT = {
  content_id: "c-9",
  seo_title: "The Best CRMs for Startups in 2026",
  markdown: "# The Best CRMs for Startups\n\nA comparison.",
};

interface SampleJob {
  sample_job_id: string;
  org_id: string;
  status: string;
  result?: unknown;
  error?: { code?: string; message?: string };
}

function job(status: string, extra: Partial<SampleJob> = {}): SampleJob {
  return { sample_job_id: "sj-1", org_id: "org-1", status, ...extra };
}

/**
 * Stands up the submit endpoint plus a poll endpoint that walks a script of
 * statuses, one per request, holding on the last entry once it runs out.
 *
 * Returns the poll counter, so a test can assert on how many times the CLI
 * actually asked — `--no-wait` asking zero times is a behavior, not an
 * implementation detail.
 */
function stubSampleJob(statuses: SampleJob[]): { polls: () => number } {
  let polls = 0;
  server.use(
    http.post(apiUrl("/org/content-generation/sample"), () => HttpResponse.json(SUBMITTED)),
    http.get(apiUrl("/org/content-generation/sample-jobs/:id"), () => {
      const next = statuses[Math.min(polls, statuses.length - 1)];
      polls += 1;
      return HttpResponse.json(next);
    }),
  );
  return { polls: () => polls };
}

/**
 * Runs a command that sleeps, advancing fake time one poll interval at a time.
 *
 * The loop is deliberately not one big jump, and deliberately the async form.
 * Each `advanceTimersByTimeAsync` yields to the real event loop, which is what
 * lets the in-flight fetch resolve before the next sleep is scheduled; a single
 * synchronous `advanceTimersByTime(180_000)` would fire every sleep against a
 * job whose first response had not arrived yet.
 *
 * It ticks through the whole timeout budget rather than stopping early. Once
 * the command has settled there is no timer left to fire, so the remaining
 * ticks cost nothing — and the alternative, a "has it finished" flag, is the
 * kind of state this helper exists to keep out of the tests.
 */
async function runWhileTicking(args: string[]): Promise<CliResult> {
  const running = runCli(args);

  const ticks = TIMEOUT_MS / POLL_INTERVAL_MS + 20;
  for (let tick = 0; tick < ticks; tick++) {
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
  }

  return running;
}

afterEach(() => {
  // Fake timers are process-wide. Left installed, the next file's MSW handlers
  // wait on a clock nobody is advancing.
  vi.useRealTimers();
});

describe("generate, when the request fails", () => {
  it("exits 3 and explains how to authenticate when there is no API key", async () => {
    const res = await runCli(["generate", "settings"], { withKey: false });

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("no API key found");
    expect(res.stderr).toContain("SENSO_API_KEY");
  });

  it("exits 3 when the API rejects the key", async () => {
    server.use(
      http.get(apiUrl("/org/content-generation"), () =>
        HttpResponse.json({ error: "invalid key" }, { status: 401 }),
      ),
    );

    const res = await runCli(["generate", "settings"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Authentication failed");
  });

  it("exits 3 when the key is valid but lacks the scope", async () => {
    server.use(
      http.post(apiUrl("/org/content-generation/run"), () =>
        HttpResponse.json({ error: "no" }, { status: 403 }),
      ),
    );

    const res = await runCli(["generate", "run"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Permission denied");
  });

  it("exits 4 when the run does not exist", async () => {
    server.use(
      http.get(
        apiUrl("/org/content-generation/runs/:runId"),
        () => new HttpResponse(null, { status: 404 }),
      ),
    );

    const res = await runCli(["generate", "runs-get", "missing"]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Not found");
  });

  it("exits 1 on a 500 and says it is not the caller's fault", async () => {
    server.use(
      http.get(
        apiUrl("/org/content-generation/job-context"),
        () => new HttpResponse(null, { status: 502 }),
      ),
    );

    const res = await runCli(["generate", "job-context"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("not your fault");
  });

  it("writes the failure to stderr as JSON, leaving stdout empty, under --output json", async () => {
    server.use(
      http.get(apiUrl("/org/content-generation"), () =>
        HttpResponse.json({ error: "nope" }, { status: 403 }),
      ),
    );

    const res = await runCli(["generate", "settings", "--output", "json"]);

    expect(res.exitCode).toBe(3);
    // The important half: a caller redirecting stdout to a file gets an empty
    // file, not a file containing an error object it would later read as data.
    expect(res.stdout).toBe("");

    const reported: unknown = JSON.parse(res.stderr);
    expect(reported).toMatchObject({
      error: { code: "forbidden", status: 403 },
    });
  });
});

describe("generate, when the command line is wrong", () => {
  it("exits 2 when update-settings is given --data that is not valid JSON", async () => {
    const res = await runCli(["generate", "update-settings", "--data", "{not json}"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Invalid JSON in --data");
  });

  it("exits 2 when --data is valid JSON but not an object", async () => {
    const res = await runCli(["generate", "update-settings", "--data", "[1,2]"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("must be a JSON object");
  });

  it("exits 2 when update-settings is missing its required --data", async () => {
    const res = await runCli(["generate", "update-settings"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
  });

  it("exits 2 when sample is missing its required --content-type-id", async () => {
    const res = await runCli(["generate", "sample", "--prompt-id", "p-1"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
  });

  it("names the valid formats when --output is not one of them", async () => {
    const res = await runCli(["generate", "settings", "--output", "yaml"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("json, table, plain");
  });
});

describe("generate settings, on the wire", () => {
  it("reads the content-generation settings resource", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/content-generation"), ({ request }) => {
        seen = request;
        return HttpResponse.json(SETTINGS);
      }),
    );

    const res = await runCli(["generate", "settings", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(seen?.method).toBe("GET");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/content-generation");
    expect(seen?.headers.get("x-api-key")).toBe(TEST_API_KEY);
    expect(res.json()).toEqual(SETTINGS);
  });

  it("renders the settings as field/value rows under --output table", async () => {
    server.use(http.get(apiUrl("/org/content-generation"), () => HttpResponse.json(SETTINGS)));

    const res = await runCli(["generate", "settings", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("enable_content_generation");
    expect(res.stdout).toContain("true");
    // A nested array must not render as [object Object].
    expect(res.stdout).toContain("1, 3, 5");
  });

  it("renders key/value lines by default", async () => {
    server.use(http.get(apiUrl("/org/content-generation"), () => HttpResponse.json(SETTINGS)));

    const res = await runCli(["generate", "settings"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("content_auto_publish");
    expect(res.stdout).toContain("ct-1");
  });
});

describe("generate update-settings, on the wire", () => {
  it("PATCHes the parsed --data through unchanged", async () => {
    let seen: Request | undefined;
    let body: unknown;
    server.use(
      http.patch(apiUrl("/org/content-generation"), async ({ request }) => {
        seen = request;
        body = await request.json();
        return HttpResponse.json(SETTINGS);
      }),
    );

    const res = await runCli([
      "generate",
      "update-settings",
      "--data",
      '{"content_auto_publish":true,"content_schedule":[0,6]}',
    ]);

    expect(res.exitCode).toBe(0);
    expect(seen?.method).toBe("PATCH");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/content-generation");
    expect(body).toEqual({ content_auto_publish: true, content_schedule: [0, 6] });
  });

  it("puts the success line on stderr and the payload on stdout", async () => {
    server.use(http.patch(apiUrl("/org/content-generation"), () => HttpResponse.json(SETTINGS)));

    const res = await runCli(["generate", "update-settings", "--data", "{}"]);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain("settings updated");
    expect(res.stdout).not.toContain("settings updated");
    expect(res.stdout).toContain("enable_content_generation");
  });
});

describe("generate run, on the wire", () => {
  it("posts an empty body when no subset is named", async () => {
    let seen: Request | undefined;
    let body: unknown;
    server.use(
      http.post(apiUrl("/org/content-generation/run"), async ({ request }) => {
        seen = request;
        body = await request.json();
        return HttpResponse.json({ run_id: "r-1", status: "queued" });
      }),
    );

    const res = await runCli(["generate", "run", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(seen?.method).toBe("POST");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/content-generation/run");
    expect(body).toEqual({});
  });

  it("translates the three restriction flags into snake_case body fields", async () => {
    let body: unknown;
    server.use(
      http.post(apiUrl("/org/content-generation/run"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ run_id: "r-1" });
      }),
    );

    await runCli([
      "generate",
      "run",
      "--prompt-ids",
      "p-1",
      "p-2",
      "--content-type-id",
      "ct-9",
      "--publisher-ids",
      "pub-1",
    ]);

    expect(body).toEqual({
      prompt_ids: ["p-1", "p-2"],
      content_type_id: "ct-9",
      publisher_ids: ["pub-1"],
    });
  });
});

describe("generate job-context, on the wire", () => {
  it("reads the job-context resource", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/content-generation/job-context"), ({ request }) => {
        seen = request;
        return HttpResponse.json({ summary: { create: 3, update: 1 }, prompts: [] });
      }),
    );

    const res = await runCli(["generate", "job-context", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(seen?.method).toBe("GET");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/content-generation/job-context");
    expect(res.json()).toMatchObject({ summary: { create: 3 } });
  });
});

describe("generate runs-list, on the wire", () => {
  it("applies the paging defaults and sends no filter parameters", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/content-generation/runs"), ({ request }) => {
        seen = request;
        return HttpResponse.json({ runs: [{ run_id: "r-1", status: "completed" }] });
      }),
    );

    await runCli(["generate", "runs-list"]);

    const params = new URL(seen?.url ?? "").searchParams;
    expect(params.get("limit")).toBe("20");
    expect(params.get("offset")).toBe("0");
    // Unset filters must be absent, not empty: `?status=` is a different query.
    expect(params.has("status")).toBe(false);
    expect(params.has("active_only")).toBe(false);
    expect(params.has("start_date")).toBe(false);
    expect(params.has("end_date")).toBe(false);
  });

  it("maps every filter flag onto the query parameter the API expects", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/content-generation/runs"), ({ request }) => {
        seen = request;
        return HttpResponse.json({ runs: [] });
      }),
    );

    await runCli([
      "generate",
      "runs-list",
      "--limit",
      "5",
      "--offset",
      "15",
      "--status",
      "running",
      "--active-only",
      "--start-date",
      "2026-01-01",
      "--end-date",
      "2026-02-01",
    ]);

    const params = new URL(seen?.url ?? "").searchParams;
    expect(params.get("limit")).toBe("5");
    expect(params.get("offset")).toBe("15");
    expect(params.get("status")).toBe("running");
    // A boolean flag becomes the string the API reads, not "on" or "1".
    expect(params.get("active_only")).toBe("true");
    expect(params.get("start_date")).toBe("2026-01-01");
    expect(params.get("end_date")).toBe("2026-02-01");
  });
});

describe("generate runs-get, runs-items and runs-logs, on the wire", () => {
  it("reads one run by ID", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/content-generation/runs/:runId"), ({ request }) => {
        seen = request;
        return HttpResponse.json({ run_id: "r-1", status: "completed" });
      }),
    );

    const res = await runCli(["generate", "runs-get", "r-1", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/content-generation/runs/r-1");
    expect(res.json()).toEqual({ run_id: "r-1", status: "completed" });
  });

  it("reads a run's items with its own paging defaults and status filter", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/content-generation/runs/:runId/items"), ({ request }) => {
        seen = request;
        return HttpResponse.json({ items: [{ item_id: "i-1", status: "succeeded" }] });
      }),
    );

    await runCli(["generate", "runs-items", "r-1", "--status", "failed"]);

    const url = new URL(seen?.url ?? "");
    expect(url.pathname).toBe("/api/v1/org/content-generation/runs/r-1/items");
    expect(url.searchParams.get("limit")).toBe("100");
    expect(url.searchParams.get("offset")).toBe("0");
    expect(url.searchParams.get("status")).toBe("failed");
  });

  it("reads a run's logs, which take paging but no filter", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/content-generation/runs/:runId/logs"), ({ request }) => {
        seen = request;
        return HttpResponse.json({ logs: [{ level: "info", message: "started" }] });
      }),
    );

    await runCli(["generate", "runs-logs", "r-1", "--limit", "3", "--offset", "6"]);

    const url = new URL(seen?.url ?? "");
    expect(url.pathname).toBe("/api/v1/org/content-generation/runs/r-1/logs");
    expect(url.searchParams.get("limit")).toBe("3");
    expect(url.searchParams.get("offset")).toBe("6");
    expect(url.searchParams.has("status")).toBe(false);
  });

  it("renders one row per run under --output table", async () => {
    server.use(
      http.get(apiUrl("/org/content-generation/runs"), () =>
        HttpResponse.json({
          runs: [
            { run_id: "r-1", status: "completed" },
            { run_id: "r-2", status: "running" },
          ],
          total: 2,
        }),
      ),
    );

    const res = await runCli(["generate", "runs-list", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("run_id");
    expect(res.stdout).toContain("r-2");
    expect(res.stdout).toContain("running");
  });
});

describe("generate sample, on the wire", () => {
  it("submits the prompt and content type under the API's own field names", async () => {
    let seen: Request | undefined;
    let body: unknown;
    server.use(
      http.post(apiUrl("/org/content-generation/sample"), async ({ request }) => {
        seen = request;
        body = await request.json();
        return HttpResponse.json(SUBMITTED);
      }),
    );

    const res = await runCli([
      "generate",
      "sample",
      "--prompt-id",
      "p-1",
      "--content-type-id",
      "ct-1",
      "--no-wait",
    ]);

    expect(res.exitCode).toBe(0);
    expect(seen?.method).toBe("POST");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/content-generation/sample");
    // --prompt-id is geo_question_id on the wire. Renaming either side silently
    // generates content for the wrong prompt, so it is pinned here.
    expect(body).toEqual({ geo_question_id: "p-1", content_type_id: "ct-1" });
  });

  it("adds publish_destination only when --destination is given", async () => {
    let body: unknown;
    server.use(
      http.post(apiUrl("/org/content-generation/sample"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(SUBMITTED);
      }),
    );

    await runCli([
      "generate",
      "sample",
      "--prompt-id",
      "p-1",
      "--content-type-id",
      "ct-1",
      "--destination",
      "webflow",
      "--no-wait",
    ]);

    expect(body).toEqual({
      geo_question_id: "p-1",
      content_type_id: "ct-1",
      publish_destination: "webflow",
    });
  });
});

describe("generate sample --no-wait", () => {
  it("returns the accepted job immediately and never polls", async () => {
    const stub = stubSampleJob([job("queued")]);

    const res = await runCli([
      "generate",
      "sample",
      "--prompt-id",
      "p-1",
      "--content-type-id",
      "ct-1",
      "--no-wait",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    // The submit response is the payload, unmodified.
    expect(res.json()).toEqual(SUBMITTED);
    // The point of the flag: no waiting, and therefore no polling at all.
    expect(stub.polls()).toBe(0);
  });
});

describe("generate sample, while the job runs", () => {
  it("polls until the job completes and emits the job's result as the payload", async () => {
    vi.useFakeTimers();
    const stub = stubSampleJob([
      job("queued"),
      job("running"),
      job("completed", { result: SAMPLE_RESULT }),
    ]);

    const res = await runWhileTicking([
      "generate",
      "sample",
      "--prompt-id",
      "p-1",
      "--content-type-id",
      "ct-1",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    // The generated content, not the job envelope around it.
    expect(res.json()).toEqual(SAMPLE_RESULT);
    expect(stub.polls()).toBe(3);
  });

  it("falls back to the job itself when a completed job carries no result", async () => {
    vi.useFakeTimers();
    stubSampleJob([job("completed")]);

    const res = await runWhileTicking([
      "generate",
      "sample",
      "--prompt-id",
      "p-1",
      "--content-type-id",
      "ct-1",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toMatchObject({ sample_job_id: "sj-1", status: "completed" });
  });

  it("reports each status transition on stderr, never on stdout", async () => {
    vi.useFakeTimers();
    stubSampleJob([
      job("queued"),
      job("queued"),
      job("running"),
      job("completed", { result: SAMPLE_RESULT }),
    ]);

    const res = await runWhileTicking([
      "generate",
      "sample",
      "--prompt-id",
      "p-1",
      "--content-type-id",
      "ct-1",
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain("Sample job accepted: sj-1");
    expect(res.stderr).toContain("Sample job status: queued");
    expect(res.stderr).toContain("Sample job status: running");
    // Progress commentary is a diagnostic. A caller piping stdout must see the
    // generated markdown and nothing else.
    expect(res.stdout).not.toContain("Sample job status");
    expect(res.stdout).toContain("seo_title");
  });

  it("does not repeat a status that has not changed", async () => {
    vi.useFakeTimers();
    stubSampleJob([
      job("running"),
      job("running"),
      job("running"),
      job("completed", { result: SAMPLE_RESULT }),
    ]);

    const res = await runWhileTicking([
      "generate",
      "sample",
      "--prompt-id",
      "p-1",
      "--content-type-id",
      "ct-1",
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.stderr.match(/Sample job status: running/g)).toHaveLength(1);
  });

  it("says nothing while waiting under --output json", async () => {
    vi.useFakeTimers();
    stubSampleJob([job("running"), job("completed", { result: SAMPLE_RESULT })]);

    const res = await runWhileTicking([
      "generate",
      "sample",
      "--prompt-id",
      "p-1",
      "--content-type-id",
      "ct-1",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toBe("");
  });
});

describe("generate sample, when the job does not succeed", () => {
  it("exits 1 with the job's own error message and code when it fails", async () => {
    vi.useFakeTimers();
    stubSampleJob([
      job("running"),
      job("failed", {
        error: { code: "content_type_invalid", message: "The content type has no template." },
      }),
    ]);

    const res = await runWhileTicking([
      "generate",
      "sample",
      "--prompt-id",
      "p-1",
      "--content-type-id",
      "ct-1",
    ]);

    // A job that ran and failed is a server-side outcome, not a bad command
    // line: exit 1, and the reason is the only useful thing to print.
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("The content type has no template.");
    expect(res.stderr).toContain("content_type_invalid");
  });

  it("falls back to the status when a failed job reports a blank message", async () => {
    vi.useFakeTimers();
    stubSampleJob([job("failed", { error: { message: "" } })]);

    const res = await runWhileTicking([
      "generate",
      "sample",
      "--prompt-id",
      "p-1",
      "--content-type-id",
      "ct-1",
    ]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Sample job ended with status: failed");
  });

  it("exits 1 and names the status when the job expires", async () => {
    vi.useFakeTimers();
    stubSampleJob([job("queued"), job("expired")]);

    const res = await runWhileTicking([
      "generate",
      "sample",
      "--prompt-id",
      "p-1",
      "--content-type-id",
      "ct-1",
    ]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Sample job ended with status: expired");
  });

  it("reports the failure as JSON on stderr under --output json", async () => {
    vi.useFakeTimers();
    stubSampleJob([
      job("failed", { error: { code: "generation_failed", message: "No sources." } }),
    ]);

    const res = await runWhileTicking([
      "generate",
      "sample",
      "--prompt-id",
      "p-1",
      "--content-type-id",
      "ct-1",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");

    const reported: unknown = JSON.parse(res.stderr);
    expect(reported).toMatchObject({ error: { code: "error" } });
    expect(JSON.stringify(reported)).toContain("No sources.");
  });
});

describe("generate sample, when the job never finishes", () => {
  it("gives up after the timeout budget, exits 5 and says where to poll by hand", async () => {
    vi.useFakeTimers();
    // Never terminal: the CLI must stop waiting on its own.
    const stub = stubSampleJob([job("running")]);

    const res = await runWhileTicking([
      "generate",
      "sample",
      "--prompt-id",
      "p-1",
      "--content-type-id",
      "ct-1",
    ]);

    // 5, not 1: the job is probably still running server-side, so this is
    // "we stopped waiting", which a caller can retry.
    expect(res.exitCode).toBe(5);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Timed out waiting for sample job sj-1");
    // The hint has to name the URL, because the work is not lost.
    expect(res.stderr).toContain("/org/content-generation/sample-jobs/sj-1");
    // It really did keep polling for the whole budget rather than giving up early.
    expect(stub.polls()).toBe(TIMEOUT_MS / POLL_INTERVAL_MS);
  });
});
