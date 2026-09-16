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
 *     hand back the exact command to poll by hand, because the work is still
 *     running server-side;
 *   - the status commentary must stay on stderr, so `--output json | jq` sees
 *     only the generated content;
 *   - `--no-wait` must poll exactly zero times, which is the whole point of it,
 *     and must return the poll command in the envelope — under `--output json`
 *     stderr is silent, so a job id with no command beside it is a dead end.
 *
 * Two other things are worth protecting here because they cost money. Every id
 * and every closed-set flag is checked before the request: `--status complete`
 * used to return an empty list and exit 0, which an agent reads as "there are
 * no runs" rather than "you misspelled completed". And `industry-draft` is
 * billed and NOT stored, which has to be said in the output rather than only in
 * `--help`, because an agent that assumes it was saved loses the document.
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
import { apiUrl, envelope, errorEnvelope, runCli, type CliResult } from "../helpers.js";

/** Mirrors SAMPLE_JOB_POLL_INTERVAL_MS in src/commands/generate.ts. */
const POLL_INTERVAL_MS = 2_000;

/** Mirrors SAMPLE_JOB_TIMEOUT_MS in src/commands/generate.ts. */
const TIMEOUT_MS = 180_000;

// Real UUIDs throughout: every id these commands take is validated before the
// request, so a placeholder like "r-1" now exits 2 and never reaches MSW.
const ORG_ID = "1f0e9d8c-7b6a-4958-8473-625140392817";
const PROMPT_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const PROMPT_ID_2 = "8d0f7780-8536-41ef-a55c-f18fd2f01bf8";
const CONTENT_TYPE_ID = "0b7d2c44-9f1e-4a6b-8c3d-5e2f1a0b9c8d";
const PUBLISHER_ID = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const RUN_ID = "4e5f6a7b-8c9d-4e0f-a1b2-c3d4e5f6a7b8";
const RUN_ITEM_ID = "6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d";
const SAMPLE_JOB_ID = "3d2f8a1c-6e4b-4c9a-8f0e-1a2b3c4d5e6f";
const CONTENT_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const VERSION_ID = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";

/** dto.ContentGenerationSettingsResponse, with one selected publisher. */
const SETTINGS = {
  org_id: ORG_ID,
  enable_content_generation: true,
  content_auto_publish: false,
  content_schedule: [1, 3, 5],
  selected_content_type_id: CONTENT_TYPE_ID,
  publishers: [
    {
      publisher_id: PUBLISHER_ID,
      scope: "shared",
      name: "Citeables",
      slug: "citeables",
      type: "citeables",
      display_url: "citeables.com",
      active: true,
    },
  ],
};

/** dto.ContentGenerationSampleJobSubmitResponse. */
const SUBMITTED = {
  message: "Sample generation job accepted",
  sample_job_id: SAMPLE_JOB_ID,
  org_id: ORG_ID,
  status: "queued",
};

/** dto.ContentGenerationSampleResponse — what a completed job carries. */
const SAMPLE_RESULT = {
  content_id: CONTENT_ID,
  version_id: VERSION_ID,
  version_num: 1,
  raw_markdown: "# The Best CRMs for Startups\n\nA comparison.",
  seo_title: "The Best CRMs for Startups in 2026",
  url_slug: "best-crms-for-startups-2026",
  meta_data: { description: "A comparison of CRMs for early-stage teams." },
  json_ld: { "@type": "Article" },
  editorial_status: "draft",
  publish_status: "unpublished",
};

interface SampleJob {
  sample_job_id: string;
  org_id: string;
  status: string;
  created_at: string;
  updated_at: string;
  result?: unknown;
  error?: { code?: string; message?: string };
}

function job(status: string, extra: Partial<SampleJob> = {}): SampleJob {
  return {
    sample_job_id: SAMPLE_JOB_ID,
    org_id: ORG_ID,
    status,
    created_at: "2026-09-15T09:00:00Z",
    updated_at: "2026-09-15T09:00:04Z",
    ...extra,
  };
}

/** One row of dto.ContentGenerationRunListItemResponse, trimmed to the columns. */
function runRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_id: RUN_ID,
    org_id: ORG_ID,
    org_name: "Acme",
    status: "completed",
    active: false,
    trigger_mode: "manual",
    trigger_source: "api",
    actor_type: "user",
    selection_source: "settings",
    publisher_selection_source: "settings",
    requested_prompt_count: 2,
    resolved_prompt_count: 2,
    pending_items: 0,
    running_items: 0,
    succeeded_items: 2,
    failed_items: 0,
    skipped_items: 0,
    stopped_items: 0,
    started_at: "2026-09-15T09:00:00Z",
    completed_at: "2026-09-15T09:04:11Z",
    created_at: "2026-09-15T08:59:58Z",
    updated_at: "2026-09-15T09:04:11Z",
    ...overrides,
  };
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

