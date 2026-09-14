/**
 * Command layer: `senso evals`.
 *
 * Four things here are worth protecting.
 *
 * The first is that `--wait` polls rather than asking the API to hold the
 * connection. The endpoint does support `wait: true`, but `apiRequest` gives up
 * at 30 seconds and a judge run measured 18 seconds once and over 30 the next,
 * so the flag would have failed about as often as it worked. The body must
 * therefore NOT carry `wait`, and the command must poll the run instead.
 *
 * The second is what a failed run does. A caller who passed `--wait` asked for a
 * verdict; a run that ends `failed` has none, so stdout stays empty and the exit
 * code is 1 — the same contract as `website-import start`. Without `--wait`, a
 * queued run IS the answer and exits 0.
 *
 * The third is `--from` / `--to`. These are RFC 3339 instants, unlike the
 * `YYYY-MM-DD` dates every other windowed command in this CLI takes. The API
 * answers a plain date with a 400, so the check belongs here.
 *
 * The fourth is what is NOT validated: `--evaluator` and `--subject-type` on the
 * list commands have no enum in the spec, and real subject types include
 * `question_run` and `search_turn`. Restricting them would reject valid filters.
 *
 * Failure branches come first, as in tests/commands/roles.test.ts.
 */

import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../setup.js";
import { apiUrl, runCli } from "../helpers.js";

const RUN_ID = "291a6160-2306-428d-82d5-28a94c766585";
const CONTENT_ID = "420872df-71ee-485b-829d-fcdb48e17321";

const QUEUED = { eval_run_id: RUN_ID, evaluator_key: "kb_accuracy", status: "queued" };
const COMPLETED = {
  eval_run_id: RUN_ID,
  evaluator_key: "kb_accuracy",
  status: "completed",
  accuracy_pct: 100,
  band: "green",
  claims_total: 4,
  claims_scored: 4,
};
const FAILED = {
  eval_run_id: RUN_ID,
  evaluator_key: "brand_alignment",
  status: "failed",
  error_code: "judge_failed",
  error_message: "brand_alignment needs a brand kit with writing rules",
};

describe("evals text, when a flag is not usable", () => {
  it("exits 2 when neither --text nor --text-file is given", async () => {
    const res = await runCli(["evals", "text"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("exactly one");
  });

  it("exits 2 when both --text and --text-file are given", async () => {
    const res = await runCli(["evals", "text", "--text", "hi", "--text-file", "/etc/hosts"]);

    expect(res.exitCode).toBe(2);
  });

  it("exits 2 when the text is only whitespace", async () => {
    const res = await runCli(["evals", "text", "--text", "   "]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("empty");
  });

  it("exits 2 when --text-file cannot be read", async () => {
    const res = await runCli(["evals", "text", "--text-file", "/nope/missing.txt"]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("Cannot read");
  });

  it("exits 2 and names the evaluators when --evaluator is not one of them", async () => {
    const res = await runCli(["evals", "text", "--text", "hi", "--evaluator", "kb_acuracy"]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("kb_accuracy");
  });

  it("exits 2 when --label is over 128 characters", async () => {
    const res = await runCli(["evals", "text", "--text", "hi", "--label", "x".repeat(129)]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("maximum is 128");
  });
});

describe("evals runs and claims, when a filter is not usable", () => {
  it("exits 2 when --from is a plain date rather than an RFC 3339 instant", async () => {
    const res = await runCli(["evals", "runs", "--from", "2026-09-01"]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("RFC 3339");
  });

  it("exits 2 when --to is a plain date", async () => {
    const res = await runCli(["evals", "claims", "--to", "2026-09-15"]);

    expect(res.exitCode).toBe(2);
  });

  it("exits 2 when --limit is above the maximum", async () => {
    const res = await runCli(["evals", "runs", "--limit", "101"]);

    expect(res.exitCode).toBe(2);
  });

  it("accepts an evaluator the CLI has never heard of, because the spec sets no enum", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/evals/runs"), ({ request }) => {
        seen = request;
        return HttpResponse.json({ items: [], total: 0, limit: 25, offset: 0 });
      }),
    );

    const res = await runCli(["evals", "runs", "--evaluator", "some_future_evaluator"]);

    expect(res.exitCode).toBe(0);
    expect(new URL(seen!.url).searchParams.get("evaluator")).toBe("some_future_evaluator");
  });

  it("accepts a subject type beyond inline and content", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/evals/claims"), ({ request }) => {
        seen = request;
        return HttpResponse.json({ items: [], total: 0, limit: 25, offset: 0 });
      }),
    );

    const res = await runCli(["evals", "claims", "--subject-type", "question_run"]);

    expect(res.exitCode).toBe(0);
    expect(new URL(seen!.url).searchParams.get("subject_type")).toBe("question_run");
  });
});

