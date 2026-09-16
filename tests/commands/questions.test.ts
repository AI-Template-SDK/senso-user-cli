/**
 * Command layer: `senso questions`.
 *
 * The same geo_questions rows as `senso prompts`, addressed by the same UUID —
 * `geo_question_id` here is `prompt_id` there. An agent that reads the two
 * groups as two resources will delete a question believing the prompt survives,
 * so the help text and the delete confirmation both have to say otherwise, and
 * both are asserted here.
 *
 * What else is worth protecting:
 *
 *   - `--type` is the SCOPE (organization | network) and becomes the
 *     `question_type` query parameter, with a default the caller never types. A
 *     rename or a dropped default silently changes which questions come back
 *     and the list still looks plausible.
 *   - `tag_ids: null` is refused before the request. dto.PatchGeoQuestionRequest
 *     declares TagIDs as *[]uuid.UUID, so JSON null arrives as nil —
 *     indistinguishable from "not supplied" — and the API answers 400. The empty
 *     array is the only value that clears tags, and this command's own help used
 *     to recommend the one that does not work.
 *   - This endpoint's validator is a case-sensitive `oneof`, so the legacy stage
 *     spellings `senso prompts create` rewrites are 400s here. Two endpoints,
 *     two vocabularies, and the stricter one is checked client-side.
 *   - `GET /org/questions` returns a list travelling with an inert `sort_by`
 *     scalar. That is not a pagination key, and it once made the whole list
 *     render as a single line of JSON.
 *
 * Fixtures are the real shapes: dto.GeoQuestionListResponse,
 * dto.GeoQuestionResponse and dto.TagResponse in senso-api internal/api/dto.
 *
 * Failure and usage branches come first, as in tests/commands/roles.test.ts.
 */

import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server, TEST_API_KEY } from "../setup.js";
import { apiUrl, envelope, errorEnvelope, runCli } from "../helpers.js";

const QUESTION_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_QUESTION_ID = "22222222-2222-4222-8222-222222222222";
const MISSING_ID = "00000000-0000-4000-8000-000000000000";
const ORG_ID = "1f8b5c2e-77a1-4a3b-9f0c-6d2e1b4a7c93";
const GEO_POOL_ID = "6f1c9a2b-4d8e-4c3a-9f7b-2e5d8c1a3b4f";
const TAG_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

/** dto.TagResponse, as the tag service renders it. */
const TAG = {
  id: TAG_ID,
  org_id: ORG_ID,
  name: "crm",
  curated: true,
  created_at: "2026-03-01T00:00:00Z",
  updated_at: "2026-03-01T00:00:00Z",
};

/** One dto.GeoQuestionResponse. persona_* are null for a question created here. */
const QUESTION = {
  geo_question_id: QUESTION_ID,
  org_id: ORG_ID,
  question_text: "What is the best CRM for a two-person team?",
  type: "decision",
  geo_pool_id: GEO_POOL_ID,
  persona_id: null,
  persona_question_id: null,
  persona_name: null,
  tags: [TAG],
  created_at: "2026-03-01T00:00:00Z",
  updated_at: "2026-03-01T00:00:00Z",
};

/**
 * dto.GeoQuestionListResponse.
 *
 * limit, offset and sort_by are real fields and really are 0 / 0 / "": the
 * handler sets Total only. `sort_by` is the extra scalar travelling beside the
 * list.
 */
const QUESTIONS = {
  questions: [
    QUESTION,
    {
      geo_question_id: OTHER_QUESTION_ID,
      org_id: ORG_ID,
      question_text: "How does GEO differ from SEO?",
      type: "awareness",
      geo_pool_id: GEO_POOL_ID,
      persona_id: null,
      persona_question_id: null,
      persona_name: null,
      tags: [],
      created_at: "2026-03-02T00:00:00Z",
      updated_at: "2026-03-02T00:00:00Z",
    },
  ],
  total: 2,
  limit: 0,
  offset: 0,
  sort_by: "",
};

/** POST /org/questions answers 201 with tags omitted when none were attached. */
const CREATED = {
  geo_question_id: QUESTION_ID,
  org_id: ORG_ID,
  question_text: "How do agencies choose a CRM?",
  type: "consideration",
  geo_pool_id: GEO_POOL_ID,
  persona_id: null,
  persona_question_id: null,
  persona_name: null,
  created_at: "2026-03-01T00:00:00Z",
  updated_at: "2026-03-01T00:00:00Z",
};