/** The flags `generate sample` cannot run without. */
const SAMPLE_FLAGS = ["--prompt-id", PROMPT_ID, "--content-type-id", CONTENT_TYPE_ID];

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

  it("exits 4 naming the run and the id when it does not exist", async () => {
    server.use(
      http.get(
        apiUrl("/org/content-generation/runs/:runId"),
        () => new HttpResponse(null, { status: 404 }),
      ),
    );

    const res = await runCli(["generate", "runs-get", RUN_ID]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
    // The noun and the id, not a bare "Not found.": this API has several UUID
    // id spaces and they are not interchangeable.
    expect(res.stderr).toContain(`Run ${RUN_ID} not found`);
    expect(res.stderr).toContain("senso generate runs-list");
  });

  it("exits 1 on a 502 and says it is not the caller's fault", async () => {
    server.use(
      http.get(
        apiUrl("/org/content-generation/job-context"),
        () => new HttpResponse(null, { status: 502 }),
      ),
    );

    const res = await runCli(["generate", "job-context"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("server-side failure");
  });

  it("exits 1 on a 503 WITHOUT offering a retry, because retrying cannot work", async () => {
    server.use(
      http.get(apiUrl("/org/content-generation"), () =>
        HttpResponse.json({ message: "Content generation is not enabled here" }, { status: 503 }),
      ),
    );

    const res = await runCli(["generate", "settings"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("not a transient failure");
    expect(res.stderr).not.toContain("Retry shortly");
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
    expect(errorEnvelope(res)).toMatchObject({
      ok: false,
      command: "generate settings",
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

  it("exits 2 on an empty --data, which the API would read as changing nothing", async () => {
    const res = await runCli(["generate", "update-settings", "--data", "{}"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Name at least one setting to change");
  });

  it("exits 2 on a schedule day outside 0-6, naming the day that was wrong", async () => {
    const res = await runCli([
      "generate",
      "update-settings",
      "--data",
      '{"content_schedule":[1,7]}',
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(errorEnvelope(res).error).toMatchObject({
      code: "usage",
      field: "--data.content_schedule[1]",
      received: "7",
      allowed: ["0", "1", "2", "3", "4", "5", "6"],
    });
  });

  it("exits 2 when update-settings is missing its required --data", async () => {
    const res = await runCli(["generate", "update-settings"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
  });

  it("exits 2 when sample is missing its required --content-type-id", async () => {
    const res = await runCli(["generate", "sample", "--prompt-id", PROMPT_ID]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
  });

  it("exits 2 when --prompt-id is not a UUID, naming the id space it wanted", async () => {
    const res = await runCli([
      "generate",
      "sample",
      "--prompt-id",
      "p-1",
      "--content-type-id",
      CONTENT_TYPE_ID,
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(errorEnvelope(res).error).toMatchObject({
      code: "usage",
      field: "--prompt-id",
      received: "p-1",
    });
    expect(errorEnvelope(res).error.hint).toContain("senso prompts list");
  });

  it("names the valid formats when --output is not one of them", async () => {
    const res = await runCli(["generate", "settings", "--output", "yaml"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("json, table, plain");
  });
});

describe("generate runs-list --status, which used to be forwarded unchecked", () => {
  // No handler is registered in this block: an unmocked request fails the test,
  // so passing is itself the assertion that the guard ran first. That matters
  // more here than elsewhere — the API answers an unknown status with an empty
  // list and a 200, which reads as "there are no runs".
  it("exits 2 on a misspelled --status and hands back the accepted set", async () => {
    const res = await runCli(["generate", "runs-list", "--status", "complete", "--output", "json"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");

    const { error } = errorEnvelope(res);
    expect(error.code).toBe("usage");
    expect(error.field).toBe("--status");
    expect(error.received).toBe("complete");
    expect(error.allowed).toEqual([
      "queued",
      "running",
      "completed",
      "partial_failed",
      "failed",
      "dispatch_failed",
      "blocked",
      "skipped",
      "stopped",
    ]);
  });

  it("exits 2 when --limit is below 1 rather than letting the API clamp it", async () => {
    const res = await runCli(["generate", "runs-list", "--limit", "0"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("--limit");
  });

  it("exits 2 when a date is neither YYYY-MM-DD nor RFC 3339", async () => {
    const res = await runCli(["generate", "runs-list", "--start-date", "last tuesday"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("--start-date");
  });
});

describe("generate runs-items --status, checked against the item statuses", () => {
  it("exits 2 on a run status used where an ITEM status belongs", async () => {
    // "completed" is a valid RUN status and not a valid item status. The two
    // sets overlap enough that forwarding the wrong one looks plausible.
    const res = await runCli([
      "generate",
      "runs-items",
      RUN_ID,
      "--status",
      "completed",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");

    const { error } = errorEnvelope(res);
    expect(error.field).toBe("--status");
    expect(error.allowed).toEqual([
      "pending",
      "running",
      "succeeded",
      "failed",
      "skipped",
      "stopped",
    ]);
  });

  it("exits 2 when the run id is not a UUID, before asking for its items", async () => {
    const res = await runCli(["generate", "runs-items", "r-1"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("not a UUID");
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
    expect(res.data()).toEqual(SETTINGS);
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
    expect(res.stdout).toContain(CONTENT_TYPE_ID);
  });

  it("names the one command that fixes generation being switched off", async () => {
    server.use(
      http.get(apiUrl("/org/content-generation"), () =>
        HttpResponse.json({ ...SETTINGS, enable_content_generation: false }),
      ),
    );

    const res = await runCli(["generate", "settings", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(envelope(res).next?.[0]?.command).toContain(
      "senso generate update-settings --data '{\"enable_content_generation\":true}'",
    );
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

    const res = await runCli([
      "generate",
      "update-settings",
      "--data",
      '{"enable_content_generation":true}',
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain("Updated content generation settings");
    expect(res.stdout).not.toContain("Updated content generation settings");
    expect(res.stdout).toContain("enable_content_generation");
  });

  it("warns when generation is on but no destination is selected", async () => {
    server.use(
      http.patch(apiUrl("/org/content-generation"), () =>
        HttpResponse.json({ ...SETTINGS, publishers: [] }),
      ),
    );

    const res = await runCli([
      "generate",
      "update-settings",
      "--data",
      '{"enable_content_generation":true}',
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    expect(envelope(res).warnings?.[0]).toContain("no destination is selected");
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
        return HttpResponse.json({
          message: "Run accepted",
          org_id: ORG_ID,
          run_id: RUN_ID,
        });
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
        return HttpResponse.json({ message: "Run accepted", org_id: ORG_ID, run_id: RUN_ID });
      }),
    );

    await runCli([
      "generate",
      "run",
      "--prompt-ids",
      PROMPT_ID,
      PROMPT_ID_2,
      "--content-type-id",
      CONTENT_TYPE_ID,
      "--publisher-ids",
      PUBLISHER_ID,
    ]);

    expect(body).toEqual({
      prompt_ids: [PROMPT_ID, PROMPT_ID_2],
      content_type_id: CONTENT_TYPE_ID,
      publisher_ids: [PUBLISHER_ID],
    });
  });

  it("names every bad id at once rather than one round trip each", async () => {
    const res = await runCli([
      "generate",
      "run",
      "--prompt-ids",
      "p-1",
      PROMPT_ID,
      "p-2",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    expect(errorEnvelope(res).error.received).toBe("p-1, p-2");
  });

  it("hands back the exact poll commands, with the real run id substituted", async () => {
    // The run continues server-side and `--output json` silences stderr, so a
    // run_id with no command beside it is where an agent stops.
    server.use(
      http.post(apiUrl("/org/content-generation/run"), () =>
        HttpResponse.json({ message: "Run accepted", org_id: ORG_ID, run_id: RUN_ID }),
      ),
    );

    const res = await runCli(["generate", "run", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(envelope(res).next?.map((n) => n.command)).toEqual([
      `senso generate runs-get ${RUN_ID}`,
      `senso generate runs-items ${RUN_ID}`,
    ]);
  });

  it("puts the accepted line on stderr, never on stdout", async () => {
    server.use(
      http.post(apiUrl("/org/content-generation/run"), () =>
        HttpResponse.json({ message: "Run accepted", org_id: ORG_ID, run_id: RUN_ID }),
      ),
    );

    const res = await runCli(["generate", "run"]);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain(`Run ${RUN_ID} accepted.`);
    expect(res.stderr).toContain(`senso generate runs-get ${RUN_ID}`);
    expect(res.stdout).not.toContain("accepted.");
  });
});

describe("generate job-context, on the wire", () => {
  it("reads the job-context resource", async () => {
    let seen: Request | undefined;
    const payload = {
      org_id: ORG_ID,
      org_name: "Acme",
      org_slug: "acme",
      content_auto_publish: false,
      selected_content_type_id: CONTENT_TYPE_ID,
      prompts: [],
      summary: { total_prompts: 4, create_queue_count: 3, update_queue_count: 1 },
    };
    server.use(
      http.get(apiUrl("/org/content-generation/job-context"), ({ request }) => {
        seen = request;
        return HttpResponse.json(payload);
      }),
    );

    const res = await runCli(["generate", "job-context", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(seen?.method).toBe("GET");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/content-generation/job-context");
    expect(res.data()).toEqual(payload);
  });

  it("renders the prompts a run would process, with the queue each is in", async () => {
    server.use(
      http.get(apiUrl("/org/content-generation/job-context"), () =>
        HttpResponse.json({
          org_id: ORG_ID,
          org_name: "Acme",
          org_slug: "acme",
          content_auto_publish: false,
          selected_content_type_id: CONTENT_TYPE_ID,
          prompts: [
            {
              geo_question_id: PROMPT_ID,
              question_text: "what is the best CRM for startups",
              type: "consideration",
              has_content: false,
              queue_type: "create",
              content_id: null,
              latest_version_id: null,
              ever_published: false,
              citeables_action: "create",
            },
            {
              geo_question_id: PROMPT_ID_2,
              question_text: "how much does a CRM cost",
              type: "evaluation",
              has_content: true,
              queue_type: "update",
              content_id: CONTENT_ID,
              latest_version_id: VERSION_ID,
              // omitempty on the wire: only an update-queue prompt has one, so
              // a fixture of create-queue rows alone would hide the column.
              editorial_status: "published",
              ever_published: true,
              citeables_action: "update",
            },
          ],
          summary: { total_prompts: 2, create_queue_count: 1, update_queue_count: 1 },
        }),
      ),
    );

    const res = await runCli(["generate", "job-context", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("queue_type");
    expect(res.stdout).toContain("create");
    expect(res.stdout).toContain(PROMPT_ID);
    // Every declared column is a field the API really returns.
    expect(res.stderr).not.toContain("did not return");
  });
});

describe("generate runs-list, on the wire", () => {
  it("applies the paging defaults and sends no filter parameters", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/content-generation/runs"), ({ request }) => {
        seen = request;
        return HttpResponse.json({ runs: [runRow()], total: 1, limit: 20, offset: 0 });
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
        return HttpResponse.json({ runs: [], total: 0, limit: 5, offset: 15 });
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

  it("names the filters that could have hidden a run when nothing matched", async () => {
    server.use(
      http.get(apiUrl("/org/content-generation/runs"), () =>
        HttpResponse.json({ runs: [], total: 0, limit: 20, offset: 0 }),
      ),
    );

    const res = await runCli(["generate", "runs-list", "--status", "blocked", "--active-only"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("No runs found.");
    expect(res.stderr).toContain("--status blocked --active-only");
  });

  it("carries the caller's own filters into the next-page command", async () => {
    // A next page that drops the filters pages through a different result set
    // than the one the caller was reading, which is worse than saying nothing.
    server.use(
      http.get(apiUrl("/org/content-generation/runs"), () =>
        HttpResponse.json({
          runs: [runRow(), runRow({ run_id: PROMPT_ID_2, status: "running", active: true })],
          total: 9,
          limit: 2,
          offset: 0,
        }),
      ),
    );

    const res = await runCli([
      "generate",
      "runs-list",
      "--limit",
      "2",
      "--status",
      "running",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    const { page } = envelope(res);
    expect(page).toMatchObject({ offset: 0, limit: 2, returned: 2, total: 9, has_more: true });
    expect(page?.next).toContain("--status running");
    expect(page?.next).toContain("--offset 2");
  });

  it("prints the paging footer on stderr and nothing about it on stdout", async () => {
    server.use(
      http.get(apiUrl("/org/content-generation/runs"), () =>
        HttpResponse.json({ runs: [runRow()], total: 9, limit: 1, offset: 4 }),
      ),
    );

    const res = await runCli(["generate", "runs-list", "--limit", "1", "--offset", "4"]);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain("Showing 5–5 of 9.");
    expect(res.stderr).toContain("Next page:");
    expect(res.stdout).not.toContain("Showing");
  });
});

describe("generate runs-get, runs-items and runs-logs, on the wire", () => {
  it("reads one run by ID", async () => {
    let seen: Request | undefined;
    const payload = { run: runRow() };
    server.use(
      http.get(apiUrl("/org/content-generation/runs/:runId"), ({ request }) => {
        seen = request;
        return HttpResponse.json(payload);
      }),
    );

    const res = await runCli(["generate", "runs-get", RUN_ID, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(new URL(seen?.url ?? "").pathname).toBe(`/api/v1/org/content-generation/runs/${RUN_ID}`);
    // json keeps the API's own `{ run: {...} }` wrapper; only plain and table
    // see the unwrapped row.
    expect(res.data()).toEqual(payload);
  });

  it("unwraps the run for the table, rather than stringifying it onto one key", async () => {
    server.use(
      http.get(apiUrl("/org/content-generation/runs/:runId"), () =>
        HttpResponse.json({ run: runRow() }),
      ),
    );

    const res = await runCli(["generate", "runs-get", RUN_ID, "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("succeeded_items");
    expect(res.stdout).toContain(RUN_ID);
    expect(res.stderr).not.toContain("did not return");
  });

  it("says to poll again while the run is still active", async () => {
    server.use(
      http.get(apiUrl("/org/content-generation/runs/:runId"), () =>
        HttpResponse.json({ run: runRow({ status: "running", active: true }) }),
      ),
    );

    const res = await runCli(["generate", "runs-get", RUN_ID, "--output", "json"]);

    expect(envelope(res).next).toEqual([
      {
        why: "The run is still active; poll it again",
        command: `senso generate runs-get ${RUN_ID}`,
      },
    ]);
  });

  it("reads a run's items with its own paging defaults and status filter", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/content-generation/runs/:runId/items"), ({ request }) => {
        seen = request;
        return HttpResponse.json({ items: [], total: 0, limit: 100, offset: 0 });
      }),
    );

    await runCli(["generate", "runs-items", RUN_ID, "--status", "failed"]);

    const url = new URL(seen?.url ?? "");
    expect(url.pathname).toBe(`/api/v1/org/content-generation/runs/${RUN_ID}/items`);
    expect(url.searchParams.get("limit")).toBe("100");
    expect(url.searchParams.get("offset")).toBe("0");
    expect(url.searchParams.get("status")).toBe("failed");
  });

  it("points at the content a succeeded item produced", async () => {
    server.use(
      http.get(apiUrl("/org/content-generation/runs/:runId/items"), () =>
        HttpResponse.json({
          items: [
            {
              run_item_id: RUN_ITEM_ID,
              run_id: RUN_ID,
              geo_question_id: PROMPT_ID,
              question_text: "what is the best CRM for startups",
              queue_type: "create",
              status: "succeeded",
              content_id: CONTENT_ID,
              version_id: VERSION_ID,
              created_at: "2026-09-15T09:00:00Z",
              updated_at: "2026-09-15T09:02:00Z",
            },
          ],
          total: 1,
          limit: 100,
          offset: 0,
        }),
      ),
    );

    const res = await runCli(["generate", "runs-items", RUN_ID, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(envelope(res).next?.[0]?.command).toBe(`senso generated-content get ${CONTENT_ID}`);
  });

  it("reads a run's logs, which take paging but no filter", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/content-generation/runs/:runId/logs"), ({ request }) => {
        seen = request;
        return HttpResponse.json({
          logs: [
            {
              log_id: "5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f",
              run_id: RUN_ID,
              level: "info",
              event_type: "run_started",
              message: "started",
              created_at: "2026-09-15T09:00:00Z",
            },
          ],
          total: 1,
          limit: 3,
          offset: 6,
        });
      }),
    );

    await runCli(["generate", "runs-logs", RUN_ID, "--limit", "3", "--offset", "6"]);

    const url = new URL(seen?.url ?? "");
    expect(url.pathname).toBe(`/api/v1/org/content-generation/runs/${RUN_ID}/logs`);
    expect(url.searchParams.get("limit")).toBe("3");
    expect(url.searchParams.get("offset")).toBe("6");
    expect(url.searchParams.has("status")).toBe(false);
  });

  it("renders one row per run under --output table", async () => {
    server.use(
      http.get(apiUrl("/org/content-generation/runs"), () =>
        HttpResponse.json({
          runs: [runRow(), runRow({ run_id: PROMPT_ID_2, status: "running", active: true })],
          total: 2,
          limit: 20,
          offset: 0,
        }),
      ),
    );

    const res = await runCli(["generate", "runs-list", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("run_id");
    expect(res.stdout).toContain("running");
    expect(res.stderr).not.toContain("did not return");
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

    const res = await runCli(["generate", "sample", ...SAMPLE_FLAGS, "--no-wait"]);

    expect(res.exitCode).toBe(0);
    expect(seen?.method).toBe("POST");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/content-generation/sample");
    // --prompt-id is geo_question_id on the wire. Renaming either side silently
    // generates content for the wrong prompt, so it is pinned here.
    expect(body).toEqual({ geo_question_id: PROMPT_ID, content_type_id: CONTENT_TYPE_ID });
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
      ...SAMPLE_FLAGS,
      "--destination",
      "citeables",
      "--no-wait",
    ]);

    expect(body).toEqual({
      geo_question_id: PROMPT_ID,
      content_type_id: CONTENT_TYPE_ID,
      publish_destination: "citeables",
    });
  });

  it("exits 2 on an empty --destination rather than submitting a billable job", async () => {
    const res = await runCli(["generate", "sample", ...SAMPLE_FLAGS, "--destination", "  "]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("--destination");
  });
});

describe("generate sample --no-wait", () => {
  it("returns the accepted job immediately and never polls", async () => {
    const stub = stubSampleJob([job("queued")]);

    const res = await runCli([
      "generate",
      "sample",
      ...SAMPLE_FLAGS,
      "--no-wait",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    // The submit response is the payload, unmodified.
    expect(res.data()).toEqual(SUBMITTED);
    // The point of the flag: no waiting, and therefore no polling at all.
    expect(stub.polls()).toBe(0);
  });

  it("hands back the exact poll command, with the job id substituted", async () => {
    // Under --output json stderr is silent, so a sample_job_id with no command
    // beside it leaves an agent holding an id it cannot use.
    stubSampleJob([job("queued")]);

    const res = await runCli([
      "generate",
      "sample",
      ...SAMPLE_FLAGS,
      "--no-wait",
      "--output",
      "json",
    ]);

    expect(envelope(res).next).toEqual([
      {
        why: "Poll until the job is completed or failed",
        command: `senso generate sample-status ${SAMPLE_JOB_ID}`,
      },
    ]);
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

    const res = await runWhileTicking(["generate", "sample", ...SAMPLE_FLAGS, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    // The generated content, not the job envelope around it.
    expect(res.data()).toEqual(SAMPLE_RESULT);
    expect(stub.polls()).toBe(3);
  });

  it("hands back the commands that read and check the draft it just saved", async () => {
    vi.useFakeTimers();
    stubSampleJob([job("completed", { result: SAMPLE_RESULT })]);

    const res = await runWhileTicking(["generate", "sample", ...SAMPLE_FLAGS, "--output", "json"]);

    expect(envelope(res).next?.map((n) => n.command)).toEqual([
      `senso generated-content get ${CONTENT_ID}`,
      `senso ctas for-content ${CONTENT_ID}`,
    ]);
  });

  it("falls back to the job itself when a completed job carries no result", async () => {
    vi.useFakeTimers();
    stubSampleJob([job("completed")]);

    const res = await runWhileTicking(["generate", "sample", ...SAMPLE_FLAGS, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toMatchObject({ sample_job_id: SAMPLE_JOB_ID, status: "completed" });
  });

  it("reports each status transition on stderr, never on stdout", async () => {
    vi.useFakeTimers();
    stubSampleJob([
      job("queued"),
      job("queued"),
      job("running"),
      job("completed", { result: SAMPLE_RESULT }),
    ]);

    const res = await runWhileTicking(["generate", "sample", ...SAMPLE_FLAGS]);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain(`Sample job accepted: ${SAMPLE_JOB_ID}`);
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

    const res = await runWhileTicking(["generate", "sample", ...SAMPLE_FLAGS]);

    expect(res.exitCode).toBe(0);
    expect(res.stderr.match(/Sample job status: running/g)).toHaveLength(1);
  });

  it("says nothing while waiting under --output json", async () => {
    vi.useFakeTimers();
    stubSampleJob([job("running"), job("completed", { result: SAMPLE_RESULT })]);

    const res = await runWhileTicking(["generate", "sample", ...SAMPLE_FLAGS, "--output", "json"]);

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
        error: { code: "content_type_not_found", message: "The content type has no template." },
      }),
    ]);

    const res = await runWhileTicking(["generate", "sample", ...SAMPLE_FLAGS]);

    // A job that ran and failed is a server-side outcome, not a bad command
    // line: exit 1, and the reason is the only useful thing to print.
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("The content type has no template.");
    expect(res.stderr).toContain("content_type_not_found");
    // The job's own code is what the hint is chosen by — the HTTP status was 200.
    expect(res.stderr).toContain("senso content-types list");
  });

  it("lifts a credit failure to its own stable code, since topping up is a different reaction", async () => {
    vi.useFakeTimers();
    stubSampleJob([
      job("failed", { error: { code: "insufficient_credits", message: "No credits left." } }),
    ]);

    const res = await runWhileTicking(["generate", "sample", ...SAMPLE_FLAGS, "--output", "json"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(errorEnvelope(res).error).toMatchObject({
      code: "insufficient_credits",
      details: { sample_job_id: SAMPLE_JOB_ID, status: "failed", job_code: "insufficient_credits" },
    });
  });

  it("falls back to the status when a failed job reports a blank message", async () => {
    vi.useFakeTimers();
    stubSampleJob([job("failed", { error: { message: "" } })]);

    const res = await runWhileTicking(["generate", "sample", ...SAMPLE_FLAGS]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Sample job ended with status: failed");
  });

  it("exits 1 and names the status when the job expires", async () => {
    vi.useFakeTimers();
    stubSampleJob([job("queued"), job("expired")]);

    const res = await runWhileTicking(["generate", "sample", ...SAMPLE_FLAGS]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Sample job ended with status: expired");
  });

  it("reports the failure as JSON on stderr under --output json", async () => {
    vi.useFakeTimers();
    stubSampleJob([
      job("failed", { error: { code: "content_generation_failed", message: "No sources." } }),
    ]);

    const res = await runWhileTicking(["generate", "sample", ...SAMPLE_FLAGS, "--output", "json"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");

    const { error } = errorEnvelope(res);
    expect(error.code).toBe("error");
    expect(error.message).toContain("No sources.");
  });
});

describe("generate sample, when the job never finishes", () => {
  it("gives up after the timeout budget, exits 5 and says where to poll by hand", async () => {
    vi.useFakeTimers();
    // Never terminal: the CLI must stop waiting on its own.
    const stub = stubSampleJob([job("running")]);

    const res = await runWhileTicking(["generate", "sample", ...SAMPLE_FLAGS]);

    // 5, not 1: the job is probably still running server-side, so this is
    // "we stopped waiting", which a caller can retry.
    expect(res.exitCode).toBe(5);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain(`Timed out after 180 s waiting for sample job ${SAMPLE_JOB_ID}`);
    expect(res.stderr).toContain("last status: running");
    // The hint has to be the runnable command, because the work is not lost.
    expect(res.stderr).toContain(`senso generate sample-status ${SAMPLE_JOB_ID}`);
    // It really did keep polling for the whole budget rather than giving up early.
    expect(stub.polls()).toBe(TIMEOUT_MS / POLL_INTERVAL_MS);
  });
});

describe("generate sample-status", () => {
  it("exits 4 naming the sample job when the id is unknown", async () => {
    server.use(
      http.get(
        apiUrl("/org/content-generation/sample-jobs/:id"),
        () => new HttpResponse(null, { status: 404 }),
      ),
    );

    const res = await runCli(["generate", "sample-status", SAMPLE_JOB_ID]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain(`Sample job ${SAMPLE_JOB_ID} not found`);
  });

  it("says to poll again while the job is not finished", async () => {
    server.use(
      http.get(apiUrl("/org/content-generation/sample-jobs/:id"), () =>
        HttpResponse.json(job("running")),
      ),
    );

    const res = await runCli(["generate", "sample-status", SAMPLE_JOB_ID, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(envelope(res).next).toEqual([
      {
        why: "The job is not finished; poll it again",
        command: `senso generate sample-status ${SAMPLE_JOB_ID}`,
      },
    ]);
  });
});

/**
 * `generate industry-draft` is synchronous, slow and billable — 10-30 seconds and
 * credits per call in live testing. That is why the length limits are checked
 * here rather than left to the API: a body that will be rejected for a 501-char
 * `--audience` should not cost the caller a round trip to find out, and a 402
 * has to be legible rather than a generic failure.
 *
 * The other thing worth protecting is that the result is NOT STORED. Nothing in
 * `senso generated-content` will show it, so the output itself has to say so —
 * a fact that lives only in `--help` reaches an agent that never read the help.
 */
describe("generate industry-draft", () => {
  const INDUSTRY_PROMPT_ID = "a4226991-3d00-49ec-b5cc-95642c946cc0";
  const CT_ID = "06f9f0df-b9b5-42d9-af53-859f1a47f27e";
  const PL_1 = "b5c6d7e8-f9a0-4b1c-8d2e-3f4a5b6c7d8e";
  const PL_2 = "c6d7e8f9-a0b1-4c2d-8e3f-4a5b6c7d8e9f";

  /** dto.BuilderIndustryPromptDraftResponse. */
  const DRAFT = {
    industry_prompt_id: INDUSTRY_PROMPT_ID,
    prompt_text: "How do change fees compare?",
    funnel_stage: "consideration",
    document_markdown: "# Heading\n\nBody.[^1]",
    content_type: { id: CT_ID, name: "Comparison" },
    citations: [
      {
        id: "1",
        url: "https://example.com/change-fees",
        label: "Change fee policy",
        snippet: "Fees vary by fare class.",
      },
    ],
    retrieval: { total_results: 12, context_chunks_used: 6 },
    usage: { input_tokens: 4210, output_tokens: 1180 },
    model_used: "claude-sonnet-4-6",
    notes: [],
  };

  const draftPath = "/org/content-generation/industry-prompt-draft";

  it("exits 2 without sending a request when --audience is over 500 characters", async () => {
    const res = await runCli([
      "generate",
      "industry-draft",
      "--industry-prompt-id",
      INDUSTRY_PROMPT_ID,
      "--content-type-id",
      CT_ID,
      "--audience",
      "x".repeat(501),
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("maximum is 500");
    // Said out loud, because the reason for checking here is that the call costs.
    expect(res.stderr).toContain("nothing was sent or billed");
  });

  it("exits 2 when --extra-instructions is over 4000 characters", async () => {
    const res = await runCli([
      "generate",
      "industry-draft",
      "--industry-prompt-id",
      INDUSTRY_PROMPT_ID,
      "--content-type-id",
      CT_ID,
      "--extra-instructions",
      "x".repeat(4001),
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("maximum is 4000");
  });

  it("exits 2 when more than 100 product line ids are given", async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `pl-${String(i)}`).join(",");

    const res = await runCli([
      "generate",
      "industry-draft",
      "--industry-prompt-id",
      INDUSTRY_PROMPT_ID,
      "--content-type-id",
      CT_ID,
      "--product-line-ids",
      ids,
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("maximum is 100");
  });

  it("exits 2 when an industry prompt id is not a UUID, naming where they come from", async () => {
    const res = await runCli([
      "generate",
      "industry-draft",
      "--industry-prompt-id",
      "ip-1",
      "--content-type-id",
      CT_ID,
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    expect(errorEnvelope(res).error).toMatchObject({
      code: "usage",
      field: "--industry-prompt-id",
      received: "ip-1",
    });
    expect(errorEnvelope(res).error.hint).toContain("senso industries prompts");
  });

  it("exits 2 when the required options are missing", async () => {
    const res = await runCli(["generate", "industry-draft"]);

    expect(res.exitCode).toBe(2);
  });

  it("exits 1 and stays legible on a 402 for an insufficient credit balance", async () => {
    server.use(
      http.post(apiUrl(draftPath), () =>
        HttpResponse.json({ message: "Insufficient credits" }, { status: 402 }),
      ),
    );

    const res = await runCli([
      "generate",
      "industry-draft",
      "--industry-prompt-id",
      INDUSTRY_PROMPT_ID,
      "--content-type-id",
      CT_ID,
    ]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Insufficient credits");
    expect(res.stderr).toContain("senso credits balance");
  });

  it("exits 4 naming the industry prompt when it is not in this organization's industry", async () => {
    server.use(
      http.post(apiUrl(draftPath), () =>
        HttpResponse.json({ message: "Not found" }, { status: 404 }),
      ),
    );

    const res = await runCli([
      "generate",
      "industry-draft",
      "--industry-prompt-id",
      INDUSTRY_PROMPT_ID,
      "--content-type-id",
      CT_ID,
    ]);

    expect(res.exitCode).toBe(4);
    expect(res.stderr).toContain(`Industry prompt ${INDUSTRY_PROMPT_ID} not found`);
  });

  it("sends only the fields that were given", async () => {
    let body: unknown;
    server.use(
      http.post(apiUrl(draftPath), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(DRAFT);
      }),
    );

    const res = await runCli([
      "generate",
      "industry-draft",
      "--industry-prompt-id",
      INDUSTRY_PROMPT_ID,
      "--content-type-id",
      CT_ID,
    ]);

    expect(res.exitCode).toBe(0);
    expect(body).toEqual({
      industry_prompt_id: INDUSTRY_PROMPT_ID,
      selected_content_type_id: CT_ID,
    });
  });

  it("maps every optional flag onto its snake_case field", async () => {
    let body: unknown;
    server.use(
      http.post(apiUrl(draftPath), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(DRAFT);
      }),
    );

    await runCli([
      "generate",
      "industry-draft",
      "--industry-prompt-id",
      INDUSTRY_PROMPT_ID,
      "--content-type-id",
      CT_ID,
      "--product-line-ids",
      `${PL_1}, ${PL_2}`,
      "--audience",
      "Business travelers",
      "--style-tone",
      "Direct",
      "--extra-instructions",
      "Avoid pricing claims",
    ]);

    expect(body).toEqual({
      industry_prompt_id: INDUSTRY_PROMPT_ID,
      selected_content_type_id: CT_ID,
      selected_product_line_ids: [PL_1, PL_2],
      audience: "Business travelers",
      style_tone: "Direct",
      extra_instructions: "Avoid pricing claims",
    });
  });

  it("says in the output that the draft was NOT stored, not only in the help", async () => {
    server.use(http.post(apiUrl(draftPath), () => HttpResponse.json(DRAFT)));

    const res = await runCli([
      "generate",
      "industry-draft",
      "--industry-prompt-id",
      INDUSTRY_PROMPT_ID,
      "--content-type-id",
      CT_ID,
    ]);

    expect(res.exitCode).toBe(0);
    // An agent that assumes this was saved moves on and loses the document, so
    // the fact travels with the result rather than living in --help.
    expect(res.stderr).toContain("NOT stored");
    expect(res.stderr).toContain("senso engine draft");
    // And the markdown really is on stdout, where it can be redirected.
    expect(res.stdout).toContain("document_markdown");
  });

  it("carries the same warning in the envelope, where --output json can read it", async () => {
    // `--output json` silences stderr, and every published Senso skill passes
    // it — so a warning written only to stderr reaches nobody who needs it.
    server.use(http.post(apiUrl(draftPath), () => HttpResponse.json(DRAFT)));

    const res = await runCli([
      "generate",
      "industry-draft",
      "--industry-prompt-id",
      INDUSTRY_PROMPT_ID,
      "--content-type-id",
      CT_ID,
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    expect(envelope(res).warnings?.[0]).toContain("NOT stored");
    expect(envelope(res).next?.[0]?.command).toContain("senso engine draft");
  });

  it("repeats the API's own notes as warnings, so an ungrounded draft says so", async () => {
    server.use(
      http.post(apiUrl(draftPath), () =>
        HttpResponse.json({
          ...DRAFT,
          retrieval: { total_results: 0, context_chunks_used: 0 },
          notes: ["Retrieval returned no context; this draft is ungrounded."],
        }),
      ),
    );

    const res = await runCli([
      "generate",
      "industry-draft",
      "--industry-prompt-id",
      INDUSTRY_PROMPT_ID,
      "--content-type-id",
      CT_ID,
      "--output",
      "json",
    ]);

    expect(envelope(res).warnings).toContain(
      "Retrieval returned no context; this draft is ungrounded.",
    );
  });

  it("keeps the progress line off stdout under --output json", async () => {
    server.use(http.post(apiUrl(draftPath), () => HttpResponse.json(DRAFT)));

    const res = await runCli([
      "generate",
      "industry-draft",
      "--industry-prompt-id",
      INDUSTRY_PROMPT_ID,
      "--content-type-id",
      CT_ID,
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.data<{ document_markdown: string }>().document_markdown).toBe(
      "# Heading\n\nBody.[^1]",
    );
    expect(res.stderr).toBe("");
  });
});

describe("generate industry-draft, the empty product-line list", () => {
  /**
   * Omitting `selected_product_line_ids` means "all of them", so sending `[]`
   * is not the same thing — it would strip the product-line context off a call
   * that consumes credits. An explicitly empty list is a usage error instead.
   */
  it("exits 2 rather than sending an empty selected_product_line_ids", async () => {
    let called = false;
    server.use(
      http.post(apiUrl("/org/content-generation/industry-prompt-draft"), () => {
        called = true;
        return HttpResponse.json({});
      }),
    );

    const res = await runCli([
      "generate",
      "industry-draft",
      "--industry-prompt-id",
      "a4226991-3d00-49ec-b5cc-95642c946cc0",
      "--content-type-id",
      "06f9f0df-b9b5-42d9-af53-859f1a47f27e",
      "--product-line-ids",
      "",
    ]);

    expect(res.exitCode).toBe(2);
    expect(called).toBe(false);
    expect(res.stderr).toContain("Omit the flag");
  });
});
