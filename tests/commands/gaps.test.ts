/**
 * Command layer: `senso gaps`.
 *
 * Four things here are worth protecting.
 *
 * The first is that multi-value filters reach the API as repeated keys. The API
 * reads `statuses=weak&statuses=open`; a comma-joined value is one status that
 * does not exist, and the answer to that is an empty list rather than an error —
 * which reads exactly like an organization with no gaps.
 *
 * The second is the resolution matrix. A write must name what it produced and a
 * ruling must name the document it is about. The API enforces both with a 400;
 * the CLI catches them first and names the flag, so an agent learns the fix from
 * the message instead of a round trip.
 *
 * The third is the guidance, and it is the most valuable thing here. `get` ends
 * with the commands to act on this gap, chosen from its problem and status, and
 * every mutation says what the gap now is and how to undo it. All of it used to
 * be written with `log.hint`, which `--output json` silences — so the caller it
 * was written for, an agent passing the flag every published Senso skill passes,
 * was the one caller who could never read it. It now travels in the envelope's
 * `next` and `warnings` as well, and the tests under "the guidance a JSON caller
 * gets" are what hold it there.
 *
 * The fourth is exit codes for "does not exist". Reading an unknown gap is a
 * 404, but recording a resolution against one is a 400 "gap not found"; both
 * must exit 4.
 *
 * Failure branches come first, as in tests/commands/roles.test.ts.
 */

import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../setup.js";
import { apiUrl, envelope, errorEnvelope, runCli } from "../helpers.js";

const GAP_ID = "11111111-2222-4333-8444-555555555555";
const RESOLUTION_ID = "99999999-2222-4333-8444-555555555555";
const CONTENT_ID = "420872df-71ee-485b-829d-fcdb48e17321";
const TAG_ID = "7a3c9f10-1111-4222-8333-444455556666";
/** A document node id. Distinct from TAG_ID: they are different id spaces. */
const KB_NODE_ID = "6b2d8e01-1111-4222-8333-444455556666";
const SEARCH_TURN_ID = "3d4e5f60-1111-4222-8333-444455556666";

const API_GAP = {
  gap_id: GAP_ID,
  kind: "missing",
  problem: "not_found",
  status: "open",
  claim_text: "Do you offer an annual plan?",
  occurrence_count: 3,
  asker_count: 0,
  api_occurrence_count: 3,
  surfaces: ["api_search"],
  first_seen_at: "2026-09-14T10:00:00Z",
  last_seen_at: "2026-09-14T12:30:00Z",
  status_changed_at: "2026-09-14T11:05:00Z",
  awaiting_update: false,
  tags: [],
  origin: {
    kind: "api_unanswered_question",
    surface: "api_search",
    surface_counts: { search_turn: 0, content: 0, question_run: 0, api_search: 3 },
  },
};

const LIST = { gaps: [API_GAP], total: 7, limit: 1, offset: 0 };

const DETAIL = {
  gap: API_GAP,
  occurrences: [
    {
      subject_type: "search_turn",
      subject_id: SEARCH_TURN_ID,
      question: "Do you offer an annual plan?",
      occurred_at: "2026-09-14T12:30:00Z",
    },
  ],
  resolutions: [],
  lead_evidence: { retrieval: { raw_result_count: 12, filtered_result_count: 0, top_score: 0.31 } },
};

const SAVED = {
  resolution_id: RESOLUTION_ID,
  resolution_type: "answered",
  produced_content_id: CONTENT_ID,
  created_at: "2026-09-14T13:00:00Z",
};

/** Answers the list endpoint and records the query it was sent. */
function captureList(response: Record<string, unknown> = LIST): { url?: URL } {
  const seen: { url?: URL } = {};
  server.use(
    http.get(apiUrl("/org/gaps"), ({ request }) => {
      seen.url = new URL(request.url);
      return HttpResponse.json(response);
    }),
  );
  return seen;
}