/** Commander wraps help at the terminal width, so compare on one line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ");
}

describe("questions, when the request fails", () => {
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

  it("exits 4 naming the question and the id space when patching one that is gone", async () => {
    server.use(
      http.patch(apiUrl("/org/questions/:id"), () =>
        HttpResponse.json({ error: "Question not found" }, { status: 404 }),
      ),
    );

    const res = await runCli([
      "questions",
      "patch",
      MISSING_ID,
      "--data",
      '{"type":"decision"}',
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
    expect(errorEnvelope(res).error).toMatchObject({
      code: "not_found",
      status: 404,
      field: "geo_question_id",
      received: MISSING_ID,
      hint: "List them with `senso questions list`.",
    });
    expect(errorEnvelope(res).error.message).toContain(`Question ${MISSING_ID} not found`);
  });

  it("exits 4 when deleting a question that is gone, and confirms nothing", async () => {
    server.use(
      http.delete(apiUrl("/org/questions/:id"), () => new HttpResponse(null, { status: 404 })),
    );

    const res = await runCli(["questions", "delete", MISSING_ID]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
    // The ✓ must not appear for a delete that did not happen.
    expect(res.stderr).not.toContain("deleted, with its run history");
  });

  it("exits 1 on a 500 and says retrying is worth it", async () => {
    server.use(http.get(apiUrl("/org/questions"), () => new HttpResponse(null, { status: 500 })));

    const res = await runCli(["questions", "list"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("server-side failure");
    expect(res.stderr).toContain("Retry shortly");
  });

  it("exits 1 on a 501 without offering a retry, because this one cannot work", async () => {
    server.use(http.get(apiUrl("/org/questions"), () => new HttpResponse(null, { status: 501 })));

    const res = await runCli(["questions", "list"]);

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("not a transient failure");
    expect(res.stderr).not.toContain("Retry shortly");
  });

  it("exits 5 when the API rate-limits, because retrying is the right response", async () => {
    server.use(http.get(apiUrl("/org/questions"), () => new HttpResponse(null, { status: 429 })));

    const res = await runCli(["questions", "list"]);

    expect(res.exitCode).toBe(5);
    expect(res.stderr).toContain("Rate limited");
  });

  it("reports a malformed body rather than throwing a parse error at the user", async () => {
    server.use(http.get(apiUrl("/org/questions"), () => new HttpResponse("<html>nope</html>")));

    const res = await runCli(["questions", "list"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Invalid JSON response");
  });

  it("writes the failure envelope to stderr, leaving stdout empty, under --output json", async () => {
    server.use(
      http.get(apiUrl("/org/questions"), () =>
        HttpResponse.json({ error: "nope" }, { status: 403 }),
      ),
    );

    const res = await runCli(["questions", "list", "--output", "json"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(errorEnvelope(res)).toMatchObject({
      ok: false,
      command: "questions list",
      error: { code: "forbidden", status: 403 },
    });
  });
});

describe("questions, when the command line is wrong", () => {
  // No handler is registered in this block: a request reaching MSW would fail
  // the test that made it, which is how "checked before the request" is proved.
  it("exits 2 when create's --data is not valid JSON", async () => {
    const res = await runCli(["questions", "create", "--data", "{question_text: hi}"]);

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

  it("reports the usage failure as an error envelope under --output json", async () => {
    const res = await runCli(["questions", "create", "--data", "{", "--output", "json"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(errorEnvelope(res).error).toMatchObject({ code: "invalid_json", field: "--data" });
  });

  it("exits 2 naming the missing key when create's --data has no type", async () => {
    const res = await runCli(["questions", "create", "--data", '{"question_text":"hi"}']);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("missing a required key: type");
  });

  it("exits 2 with the four stages in error.allowed when the stage is not one", async () => {
    const res = await runCli([
      "questions",
      "create",
      "--data",
      '{"question_text":"hi","type":"not-a-stage"}',
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    expect(errorEnvelope(res).error).toMatchObject({
      code: "usage",
      field: "type",
      received: "not-a-stage",
      allowed: ["awareness", "consideration", "evaluation", "decision"],
    });
  });

  it("exits 2 on a legacy spelling `prompts create` accepts, because this validator does not", async () => {
    const res = await runCli([
      "questions",
      "create",
      "--data",
      '{"question_text":"hi","type":"rank"}',
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain('Invalid "type" in --data: "rank"');
    expect(res.stderr).toContain("`senso prompts create` also accepts the legacy spellings");
  });

  it("exits 2 when question_text is longer than the 255 this endpoint stores", async () => {
    const res = await runCli([
      "questions",
      "create",
      "--data",
      JSON.stringify({ question_text: "x".repeat(256), type: "decision" }),
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("256 characters");
    expect(res.stderr).toContain("`senso prompts create`, which accepts 500");
  });

  it("exits 2 when a tag_ids entry is not a UUID", async () => {
    const res = await runCli([
      "questions",
      "create",
      "--data",
      '{"question_text":"hi","type":"decision","tag_ids":["t-1"]}',
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    expect(errorEnvelope(res).error).toMatchObject({ field: "tag_ids", received: "t-1" });
  });

  it("exits 2 when patch's --data names neither type nor tag_ids", async () => {
    const res = await runCli(["questions", "patch", QUESTION_ID, "--data", "{}"]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("must set at least one of: tag_ids, type");
  });

  it("refuses `tag_ids: null` and says the empty array is how tags are cleared", async () => {
    // The API reads null as "field not supplied" and answers 400 "At least one
    // field must be provided for update" — so this used to look like a CLI bug.
    const res = await runCli([
      "questions",
      "patch",
      QUESTION_ID,
      "--data",
      '{"tag_ids":null}',
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(errorEnvelope(res).error).toMatchObject({
      code: "usage",
      field: "tag_ids",
      received: "null",
    });
    expect(errorEnvelope(res).error.hint).toContain(`--data '{"tag_ids":[]}'`);
  });

  it("exits 2 when <questionId> is not a UUID", async () => {
    const res = await runCli([
      "questions",
      "patch",
      "q-7c11",
      "--data",
      '{"type":"decision"}',
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    expect(errorEnvelope(res).error).toMatchObject({
      field: "<questionId>",
      received: "q-7c11",
    });
  });

  it("exits 2 and names the two scopes when --type is neither", async () => {
    const res = await runCli(["questions", "list", "--type", "not-a-type"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain('Invalid --type: "not-a-type"');
    expect(res.stderr).toContain("organization, network");
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

  it("sends the requested scope when --type is given", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/questions"), ({ request }) => {
        seen = request;
        return HttpResponse.json({ ...QUESTIONS, questions: [], total: 0 });
      }),
    );

    await runCli(["questions", "list", "--type", "network"]);

    expect(new URL(seen?.url ?? "").searchParams.get("question_type")).toBe("network");
  });
});

describe("questions create, patch and delete, on the wire", () => {
  it("POSTs only the fields this endpoint models", async () => {
    let seen: Request | undefined;
    server.use(
      http.post(apiUrl("/org/questions"), ({ request }) => {
        seen = request.clone();
        return HttpResponse.json(CREATED, { status: 201 });
      }),
    );

    await runCli([
      "questions",
      "create",
      "--data",
      '{"question_text":"How do agencies choose a CRM?","type":"consideration"}',
    ]);

    expect(seen?.method).toBe("POST");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/questions");
    expect(seen?.headers.get("content-type")).toBe("application/json");
    await expect(seen?.json()).resolves.toEqual({
      question_text: "How do agencies choose a CRM?",
      type: "consideration",
    });
  });

  it("forwards tag_ids and geo_pool_id when they are supplied", async () => {
    let seen: Request | undefined;
    server.use(
      http.post(apiUrl("/org/questions"), ({ request }) => {
        seen = request.clone();
        return HttpResponse.json({ ...CREATED, tags: [TAG] }, { status: 201 });
      }),
    );

    await runCli([
      "questions",
      "create",
      "--data",
      JSON.stringify({
        question_text: "How do agencies choose a CRM?",
        type: "consideration",
        tag_ids: [TAG_ID],
        geo_pool_id: GEO_POOL_ID,
      }),
    ]);

    await expect(seen?.json()).resolves.toEqual({
      question_text: "How do agencies choose a CRM?",
      type: "consideration",
      tag_ids: [TAG_ID],
      geo_pool_id: GEO_POOL_ID,
    });
  });

  it("PATCHes only the fields the caller named", async () => {
    let seen: Request | undefined;
    server.use(
      http.patch(apiUrl("/org/questions/:id"), ({ request }) => {
        seen = request.clone();
        return HttpResponse.json(QUESTION);
      }),
    );

    await runCli([
      "questions",
      "patch",
      QUESTION_ID,
      "--data",
      JSON.stringify({ tag_ids: [TAG_ID], type: "consideration" }),
    ]);

    expect(seen?.method).toBe("PATCH");
    expect(new URL(seen?.url ?? "").pathname).toBe(`/api/v1/org/questions/${QUESTION_ID}`);
    await expect(seen?.json()).resolves.toEqual({ tag_ids: [TAG_ID], type: "consideration" });
  });

  it("sends an empty tag_ids array through, which is what clears the tags", async () => {
    let seen: Request | undefined;
    server.use(
      http.patch(apiUrl("/org/questions/:id"), ({ request }) => {
        seen = request.clone();
        return HttpResponse.json({ ...QUESTION, tags: [] });
      }),
    );

    const res = await runCli(["questions", "patch", QUESTION_ID, "--data", '{"tag_ids":[]}']);

    expect(res.exitCode).toBe(0);
    await expect(seen?.json()).resolves.toEqual({ tag_ids: [] });
  });

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
  it("carries the payload unmodified in the envelope's data under --output json", async () => {
    server.use(http.get(apiUrl("/org/questions"), () => HttpResponse.json(QUESTIONS)));

    const res = await runCli(["questions", "list", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual(QUESTIONS);
    expect(res.stderr).toBe("");
  });

  it("renders a real list although a sort_by scalar travels beside it", async () => {
    // `sort_by` is not a pagination key, and the payload used to be rendered as
    // one line of JSON because of it.
    server.use(http.get(apiUrl("/org/questions"), () => HttpResponse.json(QUESTIONS)));

    const res = await runCli(["questions", "list"]);

    expect(res.exitCode).toBe(0);
    // plain never truncates, so the full question text survives.
    expect(res.stdout).toContain("What is the best CRM for a two-person team?");
    expect(res.stdout).toContain("How does GEO differ from SEO?");
    expect(res.stdout).toContain("awareness");
    expect(res.stdout).not.toContain('{"geo_question_id"');
  });

  it("shows geo_question_id, the id every other command takes, under --output table", async () => {
    server.use(http.get(apiUrl("/org/questions"), () => HttpResponse.json(QUESTIONS)));

    const res = await runCli(["questions", "list", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    for (const column of ["geo_question_id", "question_text", "type", "created_at"]) {
      expect(res.stdout).toContain(column);
    }
    expect(res.stdout).toContain(QUESTION_ID);
    expect(res.stdout).toContain("decision");
    // Every declared column is a field the API really returns.
    expect(res.stderr).not.toContain("the API did not return");
  });

  it("says an empty network list is not an error, and where to check why", async () => {
    server.use(
      http.get(apiUrl("/org/questions"), () =>
        HttpResponse.json({ questions: [], total: 0, limit: 0, offset: 0, sort_by: "" }),
      ),
    );

    const res = await runCli(["questions", "list", "--type", "network"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("No questions found.");
    expect(res.stderr).toContain("senso org get");
  });
});

describe("questions create and patch, on success", () => {
  it("puts the created question on stdout and the follow-up on stderr", async () => {
    server.use(http.post(apiUrl("/org/questions"), () => HttpResponse.json(CREATED)));

    const res = await runCli([
      "questions",
      "create",
      "--data",
      '{"question_text":"How do agencies choose a CRM?","type":"consideration"}',
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(QUESTION_ID);
    expect(res.stderr).toContain("senso run-config schedule");
    expect(res.stdout).not.toContain("What you can do next");
  });

  it("warns when tag_ids were sent and the response came back with no tags", async () => {
    // The handler attaches tags after the insert and reports a failure only
    // through c.Error(), still answering 201 — a missing `tags` is the only
    // signal the caller gets that its tag ids did not take.
    server.use(http.post(apiUrl("/org/questions"), () => HttpResponse.json(CREATED)));

    const res = await runCli([
      "questions",
      "create",
      "--data",
      JSON.stringify({
        question_text: "How do agencies choose a CRM?",
        type: "consideration",
        tag_ids: [TAG_ID],
      }),
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    expect(envelope(res).warnings?.join(" ")).toContain("could not attach the tag_ids");
    expect(envelope(res).next).toContainEqual({
      why: "Check which tags actually landed",
      command: `senso prompts tags list ${QUESTION_ID}`,
    });
  });

  it("stays silent about tags when none were asked for", async () => {
    server.use(http.post(apiUrl("/org/questions"), () => HttpResponse.json(CREATED)));

    const res = await runCli([
      "questions",
      "create",
      "--data",
      '{"question_text":"How do agencies choose a CRM?","type":"consideration"}',
      "--output",
      "json",
    ]);

    expect(envelope(res).warnings).toBeUndefined();
  });

  it("warns that tag_ids replaced the whole tag set rather than adding to it", async () => {
    server.use(http.patch(apiUrl("/org/questions/:id"), () => HttpResponse.json(QUESTION)));

    const res = await runCli([
      "questions",
      "patch",
      QUESTION_ID,
      "--data",
      JSON.stringify({ tag_ids: [TAG_ID] }),
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual(QUESTION);
    expect(envelope(res).warnings?.join(" ")).toContain("are now detached");
  });

  it("says nothing about tags when only the stage changed", async () => {
    server.use(http.patch(apiUrl("/org/questions/:id"), () => HttpResponse.json(QUESTION)));

    const res = await runCli([
      "questions",
      "patch",
      QUESTION_ID,
      "--data",
      '{"type":"decision"}',
      "--output",
      "json",
    ]);

    expect(envelope(res).warnings).toBeUndefined();
    expect(envelope(res).next).toContainEqual({
      why: "See the question's run history",
      command: `senso prompts get ${QUESTION_ID}`,
    });
  });
});

describe("questions delete, on success", () => {
  it("warns that it destroyed the run history, exactly as prompts delete does", async () => {
    // The two commands are one operation on one row. A caller who believes
    // `questions delete` is the lightweight half loses every run recorded
    // against it.
    server.use(
      http.delete(apiUrl("/org/questions/:id"), () => new HttpResponse(null, { status: 204 })),
    );

    const res = await runCli(["questions", "delete", QUESTION_ID]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain(`Question ${QUESTION_ID} deleted, with its run history.`);
    expect(res.stderr).toContain("the same row `senso prompts delete` would have");
  });

  it("names what was deleted in the envelope, and warns there too", async () => {
    server.use(
      http.delete(apiUrl("/org/questions/:id"), () => new HttpResponse(null, { status: 204 })),
    );

    const res = await runCli(["questions", "delete", QUESTION_ID, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual({ action: "deleted", resource: "question", id: QUESTION_ID });
    expect(envelope(res).warnings?.join(" ")).toContain("every run recorded against it");
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

describe("questions --help, where an agent learns what a question is", () => {
  it("says these are the same records as prompts, addressed by the same UUID", async () => {
    const res = await runCli(["questions", "--help"]);

    const help = oneLine(res.stdout);
    expect(help).toContain("These are the SAME records as `senso prompts`");
    expect(help).toContain("geo_question_id is the same UUID as prompt_id");
    expect(help).toContain(
      "`questions delete` removes the question AND its run history, exactly as `prompts delete` does",
    );
  });

  it("separates the two meanings of type, which is the group's one real trap", async () => {
    const res = await runCli(["questions", "list", "--help"]);

    const help = oneLine(res.stdout);
    expect(help).toContain("This is the scope, not the funnel stage.");
  });

  it("says in patch's own help that tag_ids: null does not clear tags", async () => {
    const res = await runCli(["questions", "patch", "--help"]);

    const help = oneLine(res.stdout);
    expect(help).toContain("pass [] to remove them all");
    expect(help).toContain("tag_ids: null does NOT clear them");
  });
});
