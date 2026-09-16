/**
 * Command layer: `senso run-config`.
 *
 * Eight commands over two model vocabularies for the same models — bare names
 * (`chatgpt`) on /org/run-models, registry ids (`anthropic/claude`) on
 * /org/scheduler-models — plus the days those models run on. What is worth
 * protecting:
 *
 *   - The route and the verb. The paths differ by a suffix and the reads and
 *     writes by a verb, and a transposition is invisible until a week of runs
 *     has happened against the wrong configuration. `set-models` also rewrites
 *     the scheduler opt-in, which is why both routes are asserted separately.
 *   - Every write REPLACES. The warnings that say so are part of the answer,
 *     and under --output json they exist only in the envelope.
 *   - A name this CLI does not know costs exit 2, not a round trip; a name the
 *     API does not know comes back with `valid_models` and `suggestions` in
 *     error.details. Reading only the first line of that message — which is all
 *     the CLI used to show — tells a caller nothing it can act on.
 *   - `model-options` is the discovery command for `set-models`. If it does not
 *     print the model ids in plain output it has failed at its only job, and it
 *     returns a list travelling with a `scope` scalar, the shape that used to
 *     be collapsed onto one line.
 *
 * Fixtures are the real shapes: dto.OrgRunModelsResponse, dto.ModelOptionsResponse,
 * dto.ModelResponse, dto.OrgRunScheduleResponse, and handlers.unknownModelsResponse
 * for the rejected-model body (senso-api internal/api/dto, internal/api/handlers).
 *
 * Failure branches come first, as in tests/commands/roles.test.ts.
 */

import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../setup.js";
import { apiUrl, envelope, errorEnvelope, runCli } from "../helpers.js";

/** dto.OrgRunModelsResponse: the org's configured run models. */
const MODELS = {
  models: [
    {
      geo_model_id: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      name: "chatgpt",
      created_at: "2026-03-01T00:00:00Z",
      updated_at: "2026-03-01T00:00:00Z",
    },
    {
      geo_model_id: "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e",
      name: "claude",
      created_at: "2026-03-02T00:00:00Z",
      updated_at: "2026-03-02T00:00:00Z",
    },
  ],
};

/** dto.ModelOptionsResponse: valid_models plus the run surface they apply to. */
const MODEL_OPTIONS = {
  scope: "org",
  valid_models: [
    { name: "chatgpt", display_name: "ChatGPT" },
    { name: "claude", display_name: "Claude" },
    { name: "google_ai_overviews", display_name: "Google AI Overviews" },
  ],
};

/** dto.ModelListResponse of dto.ModelResponse: the scheduler opt-in. */
const SCHEDULER_MODELS = {
  models: [
    {
      id: "2c3d4e5f-6a7b-4c8d-89ef-0a1b2c3d4e5f",
      provider: "anthropic",
      model: "claude",
      execution_mode: "single_sync",
      adapter_key: "anthropic",
    },
    {
      id: "3d4e5f6a-7b8c-4d9e-8f0a-1b2c3d4e5f6a",
      provider: "brightdata",
      model: "chatgpt",
      execution_mode: "batch_async",
      adapter_key: "bd_dataset",
    },
  ],
};

const SCHEDULE = { schedule: [1, 3, 5] };

/**
 * handlers.unknownModelsResponse, the shared 400 for a rejected model list.
 *
 * `error` is what the CLI shows as the message; everything machine-readable
 * lands in error.details, which is the only place a caller can read the
 * accepted set from.
 */
const REJECTED_RUN_MODEL = {
  status: 400,
  message:
    'model(s) "gpt5" not supported for org runs; use "gpt" instead of "gpt5"; supported models: chatgpt, claude, gemini',
  error: "unknown model(s): gpt5",
  unsupported_models: ["gpt5"],
  valid_models: ["chatgpt", "claude", "gemini"],
  suggestions: { gpt5: "gpt" },
};

const REJECTED_SCHEDULER_MODEL = {
  status: 400,
  message:
    'model(s) "acme/llm" not supported for org runs; supported models: anthropic/claude, brightdata/chatgpt; list them with GET /org/scheduler-models/supported',
  error: "unknown model(s): acme/llm",
  unsupported_models: ["acme/llm"],
  valid_models: ["anthropic/claude", "brightdata/chatgpt"],
};

