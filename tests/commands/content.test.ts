/**
 * Command layer: `senso content`, including the nested `content tags` group.
 *
 * This is the largest CRUD group in the CLI, and the one where a quietly
 * renamed parameter would do the most damage. What is worth protecting here:
 *
 *   - `content list` does not hit `/org/content` at all — it reads
 *     `/org/kb/my-files` and projects the KB node shape into its own columns.
 *     That indirection is invisible from the command line, so it is pinned on
 *     the wire, and the projection is pinned in all three formats.
 *   - The group mixes three id spaces — content_id, version_id and
 *     publish_record_id — and each is a 36-character hex string. Every one of
 *     them is checked before the request, so a wrong id costs exit 2 rather
 *     than a round trip and an opaque server error.
 *   - Half of this group writes: delete, unpublish, reject, restore, owners and
 *     tags all take a different method or a different path depending on the
 *     flags they were given. Those branches are asserted as requests, because
 *     the wrong one succeeds silently and destroys the wrong thing.
 *   - Two of those writes are destructive when they are misread. `unpublish`
 *     must report what the API says it retracted rather than what was asked
 *     for, and a malformed --publish-record-ids must never reach the API, which
 *     discards its own bind error and then unpublishes EVERYWHERE. `tags set`
 *     with no flags must be refused rather than clearing every tag.
 *
 * Every fixture is shaped like the DTOs in senso-api: content_dto.go,
 * content_verification_dto.go, content_provenance_dto.go, kb_node_dto.go,
 * tag.go and app_dto.go. A fixture that invents a field name is how a blank
 * column ships green.
 *
 * Failure branches come first, as in tests/commands/roles.test.ts.
 */

import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server, TEST_API_KEY } from "../setup.js";
import { apiUrl, envelope, errorEnvelope, runCli } from "../helpers.js";

const ORG_ID = "a1b2c3d4-e5f6-4071-8293-a4b5c6d7e8f9";
const CONTENT_ID = "9d7e1c40-5b3a-4c22-8f16-0a3b7e5d2c81";
const CONTENT_ID_2 = "1f2e3d4c-5b6a-4978-8867-564534231201";
const VERSION_ID = "4c6b8e02-7f31-4a95-b0d3-8e1f2a5c7d94";
const VERSION_ID_2 = "8e9f0a1b-2c3d-4e5f-9a0b-1c2d3e4f5a6b";
const PUBLISH_RECORD_ID = "2b7f0c93-41a8-4d6e-9f52-7c8a1e3b0d45";
const PUBLISH_RECORD_ID_2 = "7d1e4b5a-9c02-4f38-a6b1-3e9c8d2f4a07";
const PUBLISH_RECORD_ID_3 = "e4f5a6b7-c8d9-4e0f-9a1b-2c3d4e5f6a7b";
const PUBLISHER_ID = "0a9b8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d";
const USER_ID = "c3d4e5f6-7a8b-4c9d-8e0f-1a2b3c4d5e6f";
const USER_ID_2 = "b2c3d4e5-6f7a-4b8c-9d0e-1f2a3b4c5d6e";
const TAG_ID = "5e2a7b91-6c04-4d3f-9a18-b2c7e4f01d65";
const TAG_ID_2 = "3c1d5f82-7a06-4b9e-8d51-c4a2f6e09b73";
const CTA_ID = "b7e2c1d0-3f4a-4b5c-9d6e-7f8a9b0c1d2e";
const KB_NODE_ID = "0f1e2d3c-4b5a-4968-8776-655443322110";
const KB_NODE_ID_2 = "11223344-5566-4778-8899-aabbccddeeff";
const CLIENT_EVENT_ID = "b1c2d3e4-f5a6-4071-8293-a4b5c6d7e8f9";