describe("evals, when the API refuses", () => {
  it("exits 4 when the run id is unknown", async () => {
    server.use(
      http.get(apiUrl("/org/evals/runs/:runId"), () =>
        HttpResponse.json({ message: "Not found" }, { status: 404 }),
      ),
    );

    const res = await runCli(["evals", "get", RUN_ID]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
  });

  it("exits 1 when the content item's latest version is not raw text", async () => {
    server.use(
      http.post(apiUrl("/org/evals/content"), () =>
        HttpResponse.json({ message: "Item stores a pointer, not text" }, { status: 422 }),
      ),
    );

    const res = await runCli(["evals", "content", CONTENT_ID]);

    expect(res.exitCode).toBe(1);
  });

  it("exits 3 on a 401", async () => {
    server.use(
      http.get(apiUrl("/org/evals/evaluators"), () =>
        HttpResponse.json({ message: "Unauthorized" }, { status: 401 }),
      ),
    );

    const res = await runCli(["evals", "evaluators"]);

    expect(res.exitCode).toBe(3);
  });
});

describe("evals text, on the wire", () => {
  it("does NOT send wait, even when --wait is passed", async () => {
    let body: unknown;
    server.use(
      http.post(apiUrl("/org/evals/text"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(QUEUED, { status: 202 });
      }),
      http.get(apiUrl("/org/evals/runs/:runId"), () => HttpResponse.json(COMPLETED)),
    );

    const res = await runCli(["evals", "text", "--text", "hello", "--wait"]);

    expect(res.exitCode).toBe(0);
    expect(body).toEqual({ text: "hello" });
  });

  it("maps every trigger option onto its snake_case field", async () => {
    let body: unknown;
    server.use(
      http.post(apiUrl("/org/evals/text"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(QUEUED, { status: 202 });
      }),
    );

    await runCli([
      "evals",
      "text",
      "--text",
      "hello",
      "--title",
      "A title",
      "--evaluator",
      "brand_alignment",
      "--evaluator-version",
      "1.1",
      "--judge-model",
      "some-model",
      "--label",
      "tag",
      "--idempotency-key",
      "key-1",
    ]);

    expect(body).toEqual({
      text: "hello",
      title: "A title",
      evaluator: "brand_alignment",
      evaluator_version: "1.1",
      judge_model: "some-model",
      label: "tag",
      idempotency_key: "key-1",
    });
  });

  it("reads the text from --text-file", async () => {
    let body: { text?: string } | undefined;
    server.use(
      http.post(apiUrl("/org/evals/text"), async ({ request }) => {
        body = (await request.json()) as { text?: string };
        return HttpResponse.json(QUEUED, { status: 202 });
      }),
    );

    const res = await runCli(["evals", "text", "--text-file", "package.json"]);

    expect(res.exitCode).toBe(0);
    expect(body?.text).toContain("@senso-ai/cli");
  });
});

describe("evals, waiting for a run", () => {
  it("polls until the run finishes and prints the finished run", async () => {
    let polls = 0;
    server.use(
      http.post(apiUrl("/org/evals/text"), () => HttpResponse.json(QUEUED, { status: 202 })),
      http.get(apiUrl("/org/evals/runs/:runId"), () => {
        polls += 1;
        return HttpResponse.json(polls < 2 ? { ...QUEUED, status: "running" } : COMPLETED);
      }),
    );

    const res = await runCli(["evals", "text", "--text", "hello", "--wait", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json<{ status: string }>().status).toBe("completed");
    expect(polls).toBeGreaterThan(1);
  }, 20_000);

  it("exits 1 with an empty stdout when the run ends failed", async () => {
    server.use(
      http.post(apiUrl("/org/evals/content"), () => HttpResponse.json(QUEUED, { status: 202 })),
      http.get(apiUrl("/org/evals/runs/:runId"), () => HttpResponse.json(FAILED)),
    );

    const res = await runCli(["evals", "content", CONTENT_ID, "--wait"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("judge_failed");
  });

  it("exits 0 on a queued run when --wait was NOT passed", async () => {
    server.use(
      http.post(apiUrl("/org/evals/content"), () => HttpResponse.json(QUEUED, { status: 202 })),
    );

    const res = await runCli(["evals", "content", CONTENT_ID]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(RUN_ID);
  });
});

describe("evals, reading results", () => {
  it("lists evaluators with their current version", async () => {
    server.use(
      http.get(apiUrl("/org/evals/evaluators"), () =>
        HttpResponse.json({
          items: [{ key: "kb_accuracy", display_name: "KB Accuracy", latest_version: "1.1" }],
          total: 1,
          limit: 25,
          offset: 0,
        }),
      ),
    );

    const res = await runCli(["evals", "evaluators", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("kb_accuracy");
    expect(res.stdout).toContain("latest_version");
  });

  it("narrows claims to one run with --run-id", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/evals/claims"), ({ request }) => {
        seen = request;
        return HttpResponse.json({ items: [], total: 0, limit: 25, offset: 0 });
      }),
    );

    const res = await runCli(["evals", "claims", "--run-id", RUN_ID]);

    expect(res.exitCode).toBe(0);
    expect(new URL(seen!.url).searchParams.get("run_id")).toBe(RUN_ID);
  });

  it("sends the window as the instants the API expects", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/evals/runs"), ({ request }) => {
        seen = request;
        return HttpResponse.json({ items: [], total: 0, limit: 25, offset: 0 });
      }),
    );

    await runCli([
      "evals",
      "runs",
      "--from",
      "2026-09-01T00:00:00Z",
      "--to",
      "2026-09-15T00:00:00Z",
      "--limit",
      "2",
      "--offset",
      "1",
    ]);

    const url = new URL(seen!.url);
    expect(url.searchParams.get("from")).toBe("2026-09-01T00:00:00Z");
    expect(url.searchParams.get("to")).toBe("2026-09-15T00:00:00Z");
    expect(url.searchParams.get("limit")).toBe("2");
    expect(url.searchParams.get("offset")).toBe("1");
  });

  it("keeps stdout pure JSON under --output json", async () => {
    server.use(http.get(apiUrl("/org/evals/runs/:runId"), () => HttpResponse.json(COMPLETED)));

    const res = await runCli(["evals", "get", RUN_ID, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json<{ accuracy_pct: number }>().accuracy_pct).toBe(100);
    expect(res.stderr).toBe("");
  });

  it("names the valid formats when --output is not one of them", async () => {
    const res = await runCli(["evals", "runs", "--output", "yaml"]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("json, table, plain");
  });
});

describe("evals, terminal statuses", () => {
  /**
   * The spec's own rule: a run is finished when its status is `completed`,
   * `gated` or `failed`. An earlier version of this command waited only for
   * `completed` or `failed`, so a gated run — which ends instantly, with no
   * model spend — would have polled the whole 180-second budget and then
   * reported a timeout for a run that was already over.
   */
  it("stops polling on a gated run instead of waiting out the budget", async () => {
    server.use(
      http.post(apiUrl("/org/evals/text"), () => HttpResponse.json(QUEUED, { status: 202 })),
      http.get(apiUrl("/org/evals/runs/:runId"), () =>
        HttpResponse.json({ ...QUEUED, status: "gated" }),
      ),
    );

    const res = await runCli(["evals", "text", "--text", "hello", "--wait", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json<{ status: string }>().status).toBe("gated");
  }, 20_000);

  it("says a gated run produced no score, rather than letting it read as a pass", async () => {
    server.use(
      http.post(apiUrl("/org/evals/text"), () => HttpResponse.json(QUEUED, { status: 202 })),
      http.get(apiUrl("/org/evals/runs/:runId"), () =>
        HttpResponse.json({ ...QUEUED, status: "gated" }),
      ),
    );

    const res = await runCli(["evals", "text", "--text", "hello", "--wait"]);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain("nothing to judge");
  }, 20_000);

  it("stops polling on a canceled run, which is reserved but must not hang", async () => {
    server.use(
      http.post(apiUrl("/org/evals/text"), () => HttpResponse.json(QUEUED, { status: 202 })),
      http.get(apiUrl("/org/evals/runs/:runId"), () =>
        HttpResponse.json({ ...QUEUED, status: "canceled" }),
      ),
    );

    const res = await runCli(["evals", "text", "--text", "hello", "--wait", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json<{ status: string }>().status).toBe("canceled");
  }, 20_000);
});

describe("evals, limits the API imposes", () => {
  it("exits 2 when --run-id is not a UUID, rather than round-tripping to a 400", async () => {
    const res = await runCli(["evals", "claims", "--run-id", "not-a-uuid"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("not a UUID");
  });

  it("exits 2 when --idempotency-key is over 255 characters", async () => {
    const res = await runCli([
      "evals",
      "text",
      "--text",
      "hello",
      "--idempotency-key",
      "x".repeat(256),
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("maximum is 255");
  });

  /**
   * `outputTable` keeps the first eight columns and drops the rest without
   * saying so, so a column list longer than that promises fields that never
   * appear. This asserts the list still fits.
   */
  it("renders every column it names under --output table", async () => {
    server.use(
      http.get(apiUrl("/org/evals/runs"), () =>
        HttpResponse.json({
          items: [
            {
              eval_run_id: RUN_ID,
              evaluator_key: "kb_accuracy",
              status: "completed",
              accuracy_pct: 100,
              band: "green",
              claims_scored: 4,
              claims_total: 4,
              label: "tag-visible",
            },
          ],
          total: 1,
          limit: 25,
          offset: 0,
        }),
      ),
    );

    const res = await runCli(["evals", "runs", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("label");
    expect(res.stdout).toContain("tag-visible");
  });
});
