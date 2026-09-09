/**
 * Command layer: `senso questions`.
 *
 * The full CRUD shape, and the widest surface in this batch. Three things here
 * are worth protecting beyond "the command works":
 *
 *   - `--type` becomes the `question_type` query parameter, and it has a default
 *     the user never types. A rename or a dropped default silently changes which
 *     questions come back, and the list still looks plausible.
 *   - `geo_question_id` is the id other commands reference (see `engine
 *     publish`), so it is asserted as a column rather than left to the generic
 *     renderer's choice.
 *   - `delete` has no payload. Its ✓ belongs on stderr and its `--output json`
 *     must still be parseable, or a script cannot tell a delete from a failure.
 *
 * Failure and usage branches come first, as in tests/commands/roles.test.ts.
 */

import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server, TEST_API_KEY } from "../setup.js";
import { apiUrl, runCli } from "../helpers.js";

const QUESTION_ID = "q-7c11";

const QUESTIONS = {
  questions: [
    {
      geo_question_id: "q-1",
      question_text: "What is the best CRM for a two-person team?",
      type: "decision",
      created_at: "2026-03-01T00:00:00Z",
    },
    {
      geo_question_id: "q-2",
      question_text: "How does GEO differ from SEO?",
      type: "awareness",
      created_at: "2026-03-02T00:00:00Z",
    },
  ],
};

const QUESTION = {
  geo_question_id: QUESTION_ID,
  question_text: "What is the best CRM for a two-person team?",
  type: "decision",
  tag_ids: ["t-1"],
};

