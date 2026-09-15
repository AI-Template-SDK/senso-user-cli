/**
 * Command layer: `senso run-config`.
 *
 * Four commands, two of them writes that replace configuration outright rather
 * than merging into it: `set-models` replaces the model list and `set-schedule`
 * replaces the run days. What is worth protecting here is that the body the
 * caller wrote in `--data` is what reaches the API, byte for byte, and that it
 * goes to the right route with the right method — the two paths differ only in
 * a suffix (`/org/run-models` vs `/org/run-schedule`) and the reads and writes
 * differ only in the verb, so a transposition is easy to make and impossible to
 * notice until a week of runs has happened on the wrong days.
 *
 * The schedule response is also the one shape in this group that is neither a
 * list of objects nor a flat scalar — `{ schedule: [1, 3, 5] }` — so it is the
 * useful check that all three output formats survive an array-of-numbers.
 *
 * Failure branches come first, as in tests/commands/roles.test.ts.
 */

import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../setup.js";
import { apiUrl, runCli } from "../helpers.js";

const MODELS = {
  models: [
    { geo_model_id: "m-1", name: "chatgpt" },
    { geo_model_id: "m-2", name: "gemini" },
  ],
};

const SCHEDULE = { schedule: [1, 3, 5] };

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

  it("exits 1 on a 500 and says it is not the caller's fault", async () => {
    server.use(http.get(apiUrl("/org/run-models"), () => new HttpResponse(null, { status: 500 })));

    const res = await runCli(["run-config", "models"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("server-side failure");
  });

  it("reports a malformed body rather than throwing a parse error at the user", async () => {
    server.use(http.get(apiUrl("/org/run-models"), () => new HttpResponse("<html>nope</html>")));

    const res = await runCli(["run-config", "models"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Invalid JSON response");
  });

  it("writes the failure to stderr as JSON, leaving stdout empty, under --output json", async () => {
    server.use(
      http.get(apiUrl("/org/run-models"), () =>
        HttpResponse.json({ error: "nope" }, { status: 403 }),
      ),
    );

    const res = await runCli(["run-config", "models", "--output", "json"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");

    const reported: unknown = JSON.parse(res.stderr);
    expect(reported).toMatchObject({ error: { code: "forbidden", status: 403 } });
  });
});

describe("run-config, when the command line is wrong", () => {
  it("exits 2 when set-models' --data is not valid JSON", async () => {
    const res = await runCli(["run-config", "set-models", "--data", "{models: [chatgpt]}"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Invalid JSON in --data");
  });

  it("exits 2 when set-models' --data is a bare array rather than an object", async () => {
    const res = await runCli(["run-config", "set-models", "--data", '["chatgpt"]']);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("must be a JSON object");
  });

  it("exits 2 when set-schedule's --data is not valid JSON", async () => {
    const res = await runCli(["run-config", "set-schedule", "--data", "1,3,5"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Invalid JSON in --data");
  });

  it("exits 2 when set-models is given no --data at all", async () => {
    const res = await runCli(["run-config", "set-models"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
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

  it("PUTs the parsed --data object to /org/run-models unchanged", async () => {
    let body: unknown;
    let seen: Request | undefined;
    server.use(
      http.put(apiUrl("/org/run-models"), async ({ request }) => {
        seen = request;
        body = await request.json();
        return HttpResponse.json(MODELS);
      }),
    );

    await runCli(["run-config", "set-models", "--data", '{"models":["chatgpt","gemini"]}']);

    // PUT, not POST: this replaces the list rather than appending to it.
    expect(seen?.method).toBe("PUT");
    expect(new URL(seen!.url).pathname).toBe("/api/v1/org/run-models");
    expect(seen?.headers.get("content-type")).toBe("application/json");
    expect(body).toEqual({ models: ["chatgpt", "gemini"] });
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

  it("PUTs the day numbers to /org/run-schedule as numbers, not strings", async () => {
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

  it("PUTs an empty schedule when asked to, rather than treating it as no change", async () => {
    let body: unknown;
    server.use(
      http.put(apiUrl("/org/run-schedule"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ schedule: [] });
      }),
    );

    const res = await runCli(["run-config", "set-schedule", "--data", '{"schedule":[]}']);

    expect(res.exitCode).toBe(0);
    expect(body).toEqual({ schedule: [] });
  });

  // The help text says values must be 0-6, and the day is checked before the
  // request: no handler is registered for these, so they also prove nothing was
  // sent.
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

  it("exits 2 when --data has no schedule array at all", async () => {
    const res = await runCli(["run-config", "set-schedule", "--data", '{"days":[1]}']);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("schedule");
  });
});

describe("run-config models, on success", () => {
  it("prints the payload unmodified under --output json", async () => {
    server.use(http.get(apiUrl("/org/run-models"), () => HttpResponse.json(MODELS)));

    const res = await runCli(["run-config", "models", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual(MODELS);
    expect(res.stderr).toBe("");
  });

  it("renders one row per model under --output table", async () => {
    server.use(http.get(apiUrl("/org/run-models"), () => HttpResponse.json(MODELS)));

    const res = await runCli(["run-config", "models", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("geo_model_id");
    expect(res.stdout).toContain("chatgpt");
    expect(res.stdout).toContain("gemini");
  });

  it("renders a readable block per model by default", async () => {
    server.use(http.get(apiUrl("/org/run-models"), () => HttpResponse.json(MODELS)));

    const res = await runCli(["run-config", "models"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("m-1");
    expect(res.stdout).toContain("gemini");
  });

  it("says so plainly when no models are configured", async () => {
    server.use(http.get(apiUrl("/org/run-models"), () => HttpResponse.json({ models: [] })));

    const res = await runCli(["run-config", "models"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("models");
  });
});

describe("run-config schedule, on success", () => {
  it("prints the payload unmodified under --output json", async () => {
    server.use(http.get(apiUrl("/org/run-schedule"), () => HttpResponse.json(SCHEDULE)));

    const res = await runCli(["run-config", "schedule", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual(SCHEDULE);
    expect(res.stderr).toBe("");
  });

  it("renders the day list as a field/value row under --output table", async () => {
    server.use(http.get(apiUrl("/org/run-schedule"), () => HttpResponse.json(SCHEDULE)));

    const res = await runCli(["run-config", "schedule", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("schedule");
    expect(res.stdout).toContain("1, 3, 5");
  });

  it("renders the day list on one key/value line by default", async () => {
    server.use(http.get(apiUrl("/org/run-schedule"), () => HttpResponse.json(SCHEDULE)));

    const res = await runCli(["run-config", "schedule"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("schedule");
    expect(res.stdout).toContain("1, 3, 5");
  });
});

describe("run-config writes, on success", () => {
  it("puts the updated models on stdout and the tick on stderr", async () => {
    server.use(http.put(apiUrl("/org/run-models"), () => HttpResponse.json(MODELS)));

    const res = await runCli(["run-config", "set-models", "--data", '{"models":["chatgpt"]}']);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("chatgpt");
    expect(res.stderr).toContain("Models updated.");
    expect(res.stdout).not.toContain("Models updated.");
  });

  it("emits only the payload under --output json, with no tick alongside it", async () => {
    server.use(http.put(apiUrl("/org/run-schedule"), () => HttpResponse.json(SCHEDULE)));

    const res = await runCli([
      "run-config",
      "set-schedule",
      "--data",
      '{"schedule":[1,3,5]}',
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual(SCHEDULE);
    expect(res.stderr).toBe("");
  });

  it("keeps the tick off stdout for set-schedule in plain mode", async () => {
    server.use(http.put(apiUrl("/org/run-schedule"), () => HttpResponse.json(SCHEDULE)));

    const res = await runCli(["run-config", "set-schedule", "--data", '{"schedule":[1,3,5]}']);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain("Schedule updated.");
    expect(res.stdout).not.toContain("Schedule updated.");
  });
});

/**
 * The scheduler-model half of the group, added after the run-model half.
 *
 * `/org/run-models` and `/org/scheduler-models` are two different opt-in sets
 * whose commands read almost identically, and writing the first silently
 * replaces the second. A transposed path here is a caller quietly reconfiguring
 * the wrong one, so both routes are asserted on the wire.
 */

const MODEL_OPTIONS = {
  scope: "org",
  valid_models: [
    { name: "chatgpt", display_name: "ChatGPT" },
    { name: "claude", display_name: "Claude" },
  ],
};

const SCHEDULER_MODELS = {
  models: [
    {
      id: "sm-1",
      provider: "anthropic",
      model: "claude",
      execution_mode: "batch_async",
      adapter_key: "anthropic_claude",
    },
  ],
};

describe("run-config model-options and scheduler-models, on the wire", () => {
  it("reads the options from /org/run-models/options, not from /org/run-models", async () => {
    let url: string | undefined;
    server.use(
      http.get(apiUrl("/org/run-models/options"), ({ request }) => {
        url = request.url;
        return HttpResponse.json(MODEL_OPTIONS);
      }),
    );

    const res = await runCli(["run-config", "model-options"]);

    expect(res.exitCode).toBe(0);
    expect(url).toContain("/org/run-models/options");
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
    expect(seen?.url).toContain("/org/scheduler-models");
  });

  it("puts the --data body to /org/scheduler-models verbatim", async () => {
    let body: unknown;
    let method: string | undefined;
    server.use(
      http.put(apiUrl("/org/scheduler-models"), async ({ request }) => {
        body = await request.json();
        method = request.method;
        return HttpResponse.json(SCHEDULER_MODELS);
      }),
    );

    await runCli([
      "run-config",
      "set-scheduler-models",
      "--data",
      '{"models":["anthropic/claude","openai/gpt"]}',
    ]);

    expect(method).toBe("PUT");
    expect(body).toEqual({ models: ["anthropic/claude", "openai/gpt"] });
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
});

describe("run-config model-options and scheduler-models, on success", () => {
  it("prints the options payload unmodified under --output json", async () => {
    server.use(http.get(apiUrl("/org/run-models/options"), () => HttpResponse.json(MODEL_OPTIONS)));

    const res = await runCli(["run-config", "model-options", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual(MODEL_OPTIONS);
    expect(res.stderr).toBe("");
  });

  it("renders one row per option under --output table", async () => {
    server.use(http.get(apiUrl("/org/run-models/options"), () => HttpResponse.json(MODEL_OPTIONS)));

    const res = await runCli(["run-config", "model-options", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("display_name");
    expect(res.stdout).toContain("ChatGPT");
  });

  it("renders the scheduler models as readable blocks by default", async () => {
    server.use(
      http.get(apiUrl("/org/scheduler-models"), () => HttpResponse.json(SCHEDULER_MODELS)),
    );

    const res = await runCli(["run-config", "scheduler-models"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("anthropic");
    expect(res.stdout).toContain("batch_async");
  });

  it("keeps the tick off stdout after a scheduler-model write", async () => {
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
    expect(res.stderr).toContain("Scheduler models updated.");
    expect(res.stdout).not.toContain("Scheduler models updated.");
  });

  it("exits 1 and reports the accepted values when a model is unsupported", async () => {
    server.use(
      http.put(apiUrl("/org/scheduler-models"), () =>
        HttpResponse.json(
          { error: "unsupported models: acme/llm; valid: anthropic/claude" },
          { status: 400 },
        ),
      ),
    );

    const res = await runCli([
      "run-config",
      "set-scheduler-models",
      "--data",
      '{"models":["acme/llm"]}',
    ]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("anthropic/claude");
  });
});