describe("run-config, when the request fails", () => {
  it("exits 3 and explains how to authenticate when there is no API key", async () => {
    const res = await runCli(["run-config", "models"], { withKey: false });

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("no API key found");
    expect(res.stderr).toContain("SENSO_API_KEY");
  });

  it("exits 3 when the API rejects the key", async () => {
    server.use(
      http.get(apiUrl("/org/run-models"), () =>
        HttpResponse.json({ error: "invalid key" }, { status: 401 }),
      ),
    );

    const res = await runCli(["run-config", "models"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Authentication failed");
  });

  it("exits 3 when a read-only key tries to replace the schedule", async () => {
    server.use(
      http.put(apiUrl("/org/run-schedule"), () =>
        HttpResponse.json({ error: "read-only key" }, { status: 403 }),
      ),
    );

    const res = await runCli(["run-config", "set-schedule", "--data", '{"schedule":[1]}']);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Permission denied");
  });

  it("exits 4 on a 404", async () => {
    server.use(
      http.get(apiUrl("/org/run-schedule"), () => new HttpResponse(null, { status: 404 })),
    );

    const res = await runCli(["run-config", "schedule"]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Not found");
  });

  it("exits 1 on a 500 and says retrying is worth it", async () => {
    server.use(http.get(apiUrl("/org/run-models"), () => new HttpResponse(null, { status: 500 })));

    const res = await runCli(["run-config", "models"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("server-side failure");
    expect(res.stderr).toContain("Retry shortly");
  });

  it("exits 1 on a 503 and says retrying is precisely what will not work", async () => {
    server.use(
      http.get(apiUrl("/org/scheduler-models"), () => new HttpResponse(null, { status: 503 })),
    );

    const res = await runCli(["run-config", "scheduler-models"]);

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("not a transient failure");
    expect(res.stderr).not.toContain("Retry shortly");
  });

  it("exits 5 when the API rate-limits, because retrying is the right response", async () => {
    server.use(http.get(apiUrl("/org/run-models"), () => new HttpResponse(null, { status: 429 })));

    const res = await runCli(["run-config", "models"]);

    expect(res.exitCode).toBe(5);
    expect(res.stderr).toContain("Rate limited");
  });

  it("reports a malformed body rather than throwing a parse error at the user", async () => {
    server.use(http.get(apiUrl("/org/run-models"), () => new HttpResponse("<html>nope</html>")));

    const res = await runCli(["run-config", "models"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Invalid JSON response");
  });

  it("writes the failure envelope to stderr, leaving stdout empty, under --output json", async () => {
    server.use(
      http.get(apiUrl("/org/run-models"), () =>
        HttpResponse.json({ error: "nope" }, { status: 403 }),
      ),
    );

    const res = await runCli(["run-config", "models", "--output", "json"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(errorEnvelope(res)).toMatchObject({
      ok: false,
      command: "run-config models",
      error: { code: "forbidden", status: 403 },
    });
  });
});

describe("run-config set-models, refusing a request before making it", () => {
  // Nothing here registers a handler: a request reaching MSW would fail the
  // test that made it.
  it("exits 2 when --data is not valid JSON", async () => {
    const res = await runCli(["run-config", "set-models", "--data", "{models: [chatgpt]}"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Invalid JSON in --data");
  });

  it("exits 2 when --data is a bare array rather than an object", async () => {
    const res = await runCli(["run-config", "set-models", "--data", '["chatgpt"]']);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("must be a JSON object");
  });

  it("exits 2 when the models array is missing", async () => {
    const res = await runCli(["run-config", "set-models", "--data", '{"model":"chatgpt"}']);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("models");
  });

  it("exits 2 rather than clearing every model when the array is empty", async () => {
    const res = await runCli(["run-config", "set-models", "--data", '{"models":[]}']);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain('non-empty "models" array');
  });

  it("exits 2 and names the offending entry when a model is not a string", async () => {
    const res = await runCli(["run-config", "set-models", "--data", '{"models":[7]}']);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("Invalid model: 7");
  });

  it("exits 2 with the accepted names, and points at the discovery command", async () => {
    const res = await runCli([
      "run-config",
      "set-models",
      "--data",
      '{"models":["chatgpt","gpt5"]}',
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(errorEnvelope(res).error).toMatchObject({
      code: "usage",
      field: "models",
      received: "gpt5",
      allowed: ["chatgpt", "perplexity", "gemini", "grok", "google_ai_overviews", "claude", "gpt"],
    });
    expect(errorEnvelope(res).error.hint).toContain("senso run-config model-options");
  });

  it("exits 2 when given the provider/model form that belongs to the other command", async () => {
    const res = await runCli([
      "run-config",
      "set-models",
      "--data",
      '{"models":["anthropic/claude"]}',
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain('Invalid model: "anthropic/claude"');
    expect(res.stderr).toContain("senso run-config set-scheduler-models");
  });
});

describe("run-config set-scheduler-models, refusing a request before making it", () => {
  it("exits 2 when --data is not valid JSON", async () => {
    const res = await runCli(["run-config", "set-scheduler-models", "--data", "{oops"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("--data");
  });

  it("exits 2 when the models array is missing", async () => {
    const res = await runCli([
      "run-config",
      "set-scheduler-models",
      "--data",
      '{"model":"claude"}',
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("models");
  });

  it("exits 2 rather than clearing the opt-in when the models array is empty", async () => {
    const res = await runCli(["run-config", "set-scheduler-models", "--data", '{"models":[]}']);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
  });

  it("exits 2 and names the offending entry when a model is not a string", async () => {
    const res = await runCli(["run-config", "set-scheduler-models", "--data", '{"models":[7]}']);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("7");
  });

  it("exits 2 on the bare name set-models takes, which is the mistake agents make", async () => {
    const res = await runCli([
      "run-config",
      "set-scheduler-models",
      "--data",
      '{"models":["claude"]}',
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    expect(errorEnvelope(res).error).toMatchObject({
      code: "usage",
      field: "models",
      received: "claude",
      allowed: [
        "brightdata/chatgpt",
        "brightdata/grok",
        "brightdata/perplexity",
        "brightdata/gemini",
        "brightdata_serp/google_ai_overviews",
        "anthropic/claude",
        "openai/gpt",
      ],
    });
    expect(errorEnvelope(res).error.hint).toContain("senso run-config set-models");
  });
});

describe("run-config set-schedule, refusing a request before making it", () => {
  it("exits 2 when --data is not valid JSON", async () => {
    const res = await runCli(["run-config", "set-schedule", "--data", "1,3,5"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Invalid JSON in --data");
  });

  it("exits 2 when --data has no schedule array at all", async () => {
    const res = await runCli(["run-config", "set-schedule", "--data", '{"days":[1]}']);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("schedule");
  });

  it("exits 2 on an empty schedule, which the API cannot store", async () => {
    // `{"schedule":[]}` used to pass the client check and come back as a 400
    // that read like a CLI bug. Runs cannot be turned off from this command.
    const res = await runCli(["run-config", "set-schedule", "--data", '{"schedule":[]}']);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("must name at least one day");
  });

  it("exits 2 naming the offending day when one is out of range", async () => {
    const res = await runCli(["run-config", "set-schedule", "--data", '{"schedule":[9]}']);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("9");
    expect(res.stderr).toContain("0-6");
  });

  it("exits 2 naming the offending day when one is not a number", async () => {
    const res = await runCli(["run-config", "set-schedule", "--data", '{"schedule":["1"]}']);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain('"1"');
  });

  it("exits 2 on a day listed twice, since a schedule is a set of days", async () => {
    const res = await runCli(["run-config", "set-schedule", "--data", '{"schedule":[1,1]}']);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("Duplicate schedule day: 1 (Monday)");
  });

  it("names the valid formats when --output is not one of them", async () => {
    const res = await runCli(["run-config", "models", "--output", "yaml"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("json, table, plain");
  });
});

describe("run-config models and set-models, on the wire", () => {
  it("GETs /org/run-models with no query and no body", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/run-models"), ({ request }) => {
        seen = request;
        return HttpResponse.json(MODELS);
      }),
    );

    await runCli(["run-config", "models"]);

    expect(seen?.method).toBe("GET");
    expect(new URL(seen!.url).pathname).toBe("/api/v1/org/run-models");
    expect(new URL(seen!.url).search).toBe("");
    expect(seen?.headers.get("content-type")).toBeNull();
  });

  it("PUTs the model list to /org/run-models, replacing rather than appending", async () => {
    let body: unknown;
    let seen: Request | undefined;
    server.use(
      http.put(apiUrl("/org/run-models"), async ({ request }) => {
        seen = request;
        body = await request.json();
        return HttpResponse.json(MODELS);
      }),
    );

    await runCli(["run-config", "set-models", "--data", '{"models":["chatgpt","claude"]}']);

    expect(seen?.method).toBe("PUT");
    expect(new URL(seen!.url).pathname).toBe("/api/v1/org/run-models");
    expect(seen?.headers.get("content-type")).toBe("application/json");
    expect(body).toEqual({ models: ["chatgpt", "claude"] });
  });

  it("sends the canonical name for an alias and for a capitalized spelling", async () => {
    // The API stores the canonical name either way; resolving here means the
    // error message can offer a name rather than an alias.
    let body: unknown;
    server.use(
      http.put(apiUrl("/org/run-models"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(MODELS);
      }),
    );

    await runCli([
      "run-config",
      "set-models",
      "--data",
      '{"models":["AIOverview","claude-sonnet-4-6","ChatGPT"]}',
    ]);

    expect(body).toEqual({ models: ["google_ai_overviews", "claude", "chatgpt"] });
  });
});

describe("run-config model-options and scheduler-models, on the wire", () => {
  it("reads the options from /org/run-models/options, not from /org/run-models", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/run-models/options"), ({ request }) => {
        seen = request;
        return HttpResponse.json(MODEL_OPTIONS);
      }),
    );

    const res = await runCli(["run-config", "model-options"]);

    expect(res.exitCode).toBe(0);
    expect(seen?.method).toBe("GET");
    expect(new URL(seen!.url).pathname).toBe("/api/v1/org/run-models/options");
  });

  it("reads the scheduler opt-in from /org/scheduler-models", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/scheduler-models"), ({ request }) => {
        seen = request;
        return HttpResponse.json(SCHEDULER_MODELS);
      }),
    );

    await runCli(["run-config", "scheduler-models"]);

    expect(seen?.method).toBe("GET");
    expect(new URL(seen!.url).pathname).toBe("/api/v1/org/scheduler-models");
  });

  it("PUTs the provider/model ids to /org/scheduler-models verbatim", async () => {
    let body: unknown;
    let seen: Request | undefined;
    server.use(
      http.put(apiUrl("/org/scheduler-models"), async ({ request }) => {
        seen = request;
        body = await request.json();
        return HttpResponse.json(SCHEDULER_MODELS);
      }),
    );

    await runCli([
      "run-config",
      "set-scheduler-models",
      "--data",
      '{"models":["anthropic/claude","brightdata/chatgpt"]}',
    ]);

    expect(seen?.method).toBe("PUT");
    expect(new URL(seen!.url).pathname).toBe("/api/v1/org/scheduler-models");
    expect(body).toEqual({ models: ["anthropic/claude", "brightdata/chatgpt"] });
  });
});

describe("run-config schedule and set-schedule, on the wire", () => {
  it("GETs /org/run-schedule", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/run-schedule"), ({ request }) => {
        seen = request;
        return HttpResponse.json(SCHEDULE);
      }),
    );

    await runCli(["run-config", "schedule"]);

    expect(seen?.method).toBe("GET");
    expect(new URL(seen!.url).pathname).toBe("/api/v1/org/run-schedule");
  });

  it("PUTs the day numbers as numbers, not strings", async () => {
    let body: unknown;
    let seen: Request | undefined;
    server.use(
      http.put(apiUrl("/org/run-schedule"), async ({ request }) => {
        seen = request;
        body = await request.json();
        return HttpResponse.json(SCHEDULE);
      }),
    );

    await runCli(["run-config", "set-schedule", "--data", '{"schedule":[1,3,5]}']);

    expect(seen?.method).toBe("PUT");
    expect(new URL(seen!.url).pathname).toBe("/api/v1/org/run-schedule");
    expect(body).toEqual({ schedule: [1, 3, 5] });
  });
});

describe("run-config models, on success", () => {
  it("carries the payload unmodified in the envelope's data under --output json", async () => {
    server.use(http.get(apiUrl("/org/run-models"), () => HttpResponse.json(MODELS)));

    const res = await runCli(["run-config", "models", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual(MODELS);
    expect(res.stderr).toBe("");
  });

  it("renders one row per model under --output table, with the columns it declared", async () => {
    server.use(http.get(apiUrl("/org/run-models"), () => HttpResponse.json(MODELS)));

    const res = await runCli(["run-config", "models", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    for (const column of ["name", "geo_model_id", "created_at"]) {
      expect(res.stdout).toContain(column);
    }
    expect(res.stdout).toContain("chatgpt");
    expect(res.stdout).toContain("claude");
    expect(res.stderr).not.toContain("the API did not return");
  });

  it("renders a readable block per model by default", async () => {
    server.use(http.get(apiUrl("/org/run-models"), () => HttpResponse.json(MODELS)));

    const res = await runCli(["run-config", "models"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("chatgpt");
    expect(res.stdout).toContain("0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d");
  });

  it("says an empty list means no runs at all, and how to fix it", async () => {
    server.use(http.get(apiUrl("/org/run-models"), () => HttpResponse.json({ models: [] })));

    const res = await runCli(["run-config", "models"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("No run models found.");
    expect(res.stderr).toContain("no runs will be produced");
  });
});

describe("run-config model-options, the discovery command for set-models", () => {
  it("prints the model ids in plain output, which is its whole job", async () => {
    // A list travelling with a `scope` scalar. Rendered as one line of JSON —
    // which is what used to happen — this command tells a reader nothing.
    server.use(http.get(apiUrl("/org/run-models/options"), () => HttpResponse.json(MODEL_OPTIONS)));

    const res = await runCli(["run-config", "model-options"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("chatgpt");
    expect(res.stdout).toContain("claude");
    expect(res.stdout).toContain("google_ai_overviews");
    expect(res.stdout).toContain("Google AI Overviews");
    expect(res.stdout).not.toContain('{"name"');
  });

  it("renders one row per option under --output table, with both declared columns", async () => {
    server.use(http.get(apiUrl("/org/run-models/options"), () => HttpResponse.json(MODEL_OPTIONS)));

    const res = await runCli(["run-config", "model-options", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("name");
    expect(res.stdout).toContain("display_name");
    expect(res.stdout).toContain("ChatGPT");
    expect(res.stderr).not.toContain("the API did not return");
  });

  it("keeps scope in the payload, and hands back the command to run next", async () => {
    server.use(http.get(apiUrl("/org/run-models/options"), () => HttpResponse.json(MODEL_OPTIONS)));

    const res = await runCli(["run-config", "model-options", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual(MODEL_OPTIONS);
    expect(envelope(res).next).toContainEqual({
      why: "Configure the models that answer your prompts",
      command: `senso run-config set-models --data '{"models":["chatgpt","claude"]}'`,
    });
  });

  it("says so plainly when this deployment offers no options", async () => {
    server.use(
      http.get(apiUrl("/org/run-models/options"), () =>
        HttpResponse.json({ scope: "org", valid_models: [] }),
      ),
    );

    const res = await runCli(["run-config", "model-options"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("No model options found.");
    expect(res.stderr).toContain("Check with your Senso partner");
  });
});

describe("run-config scheduler-models, on success", () => {
  it("shows the two halves of the id a set-scheduler-models call needs", async () => {
    server.use(
      http.get(apiUrl("/org/scheduler-models"), () => HttpResponse.json(SCHEDULER_MODELS)),
    );

    const res = await runCli(["run-config", "scheduler-models"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("anthropic");
    expect(res.stdout).toContain("claude");
    expect(res.stdout).toContain("batch_async");
    expect(res.stdout).toContain("bd_dataset");
  });

  it("declares columns the API really returns, under --output table", async () => {
    server.use(
      http.get(apiUrl("/org/scheduler-models"), () => HttpResponse.json(SCHEDULER_MODELS)),
    );

    const res = await runCli(["run-config", "scheduler-models", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    for (const column of ["provider", "model", "execution_mode", "adapter_key", "id"]) {
      expect(res.stdout).toContain(column);
    }
    expect(res.stderr).not.toContain("the API did not return");
  });

  it("says an empty opt-in means the scheduler will run nothing", async () => {
    server.use(http.get(apiUrl("/org/scheduler-models"), () => HttpResponse.json({ models: [] })));

    const res = await runCli(["run-config", "scheduler-models"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("No scheduler models found.");
    expect(res.stderr).toContain("Nothing is opted in");
  });
});

describe("run-config schedule, on success", () => {
  it("carries the payload unmodified in the envelope's data under --output json", async () => {
    server.use(http.get(apiUrl("/org/run-schedule"), () => HttpResponse.json(SCHEDULE)));

    const res = await runCli(["run-config", "schedule", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual(SCHEDULE);
    expect(res.stderr).toBe("");
  });

  it("names the days, because the numbers alone are a lookup table", async () => {
    server.use(http.get(apiUrl("/org/run-schedule"), () => HttpResponse.json(SCHEDULE)));

    const res = await runCli(["run-config", "schedule"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("1 (Monday), 3 (Wednesday), 5 (Friday)");
  });

  it("says an empty schedule means nothing runs, and how to set one", async () => {
    server.use(http.get(apiUrl("/org/run-schedule"), () => HttpResponse.json({ schedule: [] })));

    const res = await runCli(["run-config", "schedule", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual({ schedule: [] });
    expect(envelope(res).next).toContainEqual({
      why: "Nothing runs until days are set",
      command: `senso run-config set-schedule --data '{"schedule":[1,3,5]}'`,
    });
  });
});

describe("run-config writes, on success", () => {
  it("warns that set-models replaced the whole set and rewrote the scheduler opt-in", async () => {
    server.use(http.put(apiUrl("/org/run-models"), () => HttpResponse.json(MODELS)));

    const res = await runCli([
      "run-config",
      "set-models",
      "--data",
      '{"models":["chatgpt"]}',
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual(MODELS);
    // stderr is silent under --output json, so a warning that lived only there
    // would reach nobody.
    expect(envelope(res).warnings?.join(" ")).toContain("models that were configured");
    expect(envelope(res).warnings?.join(" ")).toContain("rewrote the scheduler opt-in");
    expect(res.stderr).toBe("");
  });

  it("puts the updated models on stdout and the warnings on stderr", async () => {
    server.use(http.put(apiUrl("/org/run-models"), () => HttpResponse.json(MODELS)));

    const res = await runCli(["run-config", "set-models", "--data", '{"models":["chatgpt"]}']);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("chatgpt");
    expect(res.stderr).toContain("replaced the whole set");
    expect(res.stdout).not.toContain("replaced the whole set");
  });

  it("warns that set-scheduler-models left the run-model list behind", async () => {
    server.use(
      http.put(apiUrl("/org/scheduler-models"), () => HttpResponse.json(SCHEDULER_MODELS)),
    );

    const res = await runCli([
      "run-config",
      "set-scheduler-models",
      "--data",
      '{"models":["anthropic/claude"]}',
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("anthropic");
    expect(res.stderr).toContain("the two lists can now disagree");
    expect(res.stdout).not.toContain("the two lists can now disagree");
  });

  it("names the days it wrote, and warns the schedule was replaced", async () => {
    server.use(http.put(apiUrl("/org/run-schedule"), () => HttpResponse.json(SCHEDULE)));

    const res = await runCli(["run-config", "set-schedule", "--data", '{"schedule":[1,3,5]}']);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("1 (Monday), 3 (Wednesday), 5 (Friday)");
    expect(res.stderr).toContain("days that were not listed no longer run");
    expect(res.stdout).not.toContain("days that were not listed no longer run");
  });
});

describe("run-config, when the API refuses a model this CLI accepted", () => {
  it("hands back valid_models and suggestions, not just the first line of the message", async () => {
    // `gpt` is accepted by set-models and deliberately absent from the picker,
    // so the registry is the authority and its answer has to survive the trip.
    server.use(
      http.put(apiUrl("/org/run-models"), () =>
        HttpResponse.json(REJECTED_RUN_MODEL, { status: 400 }),
      ),
    );

    const res = await runCli([
      "run-config",
      "set-models",
      "--data",
      '{"models":["gpt"]}',
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(errorEnvelope(res).error).toMatchObject({
      code: "validation",
      status: 400,
      details: {
        unsupported_models: ["gpt5"],
        valid_models: ["chatgpt", "claude", "gemini"],
        suggestions: { gpt5: "gpt" },
      },
      request: { method: "PUT", path: "/org/run-models" },
    });
  });

  it("does the same for a scheduler id, whose catalog no endpoint in this CLI serves", async () => {
    server.use(
      http.put(apiUrl("/org/scheduler-models"), () =>
        HttpResponse.json(REJECTED_SCHEDULER_MODEL, { status: 400 }),
      ),
    );

    const res = await runCli([
      "run-config",
      "set-scheduler-models",
      "--data",
      '{"models":["acme/llm"]}',
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(errorEnvelope(res).error.message).toContain("unknown model(s): acme/llm");
    expect(errorEnvelope(res).error).toMatchObject({
      details: { valid_models: ["anthropic/claude", "brightdata/chatgpt"] },
    });
  });
});