describe("questions list, when the request fails", () => {
  it("exits 3 and explains how to authenticate when there is no API key", async () => {
    const res = await runCli(["questions", "list"], { withKey: false });

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("no API key found");
    expect(res.stderr).toContain("SENSO_API_KEY");
  });

  it("exits 3 when the API rejects the key", async () => {
    server.use(
      http.get(apiUrl("/org/questions"), () =>
        HttpResponse.json({ error: "invalid key" }, { status: 401 }),
      ),
    );

    const res = await runCli(["questions", "list"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Authentication failed");
  });

  it("exits 3 when the key is valid but lacks the scope", async () => {
    server.use(
      http.get(apiUrl("/org/questions"), () =>
        HttpResponse.json({ error: "not permitted" }, { status: 403 }),
      ),
    );

    const res = await runCli(["questions", "list"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Permission denied");
  });

  it("exits 4 on a 404", async () => {
    server.use(http.get(apiUrl("/org/questions"), () => new HttpResponse(null, { status: 404 })));

    const res = await runCli(["questions", "list"]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Not found");
  });

  it("exits 1 on a 500 and says it is not the caller's fault", async () => {
    server.use(http.get(apiUrl("/org/questions"), () => new HttpResponse(null, { status: 500 })));

    const res = await runCli(["questions", "list"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("not your fault");
  });

  it("reports a malformed body rather than throwing a parse error at the user", async () => {
    server.use(http.get(apiUrl("/org/questions"), () => new HttpResponse("<html>nope</html>")));

    const res = await runCli(["questions", "list"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Invalid JSON response");
  });

  it("writes the failure to stderr as JSON, leaving stdout empty, under --output json", async () => {
    server.use(
      http.get(apiUrl("/org/questions"), () =>
        HttpResponse.json({ error: "nope" }, { status: 403 }),
      ),
    );

    const res = await runCli(["questions", "list", "--output", "json"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");

    const reported: unknown = JSON.parse(res.stderr);
    expect(reported).toMatchObject({
      error: { code: "forbidden", status: 403 },
    });
  });
});

describe("questions patch and delete, when the target does not exist", () => {
  it("exits 4 when patching a question that is gone", async () => {
    server.use(
      http.patch(apiUrl("/org/questions/:id"), () => new HttpResponse(null, { status: 404 })),
    );

    const res = await runCli(["questions", "patch", "q-gone", "--data", '{"type":"decision"}']);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Not found");
  });

  it("exits 4 when deleting a question that is gone, and prints no confirmation", async () => {
    server.use(
      http.delete(apiUrl("/org/questions/:id"), () => new HttpResponse(null, { status: 404 })),
    );

    const res = await runCli(["questions", "delete", "q-gone"]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
    // The ✓ must not appear for a delete that did not happen.
    expect(res.stderr).not.toContain("deleted");
  });
});

describe("questions create and patch, when the flag is wrong", () => {
  it("exits 2 when create's --data is not valid JSON, without making a request", async () => {
    // No handler registered: reaching the network would fail this test.
    const res = await runCli(["questions", "create", "--data", "{question_text: hi}"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Invalid JSON in --data");
  });

  it("exits 2 when patch's --data is not valid JSON, without making a request", async () => {
    const res = await runCli(["questions", "patch", QUESTION_ID, "--data", "nope"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Invalid JSON in --data");
  });

  it("exits 2 when --data is valid JSON but not an object", async () => {
    const res = await runCli(["questions", "create", "--data", '["a question"]']);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("--data must be a JSON object");
  });

  it("reports the usage failure as JSON on stderr under --output json", async () => {
    const res = await runCli(["questions", "create", "--data", "{", "--output", "json"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(JSON.parse(res.stderr)).toMatchObject({ error: { code: "invalid_json" } });
  });
});

describe("questions list, on the wire", () => {
  it("defaults question_type to organization when --type is not given", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/questions"), ({ request }) => {
        seen = request;
        return HttpResponse.json(QUESTIONS);
      }),
    );

    await runCli(["questions", "list"]);

    expect(seen?.method).toBe("GET");
    const url = new URL(seen?.url ?? "");
    expect(url.pathname).toBe("/api/v1/org/questions");
    // The flag is `--type`; the API parameter is `question_type`, and the
    // default is sent explicitly rather than left to the server.
    expect(url.searchParams.get("question_type")).toBe("organization");
    expect([...url.searchParams.keys()]).toEqual(["question_type"]);
    expect(seen?.headers.get("x-api-key")).toBe(TEST_API_KEY);
  });

  it("sends the requested type when --type is given", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/questions"), ({ request }) => {
        seen = request;
        return HttpResponse.json(QUESTIONS);
      }),
    );

    await runCli(["questions", "list", "--type", "network"]);

    expect(new URL(seen?.url ?? "").searchParams.get("question_type")).toBe("network");
  });

  // Per the exit-code contract an invalid enum value is a usage error (exit 2,
  // naming the valid values) rejected before any request is made. No handler is
  // registered here, so the test also proves nothing was sent.
  it("exits 2 and names the two types when --type is neither", async () => {
    const res = await runCli(["questions", "list", "--type", "not-a-type"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain('Invalid --type: "not-a-type"');
    expect(res.stderr).toContain("organization, network");
  });
});

describe("questions create, on the wire", () => {
  it("POSTs /org/questions with the --data object forwarded verbatim", async () => {
    let seen: Request | undefined;
    server.use(
      http.post(apiUrl("/org/questions"), ({ request }) => {
        seen = request.clone();
        return HttpResponse.json(QUESTION);
      }),
    );

    const body = { question_text: "What is GEO?", type: "awareness", tag_ids: ["t-1"] };
    await runCli(["questions", "create", "--data", JSON.stringify(body)]);

    expect(seen?.method).toBe("POST");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/questions");
    expect(seen?.headers.get("content-type")).toBe("application/json");
    await expect(seen?.json()).resolves.toEqual(body);
  });

  // BUG: the description constrains `type` to decision | consideration |
  // awareness | evaluation, but the CLI parses --data as an opaque object and
  // never checks it, so an invalid funnel stage is a round trip to the API
  // rather than an exit 2. Current behavior asserted.
  it("forwards an unrecognized type inside --data rather than rejecting it", async () => {
    let seen: Request | undefined;
    server.use(
      http.post(apiUrl("/org/questions"), ({ request }) => {
        seen = request.clone();
        return HttpResponse.json(QUESTION);
      }),
    );

    await runCli(["questions", "create", "--data", '{"question_text":"x","type":"not-a-stage"}']);

    await expect(seen?.json()).resolves.toMatchObject({ type: "not-a-stage" });
  });
});

describe("questions patch, on the wire", () => {
  it("PATCHes /org/questions/<id> with the --data object forwarded verbatim", async () => {
    let seen: Request | undefined;
    server.use(
      http.patch(apiUrl("/org/questions/:id"), ({ request }) => {
        seen = request.clone();
        return HttpResponse.json(QUESTION);
      }),
    );

    const body = { tag_ids: ["t-1", "t-2"], type: "consideration" };
    await runCli(["questions", "patch", QUESTION_ID, "--data", JSON.stringify(body)]);

    expect(seen?.method).toBe("PATCH");
    expect(new URL(seen?.url ?? "").pathname).toBe(`/api/v1/org/questions/${QUESTION_ID}`);
    await expect(seen?.json()).resolves.toEqual(body);
  });

  it("preserves a null tag_ids, which is how the caller clears every tag", async () => {
    let seen: Request | undefined;
    server.use(
      http.patch(apiUrl("/org/questions/:id"), ({ request }) => {
        seen = request.clone();
        return HttpResponse.json(QUESTION);
      }),
    );

    await runCli(["questions", "patch", QUESTION_ID, "--data", '{"tag_ids":null}']);

    // JSON.stringify would drop this if the body were rebuilt from undefined,
    // and "clear all tags" would quietly become "change nothing".
    await expect(seen?.json()).resolves.toEqual({ tag_ids: null });
  });
});

describe("questions delete, on the wire", () => {
  it("DELETEs /org/questions/<id> with no body", async () => {
    let seen: Request | undefined;
    server.use(
      http.delete(apiUrl("/org/questions/:id"), ({ request }) => {
        seen = request;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await runCli(["questions", "delete", QUESTION_ID]);

    expect(seen?.method).toBe("DELETE");
    expect(new URL(seen?.url ?? "").pathname).toBe(`/api/v1/org/questions/${QUESTION_ID}`);
    expect(new URL(seen?.url ?? "").search).toBe("");
    expect(seen?.body).toBeNull();
  });
});

describe("questions list, on success", () => {
  it("prints the payload unmodified under --output json", async () => {
    server.use(http.get(apiUrl("/org/questions"), () => HttpResponse.json(QUESTIONS)));

    const res = await runCli(["questions", "list", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toEqual(QUESTIONS);
    expect(res.stderr).toBe("");
  });

  it("shows geo_question_id, the id other commands reference, under --output table", async () => {
    server.use(http.get(apiUrl("/org/questions"), () => HttpResponse.json(QUESTIONS)));

    const res = await runCli(["questions", "list", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    for (const column of ["geo_question_id", "question_text", "type", "created_at"]) {
      expect(res.stdout).toContain(column);
    }
    expect(res.stdout).toContain("q-1");
    expect(res.stdout).toContain("decision");
  });

  it("renders a readable block per question by default", async () => {
    server.use(http.get(apiUrl("/org/questions"), () => HttpResponse.json(QUESTIONS)));

    const res = await runCli(["questions", "list"]);

    expect(res.exitCode).toBe(0);
    // plain never truncates, so the full question text survives.
    expect(res.stdout).toContain("What is the best CRM for a two-person team?");
    expect(res.stdout).toContain("awareness");
  });

  it("exits 0 when the org has no questions of that type", async () => {
    server.use(http.get(apiUrl("/org/questions"), () => HttpResponse.json({ questions: [] })));

    const res = await runCli(["questions", "list", "--type", "network"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("questions");
  });
});

describe("questions create and patch, on success", () => {
  it("puts the tick on stderr and the created question on stdout", async () => {
    server.use(http.post(apiUrl("/org/questions"), () => HttpResponse.json(QUESTION)));

    const res = await runCli(["questions", "create", "--data", '{"question_text":"x"}']);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(QUESTION_ID);
    expect(res.stderr).toContain("Question created");
    expect(res.stdout).not.toContain("Question created");
  });

  it("prints the payload alone under --output json", async () => {
    server.use(http.post(apiUrl("/org/questions"), () => HttpResponse.json(QUESTION)));

    const res = await runCli([
      "questions",
      "create",
      "--data",
      '{"question_text":"x"}',
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toEqual(QUESTION);
    expect(res.stderr).toBe("");
  });

  it("names the question it updated, on stderr", async () => {
    server.use(http.patch(apiUrl("/org/questions/:id"), () => HttpResponse.json(QUESTION)));

    const res = await runCli(["questions", "patch", QUESTION_ID, "--data", '{"type":"decision"}']);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain(QUESTION_ID);
    expect(res.stderr).toContain("updated");
    expect(res.stdout).toContain("decision");
  });
});

describe("questions delete, on success", () => {
  it("puts the ✓ on stderr and leaves stdout empty, so the command can be piped", async () => {
    server.use(
      http.delete(apiUrl("/org/questions/:id"), () => new HttpResponse(null, { status: 204 })),
    );

    const res = await runCli(["questions", "delete", QUESTION_ID]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain(`Question ${QUESTION_ID} deleted.`);
  });

  it("prints a parseable object on stdout under --output json", async () => {
    server.use(
      http.delete(apiUrl("/org/questions/:id"), () => new HttpResponse(null, { status: 204 })),
    );

    const res = await runCli(["questions", "delete", QUESTION_ID, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toEqual({ ok: true, message: `Question ${QUESTION_ID} deleted.` });
    expect(res.stderr).toBe("");
  });

  it("says nothing at all under --quiet", async () => {
    server.use(
      http.delete(apiUrl("/org/questions/:id"), () => new HttpResponse(null, { status: 204 })),
    );

    const res = await runCli(["questions", "delete", QUESTION_ID, "--quiet"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr).toBe("");
  });
});