/** Answers the resolution endpoint and records the body it was sent. */
function captureResolution(): { body?: Record<string, unknown> } {
  const seen: { body?: Record<string, unknown> } = {};
  server.use(
    http.post(apiUrl(`/org/gaps/${GAP_ID}/resolutions`), async ({ request }) => {
      seen.body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json(SAVED, { status: 201 });
    }),
  );
  return seen;
}

function serveDetail(detail: Record<string, unknown>): void {
  server.use(http.get(apiUrl(`/org/gaps/${GAP_ID}`), () => HttpResponse.json(detail)));
}

describe("gaps list, when a flag is not usable", () => {
  it("exits 2 on an unknown status, and offers all alongside the real ones", async () => {
    const res = await runCli(["gaps", "list", "--status", "opn"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("weak");
    expect(res.stderr).toContain("or all");
  });

  it("exits 2 on an unknown origin, naming the valid ones", async () => {
    const res = await runCli(["gaps", "list", "--origin", "api"]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("api_unanswered_question");
  });

  it("exits 2 when a --tag is not a UUID, and says where tag ids come from", async () => {
    const res = await runCli(["gaps", "list", "--tag", "pricing"]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("senso tags list");
  });

  it("exits 2 when --limit is above the API's maximum", async () => {
    const res = await runCli(["gaps", "list", "--limit", "101"]);

    expect(res.exitCode).toBe(2);
  });
});

describe("gaps get, resolve and undo, when an id is not usable", () => {
  it("exits 2 when the gap id is not a UUID, and says where gap ids come from", async () => {
    const res = await runCli(["gaps", "get", "gap-1"]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("senso gaps list");
  });

  it("exits 2 when the resolution id is not a UUID", async () => {
    const res = await runCli(["gaps", "undo", GAP_ID, "latest"]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("senso gaps get");
  });

  it("exits 2 when --content-id is not a UUID, and says which id space it wants", async () => {
    const res = await runCli([
      "gaps",
      "answer",
      GAP_ID,
      "--content-id",
      "doc-1",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    // content_id and kb_node_id are both UUIDs and are not interchangeable, so
    // the error names the field and where the right id comes from.
    expect(errorEnvelope(res).error).toMatchObject({
      code: "usage",
      field: "--content-id",
      received: "doc-1",
    });
    expect(errorEnvelope(res).error.hint).toContain("content_id");
  });
});

describe("gaps resolve, the resolution matrix", () => {
  it("exits 2 on an unknown type, naming every valid one", async () => {
    const res = await runCli(["gaps", "resolve", GAP_ID, "--type", "fixed"]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("content_added");
    expect(res.stderr).toContain("we_dont_do_this");
  });

  it("exits 2 when a write names nothing it produced, and points at the answer shortcut", async () => {
    const res = await runCli(["gaps", "resolve", GAP_ID, "--type", "answered"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("--produced-content-id");
    expect(res.stderr).toContain(`senso gaps answer ${GAP_ID}`);
  });

  it("exits 2 when a ruling names no document", async () => {
    const res = await runCli(["gaps", "resolve", GAP_ID, "--type", "ruled_claim_correct"]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("--authority-content-id");
  });

  it("exits 2 on an unknown ruling side", async () => {
    const res = await runCli([
      "gaps",
      "resolve",
      GAP_ID,
      "--type",
      "ruled_kb_correct",
      "--ruling-side",
      "left",
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("document");
  });
});

describe("gaps, when the gap does not exist", () => {
  it("exits 4 when reading an unknown gap", async () => {
    server.use(
      http.get(apiUrl(`/org/gaps/${GAP_ID}`), () =>
        HttpResponse.json({ error: "Gap not found" }, { status: 404 }),
      ),
    );

    const res = await runCli(["gaps", "get", GAP_ID]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
  });

  it("exits 4, not 1, when resolving an unknown gap — which the API answers with a 400", async () => {
    server.use(
      http.post(apiUrl(`/org/gaps/${GAP_ID}/resolutions`), () =>
        HttpResponse.json({ error: "gap not found" }, { status: 400 }),
      ),
    );

    const res = await runCli(["gaps", "dismiss", GAP_ID]);

    expect(res.exitCode).toBe(4);
    expect(res.stderr).toContain(`Gap ${GAP_ID} not found`);
    expect(res.stderr).toContain("--status all");
  });

  it("keeps any other 400 as a refusal, with the API's own message", async () => {
    server.use(
      http.post(apiUrl(`/org/gaps/${GAP_ID}/resolutions`), () =>
        HttpResponse.json({ error: "unknown resolution type" }, { status: 400 }),
      ),
    );

    const res = await runCli(["gaps", "dismiss", GAP_ID]);

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("unknown resolution type");
  });

  it("exits 4 when undoing a resolution the gap does not have, and says why that can happen", async () => {
    server.use(
      http.delete(apiUrl(`/org/gaps/${GAP_ID}/resolutions/${RESOLUTION_ID}`), () =>
        HttpResponse.json({ error: "Resolution not found" }, { status: 404 }),
      ),
    );

    const res = await runCli(["gaps", "undo", GAP_ID, RESOLUTION_ID]);

    expect(res.exitCode).toBe(4);
    expect(res.stderr).toContain("already undone");
  });
});

describe("gaps list, on the wire", () => {
  it("sends no statuses by default, leaving the API's working view in charge", async () => {
    const seen = captureList();

    await runCli(["gaps", "list"]);

    expect(seen.url?.searchParams.has("statuses")).toBe(false);
  });

  it("sends a repeated filter as repeated keys, whether repeated or comma-separated", async () => {
    const seen = captureList();

    const res = await runCli([
      "gaps",
      "list",
      "--status",
      "weak,open",
      "--status",
      "reopened",
      "--origin",
      "api_unanswered_question",
      "--surface",
      "api_search",
      "--problem",
      "not_found",
      "--kind",
      "missing",
      "--tag",
      TAG_ID,
      "--search",
      "annual plan",
      "--sort",
      "recent",
      "--limit",
      "10",
      "--offset",
      "20",
    ]);

    expect(res.exitCode).toBe(0);
    const q = seen.url?.searchParams;
    expect(q?.getAll("statuses")).toEqual(["weak", "open", "reopened"]);
    expect(q?.getAll("origin_kinds")).toEqual(["api_unanswered_question"]);
    expect(q?.getAll("surfaces")).toEqual(["api_search"]);
    expect(q?.getAll("problems")).toEqual(["not_found"]);
    expect(q?.getAll("kinds")).toEqual(["missing"]);
    expect(q?.getAll("tag_ids")).toEqual([TAG_ID]);
    expect(q?.get("search")).toBe("annual plan");
    expect(q?.get("sort")).toBe("recent");
    expect(q?.get("limit")).toBe("10");
    expect(q?.get("offset")).toBe("20");
  });

  it("expands --status all to every status, the hidden ones included", async () => {
    const seen = captureList();

    await runCli(["gaps", "list", "--status", "all"]);

    expect(seen.url?.searchParams.getAll("statuses")).toEqual([
      "weak",
      "open",
      "reopened",
      "addressed",
      "resolved",
      "dismissed",
      "dormant",
    ]);
  });
});

describe("gaps list, what it prints", () => {
  it("keeps stdout the untouched API payload under --output json, with nothing on stderr", async () => {
    captureList();

    const res = await runCli(["gaps", "list", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual(LIST);
    expect(res.stderr).toBe("");
  });

  it("prints each gap with its id, and puts the paging position and next command on stderr", async () => {
    captureList();

    const res = await runCli(["gaps", "list"]);

    expect(res.stdout).toContain("Do you offer an annual plan?");
    expect(res.stdout).toContain(`gap_id: ${GAP_ID}`);
    expect(res.stdout).toContain("api_unanswered_question");
    expect(res.stdout).not.toContain("Showing");
    expect(res.stderr).toContain("Showing 1–1 of 7");
    expect(res.stderr).toContain("--offset 1");
    // The real id, substituted — a placeholder is one more thing to resolve.
    expect(res.stderr).toContain(`senso gaps get ${GAP_ID}`);
  });

  it("explains that weak gaps are hidden when the default view is empty", async () => {
    captureList({ gaps: [], total: 0, limit: 50, offset: 0 });

    const res = await runCli(["gaps", "list"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("No gaps found.");
    expect(res.stderr).toContain("--status weak");
  });

  it("renders the origin kind as a column under --output table", async () => {
    captureList();

    const res = await runCli(["gaps", "list", "--output", "table"]);

    expect(res.stdout).toContain("origin");
    expect(res.stdout).toContain("api_unanswered_question");
  });

  it("says nothing on stderr under --quiet", async () => {
    captureList();

    const res = await runCli(["--quiet", "gaps", "list"]);

    expect(res.stdout).toContain(GAP_ID);
    expect(res.stderr).not.toContain("Showing");
  });
});

/**
 * The guidance, under `--output json`.
 *
 * This is the single most important group in this file. `--output json` implies
 * `--quiet`, every published Senso skill passes it, and all of the guidance
 * below used to be written with `log.hint` — so the caller it was written for
 * was the one caller who could never see it.
 */
describe("gaps list, the guidance a JSON caller gets", () => {
  it("says weak gaps are hidden when the default view comes back empty", async () => {
    // `{"gaps":[],"total":0}` reads as "no work to do". The organization may
    // have dozens of weak gaps that the default filter hides, and the agent
    // that stops here never finds out.
    captureList({ gaps: [], total: 0, limit: 50, offset: 0 });

    const res = await runCli(["gaps", "list", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toBe("");
    const env = envelope(res);
    expect(env.next).toContainEqual(
      expect.objectContaining({ command: "senso gaps list --status weak" }),
    );
    expect(env.next).toContainEqual(
      expect.objectContaining({ command: "senso gaps list --status all" }),
    );
    // And the reason, not only the command: "why" is what lets an agent decide
    // whether to run it.
    expect(env.next?.map((n) => n.why).join(" ")).toContain("weak");
  });

  it("does not blame the default filter when the caller chose the statuses", async () => {
    // An explicit --status that matches nothing means the filters are wrong,
    // not that something is hidden, and suggesting `--status weak` to a caller
    // who just asked for `--status weak` is noise.
    captureList({ gaps: [], total: 0, limit: 50, offset: 0 });

    const res = await runCli(["gaps", "list", "--status", "weak", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(envelope(res).next ?? []).not.toContainEqual(
      expect.objectContaining({ command: "senso gaps list --status weak" }),
    );
  });

  it("names the first gap's id in next when there is something to read", async () => {
    captureList();

    const res = await runCli(["gaps", "list", "--output", "json"]);

    expect(envelope(res).next).toContainEqual(
      expect.objectContaining({ command: `senso gaps get ${GAP_ID}` }),
    );
  });

  it("carries the paging position and a runnable next page in page", async () => {
    // The `Showing 1–1 of 7` line and the next-page command are stderr-only, so
    // a JSON caller reads them off `page` instead.
    captureList();

    const res = await runCli(["gaps", "list", "--output", "json"]);

    expect(envelope(res).page).toMatchObject({
      offset: 0,
      limit: 1,
      returned: 1,
      total: 7,
      has_more: true,
    });
    expect(envelope(res).page?.next).toContain("--offset 1");
  });
});

describe("gaps get, what it prints", () => {
  it("shows the evidence and ends with the commands to act on an API search gap", async () => {
    serveDetail(DETAIL);

    const res = await runCli(["gaps", "get", GAP_ID]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("12 candidates before the relevance filter, 0 after");
    expect(res.stdout).toContain(
      "a search through the API, the MCP server or the CLI found nothing",
    );
    expect(res.stderr).toContain("What you can do");
    expect(res.stderr).toContain("senso kb create-raw");
    expect(res.stderr).toContain(`senso gaps answer ${GAP_ID} --content-id`);
    expect(res.stderr).toContain("--no-gap-signals");
    // A near miss: something matched and scored below the bar.
    expect(res.stderr).toContain('senso search context "Do you offer an annual plan?"');
  });

  it("keeps the guidance out of the payload under --output json", async () => {
    serveDetail(DETAIL);

    const res = await runCli(["gaps", "get", GAP_ID, "--output", "json"]);

    // `data` is the API's response, unmodified: the guidance rides beside it.
    expect(res.data()).toEqual(DETAIL);
    expect(res.stderr).toBe("");
  });

  it("carries the same commands in next that plain writes to stderr", async () => {
    // The commands below are the whole product of `gaps get`, and they used to
    // exist only as `log.hint` lines — invisible to every caller that passed
    // --output json, which is every published Senso skill.
    serveDetail(DETAIL);

    const res = await runCli(["gaps", "get", GAP_ID, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    const commands = (envelope(res).next ?? []).map((n) => n.command).join("\n");
    expect(commands).toContain("senso kb create-raw");
    expect(commands).toContain(`senso gaps answer ${GAP_ID} --content-id`);
    // A near miss — 12 candidates, 0 after the filter — so improving a document
    // may be enough, and that is a different command from writing a new one.
    expect(commands).toContain('senso search context "Do you offer an annual plan?"');
    // Every command names this gap rather than a placeholder.
    expect(envelope(res).next?.every((n) => n.why.length > 0)).toBe(true);
  });

  it("carries what cannot be run as warnings, not as commands", async () => {
    // "This came from an API search" is a fact, not an act. Mixing it into
    // `next` would hand an agent a line it cannot execute.
    serveDetail(DETAIL);

    const res = await runCli(["gaps", "get", GAP_ID, "--output", "json"]);

    expect(envelope(res).warnings?.join(" ")).toContain(
      "a search through the API, the MCP server or the CLI",
    );
  });

  it("tells a JSON caller a closed gap needs nothing, and how to retract the fix", async () => {
    serveDetail({
      ...DETAIL,
      gap: { ...API_GAP, status: "addressed" },
      resolutions: [
        {
          resolution_id: RESOLUTION_ID,
          resolution_type: "answered",
          created_at: "2026-09-14T13:00:00Z",
        },
      ],
    });

    const res = await runCli(["gaps", "get", GAP_ID, "--output", "json"]);

    const env = envelope(res);
    expect(env.warnings?.join(" ")).toContain("Nothing to do unless the fix was wrong");
    expect(env.next).toEqual([
      expect.objectContaining({ command: `senso gaps undo ${GAP_ID} ${RESOLUTION_ID}` }),
    ]);
  });

  it("says a weak gap is hidden, in the envelope as well as on stderr", async () => {
    serveDetail({ ...DETAIL, gap: { ...API_GAP, status: "weak", occurrence_count: 1 } });

    const res = await runCli(["gaps", "get", GAP_ID, "--output", "json"]);

    expect(envelope(res).warnings?.join(" ")).toContain("hidden from the default list");
  });

  it("names the contradicting document in the ruling command for a conflict", async () => {
    serveDetail({
      ...DETAIL,
      gap: {
        ...API_GAP,
        kind: "conflict",
        problem: "conflict",
        contradicting_content_id: CONTENT_ID,
        contradicting_content_title: "Pricing",
        origin: { ...API_GAP.origin, kind: "claim", surface: "content" },
      },
      lead_evidence: {},
    });

    const res = await runCli(["gaps", "get", GAP_ID]);

    expect(res.stdout).toContain(`Pricing (content_id: ${CONTENT_ID})`);
    expect(res.stderr).toContain(`--type ruled_claim_correct --authority-content-id ${CONTENT_ID}`);
    expect(res.stderr).toContain("--type ruled_kb_correct");
  });

  it("offers the undo command, with the real resolution id, for a closed gap", async () => {
    serveDetail({
      ...DETAIL,
      gap: { ...API_GAP, status: "dismissed" },
      resolutions: [
        {
          resolution_id: RESOLUTION_ID,
          resolution_type: "dismissed",
          created_at: "2026-09-14T13:00:00Z",
        },
      ],
    });

    const res = await runCli(["gaps", "get", GAP_ID]);

    expect(res.stdout).toContain(`resolution_id: ${RESOLUTION_ID}`);
    expect(res.stderr).toContain(`senso gaps undo ${GAP_ID} ${RESOLUTION_ID}`);
    expect(res.stderr).not.toContain("kb create-raw");
  });
});

describe("gaps resolve, answer and dismiss, on the wire", () => {
  it("maps every resolve flag onto its snake_case field", async () => {
    const seen = captureResolution();

    const res = await runCli([
      "gaps",
      "resolve",
      GAP_ID,
      "--type",
      "ruled_claim_correct",
      "--authority-content-id",
      CONTENT_ID,
      "--ruling-side",
      "claim",
      "--notes",
      "The pricing page is stale",
    ]);

    expect(res.exitCode).toBe(0);
    expect(seen.body).toEqual({
      resolution_type: "ruled_claim_correct",
      authority_content_id: CONTENT_ID,
      ruling_side: "claim",
      notes: "The pricing page is stale",
    });
  });

  it("records answered with the content that answers it", async () => {
    const seen = captureResolution();

    await runCli(["gaps", "answer", GAP_ID, "--content-id", CONTENT_ID]);

    expect(seen.body).toEqual({ resolution_type: "answered", produced_content_id: CONTENT_ID });
  });

  it("records content_updated when an existing document was improved", async () => {
    const seen = captureResolution();

    await runCli(["gaps", "answer", GAP_ID, "--content-id", CONTENT_ID, "--updated"]);

    expect(seen.body).toMatchObject({ resolution_type: "content_updated" });
  });

  it("records dismissed, with the reason", async () => {
    const seen = captureResolution();

    await runCli(["gaps", "dismiss", GAP_ID, "--notes", "probe traffic"]);

    expect(seen.body).toEqual({ resolution_type: "dismissed", notes: "probe traffic" });
  });

  it("says what the gap now is and how to undo it, on stderr, and prints the resolution on stdout", async () => {
    captureResolution();

    const res = await runCli(["gaps", "answer", GAP_ID, "--content-id", CONTENT_ID]);

    expect(res.stderr).toContain("The gap is now addressed");
    expect(res.stderr).toContain(`senso gaps undo ${GAP_ID} ${RESOLUTION_ID}`);
    expect(res.stdout).toContain(RESOLUTION_ID);
    expect(res.stdout).not.toContain("undo");
  });

  it("says the status does not move for a ruling that still needs a document updated", async () => {
    captureResolution();

    const res = await runCli([
      "gaps",
      "resolve",
      GAP_ID,
      "--type",
      "ruled_document",
      "--authority-content-id",
      CONTENT_ID,
    ]);

    expect(res.stderr).toContain("does not change until the follow-up is recorded");
  });

  it("prints only the resolution under --output json", async () => {
    captureResolution();

    const res = await runCli(["gaps", "dismiss", GAP_ID, "--output", "json"]);

    expect(res.data()).toEqual(SAVED);
    expect(res.stderr).toBe("");
  });

  it("tells a JSON caller what the gap now is, and how to undo it", async () => {
    captureResolution();

    const res = await runCli(["gaps", "dismiss", GAP_ID, "--output", "json"]);

    const env = envelope(res);
    expect(env.warnings?.join(" ")).toContain("The gap is now dismissed");
    expect(env.warnings?.join(" ")).toContain(
      "stays closed even if the same question is asked again",
    );
    expect(env.next).toContainEqual(
      expect.objectContaining({ command: `senso gaps undo ${GAP_ID} ${RESOLUTION_ID}` }),
    );
  });

  it("warns that the API does not check the content id it was handed", async () => {
    // A well-formed id belonging to nothing, or to another organization, still
    // moves the gap to addressed. It is the one way this command can quietly do
    // the wrong thing, and under --output json a stderr caveat reaches nobody.
    captureResolution();

    const res = await runCli([
      "gaps",
      "answer",
      GAP_ID,
      "--content-id",
      CONTENT_ID,
      "--output",
      "json",
    ]);

    expect(envelope(res).warnings?.join(" ")).toContain("does not verify content ids");
    expect(envelope(res).warnings?.join(" ")).toContain(CONTENT_ID);
  });
});

describe("gaps undo, on the wire", () => {
  it("deletes the resolution and confirms with a parseable object under --output json", async () => {
    let path: string | undefined;
    server.use(
      http.delete(apiUrl(`/org/gaps/${GAP_ID}/resolutions/${RESOLUTION_ID}`), ({ request }) => {
        path = new URL(request.url).pathname;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const res = await runCli(["gaps", "undo", GAP_ID, RESOLUTION_ID, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(path).toBe(`/api/v1/org/gaps/${GAP_ID}/resolutions/${RESOLUTION_ID}`);
    // Named fields rather than `{ ok: true }` and a sentence: the only way to
    // learn WHAT was undone used to be to parse English out of the message.
    expect(res.data()).toEqual({
      action: "undone",
      resource: "gap_resolution",
      id: RESOLUTION_ID,
      gap_id: GAP_ID,
    });
    // The API answers 204, so the new status is not in the payload — the
    // command that reads it has to travel in the envelope.
    expect(envelope(res).next).toEqual([
      expect.objectContaining({ command: `senso gaps get ${GAP_ID}` }),
    ]);
  });

  it("points at gaps get to read the recomputed status", async () => {
    server.use(
      http.delete(
        apiUrl(`/org/gaps/${GAP_ID}/resolutions/${RESOLUTION_ID}`),
        () => new HttpResponse(null, { status: 204 }),
      ),
    );

    const res = await runCli(["gaps", "undo", GAP_ID, RESOLUTION_ID]);

    expect(res.stdout).toBe("");
    expect(res.stderr).toContain(`senso gaps get ${GAP_ID}`);
  });
});

/**
 * The guidance per problem and status.
 *
 * This is what an agent acts on, so each branch is pinned to the command it
 * must name. A wrong suggestion here is worse than none: the agent runs it.
 */
describe("gaps get, the next steps for each kind of gap", () => {
  const gapWith = (over: Record<string, unknown>, evidence: Record<string, unknown> = {}) => ({
    ...DETAIL,
    gap: { ...API_GAP, ...over },
    lead_evidence: evidence,
  });

  it("offers we_dont_do_this and ruled_kb_correct for a claim nothing backs", async () => {
    serveDetail(
      gapWith(
        {
          problem: "no_source",
          origin: { ...API_GAP.origin, kind: "claim", surface: "question_run" },
        },
        {
          quote: "Plans are billed monthly.",
          reasoning: "No document mentions an annual plan.",
          suggested_fix: "Add the plan terms.",
          searches: [{ query: "annual plan", result_count: 0 }],
          evidence: [{ content_id: CONTENT_ID, title: "Pricing", relation: "related" }],
        },
      ),
    );

    const res = await runCli(["gaps", "get", GAP_ID]);

    expect(res.stdout).toContain("Knowledge base quote: Plans are billed monthly.");
    expect(res.stdout).toContain("Reasoning: No document mentions an annual plan.");
    expect(res.stdout).toContain('Searched: "annual plan" (0 results)');
    expect(res.stdout).toContain(`Weighed: Pricing — related (content_id: ${CONTENT_ID})`);
    expect(res.stderr).toContain(`senso gaps resolve ${GAP_ID} --type we_dont_do_this`);
    expect(res.stderr).toContain("--type ruled_kb_correct");
    expect(res.stderr).not.toContain("--no-gap-signals");
  });

  it("asks for the feedback to be read first, and offers source_irrelevant, for a flagged answer", async () => {
    serveDetail(
      gapWith(
        {
          kind: "flagged",
          problem: "flagged",
          origin: { ...API_GAP.origin, kind: "flagged_answer" },
        },
        {
          answer_text: "We only bill monthly.",
          sources: [
            {
              content_id: CONTENT_ID,
              kb_node_id: KB_NODE_ID,
              title: "Old pricing",
              available: true,
            },
          ],
          feedback: [{ user_name: "Dana", comment: "We have an annual plan now." }],
        },
      ),
    );

    const res = await runCli(["gaps", "get", GAP_ID]);

    expect(res.stdout).toContain("Feedback from Dana: We have an annual plan now.");
    expect(res.stdout).toContain(
      `Cited: Old pricing (kb_node_id: ${KB_NODE_ID}, content_id: ${CONTENT_ID})`,
    );
    expect(res.stderr).toContain("Read the feedback above first");
    expect(res.stderr).toContain("--type source_irrelevant --authority-content-id");
    expect(res.stderr).toContain("--type not_relevant");
  });

  it("asks which document is right when two documents disagree", async () => {
    serveDetail(
      gapWith({
        kind: "kb_conflict",
        problem: "conflict",
        origin: { ...API_GAP.origin, kind: "claim", surface: "content" },
      }),
    );

    const res = await runCli(["gaps", "get", GAP_ID]);

    expect(res.stderr).toContain("--type ruled_document --authority-content-id");
    expect(res.stderr).not.toContain("ruled_claim_correct");
  });

  it("suggests improving a document the search already found, by its kb_node_id", async () => {
    serveDetail(
      gapWith(
        { origin: { ...API_GAP.origin, kind: "documents_didnt_answer", surface: "search_turn" } },
        {
          sources: [
            { content_id: CONTENT_ID, kb_node_id: KB_NODE_ID, title: "Plans", available: true },
          ],
        },
      ),
    );

    const res = await runCli(["gaps", "get", GAP_ID]);

    expect(res.stderr).toContain(`senso kb update-raw ${KB_NODE_ID}`);
    expect(res.stderr).toContain(`--content-id ${CONTENT_ID} --updated`);
    expect(res.stderr).toContain(`senso gaps dismiss ${GAP_ID}`);
  });

  it("says a weak gap is hidden and opens if seen again, and still offers the fix", async () => {
    serveDetail(gapWith({ status: "weak", occurrence_count: 1 }));

    const res = await runCli(["gaps", "get", GAP_ID]);

    expect(res.stderr).toContain("Seen once");
    expect(res.stderr).toContain("senso kb create-raw");
  });

  it("says there is nothing to do for an addressed gap unless the fix was wrong", async () => {
    serveDetail({
      ...gapWith({ status: "addressed" }),
      resolutions: [
        {
          resolution_id: RESOLUTION_ID,
          resolution_type: "answered",
          created_at: "2026-09-14T13:00:00Z",
        },
      ],
    });

    const res = await runCli(["gaps", "get", GAP_ID]);

    expect(res.stderr).toContain("Nothing to do unless the fix was wrong");
    expect(res.stderr).toContain(`senso gaps undo ${GAP_ID} ${RESOLUTION_ID}`);
    expect(res.stderr).not.toContain("kb create-raw");
  });

  it("says a gap resolved by evidence has no decision to undo", async () => {
    serveDetail(gapWith({ status: "resolved" }));

    const res = await runCli(["gaps", "get", GAP_ID]);

    expect(res.stderr).toContain("closed by evidence");
    expect(res.stderr).not.toContain("gaps undo");
  });

  it("names a document the evaluator only suggested as unverified", async () => {
    serveDetail(
      gapWith({
        problem: "no_source",
        suggested_content_id: CONTENT_ID,
        suggested_content_title: "Plans",
        tags: [{ tag_id: TAG_ID, name: "pricing", curated: false }],
        assigned_user_name: "Dana",
      }),
    );

    const res = await runCli(["gaps", "get", GAP_ID]);

    expect(res.stdout).toContain("an unverified hint from the evaluator");
    expect(res.stdout).toContain("pricing");
    expect(res.stdout).toContain("Dana");
  });
});
