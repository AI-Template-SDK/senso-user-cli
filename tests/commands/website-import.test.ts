/**
 * Command layer: `senso website-import`.
 *
 * An asynchronous operation with a completion signal that is easy to get wrong,
 * so that is what these protect.
 *
 * A finished import LEAVES `current` and appears as `latest_completed`. Polling
 * for `current.status` to turn terminal therefore waits forever — `current`
 * going null is the signal, and the outcome is read from the other field. The
 * polling tests below exist to keep that inversion from being "simplified" back
 * into a status check.
 *
 * The other thing worth protecting is the exit code. `start` waits, so a caller
 * that gets exit 0 must be able to trust the import worked; a failed import is
 * HTTP 200 with `status: "failed"` inside, which is exactly the shape that
 * silently passes if nobody asserts on it. `status` is a read and stays 0.
 *
 * Failure and conflict branches come first.
 */

import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../setup.js";
import { apiUrl, runCli } from "../helpers.js";

const RUN = {
  run_id: "run-1",
  status: "running",
  source_url: "https://acme.example",
  pages_fetched: 0,
  pages_ingested: 0,
  brand_kit_generated: false,
  created_at: "2026-09-13T10:00:00Z",
};

const DONE = {
  ...RUN,
  status: "completed",
  pages_fetched: 11,
  pages_ingested: 9,
  brand_kit_generated: true,
  completed_at: "2026-09-13T10:00:40Z",
};

const FAILED = {
  ...RUN,
  status: "failed",
  error_code: "HOMEPAGE_FETCH_FAILED",
  error_message: "The home page could not be read.",
  completed_at: "2026-09-13T10:00:20Z",
};

function serveTrigger(body: Record<string, unknown>, status = 202) {
  server.use(http.post(apiUrl("/org/website-import"), () => HttpResponse.json(body, { status })));
}

/** Serves a different status payload per call, so a poll can be watched. */
function serveStatusSequence(payloads: Record<string, unknown>[]) {
  let call = 0;
  server.use(
    http.get(apiUrl("/org/website-import/status"), () => {
      const body = payloads[Math.min(call, payloads.length - 1)];
      call += 1;
      return HttpResponse.json(body);
    }),
  );
  return () => call;
}

describe("senso website-import start, when it cannot run", () => {
  it("exits 1 and names the running import when the API answers 409", async () => {
    serveTrigger({ status: 409, message: "already running", current: RUN }, 409);

    const res = await runCli(["website-import", "start"]);

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("already running");
    expect(res.stderr).toContain("website-import status");
    expect(res.stdout).toBe("");
  });

  it("exits 1 when no website is on file (422)", async () => {
    serveTrigger(
      {
        status: 422,
        message: "No website on file for this organization",
        error_code: "NO_WEBSITE",
      },
      422,
    );

    const res = await runCli(["website-import", "start"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
  });

  it("exits 3 when the API key is rejected", async () => {
    serveTrigger({ error: "unauthorized" }, 401);

    const res = await runCli(["website-import", "start"]);

    expect(res.exitCode).toBe(3);
  });
});

describe("senso website-import start, when the import fails", () => {
  it("exits 1, reports the error code, and writes nothing to stdout", async () => {
    serveTrigger(RUN);
    serveStatusSequence([{ current: null, latest_completed: FAILED }]);

    const res = await runCli(["website-import", "start"]);

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("HOMEPAGE_FETCH_FAILED");
    expect(res.stderr).toContain("The home page could not be read.");
    // A caller that waited and got a payload would read it as success.
    expect(res.stdout).toBe("");
  });
});

describe("senso website-import start, on success", () => {
  it("polls until current clears and reports the run from latest_completed", async () => {
    serveTrigger(RUN);
    const calls = serveStatusSequence([
      { current: { ...RUN, status: "queued" }, latest_completed: null },
      { current: RUN, latest_completed: null },
      { current: null, latest_completed: DONE },
    ]);

    const res = await runCli(["website-import", "start", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(calls()).toBe(3);
    expect(JSON.parse(res.stdout)).toMatchObject({ run_id: "run-1", status: "completed" });
  });

  it("treats a skipped brand kit as a success, not a failure", async () => {
    serveTrigger(RUN);
    serveStatusSequence([
      {
        current: null,
        latest_completed: {
          ...DONE,
          brand_kit_generated: false,
          brand_kit_skip_reason: "already_populated",
        },
      },
    ]);

    const res = await runCli(["website-import", "start"]);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain("already has one");
  });

  it("returns the accepted run without polling under --no-wait", async () => {
    serveTrigger(RUN);
    const calls = serveStatusSequence([{ current: RUN, latest_completed: null }]);

    const res = await runCli(["website-import", "start", "--no-wait", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(calls()).toBe(0);
    expect(JSON.parse(res.stdout)).toMatchObject({ run_id: "run-1", status: "running" });
  });
});

describe("senso website-import status", () => {
  it("exits 0 even when the most recent import failed, because it is a read", async () => {
    serveStatusSequence([{ current: null, latest_completed: FAILED }]);

    const res = await runCli(["website-import", "status", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(JSON.parse(res.stdout)).toMatchObject({
      latest_completed: { status: "failed", error_code: "HOMEPAGE_FETCH_FAILED" },
    });
  });

  it("says so when the organization has never imported", async () => {
    serveStatusSequence([{ current: null, latest_completed: null }]);

    const res = await runCli(["website-import", "status"]);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain("never imported");
  });

  it("renders both slots under --output table", async () => {
    serveStatusSequence([{ current: RUN, latest_completed: DONE }]);

    const res = await runCli(["website-import", "status", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("current");
    expect(res.stdout).toContain("latest_completed");
    expect(res.stdout).toContain("https://acme.example");
  });
});