/** dto.TagResponse. The tag's own id field is `id`, not `tag_id`. */
const TAG = {
  id: TAG_ID,
  org_id: ORG_ID,
  name: "crm",
  curated: true,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

/**
 * dto.KBNodeListResponse. processing_status lives on the NESTED content object;
 * the top level has never carried one, which is the projection bug this group's
 * table rendering was written to fix.
 */
const KB_FILES = {
  nodes: [
    {
      kb_node_id: KB_NODE_ID,
      org_id: ORG_ID,
      parent_id: null,
      content_id: CONTENT_ID,
      type: "file",
      name: "Pricing page",
      content: {
        id: CONTENT_ID,
        type: "raw",
        content_type: "text/markdown",
        title: "Pricing page",
        version_num: 2,
        processing_status: "complete",
      },
      tags: [TAG],
      is_public: false,
      is_public_root: false,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
    },
    {
      kb_node_id: KB_NODE_ID_2,
      org_id: ORG_ID,
      parent_id: null,
      type: "folder",
      name: "Onboarding",
      tags: [],
      is_public: false,
      is_public_root: false,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
    },
  ],
  total: 2,
  limit: 10,
  offset: 0,
};

/** dto.ContentDetailResponse. The primary key is `id`, not `content_id`. */
const ONE_CONTENT = {
  id: CONTENT_ID,
  org_id: ORG_ID,
  type: "raw",
  title: "Best CRMs for startups",
  summary: "A comparison of five CRMs for teams under twenty people.",
  org_tags: [TAG],
  version_num: 3,
  editorial_status: "published",
  content_type: "text/markdown",
  text: "## Best CRMs for startups\n\nThe short answer is…",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-05T00:00:00Z",
  uploaded_by: {
    actor_type: "user",
    user_id: USER_ID,
    email: "casey@example.com",
    given_name: "Casey",
    family_name: "Lin",
  },
};

/** dto.ContentVerificationListResponse, with a live row and a draft row. */
const VERIFICATION = {
  items: [
    {
      content_id: CONTENT_ID,
      version_id: VERSION_ID,
      title: "Best CRMs for startups",
      summary: "A comparison of five CRMs.",
      editorial_status: "published",
      generated_at: "2026-01-01T00:00:00Z",
      published_at: "2026-01-02T00:00:00Z",
      ever_published: true,
      manually_marked_published: false,
      citation_rate: 0.42,
      raw_citations: 17,
      tracked_url_count: 1,
      geo_question_id: null,
      question_text: null,
      question_type: null,
      owners: [
        { user_id: USER_ID, email: "casey@example.com", given_name: "Casey", family_name: "Lin" },
      ],
      org_tags: [TAG],
      destinations: [
        {
          publish_record_id: PUBLISH_RECORD_ID,
          publisher_id: PUBLISHER_ID,
          publisher_name: "Company Blog",
          publisher_slug: "company-blog",
          publisher_type: "citeables",
          publisher_scope: "org",
          state: "live",
          external_url: "https://acme.example/best-crms",
          last_attempt_at: "2026-01-02T00:00:00Z",
        },
      ],
      cta_selection: { selection_type: "template", cta_id: CTA_ID },
    },
    {
      content_id: CONTENT_ID_2,
      version_id: VERSION_ID_2,
      title: "CRM pricing compared",
      editorial_status: "draft",
      generated_at: "2026-01-03T00:00:00Z",
      ever_published: false,
      manually_marked_published: false,
      raw_citations: 0,
      tracked_url_count: 0,
      geo_question_id: null,
      question_text: null,
      question_type: null,
      owners: [],
      org_tags: [],
      destinations: [],
    },
  ],
  total_count: 2,
  draft_count: 1,
  rejected_count: 0,
  pending_published_draft_count: 0,
  limit: 10,
  offset: 0,
};

/** dto.ContentVerificationCountsResponse. */
const COUNTS = {
  draft_count: 4,
  published_count: 12,
  rejected_count: 1,
  pending_published_draft_count: 2,
  published_domain_summaries: [
    {
      publisher_id: PUBLISHER_ID,
      publisher_name: "Company Blog",
      external_url: "https://acme.example",
      item_count: 12,
      citation_rate: 0.31,
      citation_numerator: 31,
      citation_denominator: 100,
      citation_window_days: 30,
      citation_missing_days_excluded: false,
    },
  ],
};

/** dto.ContentVerificationVelocityResponse. */
const VELOCITY = {
  earliest_publish_at: "2026-01-02T00:00:00Z",
  first_citation_at: "2026-01-09T00:00:00Z",
  pages_with_citations: 4,
  avg_days_to_first_citation: 6.5,
  total_live_pages: 10,
  destinations: [
    {
      publisher_id: PUBLISHER_ID,
      publisher_name: "Company Blog",
      publisher_slug: "company-blog",
      total_live_pages: 10,
      earliest_publish_at: "2026-01-02T00:00:00Z",
      first_citation_at: "2026-01-09T00:00:00Z",
      pages_with_citations: 4,
      avg_days_to_first_citation: 6.5,
    },
  ],
};

/** dto.ContentVersionListResponse. */
const VERSIONS = {
  content_id: CONTENT_ID,
  versions: [
    {
      version_id: VERSION_ID,
      version_num: 3,
      title: "Best CRMs for startups",
      summary: "A comparison of five CRMs.",
      editorial_status: "published",
      is_current: true,
      created_at: "2026-01-05T00:00:00Z",
      updated_at: "2026-01-05T00:00:00Z",
    },
    {
      version_id: VERSION_ID_2,
      version_num: 2,
      title: "Best CRMs",
      editorial_status: "rejected",
      is_current: false,
      created_at: "2026-01-03T00:00:00Z",
      updated_at: "2026-01-04T00:00:00Z",
    },
  ],
};

/** GET /org/content/{id}/owners answers a bare array of dto.ContentOwnerResponse. */
const OWNERS = [
  { user_id: USER_ID, email: "casey@example.com", given_name: "Casey", family_name: "Lin" },
  { user_id: USER_ID_2, email: "rhee@example.com", given_name: "Rhee", family_name: "Park" },
];

/** GET /org/content/{id}/tags answers a bare array of dto.TagResponse. */
const TAGS = [TAG];

/** The provenance audit. Five stages, keyed by name rather than listed. */
const PROVENANCE = {
  published_url: "https://acme.example/best-crms",
  content_id: CONTENT_ID,
  content_version_id: VERSION_ID,
  creation_origin: "content_engine",
  overall_status: "partial",
  stages: {
    ingestion: {
      status: "complete",
      applicability: "applicable",
      source_link_basis: "receipt",
      what_can_be_proven: ["3 source versions were ingested by a named user"],
      missing_evidence: [],
    },
    source: {
      status: "partial",
      applicability: "applicable",
      what_can_be_proven: ["The formatted context was stored"],
      missing_evidence: ["No retrieval receipt for 1 of 4 chunks"],
    },
    creation: {
      status: "complete",
      applicability: "applicable",
      what_can_be_proven: ["The accepted generation attempt is recorded"],
      missing_evidence: [],
    },
    editing: {
      status: "missing",
      applicability: "not_applicable",
      what_can_be_proven: [],
      missing_evidence: ["No edit-telemetry events were recorded"],
    },
    publication: {
      status: "complete",
      applicability: "applicable",
      what_can_be_proven: ["One live publish record matches this URL"],
      missing_evidence: [],
    },
  },
};

/** dto.ContentCitationDetailsResponse. */
const CITATION_DETAILS = {
  content_id: CONTENT_ID,
  title: "Best CRMs for startups",
  date_range: { start_date: "2026-01-01", end_date: "2026-01-31" },
  models: ["chatgpt"],
  earliest_publish_at: "2026-01-02T00:00:00Z",
  first_citation_at: "2026-01-09T00:00:00Z",
  days_to_first_citation: 7,
  summary: {
    total_citations: 12,
    avg_sov: 0.21,
    mention_rate: 0.4,
    common_sentiment: "positive",
    prompt_run_count: 30,
    cited_run_count: 30,
    cited_mentioned_run_count: 12,
    cited_mention_total: 21,
    cited_brand_mention_total: 100,
  },
  destinations: [
    {
      publish_record_id: PUBLISH_RECORD_ID,
      publisher_name: "Company Blog",
      publisher_slug: "company-blog",
      state: "live",
      external_url: "https://acme.example/best-crms",
      first_published_at: "2026-01-02T00:00:00Z",
      first_citation_at: "2026-01-09T00:00:00Z",
      days_to_first_citation: 7,
      metrics: {
        total_citations: 12,
        avg_sov: 0.21,
        mention_rate: 0.4,
        common_sentiment: "positive",
        cited_run_count: 30,
        cited_mentioned_run_count: 12,
        cited_mention_total: 21,
        cited_brand_mention_total: 100,
      },
    },
  ],
  trend: [
    {
      date: "2026-01-09",
      total_citations: 3,
      total_prompt_runs: 10,
      by_destination: { [PUBLISH_RECORD_ID]: { times_cited: 3, prompt_runs: 10 } },
    },
  ],
};

/** dto.ContentCitationPromptsResponse. */
const CITATION_PROMPTS = {
  content_id: CONTENT_ID,
  date_range: { start_date: "2026-01-01", end_date: "2026-01-31" },
  models: ["chatgpt"],
  external_urls: ["https://acme.example/best-crms"],
  prompts: [
    {
      prompt: "best crm for a five person startup",
      prompt_funnel_stage: "consideration",
      model: "chatgpt",
      source_id: "company-blog",
      mention_rate: 0.4,
      avg_sov: 0.21,
      common_sentiment: "positive",
      eval_count: 10,
      citation_count: 4,
      citation_rate: 0.4,
      mention_rate_lift: 0.1,
      avg_sov_lift: 0.05,
    },
  ],
};

const VALID_EVENTS = `{"events":[{"event_type":"draft_saved","edit_source":"manual","client_event_id":"${CLIENT_EVENT_ID}"}]}`;

describe("content, when the request fails", () => {
  it("exits 3 and explains how to authenticate when there is no API key", async () => {
    const res = await runCli(["content", "list"], { withKey: false });

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("no API key found");
    expect(res.stderr).toContain("SENSO_API_KEY");
  });

  it("exits 3 when the API rejects the key", async () => {
    server.use(
      http.get(apiUrl("/org/kb/my-files"), () =>
        HttpResponse.json({ error: "invalid key" }, { status: 401 }),
      ),
    );

    const res = await runCli(["content", "list"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Authentication failed");
  });

  it("exits 3 and blames the plan when the organization lacks the GEO product", async () => {
    server.use(
      http.get(apiUrl("/org/content/verification"), () =>
        HttpResponse.json({ error: "GEO product required" }, { status: 403 }),
      ),
    );

    const res = await runCli(["content", "verification"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Permission denied");
    // A product entitlement is a billing question; widening the key cannot fix it.
    expect(res.stderr).toContain("does not have the product");
  });

  it("exits 4 naming the content item and where its id comes from", async () => {
    server.use(
      http.get(apiUrl("/org/content/:id"), () =>
        HttpResponse.json({ error: "Content not found" }, { status: 404 }),
      ),
    );

    const res = await runCli(["content", "get", CONTENT_ID, "--output", "json"]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");

    const { error } = errorEnvelope(res);
    expect(error.code).toBe("not_found");
    // "Not found." with no noun leaves a caller unable to tell a wrong id from
    // an id out of the wrong id space.
    expect(error.message).toContain(`Content ${CONTENT_ID}`);
    expect(error.field).toBe("content_id");
    expect(error.received).toBe(CONTENT_ID);
    expect(error.hint).toContain("senso content verification");
  });

  it("exits 4 naming the VERSION, not the content, when a reject misses", async () => {
    server.use(
      http.post(apiUrl("/org/content/versions/:versionId/reject"), () =>
        HttpResponse.json({ error: "Version not found" }, { status: 404 }),
      ),
    );

    const res = await runCli(["content", "reject", VERSION_ID, "--output", "json"]);

    expect(res.exitCode).toBe(4);
    const { error } = errorEnvelope(res);
    // A content_id passed here lands on exactly this error, so the message has
    // to say which of the two id spaces was expected.
    expect(error.message).toContain(`Content version ${VERSION_ID}`);
    expect(error.field).toBe("version_id");
    expect(error.hint).toContain("senso content versions");
  });

  it("exits 1 on a 500 and says retrying may work", async () => {
    server.use(
      http.delete(apiUrl("/org/content/:id"), () =>
        HttpResponse.json({ error: "boom" }, { status: 500 }),
      ),
    );

    const res = await runCli(["content", "delete", CONTENT_ID]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("server-side failure");
    expect(res.stderr).toContain("Retry shortly");
  });

  it("exits 1 on a 503 and says it is NOT a transient failure", async () => {
    // The opposite advice from a 500: an endpoint this deployment does not
    // offer will not start working because the caller waited.
    server.use(
      http.get(apiUrl("/org/content/verification/velocity"), () =>
        HttpResponse.json({ error: "Citation velocity is not enabled here" }, { status: 503 }),
      ),
    );

    const res = await runCli(["content", "verification-velocity"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("not a transient failure");
    expect(res.stderr).not.toContain("Retry shortly");
  });

  it("exits 5 when the API rate-limits the caller", async () => {
    server.use(http.get(apiUrl("/org/kb/my-files"), () => new HttpResponse(null, { status: 429 })));

    const res = await runCli(["content", "list"]);

    expect(res.exitCode).toBe(5);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Rate limited");
  });

  it("reports a malformed body rather than throwing a parse error at the user", async () => {
    server.use(http.get(apiUrl("/org/kb/my-files"), () => new HttpResponse("<html>nope</html>")));

    const res = await runCli(["content", "list"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Invalid JSON response");
  });

  it("writes the failure envelope to stderr, leaving stdout empty, under --output json", async () => {
    server.use(
      http.get(apiUrl("/org/content/:id"), () =>
        HttpResponse.json({ error: "nope" }, { status: 403 }),
      ),
    );

    const res = await runCli(["content", "get", CONTENT_ID, "--output", "json"]);

    expect(res.exitCode).toBe(3);
    // The important half: a caller redirecting stdout to a file gets an empty
    // file, not a file containing an error object it would later read as data.
    expect(res.stdout).toBe("");

    const reported = errorEnvelope(res);
    expect(reported.ok).toBe(false);
    expect(reported.command).toBe("content get");
    expect(reported.error).toMatchObject({ code: "forbidden", status: 403 });
    expect(reported.error.request).toEqual({ method: "GET", path: `/org/content/${CONTENT_ID}` });
  });
});

describe("content, when an id is from the wrong id space", () => {
  // No handler is registered in this block: setup.ts fails any request that
  // reaches the network, so each of these also proves nothing was sent.
  it("exits 2 naming <id> when the content id is not a UUID", async () => {
    const res = await runCli(["content", "get", "c-1", "--output", "json"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");

    const { error } = errorEnvelope(res);
    expect(error.code).toBe("usage");
    expect(error.field).toBe("<id>");
    expect(error.received).toBe("c-1");
    expect(error.hint).toContain("senso content verification");
  });

  it("exits 2 naming <versionId> when restore is handed something that is not a UUID", async () => {
    const res = await runCli(["content", "restore", "v-1", "--output", "json"]);

    expect(res.exitCode).toBe(2);
    const { error } = errorEnvelope(res);
    expect(error.field).toBe("<versionId>");
    expect(error.hint).toContain("Content version ids");
  });

  it("exits 2 naming <userId>, not <id>, when only the second argument is wrong", async () => {
    const res = await runCli(["content", "remove-owner", CONTENT_ID, "u-2", "--output", "json"]);

    expect(res.exitCode).toBe(2);
    const { error } = errorEnvelope(res);
    expect(error.field).toBe("<userId>");
    expect(error.received).toBe("u-2");
  });

  it("names every malformed --user-ids value at once, not just the first", async () => {
    // Reporting one at a time makes fixing a batch of a hundred a hundred runs.
    const res = await runCli([
      "content",
      "set-owners",
      CONTENT_ID,
      "--user-ids",
      "u-1",
      USER_ID,
      "u-3",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    const { error } = errorEnvelope(res);
    expect(error.field).toBe("--user-ids");
    expect(error.received).toBe("u-1, u-3");
  });

  it("exits 2 when a --tag-ids value is not a UUID", async () => {
    const res = await runCli([
      "content",
      "verification",
      "--tag-ids",
      `${TAG_ID},not-a-uuid`,
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    const { error } = errorEnvelope(res);
    expect(error.field).toBe("--ids");
    expect(error.received).toBe("not-a-uuid");
  });
});

describe("content, when the command line is wrong", () => {
  it("exits 2 when tags add is given neither --name nor --id", async () => {
    const res = await runCli(["content", "tags", "add", CONTENT_ID]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Provide --name or --id");
  });

  it("exits 2 when tags add is given both --name and --id", async () => {
    // buildAttachTagBody prefers --id and drops the name silently, so the
    // choice is not something to guess at.
    const res = await runCli([
      "content",
      "tags",
      "add",
      CONTENT_ID,
      "--name",
      "crm",
      "--id",
      TAG_ID,
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("not both");
  });

  it("exits 2 when tags remove is given neither --name nor --id", async () => {
    const res = await runCli(["content", "tags", "remove", CONTENT_ID]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Provide --name or --id");
  });

  it("exits 2 when set-owners is missing its required --user-ids", async () => {
    const res = await runCli(["content", "set-owners", CONTENT_ID]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
  });

  it("exits 2 on a flag the group does not define", async () => {
    const res = await runCli(["content", "verification", "--order", "created_at"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
  });

  it("names the valid formats when --output is not one of them", async () => {
    const res = await runCli(["content", "list", "--output", "yaml"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("json, table, plain");
  });

  it("exits 2 on an unrecognized --status, naming the valid values", async () => {
    const res = await runCli([
      "content",
      "verification",
      "--status",
      "nonsense",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");

    const { error } = errorEnvelope(res);
    expect(error.message).toContain('Invalid --status: "nonsense"');
    expect(error.allowed).toEqual(["all", "draft", "review", "rejected", "published"]);
  });

  it("exits 2 on an unrecognized --substatus", async () => {
    const res = await runCli([
      "content",
      "verification",
      "--status",
      "published",
      "--substatus",
      "nonsense",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    const { error } = errorEnvelope(res);
    expect(error.allowed).toEqual(["pending_draft", "unpublished"]);
  });

  it("exits 2 when --substatus narrows a status it does not belong to", async () => {
    // The API answers this with a 400 after a round trip; the pairing is
    // knowable here.
    const res = await runCli([
      "content",
      "verification",
      "--status",
      "draft",
      "--substatus",
      "pending_draft",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    const { error } = errorEnvelope(res);
    expect(error.field).toBe("--substatus");
    expect(error.hint).toContain("--status published --substatus pending_draft");
  });

  it("exits 2 rather than clamping a --limit past the API's ceiling", async () => {
    const res = await runCli(["content", "verification", "--limit", "500"]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("out of range");
  });

  it("exits 2 when a citation date is not YYYY-MM-DD", async () => {
    const res = await runCli([
      "content",
      "citation-details",
      CONTENT_ID,
      "--start-date",
      "01/02/2026",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    const { error } = errorEnvelope(res);
    expect(error.field).toBe("--start-date");
  });

  it("exits 2 when --start-date is after --end-date, which returns nothing", async () => {
    const res = await runCli([
      "content",
      "citation-prompts",
      CONTENT_ID,
      "--start-date",
      "2026-02-01",
      "--end-date",
      "2026-01-01",
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("is after");
  });

  it("exits 2 when provenance is asked for without a URL", async () => {
    const res = await runCli(["content", "provenance"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
  });

  it("exits 2 when --url is not an http or https URL, since the match is exact", async () => {
    const res = await runCli([
      "content",
      "provenance",
      "--url",
      "ftp://example.com/post",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    const { error } = errorEnvelope(res);
    expect(error.field).toBe("--url");
    expect(error.received).toBe("ftp://example.com/post");
  });
});

describe("content unpublish, so that a partial retraction cannot read as success", () => {
  it("exits 2 before the request when a --publish-record-ids value is not a UUID", async () => {
    // The API binds this body with ShouldBindJSON and DISCARDS the error, so a
    // list it cannot parse is read as no list at all — and the content is then
    // unpublished from EVERY destination and answered 204. No handler is
    // registered here, so this also proves the request was never made.
    const res = await runCli([
      "content",
      "unpublish",
      CONTENT_ID,
      "--publish-record-ids",
      PUBLISH_RECORD_ID,
      "pr-2",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");

    const { error } = errorEnvelope(res);
    expect(error.code).toBe("usage");
    expect(error.field).toBe("--publish-record-ids");
    expect(error.received).toBe("pr-2");
    expect(error.hint).toContain("senso content verification --status published");
  });

  it("exits 1 when the API retracted nothing and the destinations are still live", async () => {
    // unpublished_count 0 with three failures is a failure. Reporting the
    // number of ids REQUESTED here would read as a complete success.
    server.use(
      http.post(apiUrl("/org/content/:id/unpublish"), () =>
        HttpResponse.json({
          unpublished_count: 0,
          failures: ["company-blog: 502", "docs: 502", "help: 502"],
        }),
      ),
    );

    const res = await runCli([
      "content",
      "unpublish",
      CONTENT_ID,
      "--publish-record-ids",
      PUBLISH_RECORD_ID,
      PUBLISH_RECORD_ID_2,
      PUBLISH_RECORD_ID_3,
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");

    const { error } = errorEnvelope(res);
    expect(error.message).toContain("Unpublished 0 of 3 requested");
    expect(error.message).toContain("3 destination(s) are still live");
    expect(error.details).toMatchObject({ unpublished_count: 0 });
    expect(error.hint).toContain("senso publish-records retry");
  });

  it("reports the count the API returned, not the number of ids that were sent", async () => {
    server.use(
      http.post(apiUrl("/org/content/:id/unpublish"), () =>
        HttpResponse.json({ unpublished_count: 1, failures: [] }),
      ),
    );

    const res = await runCli([
      "content",
      "unpublish",
      CONTENT_ID,
      "--publish-record-ids",
      PUBLISH_RECORD_ID,
      PUBLISH_RECORD_ID_2,
      PUBLISH_RECORD_ID_3,
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain("Unpublished 1 of 3 requested publish record(s)");
    expect(res.stderr).not.toContain("Unpublished 3");
  });

  it("puts the API's own counts on stdout under --output json", async () => {
    server.use(
      http.post(apiUrl("/org/content/:id/unpublish"), () =>
        HttpResponse.json({ unpublished_count: 2, failures: [] }),
      ),
    );

    const res = await runCli([
      "content",
      "unpublish",
      CONTENT_ID,
      "--publish-record-ids",
      PUBLISH_RECORD_ID,
      PUBLISH_RECORD_ID_2,
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual({ unpublished_count: 2, failures: [] });
    expect(envelope(res).next?.[0]?.command).toBe("senso content verification --status published");
    expect(res.stderr).toBe("");
  });

  it("treats the 204 of the unpublish-everywhere form as the full success it is", async () => {
    server.use(
      http.post(
        apiUrl("/org/content/:id/unpublish"),
        () => new HttpResponse(null, { status: 204 }),
      ),
    );

    const res = await runCli(["content", "unpublish", CONTENT_ID, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual({
      action: "unpublished",
      resource: "content",
      id: CONTENT_ID,
    });
  });
});

describe("content, when the id belongs to a knowledge base document", () => {
  /** What rejectKBContent answers for a KB document on /org/content/{id}. */
  const kbRefusal = () =>
    HttpResponse.json(
      { error: "Knowledge base content must be accessed through KB node endpoints" },
      { status: 400 },
    );

  it("exits 2 and names the kb command, rather than passing a 400 through", async () => {
    // The id it refuses is a perfectly valid content_id, just from the other
    // half of the system. Passed through unchanged, the 400 reads as a bug in
    // the command rather than as "you reached for the wrong one".
    server.use(http.get(apiUrl("/org/content/:id"), kbRefusal));

    const res = await runCli(["content", "get", CONTENT_ID, "--output", "json"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");

    const { error } = errorEnvelope(res);
    expect(error.code).toBe("usage");
    expect(error.status).toBe(400);
    expect(error.field).toBe("<id>");
    expect(error.received).toBe(CONTENT_ID);
    expect(error.message).toContain("knowledge base document");
    expect(error.hint).toContain("senso kb get <kb_node_id>");
    expect(error.hint).toContain("senso kb content <kb_node_id>");
    // The API's own sentence is kept, in the machine-readable half.
    expect(error.details).toMatchObject({
      api_message: "Knowledge base content must be accessed through KB node endpoints",
    });
  });

  it("names `senso kb delete` instead when it was a delete that was refused", async () => {
    server.use(http.delete(apiUrl("/org/content/:id"), kbRefusal));

    const res = await runCli(["content", "delete", CONTENT_ID, "--output", "json"]);

    expect(res.exitCode).toBe(2);
    expect(errorEnvelope(res).error.hint).toContain("senso kb delete <kb_node_id>");
  });

  it("still passes an unrelated 400 through as a server refusal, not a usage error", async () => {
    server.use(
      http.get(apiUrl("/org/content/:id"), () =>
        HttpResponse.json({ error: "Invalid content ID" }, { status: 400 }),
      ),
    );

    const res = await runCli(["content", "get", CONTENT_ID, "--output", "json"]);

    expect(res.exitCode).toBe(1);
    expect(errorEnvelope(res).error.code).toBe("validation");
  });
});

describe("content tags set, which replaces the whole collection", () => {
  it("exits 2 when no list is given, rather than silently detaching every tag", async () => {
    // The API reads an empty body as "replace with nothing" and applies it
    // without complaint, so a forgotten flag used to clear the collection. No
    // handler is registered: nothing may reach the network here.
    const res = await runCli(["content", "tags", "set", CONTENT_ID, "--output", "json"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");

    const { error } = errorEnvelope(res);
    expect(error.code).toBe("usage");
    expect(error.message).toContain("would remove every tag");
    expect(error.hint).toContain(`senso content tags set ${CONTENT_ID} --clear`);
  });

  it("exits 2 when --clear is combined with a list, which cannot both be meant", async () => {
    const res = await runCli([
      "content",
      "tags",
      "set",
      CONTENT_ID,
      "--clear",
      "--names",
      "crm",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    expect(errorEnvelope(res).error.field).toBe("--clear");
  });

  it("sends the empty body only when --clear asks for it", async () => {
    let body: unknown;
    server.use(
      http.put(apiUrl("/org/content/:id/tags"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json([]);
      }),
    );

    const res = await runCli(["content", "tags", "set", CONTENT_ID, "--clear"]);

    expect(res.exitCode).toBe(0);
    expect(body).toEqual({});
  });

  it("splits --names and --ids into tag_names and tag_ids on a PUT", async () => {
    let seen: Request | undefined;
    let body: unknown;
    server.use(
      http.put(apiUrl("/org/content/:id/tags"), async ({ request }) => {
        seen = request;
        body = await request.json();
        return HttpResponse.json(TAGS);
      }),
    );

    const res = await runCli([
      "content",
      "tags",
      "set",
      CONTENT_ID,
      "--names",
      "crm, pricing",
      "--ids",
      TAG_ID_2,
    ]);

    expect(res.exitCode).toBe(0);
    expect(seen?.method).toBe("PUT");
    // Whitespace around a comma is a shell artifact, not part of the tag name.
    expect(body).toEqual({ tag_names: ["crm", "pricing"], tag_ids: [TAG_ID_2] });
  });

  it("exits 2 when an --ids value is not a UUID", async () => {
    const res = await runCli([
      "content",
      "tags",
      "set",
      CONTENT_ID,
      "--ids",
      "t-9",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    expect(errorEnvelope(res).error.field).toBe("--ids");
  });

  it("says out loud that the collection was replaced, not added to", async () => {
    server.use(http.put(apiUrl("/org/content/:id/tags"), () => HttpResponse.json(TAGS)));

    const res = await runCli([
      "content",
      "tags",
      "set",
      CONTENT_ID,
      "--names",
      "crm",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    expect(envelope(res).warnings?.join(" ")).toContain("replaced the whole collection");
  });
});

describe("content record-edits, refused before a half-written batch", () => {
  // The endpoint writes events one at a time with no transaction and discards
  // the counts when one is rejected, so a batch with a typo in its fourth event
  // leaves three written and reports nothing about them.
  it("exits 2 when --data is not valid JSON", async () => {
    const res = await runCli(["content", "record-edits", CONTENT_ID, "--data", "{oops"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("--data");
  });

  it("exits 2 when the body carries no events array", async () => {
    const res = await runCli([
      "content",
      "record-edits",
      CONTENT_ID,
      "--data",
      '{"event":"saved"}',
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("events");
  });

  it("exits 2 rather than sending an empty batch", async () => {
    const res = await runCli(["content", "record-edits", CONTENT_ID, "--data", '{"events":[]}']);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
  });

  it("exits 2 naming the index of the bad event and the valid event types", async () => {
    const res = await runCli([
      "content",
      "record-edits",
      CONTENT_ID,
      "--data",
      '{"events":[{"event_type":"draft_saved","edit_source":"manual"},{"event_type":"saved","edit_source":"manual"}]}',
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    const { error } = errorEnvelope(res);
    expect(error.message).toContain("events[1].event_type");
    expect(error.allowed).toContain("draft_saved");
  });

  it("exits 2 when edit_source is outside the set the API compares literally", async () => {
    const res = await runCli([
      "content",
      "record-edits",
      CONTENT_ID,
      "--data",
      '{"events":[{"event_type":"draft_saved","edit_source":"Manual"}]}',
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    expect(errorEnvelope(res).error.allowed).toEqual(["manual", "ai", "system"]);
  });

  it("exits 2 when client_event_id — the dedupe key — is not a UUID", async () => {
    const res = await runCli([
      "content",
      "record-edits",
      CONTENT_ID,
      "--data",
      '{"events":[{"event_type":"draft_saved","edit_source":"manual","client_event_id":"e-1"}]}',
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    expect(errorEnvelope(res).error.hint).toContain("dedupe key");
  });
});

describe("content list, on the wire", () => {
  it("reads the knowledge base file listing, with the paging defaults applied", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/kb/my-files"), ({ request }) => {
        seen = request;
        return HttpResponse.json(KB_FILES);
      }),
    );

    await runCli(["content", "list"]);

    const url = new URL(seen?.url ?? "");
    expect(seen?.method).toBe("GET");
    expect(url.pathname).toBe("/api/v1/org/kb/my-files");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("offset")).toBe("0");
    expect(seen?.headers.get("x-api-key")).toBe(TEST_API_KEY);
  });

  it("passes --limit and --offset through as limit and offset", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/kb/my-files"), ({ request }) => {
        seen = request;
        return HttpResponse.json(KB_FILES);
      }),
    );

    await runCli(["content", "list", "--limit", "50", "--offset", "100"]);

    const url = new URL(seen?.url ?? "");
    expect(url.searchParams.get("limit")).toBe("50");
    expect(url.searchParams.get("offset")).toBe("100");
  });
});

describe("content reads, on the wire", () => {
  it("requests the content item by id", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/content/:id"), ({ request }) => {
        seen = request;
        return HttpResponse.json(ONE_CONTENT);
      }),
    );

    await runCli(["content", "get", CONTENT_ID]);

    expect(seen?.method).toBe("GET");
    expect(new URL(seen?.url ?? "").pathname).toBe(`/api/v1/org/content/${CONTENT_ID}`);
  });

  it("requests the version history sub-resource", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/content/:id/versions"), ({ request }) => {
        seen = request;
        return HttpResponse.json(VERSIONS);
      }),
    );

    await runCli(["content", "versions", CONTENT_ID]);

    expect(seen?.method).toBe("GET");
    expect(new URL(seen?.url ?? "").pathname).toBe(`/api/v1/org/content/${CONTENT_ID}/versions`);
  });

  it("requests the counts sub-resource, not the paginated queue", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/content/verification/counts"), ({ request }) => {
        seen = request;
        return HttpResponse.json(COUNTS);
      }),
    );

    const res = await runCli(["content", "verification-counts", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(seen?.method).toBe("GET");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/content/verification/counts");
    expect(res.data()).toEqual(COUNTS);
  });

  it("reads the velocity metrics from the nested verification route", async () => {
    let path: string | undefined;
    server.use(
      http.get(apiUrl("/org/content/verification/velocity"), ({ request }) => {
        path = new URL(request.url).pathname;
        return HttpResponse.json(VELOCITY);
      }),
    );

    const res = await runCli(["content", "verification-velocity"]);

    expect(res.exitCode).toBe(0);
    // Not /org/content/verification, which is the paginated review queue.
    expect(path).toMatch(/\/org\/content\/verification\/velocity$/);
  });
});

describe("content verification, on the wire", () => {
  it("requests the verification queue with no filters by default", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/content/verification"), ({ request }) => {
        seen = request;
        return HttpResponse.json(VERIFICATION);
      }),
    );

    await runCli(["content", "verification"]);

    const url = new URL(seen?.url ?? "");
    expect(seen?.method).toBe("GET");
    expect(url.pathname).toBe("/api/v1/org/content/verification");
    // Unset options must not become empty parameters: `?status=` means
    // something different to the API from an absent `status`.
    expect(url.search).toBe("");
  });

  it("maps every filter flag onto the query parameter the API expects", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/content/verification"), ({ request }) => {
        seen = request;
        return HttpResponse.json(VERIFICATION);
      }),
    );

    await runCli([
      "content",
      "verification",
      "--limit",
      "25",
      "--offset",
      "50",
      "--search",
      "crm pricing",
      "--status",
      "published",
      "--substatus",
      "pending_draft",
      "--tag-ids",
      `${TAG_ID},${TAG_ID_2}`,
      "--sort",
      "citation_rate_desc",
    ]);

    const params = new URL(seen?.url ?? "").searchParams;
    expect(params.get("limit")).toBe("25");
    expect(params.get("offset")).toBe("50");
    expect(params.get("search")).toBe("crm pricing");
    expect(params.get("status")).toBe("published");
    expect(params.get("substatus")).toBe("pending_draft");
    expect(params.get("tag_ids")).toBe(`${TAG_ID},${TAG_ID_2}`);
    expect(params.get("sort")).toBe("citation_rate_desc");
  });

  it("accepts a documented --status regardless of case, forwarding the canonical form", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/content/verification"), ({ request }) => {
        seen = request;
        return HttpResponse.json(VERIFICATION);
      }),
    );

    const res = await runCli(["content", "verification", "--status", "Draft"]);

    expect(res.exitCode).toBe(0);
    expect(new URL(seen?.url ?? "").searchParams.get("status")).toBe("draft");
  });
});

describe("content writes, on the wire", () => {
  it("sends a DELETE to the content item and no body", async () => {
    let seen: Request | undefined;
    server.use(
      http.delete(apiUrl("/org/content/:id"), ({ request }) => {
        seen = request;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const res = await runCli(["content", "delete", CONTENT_ID]);

    expect(res.exitCode).toBe(0);
    expect(seen?.method).toBe("DELETE");
    expect(new URL(seen?.url ?? "").pathname).toBe(`/api/v1/org/content/${CONTENT_ID}`);
    expect(await seen?.text()).toBe("");
  });

  it("posts to the unpublish sub-resource with no body when no records are named", async () => {
    let seen: Request | undefined;
    let body: string | undefined;
    server.use(
      http.post(apiUrl("/org/content/:id/unpublish"), async ({ request }) => {
        seen = request;
        body = await request.text();
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const res = await runCli(["content", "unpublish", CONTENT_ID]);

    expect(res.exitCode).toBe(0);
    expect(seen?.method).toBe("POST");
    expect(new URL(seen?.url ?? "").pathname).toBe(`/api/v1/org/content/${CONTENT_ID}/unpublish`);
    // No body at all, not `{}`: the API reads an absent body as "every
    // destination", which is a different operation from an empty list.
    expect(body).toBe("");
  });

  it("sends the named records as publish_record_ids when the flag is given", async () => {
    let body: unknown;
    server.use(
      http.post(apiUrl("/org/content/:id/unpublish"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ unpublished_count: 2, failures: [] });
      }),
    );

    const res = await runCli([
      "content",
      "unpublish",
      CONTENT_ID,
      "--publish-record-ids",
      PUBLISH_RECORD_ID,
      PUBLISH_RECORD_ID_2,
    ]);

    expect(res.exitCode).toBe(0);
    expect(body).toEqual({ publish_record_ids: [PUBLISH_RECORD_ID, PUBLISH_RECORD_ID_2] });
  });

  it("posts to the version's reject route with no body when no reason is given", async () => {
    let seen: Request | undefined;
    let body: string | undefined;
    server.use(
      http.post(apiUrl("/org/content/versions/:versionId/reject"), async ({ request }) => {
        seen = request;
        body = await request.text();
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const res = await runCli(["content", "reject", VERSION_ID]);

    expect(res.exitCode).toBe(0);
    expect(seen?.method).toBe("POST");
    expect(new URL(seen?.url ?? "").pathname).toBe(
      `/api/v1/org/content/versions/${VERSION_ID}/reject`,
    );
    expect(body).toBe("");
  });

  it("sends --reason as reason", async () => {
    let body: unknown;
    server.use(
      http.post(apiUrl("/org/content/versions/:versionId/reject"), async ({ request }) => {
        body = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await runCli(["content", "reject", VERSION_ID, "--reason", "off brand"]);

    expect(body).toEqual({ reason: "off brand" });
  });

  it("posts to the version's restore route", async () => {
    let seen: Request | undefined;
    server.use(
      http.post(apiUrl("/org/content/versions/:versionId/restore"), ({ request }) => {
        seen = request;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const res = await runCli(["content", "restore", VERSION_ID]);

    expect(res.exitCode).toBe(0);
    expect(seen?.method).toBe("POST");
    expect(new URL(seen?.url ?? "").pathname).toBe(
      `/api/v1/org/content/versions/${VERSION_ID}/restore`,
    );
  });

  it("lists the owners of a content item", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/content/:id/owners"), ({ request }) => {
        seen = request;
        return HttpResponse.json(OWNERS);
      }),
    );

    await runCli(["content", "owners", CONTENT_ID]);

    expect(seen?.method).toBe("GET");
    expect(new URL(seen?.url ?? "").pathname).toBe(`/api/v1/org/content/${CONTENT_ID}/owners`);
  });

  it("replaces the whole owner set with a PUT carrying user_ids", async () => {
    let seen: Request | undefined;
    let body: unknown;
    server.use(
      http.put(apiUrl("/org/content/:id/owners"), async ({ request }) => {
        seen = request;
        body = await request.json();
        return HttpResponse.json(OWNERS);
      }),
    );

    const res = await runCli([
      "content",
      "set-owners",
      CONTENT_ID,
      "--user-ids",
      USER_ID,
      USER_ID_2,
    ]);

    expect(res.exitCode).toBe(0);
    expect(seen?.method).toBe("PUT");
    expect(new URL(seen?.url ?? "").pathname).toBe(`/api/v1/org/content/${CONTENT_ID}/owners`);
    expect(body).toEqual({ user_ids: [USER_ID, USER_ID_2] });
  });

  it("removes one owner by deleting the nested owner path", async () => {
    let seen: Request | undefined;
    server.use(
      http.delete(apiUrl("/org/content/:id/owners/:userId"), ({ request }) => {
        seen = request;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const res = await runCli(["content", "remove-owner", CONTENT_ID, USER_ID_2]);

    expect(res.exitCode).toBe(0);
    expect(seen?.method).toBe("DELETE");
    expect(new URL(seen?.url ?? "").pathname).toBe(
      `/api/v1/org/content/${CONTENT_ID}/owners/${USER_ID_2}`,
    );
  });
});

describe("content tags, on the wire", () => {
  it("lists the tags attached to a content item", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/content/:id/tags"), ({ request }) => {
        seen = request;
        return HttpResponse.json(TAGS);
      }),
    );

    await runCli(["content", "tags", "list", CONTENT_ID]);

    expect(seen?.method).toBe("GET");
    expect(new URL(seen?.url ?? "").pathname).toBe(`/api/v1/org/content/${CONTENT_ID}/tags`);
  });

  it("attaches a tag by name as tag_name", async () => {
    let body: unknown;
    server.use(
      http.post(apiUrl("/org/content/:id/tags"), async ({ request }) => {
        body = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const res = await runCli(["content", "tags", "add", CONTENT_ID, "--name", "crm"]);

    expect(res.exitCode).toBe(0);
    expect(body).toEqual({ tag_name: "crm" });
  });

  it("attaches a tag by id as tag_id", async () => {
    let body: unknown;
    server.use(
      http.post(apiUrl("/org/content/:id/tags"), async ({ request }) => {
        body = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await runCli(["content", "tags", "add", CONTENT_ID, "--id", TAG_ID]);

    expect(body).toEqual({ tag_id: TAG_ID });
  });

  it("detaches by --id through the nested tag path", async () => {
    let seen: Request | undefined;
    server.use(
      http.delete(apiUrl("/org/content/:id/tags/:tagId"), ({ request }) => {
        seen = request;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const res = await runCli(["content", "tags", "remove", CONTENT_ID, "--id", TAG_ID]);

    expect(res.exitCode).toBe(0);
    expect(seen?.method).toBe("DELETE");
    expect(new URL(seen?.url ?? "").pathname).toBe(
      `/api/v1/org/content/${CONTENT_ID}/tags/${TAG_ID}`,
    );
  });

  it("detaches by --name through the collection with a name parameter", async () => {
    let seen: Request | undefined;
    server.use(
      http.delete(apiUrl("/org/content/:id/tags"), ({ request }) => {
        seen = request;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const res = await runCli(["content", "tags", "remove", CONTENT_ID, "--name", "crm"]);

    expect(res.exitCode).toBe(0);
    // A different request from the --id case, and detaching the wrong tag is
    // silent, so the route and the parameter are both pinned.
    const url = new URL(seen?.url ?? "");
    expect(url.pathname).toBe(`/api/v1/org/content/${CONTENT_ID}/tags`);
    expect(url.searchParams.get("name")).toBe("crm");
  });

  it("warns that detaching by name cannot tell a typo from a tag that was not attached", async () => {
    server.use(
      http.delete(apiUrl("/org/content/:id/tags"), () => new HttpResponse(null, { status: 204 })),
    );

    const res = await runCli([
      "content",
      "tags",
      "remove",
      CONTENT_ID,
      "--name",
      "crm",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    expect(envelope(res).warnings?.join(" ")).toContain("no-op");
  });
});

describe("content provenance and the citation reports, on the wire", () => {
  it("sends --url as published_url on the query string", async () => {
    let url: URL | undefined;
    server.use(
      http.get(apiUrl("/org/content/provenance"), ({ request }) => {
        url = new URL(request.url);
        return HttpResponse.json(PROVENANCE);
      }),
    );

    await runCli(["content", "provenance", "--url", "https://acme.example/best-crms"]);

    expect(url?.pathname).toContain("/org/content/provenance");
    expect(url?.searchParams.get("published_url")).toBe("https://acme.example/best-crms");
  });

  it("renames every citation-details filter into its API parameter", async () => {
    let url: URL | undefined;
    server.use(
      http.get(apiUrl("/org/content/:id/citation-details"), ({ request }) => {
        url = new URL(request.url);
        return HttpResponse.json(CITATION_DETAILS);
      }),
    );

    await runCli([
      "content",
      "citation-details",
      CONTENT_ID,
      "--start-date",
      "2026-01-01",
      "--end-date",
      "2026-01-31",
      "--models",
      "chatgpt,perplexity",
      "--locations",
      "us,ca",
    ]);

    expect(url?.pathname).toContain(`/org/content/${CONTENT_ID}/citation-details`);
    expect(url?.searchParams.get("start_date")).toBe("2026-01-01");
    expect(url?.searchParams.get("end_date")).toBe("2026-01-31");
    expect(url?.searchParams.get("models")).toBe("chatgpt,perplexity");
    expect(url?.searchParams.get("locations")).toBe("us,ca");
  });

  it("sends no filter parameters at all when none were given", async () => {
    let url: URL | undefined;
    server.use(
      http.get(apiUrl("/org/content/:id/citation-details"), ({ request }) => {
        url = new URL(request.url);
        return HttpResponse.json(CITATION_DETAILS);
      }),
    );

    await runCli(["content", "citation-details", CONTENT_ID]);

    // An empty `start_date=` is not the same request as no start_date at all.
    expect([...(url?.searchParams.keys() ?? [])]).toEqual([]);
  });

  it("carries --destinations through on citation-prompts, which citation-details has no filter for", async () => {
    let url: URL | undefined;
    server.use(
      http.get(apiUrl("/org/content/:id/citation-prompts"), ({ request }) => {
        url = new URL(request.url);
        return HttpResponse.json(CITATION_PROMPTS);
      }),
    );

    await runCli([
      "content",
      "citation-prompts",
      CONTENT_ID,
      "--destinations",
      "company-blog",
      "--models",
      "chatgpt",
    ]);

    expect(url?.pathname).toContain(`/org/content/${CONTENT_ID}/citation-prompts`);
    expect(url?.searchParams.get("destinations")).toBe("company-blog");
    expect(url?.searchParams.get("models")).toBe("chatgpt");
  });

  it("posts the events body verbatim to the bulk edit-events route", async () => {
    let body: unknown;
    let url: string | undefined;
    server.use(
      http.post(apiUrl("/org/content/:id/edit-events/bulk"), async ({ request }) => {
        body = await request.json();
        url = request.url;
        return HttpResponse.json({ inserted_count: 1, duplicate_count: 0 });
      }),
    );

    await runCli(["content", "record-edits", CONTENT_ID, "--data", VALID_EVENTS]);

    expect(url).toContain(`/org/content/${CONTENT_ID}/edit-events/bulk`);
    expect(body).toEqual({
      events: [
        { event_type: "draft_saved", edit_source: "manual", client_event_id: CLIENT_EVENT_ID },
      ],
    });
  });
});

describe("content list, on success", () => {
  it("wraps the payload, unmodified, in the envelope under --output json", async () => {
    server.use(http.get(apiUrl("/org/kb/my-files"), () => HttpResponse.json(KB_FILES)));

    const res = await runCli(["content", "list", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    // The raw response, not the projection the other two formats render.
    expect(res.data()).toEqual(KB_FILES);
    expect(envelope(res).command).toBe("content list");
    expect(res.stderr).toBe("");
  });

  it("reads processing_status out of the nested content object, where the API puts it", async () => {
    // Read from the top level — where it has never been — this column was
    // blank on every row the command has ever printed.
    server.use(http.get(apiUrl("/org/kb/my-files"), () => HttpResponse.json(KB_FILES)));

    const res = await runCli(["content", "list", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    for (const column of ["kb_node_id", "name", "type", "processing_status"]) {
      expect(res.stdout).toContain(column);
    }
    expect(res.stdout).toContain(KB_NODE_ID);
    expect(res.stdout).toContain("Pricing page");
    expect(res.stdout).toContain("complete");
    expect(res.stderr).not.toContain("did not return");
  });

  it("renders a block per node by default", async () => {
    server.use(http.get(apiUrl("/org/kb/my-files"), () => HttpResponse.json(KB_FILES)));

    const res = await runCli(["content", "list"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Onboarding");
    expect(res.stdout).toContain(KB_NODE_ID_2);
    expect(res.stdout).toContain("folder");
  });

  it("reads a bare array response as the node list", async () => {
    // Some deployments return the array unwrapped; both shapes must render.
    server.use(http.get(apiUrl("/org/kb/my-files"), () => HttpResponse.json(KB_FILES.nodes)));

    const res = await runCli(["content", "list"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Pricing page");
  });

  it("calls an unnamed node Untitled rather than printing nothing", async () => {
    server.use(
      http.get(apiUrl("/org/kb/my-files"), () =>
        HttpResponse.json({ nodes: [{ kb_node_id: KB_NODE_ID, name: "", type: "file" }] }),
      ),
    );

    const res = await runCli(["content", "list"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Untitled");
    expect(res.stdout).toContain(KB_NODE_ID);
  });

  it("says so plainly, and says where else to look, when the knowledge base is empty", async () => {
    server.use(
      http.get(apiUrl("/org/kb/my-files"), () =>
        HttpResponse.json({ nodes: [], total: 0, limit: 10, offset: 0 }),
      ),
    );

    const res = await runCli(["content", "list"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("No content found.");
    expect(res.stderr).toContain("senso kb upload");
  });
});

describe("content get, on success", () => {
  it("wraps the payload, unmodified, in the envelope under --output json", async () => {
    server.use(http.get(apiUrl("/org/content/:id"), () => HttpResponse.json(ONE_CONTENT)));

    const res = await runCli(["content", "get", CONTENT_ID, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual(ONE_CONTENT);
    expect(res.stderr).toBe("");
  });

  it("carries the next commands in the envelope, where a json caller can read them", async () => {
    // Under --output json stderr is silent, so guidance written only there
    // would reach nobody — and every shipped Senso skill passes --output json.
    server.use(http.get(apiUrl("/org/content/:id"), () => HttpResponse.json(ONE_CONTENT)));

    const res = await runCli(["content", "get", CONTENT_ID, "--output", "json"]);

    const commands = (envelope(res).next ?? []).map((n) => n.command);
    expect(commands).toContain(`senso content versions ${CONTENT_ID}`);
    expect(commands).toContain(`senso content citation-details ${CONTENT_ID}`);
  });

  it("renders the single object as field/value rows under --output table", async () => {
    server.use(http.get(apiUrl("/org/content/:id"), () => HttpResponse.json(ONE_CONTENT)));

    const res = await runCli(["content", "get", CONTENT_ID, "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("field");
    expect(res.stdout).toContain("value");
    expect(res.stdout).toContain("editorial_status");
    expect(res.stdout).toContain("Best CRMs for startups");
  });

  it("renders the version's provenance as a sub-block, not a JSON string", async () => {
    server.use(http.get(apiUrl("/org/content/:id"), () => HttpResponse.json(ONE_CONTENT)));

    const res = await runCli(["content", "get", CONTENT_ID]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("title");
    expect(res.stdout).toContain("published");
    expect(res.stdout).toContain("actor_type");
    expect(res.stdout).toContain("casey@example.com");
    expect(res.stdout).not.toContain("[object Object]");
  });
});

describe("content verification and the reports, on success", () => {
  it("renders one row per queued item under --output table, with no blank column", async () => {
    server.use(
      http.get(apiUrl("/org/content/verification"), () => HttpResponse.json(VERIFICATION)),
    );

    const res = await runCli(["content", "verification", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(CONTENT_ID);
    expect(res.stdout).toContain("CRM pricing compared");
    expect(res.stdout).toContain("editorial_status");
    expect(res.stdout).toContain("tracked_url_count");
    // Every declared column exists on at least one row; the warning would say
    // otherwise, which is how a blank first column once shipped green.
    expect(res.stderr).not.toContain("did not return");
  });

  it("keeps the org-wide counts beside the rows rather than dropping them", async () => {
    server.use(
      http.get(apiUrl("/org/content/verification"), () => HttpResponse.json(VERIFICATION)),
    );

    const res = await runCli(["content", "verification"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("draft_count");
    expect(res.stdout).toContain("Best CRMs for startups");
  });

  it("says where the page sits, so a caller knows whether to ask for more", async () => {
    server.use(
      http.get(apiUrl("/org/content/verification"), () => HttpResponse.json(VERIFICATION)),
    );

    const res = await runCli(["content", "verification", "--output", "json"]);

    expect(envelope(res).page).toMatchObject({
      offset: 0,
      limit: 10,
      returned: 2,
      total: 2,
      has_more: false,
    });
  });

  it("says why the queue might be empty, since it is filtered by default", async () => {
    server.use(
      http.get(apiUrl("/org/content/verification"), () =>
        HttpResponse.json({
          items: [],
          total_count: 0,
          draft_count: 0,
          rejected_count: 0,
          pending_published_draft_count: 0,
          limit: 10,
          offset: 0,
        }),
      ),
    );

    const res = await runCli(["content", "verification", "--status", "rejected"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("No content found.");
    expect(res.stderr).toContain("--status all");
  });

  it("lists the version history with the current version flagged", async () => {
    server.use(http.get(apiUrl("/org/content/:id/versions"), () => HttpResponse.json(VERSIONS)));

    const res = await runCli(["content", "versions", CONTENT_ID, "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("version_id");
    expect(res.stdout).toContain("is_current");
    expect(res.stdout).toContain(VERSION_ID);
    expect(res.stderr).not.toContain("did not return");
  });

  it("prints the provenance audit unmodified under --output json", async () => {
    server.use(http.get(apiUrl("/org/content/provenance"), () => HttpResponse.json(PROVENANCE)));

    const res = await runCli([
      "content",
      "provenance",
      "--url",
      "https://acme.example/best-crms",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual(PROVENANCE);
    expect(res.stderr).toBe("");
  });

  it("turns the stages, which are keyed rather than listed, into rows", async () => {
    server.use(http.get(apiUrl("/org/content/provenance"), () => HttpResponse.json(PROVENANCE)));

    const res = await runCli([
      "content",
      "provenance",
      "--url",
      "https://acme.example/best-crms",
      "--output",
      "table",
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("stage");
    expect(res.stdout).toContain("applicability");
    expect(res.stdout).toContain("ingestion");
    expect(res.stdout).toContain("publication");
    expect(res.stderr).not.toContain("did not return");
  });

  it("renders the audit header and each stage as key/value lines by default", async () => {
    server.use(http.get(apiUrl("/org/content/provenance"), () => HttpResponse.json(PROVENANCE)));

    const res = await runCli(["content", "provenance", "--url", "https://acme.example/best-crms"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("overall_status");
    expect(res.stdout).toContain("partial");
    expect(res.stdout).toContain("missing_evidence");
  });

  it("exits 4 when no live publish record has exactly this URL", async () => {
    server.use(
      http.get(apiUrl("/org/content/provenance"), () =>
        HttpResponse.json({ error: "No publish record" }, { status: 404 }),
      ),
    );

    const res = await runCli([
      "content",
      "provenance",
      "--url",
      "https://acme.example/gone",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");

    const { error } = errorEnvelope(res);
    expect(error.field).toBe("published_url");
    expect(error.received).toBe("https://acme.example/gone");
  });

  it("renders one row per prompt under --output table", async () => {
    server.use(
      http.get(apiUrl("/org/content/:id/citation-prompts"), () =>
        HttpResponse.json(CITATION_PROMPTS),
      ),
    );

    const res = await runCli(["content", "citation-prompts", CONTENT_ID, "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("mention_rate");
    expect(res.stdout).toContain("best crm for a five person startup");
    expect(res.stderr).not.toContain("did not return");
  });

  it("explains an empty prompt list as an untracked page rather than a zero score", async () => {
    // No tracked URL means no run CAN cite the item, which is a different
    // statement from "it was never cited".
    server.use(
      http.get(apiUrl("/org/content/:id/citation-prompts"), () =>
        HttpResponse.json({ ...CITATION_PROMPTS, external_urls: [], prompts: [] }),
      ),
    );

    const res = await runCli(["content", "citation-prompts", CONTENT_ID, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(envelope(res).warnings?.join(" ")).toContain("no tracked URL");
  });

  it("keeps the pooled summary visible alongside the per-destination rows", async () => {
    server.use(
      http.get(apiUrl("/org/content/:id/citation-details"), () =>
        HttpResponse.json(CITATION_DETAILS),
      ),
    );

    const res = await runCli(["content", "citation-details", CONTENT_ID]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("total_citations");
    expect(res.stdout).toContain("company-blog");
  });

  it("keeps the org totals visible on the velocity report", async () => {
    server.use(
      http.get(apiUrl("/org/content/verification/velocity"), () => HttpResponse.json(VELOCITY)),
    );

    const res = await runCli(["content", "verification-velocity"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("total_live_pages");
    expect(res.stdout).toContain("avg_days_to_first_citation");
    expect(res.stdout).toContain("Company Blog");
  });
});

describe("content owners and tags, on success", () => {
  it("renders the owner list, which the API returns as a bare array", async () => {
    server.use(http.get(apiUrl("/org/content/:id/owners"), () => HttpResponse.json(OWNERS)));

    const res = await runCli(["content", "owners", CONTENT_ID]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("casey@example.com");
    expect(res.stdout).toContain(USER_ID_2);
  });

  it("says how to assign an owner when a content item has none", async () => {
    server.use(http.get(apiUrl("/org/content/:id/owners"), () => HttpResponse.json([])));

    const res = await runCli(["content", "owners", CONTENT_ID]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("No owners found.");
    expect(res.stderr).toContain(`senso content set-owners ${CONTENT_ID}`);
  });

  it("returns the resulting owner set rather than making the caller read it back", async () => {
    server.use(http.put(apiUrl("/org/content/:id/owners"), () => HttpResponse.json(OWNERS)));

    const res = await runCli([
      "content",
      "set-owners",
      CONTENT_ID,
      "--user-ids",
      USER_ID,
      USER_ID_2,
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual(OWNERS);
    expect(envelope(res).warnings?.join(" ")).toContain("replaced the whole owner list");
  });

  it("renders the tag list, which the API returns as a bare array", async () => {
    server.use(http.get(apiUrl("/org/content/:id/tags"), () => HttpResponse.json(TAGS)));

    const res = await runCli(["content", "tags", "list", CONTENT_ID]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("crm");
    expect(res.stdout).toContain(TAG_ID);
  });

  it("says how to attach one when a content item carries no tags", async () => {
    server.use(http.get(apiUrl("/org/content/:id/tags"), () => HttpResponse.json([])));

    const res = await runCli(["content", "tags", "list", CONTENT_ID]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("No tags found.");
    expect(res.stderr).toContain(`senso content tags add ${CONTENT_ID}`);
  });

  it("puts the insert counts on stdout and the tally on stderr for record-edits", async () => {
    // A batch where every event was a duplicate used to read exactly like one
    // where every event was new.
    server.use(
      http.post(apiUrl("/org/content/:id/edit-events/bulk"), () =>
        HttpResponse.json({ inserted_count: 2, duplicate_count: 1 }),
      ),
    );

    const res = await runCli(["content", "record-edits", CONTENT_ID, "--data", VALID_EVENTS]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("duplicate_count");
    expect(res.stderr).toContain("Recorded 2 new event(s) and skipped 1 duplicate(s)");
    expect(res.stdout).not.toContain("Recorded 2 new event(s)");
  });
});

describe("content, when a command only confirms", () => {
  it("names what was deleted on stdout under --output json, rather than a sentence", async () => {
    server.use(
      http.delete(apiUrl("/org/content/:id"), () => new HttpResponse(null, { status: 204 })),
    );

    const res = await runCli(["content", "delete", CONTENT_ID, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    // A 204 has no payload, so the caller gets an object it can check rather
    // than an empty stream or an unparseable success line.
    expect(res.data()).toEqual({ action: "deleted", resource: "content", id: CONTENT_ID });
    expect(res.stderr).toBe("");
  });

  it("puts the delete confirmation on stderr, leaving stdout empty", async () => {
    server.use(
      http.delete(apiUrl("/org/content/:id"), () => new HttpResponse(null, { status: 204 })),
    );

    const res = await runCli(["content", "delete", CONTENT_ID]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("✓");
    expect(res.stderr).toContain(CONTENT_ID);
  });

  it("records the reason on a reject, so the decision is readable as a field", async () => {
    server.use(
      http.post(
        apiUrl("/org/content/versions/:versionId/reject"),
        () => new HttpResponse(null, { status: 204 }),
      ),
    );

    const res = await runCli([
      "content",
      "reject",
      VERSION_ID,
      "--reason",
      "no source for the 30-day claim",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual({
      action: "rejected",
      resource: "content_version",
      id: VERSION_ID,
      reason: "no source for the 30-day claim",
    });
    expect(envelope(res).next?.[0]?.command).toBe(`senso content restore ${VERSION_ID}`);
  });

  it("puts the reject confirmation on stderr, leaving stdout empty", async () => {
    server.use(
      http.post(
        apiUrl("/org/content/versions/:versionId/reject"),
        () => new HttpResponse(null, { status: 204 }),
      ),
    );

    const res = await runCli(["content", "reject", VERSION_ID]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("rejected");
  });

  it("says a restored version is a draft again, as a field rather than a sentence", async () => {
    server.use(
      http.post(
        apiUrl("/org/content/versions/:versionId/restore"),
        () => new HttpResponse(null, { status: 204 }),
      ),
    );

    const res = await runCli(["content", "restore", VERSION_ID, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toMatchObject({ action: "restored", editorial_status: "draft" });
  });

  it("says nothing at all under --quiet", async () => {
    server.use(
      http.delete(
        apiUrl("/org/content/:id/owners/:userId"),
        () => new HttpResponse(null, { status: 204 }),
      ),
    );

    const res = await runCli(["content", "remove-owner", CONTENT_ID, USER_ID_2, "--quiet"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr).toBe("");
  });
});
