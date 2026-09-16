/**
 * Command layer: `senso engine`.
 *
 * These two commands are the only ones in the CLI that push content outside the
 * organization, so what is worth protecting here is not the rendering — it is
 * every way a caller can be told something happened that did not:
 *
 *   - a publish that EVERY destination refused comes back HTTP 200 with
 *     publish_status "failed" and the item back in `draft`. Read as a success
 *     it printed "✓ Content published." and exited 0 for content that reached
 *     nobody. It must exit 1, name each destination's reason, and put the ids
 *     in error.details;
 *   - a PARTIAL refusal is the opposite case and must stay a success with a
 *     warning, because the content IS live somewhere;
 *   - `content_id` is the create-vs-update switch, and a body without one mints
 *     a new item on every call. A caller iterating on a draft has to be told;
 *   - `geo_question_id` is OPTIONAL — the DTO declares it as a pointer — and
 *     only raw_markdown and seo_title are enforced. A body missing one of those
 *     must exit 2 naming it rather than round-tripping to a 400;
 *   - `--publisher-ids` overrides publisher_ids inside `--data`. Getting that
 *     backwards publishes to a destination the caller narrowed away from.
 *
 * Every fixture below is the shape of ContentEnginePublishResponse /
 * ContentEngineDraftResponse in senso-api's internal/api/dto/content_engine_dto.go.
 * Failure branches come first: they are the cases a caller has to handle.
 */

import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server, TEST_API_KEY } from "../setup.js";
import { apiUrl, envelope, errorEnvelope, runCli } from "../helpers.js";

const CONTENT_ID = "9d7e1c40-5b3a-4c22-8f16-0a3b7e5d2c81";
const VERSION_ID = "4a1b8c67-2d39-4e05-9f7a-6b2c8d0e1f34";
const GEO_QUESTION_ID = "7f4c2d10-88ab-4e39-9c51-3d6e0b7a2f18";
const PUBLISHER_ID = "61e0a2c7-4b93-4f18-a7d2-0c5e9b3f18a6";
const OTHER_PUBLISHER_ID = "0c3d5b19-7a42-4ef8-9b16-5d8e2f7c04a3";

/** The smallest body the handler accepts: the two enforced keys, and nothing else. */
const BODY = {
  raw_markdown: "# How refunds work\n\nRefunds are issued within 14 days.",
  seo_title: "How do refunds work at Acme?",
};

/** The same body, updating an existing item rather than creating one. */
const UPDATE_BODY = { content_id: CONTENT_ID, ...BODY };

/** ContentEnginePublishResponse for a publish every destination accepted. */
const PUBLISHED = {
  content_id: CONTENT_ID,
  version_id: VERSION_ID,
  version_num: 3,
  citeables_action: "publish",
  publish_status: "success",
  editorial_status: "published",
  publish_destination: "citeables",
  publish_destinations: [
    {
      publisher: "citeables",
      display_url: "https://acme.citeables.com/how-refunds-work",
      status: "success",
    },
  ],
};

/** The 200 that means nothing was published: every destination refused. */
const ALL_REFUSED = {
  content_id: CONTENT_ID,
  version_id: VERSION_ID,
  version_num: 3,
  citeables_action: "publish",
  publish_status: "failed",
  editorial_status: "draft",
  publish_destination: "",
  publish_destinations: [
    {
      publisher: "citeables",
      display_url: "",
      status: "failed",
      error_msg: "adapter returned 502",
    },
    {
      publisher: "webflow",
      display_url: "",
      status: "failed",
      error_msg: "collection not authorized",
    },
  ],
};

/** One destination took it and one did not: still a publish, still live. */
const PARTIALLY_REFUSED = {
  ...PUBLISHED,
  publish_destinations: [
    {
      publisher: "citeables",
      display_url: "https://acme.citeables.com/how-refunds-work",
      status: "success",
    },
    {
      publisher: "webflow",
      display_url: "",
      status: "failed",
      error_msg: "collection not authorized",
    },
  ],
};

/** ContentEngineDraftResponse. editorial_status is always "draft" here. */
const DRAFTED = {
  content_id: CONTENT_ID,
  version_id: VERSION_ID,
  version_num: 1,
  editorial_status: "draft",
};

function publishArgs(body: unknown, ...rest: string[]): string[] {
  return ["engine", "publish", "--data", JSON.stringify(body), ...rest];
}

function draftArgs(body: unknown, ...rest: string[]): string[] {
  return ["engine", "draft", "--data", JSON.stringify(body), ...rest];
}

describe("engine publish, when the request fails", () => {
  it("exits 3 and explains how to authenticate when there is no API key", async () => {
    const res = await runCli(publishArgs(BODY), { withKey: false });

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("no API key found");
    expect(res.stderr).toContain("SENSO_API_KEY");
  });

  it("exits 3 when the API rejects the key", async () => {
    server.use(
      http.post(apiUrl("/org/content-engine/publish"), () =>
        HttpResponse.json({ error: "invalid key" }, { status: 401 }),
      ),
    );

    const res = await runCli(publishArgs(BODY));

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Authentication failed");
  });

  it("exits 3 when the organization does not have the GEO product", async () => {
    server.use(
      http.post(apiUrl("/org/content-engine/publish"), () =>
        HttpResponse.json(
          { error: "organization is not entitled to product geo" },
          { status: 403 },
        ),
      ),
    );

    const res = await runCli(publishArgs(BODY));

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Permission denied");
    expect(res.stderr).toContain("does not have the product");
  });

  it("exits 1, not 3, when the organization is out of credits", async () => {
    // 402 is deliberately not an auth failure: the key is fine, so retrying with
    // a different key is the wrong reaction.
    server.use(
      http.post(apiUrl("/org/content-engine/publish"), () =>
        HttpResponse.json({ error: "no credits remaining" }, { status: 402 }),
      ),
    );

    const res = await runCli(publishArgs(BODY));

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Insufficient credits");
  });

  it("exits 4 when the geo question does not exist", async () => {
    server.use(
      http.post(apiUrl("/org/content-engine/publish"), () =>
        HttpResponse.json({ error: "geo question not found" }, { status: 404 }),
      ),
    );

    const res = await runCli(publishArgs({ ...BODY, geo_question_id: GEO_QUESTION_ID }));

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("geo question not found");
  });

  it("exits 1 on a 500 and offers a retry, because retrying can work", async () => {
    server.use(
      http.post(
        apiUrl("/org/content-engine/publish"),
        () => new HttpResponse(null, { status: 500 }),
      ),
    );

    const res = await runCli(publishArgs(BODY));

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Retry shortly");
  });

  it("exits 1 on a 503 and says retrying is NOT the answer", async () => {
    // A deployment-level refusal. Inheriting the 5xx "try again later" hint
    // would send a caller into a loop that can never succeed.
    server.use(
      http.post(apiUrl("/org/content-engine/publish"), () =>
        HttpResponse.json({ error: "publishing is disabled in this environment" }, { status: 503 }),
      ),
    );

    const res = await runCli(publishArgs(BODY));

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("not a transient failure");
    expect(res.stderr).not.toContain("Retry shortly");
  });

  it("exits 1 on a 409 saying publish operations are already in flight", async () => {
    server.use(
      http.post(apiUrl("/org/content-engine/publish"), () =>
        HttpResponse.json(
          { error: "publish operations are in flight for this content", content_id: CONTENT_ID },
          { status: 409 },
        ),
      ),
    );

    const res = await runCli(publishArgs(UPDATE_BODY, "--output", "json"));

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    const err = errorEnvelope(res);
    expect(err.error.code).toBe("conflict");
    expect(err.error.status).toBe(409);
    expect(err.error.details).toMatchObject({ content_id: CONTENT_ID });
  });

  it("writes the failure to stderr as an error envelope, leaving stdout empty", async () => {
    server.use(
      http.post(apiUrl("/org/content-engine/publish"), () =>
        HttpResponse.json({ error: "nope" }, { status: 403 }),
      ),
    );

    const res = await runCli(publishArgs(BODY, "--output", "json"));

    expect(res.exitCode).toBe(3);
    // A publishing pipeline that reads stdout must not mistake an error object
    // for a publish result.
    expect(res.stdout).toBe("");
    const err = errorEnvelope(res);
    expect(err.command).toBe("engine publish");
    expect(err.error).toMatchObject({
      code: "forbidden",
      status: 403,
      request: { method: "POST", path: "/org/content-engine/publish" },
    });
  });
});

describe("engine publish, when every destination refused it", () => {
  it("exits 1 for an HTTP 200 whose publish_status is failed", async () => {
    // The whole reason this branch exists: the API answers 200, and a CLI that
    // reads any 2xx as success reports a publish that reached nobody.
    server.use(
      http.post(apiUrl("/org/content-engine/publish"), () => HttpResponse.json(ALL_REFUSED)),
    );

    const res = await runCli(publishArgs(UPDATE_BODY));

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).not.toContain("✓");
    expect(res.stderr).toContain("still a draft");
  });

  it("names every destination and the reason it gave", async () => {
    server.use(
      http.post(apiUrl("/org/content-engine/publish"), () => HttpResponse.json(ALL_REFUSED)),
    );

    const res = await runCli(publishArgs(UPDATE_BODY));

    expect(res.stderr).toContain("citeables: adapter returned 502");
    expect(res.stderr).toContain("webflow: collection not authorized");
  });

  it("puts the ids and each destination's outcome in error.details", async () => {
    // Under --output json stderr carries the only copy of this, and a caller
    // that wants to retry needs content_id rather than a sentence to parse.
    server.use(
      http.post(apiUrl("/org/content-engine/publish"), () => HttpResponse.json(ALL_REFUSED)),
    );

    const res = await runCli(publishArgs(UPDATE_BODY, "--output", "json"));

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    const err = errorEnvelope(res);
    expect(err.error.details).toMatchObject({
      http_status: 200,
      publish_status: "failed",
      editorial_status: "draft",
      content_id: CONTENT_ID,
      version_id: VERSION_ID,
      publish_destinations: ALL_REFUSED.publish_destinations,
    });
  });

  it("tells the caller to retry the same content_id rather than duplicate it", async () => {
    server.use(
      http.post(apiUrl("/org/content-engine/publish"), () => HttpResponse.json(ALL_REFUSED)),
    );

    const res = await runCli(publishArgs(UPDATE_BODY, "--output", "json"));

    const err = errorEnvelope(res);
    expect(err.error.hint).toContain("senso destinations list");
    expect(err.error.hint).toContain(`"content_id":"${CONTENT_ID}"`);
  });
});

describe("engine publish and draft, when --data is wrong", () => {
  // No handler is registered in this block. Reaching the network would fail the
  // test, which is how "nothing is sent before the flag is checked" is proven.

  it("exits 2 when publish's --data is not valid JSON", async () => {
    const res = await runCli(["engine", "publish", "--data", "{raw_markdown: hi}"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Invalid JSON in --data");
  });

  it("exits 2 when draft's --data is valid JSON but not an object", async () => {
    const res = await runCli(["engine", "draft", "--data", "[]"]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("--data must be a JSON object");
  });

  it("exits 2 naming seo_title when only raw_markdown was sent", async () => {
    const res = await runCli(publishArgs({ raw_markdown: "# Hi" }, "--output", "json"));

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    const err = errorEnvelope(res);
    expect(err.error.code).toBe("usage");
    expect(err.error.message).toContain("seo_title");
    expect(err.error.allowed).toContain("raw_markdown");
    expect(err.error.allowed).toContain("content_id");
  });

  it("names both required keys when a body has neither", async () => {
    const res = await runCli(draftArgs({ geo_question_id: GEO_QUESTION_ID }));

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("raw_markdown");
    expect(res.stderr).toContain("seo_title");
  });

  it("does NOT require geo_question_id, which the DTO declares as optional", async () => {
    // The old help called it required. A caller who believed that would invent
    // a question id for content that has no prompt behind it.
    server.use(http.post(apiUrl("/org/content-engine/draft"), () => HttpResponse.json(DRAFTED)));

    const res = await runCli(draftArgs(BODY));

    expect(res.exitCode).toBe(0);
  });

  it("exits 2 when raw_markdown is present but blank", async () => {
    const res = await runCli(publishArgs({ ...BODY, raw_markdown: "   " }, "--output", "json"));

    expect(res.exitCode).toBe(2);
    expect(errorEnvelope(res).error.field).toBe("--data raw_markdown");
  });

  it("exits 2 when seo_title is not a string", async () => {
    const res = await runCli(publishArgs({ ...BODY, seo_title: 7 }, "--output", "json"));

    expect(res.exitCode).toBe(2);
    expect(errorEnvelope(res).error.field).toBe("--data seo_title");
  });

  it("exits 2 when content_id is not a UUID, rather than minting a duplicate", async () => {
    const res = await runCli(publishArgs({ ...BODY, content_id: "c-1" }, "--output", "json"));

    expect(res.exitCode).toBe(2);
    const err = errorEnvelope(res);
    expect(err.error.field).toBe("--data content_id");
    expect(err.error.received).toBe("c-1");
  });

  it("exits 2 when geo_question_id is not a UUID", async () => {
    const res = await runCli(draftArgs({ ...BODY, geo_question_id: "q-1" }, "--output", "json"));

    expect(res.exitCode).toBe(2);
    expect(errorEnvelope(res).error.field).toBe("--data geo_question_id");
  });

  it("exits 2 on a key the endpoint does not accept, because the API drops it silently", async () => {
    const res = await runCli(publishArgs({ ...BODY, url_slug: "how-refunds-work" }));

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("url_slug");
  });

  it("refuses publish-only keys in draft's --data", async () => {
    const res = await runCli(draftArgs({ ...BODY, publisher_ids: [PUBLISHER_ID] }));

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("publisher_ids");
  });

  it("exits 2 on an empty publisher_ids, which the API reads as EVERY destination", async () => {
    const res = await runCli(publishArgs({ ...BODY, publisher_ids: [] }, "--output", "json"));

    expect(res.exitCode).toBe(2);
    expect(errorEnvelope(res).error.hint).toContain("EVERY destination");
  });

  it("exits 2 when a publisher id is not a UUID", async () => {
    const res = await runCli(
      publishArgs({ ...BODY, publisher_ids: ["pub-1"] }, "--output", "json"),
    );

    expect(res.exitCode).toBe(2);
    expect(errorEnvelope(res).error.field).toBe("--data publisher_ids");
  });

  it("exits 2 when the Builder provenance keys are not sent as a pair", async () => {
    const res = await runCli(
      publishArgs({ ...BODY, builder_workspace_id: CONTENT_ID }, "--output", "json"),
    );

    expect(res.exitCode).toBe(2);
    const err = errorEnvelope(res);
    expect(err.error.field).toBe("--data expected_workspace_version_id");
    expect(err.error.allowed).toEqual(["builder_workspace_id", "expected_workspace_version_id"]);
  });

  it("exits 2 for manual_published_url without mark_as_published, which the API ignores", async () => {
    const res = await runCli(
      publishArgs(
        { ...BODY, manual_published_url: "https://acme.com/refunds" },
        "--output",
        "json",
      ),
    );

    expect(res.exitCode).toBe(2);
    expect(errorEnvelope(res).error.hint).toContain("looked like a successful write");
  });

  it("exits 2 when manual_published_at is not RFC 3339", async () => {
    const res = await runCli(
      publishArgs({ ...BODY, mark_as_published: true, manual_published_at: "yesterday" }),
    );

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("manual_published_at");
  });

  it("refuses a publish whose markdown still holds a missing-evidence placeholder", async () => {
    const res = await runCli(
      publishArgs(
        {
          ...BODY,
          raw_markdown: "# Refunds\n\n[Missing approved evidence: the refund window]\n",
        },
        "--output",
        "json",
      ),
    );

    expect(res.exitCode).toBe(2);
    const err = errorEnvelope(res);
    expect(err.error.received).toBe("[Missing approved evidence: the refund window]");
    expect(err.error.hint).toContain("senso engine draft");
  });

  it("accepts the same placeholder in a draft, which is allowed to be incomplete", async () => {
    server.use(http.post(apiUrl("/org/content-engine/draft"), () => HttpResponse.json(DRAFTED)));

    const res = await runCli(
      draftArgs({
        ...UPDATE_BODY,
        raw_markdown: "# Refunds\n\n[Missing approved evidence: the refund window]\n",
      }),
    );

    expect(res.exitCode).toBe(0);
  });
});

describe("engine publish, on the wire", () => {
  it("POSTs /org/content-engine/publish with the --data object forwarded verbatim", async () => {
    let seen: Request | undefined;
    server.use(
      http.post(apiUrl("/org/content-engine/publish"), ({ request }) => {
        seen = request.clone();
        return HttpResponse.json(PUBLISHED);
      }),
    );

    await runCli(publishArgs(UPDATE_BODY));

    expect(seen?.method).toBe("POST");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/content-engine/publish");
    expect(seen?.headers.get("content-type")).toBe("application/json");
    expect(seen?.headers.get("x-api-key")).toBe(TEST_API_KEY);
    // No publisher_ids key at all when the flag was not passed: absent means
    // "every configured destination", which is not the same as an empty list.
    await expect(seen?.json()).resolves.toEqual(UPDATE_BODY);
  });

  it("lets --publisher-ids override publisher_ids inside --data", async () => {
    let seen: Request | undefined;
    server.use(
      http.post(apiUrl("/org/content-engine/publish"), ({ request }) => {
        seen = request.clone();
        return HttpResponse.json(PUBLISHED);
      }),
    );

    await runCli(
      publishArgs(
        { ...UPDATE_BODY, publisher_ids: [OTHER_PUBLISHER_ID] },
        "--publisher-ids",
        PUBLISHER_ID,
      ),
    );

    // The flag wins. Merging the two, or letting --data win, would publish to a
    // destination the caller narrowed away from.
    await expect(seen?.json()).resolves.toMatchObject({ publisher_ids: [PUBLISHER_ID] });
  });

  it("keeps publisher_ids from --data when the flag is absent", async () => {
    let seen: Request | undefined;
    server.use(
      http.post(apiUrl("/org/content-engine/publish"), ({ request }) => {
        seen = request.clone();
        return HttpResponse.json(PUBLISHED);
      }),
    );

    await runCli(publishArgs({ ...UPDATE_BODY, publisher_ids: [OTHER_PUBLISHER_ID] }));

    await expect(seen?.json()).resolves.toMatchObject({ publisher_ids: [OTHER_PUBLISHER_ID] });
  });

  it("exits 2 without sending anything when --publisher-ids is not a UUID", async () => {
    const res = await runCli(publishArgs(UPDATE_BODY, "--publisher-ids", "citeables"));

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("--publisher-ids");
  });
});

describe("engine draft, on the wire", () => {
  it("POSTs /org/content-engine/draft, a different path from publish", async () => {
    let seen: Request | undefined;
    server.use(
      http.post(apiUrl("/org/content-engine/draft"), ({ request }) => {
        seen = request.clone();
        return HttpResponse.json(DRAFTED);
      }),
    );

    await runCli(draftArgs(UPDATE_BODY));

    expect(seen?.method).toBe("POST");
    // If this ever became the publish path, a review step would go live.
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/content-engine/draft");
    await expect(seen?.json()).resolves.toEqual(UPDATE_BODY);
  });
});

describe("engine publish, on success", () => {
  it("prints the payload under data, with nothing beside it", async () => {
    server.use(
      http.post(apiUrl("/org/content-engine/publish"), () => HttpResponse.json(PUBLISHED)),
    );

    const res = await runCli(publishArgs(UPDATE_BODY, "--output", "json"));

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual(PUBLISHED);
    expect(envelope(res).command).toBe("engine publish");
    expect(res.stderr).toBe("");
  });

  it("warns that a body with no content_id created a NEW item", async () => {
    // Correct on a first save and a duplicate on every call after it, and the
    // payload looks identical either way.
    server.use(
      http.post(apiUrl("/org/content-engine/publish"), () => HttpResponse.json(PUBLISHED)),
    );

    const res = await runCli(publishArgs(BODY, "--output", "json"));

    expect(res.exitCode).toBe(0);
    const warnings = envelope(res).warnings ?? [];
    expect(warnings.join(" ")).toContain("NEW content item");
    expect(warnings.join(" ")).toContain(CONTENT_ID);
  });

  it("says nothing about creating anything when content_id was sent", async () => {
    server.use(
      http.post(apiUrl("/org/content-engine/publish"), () => HttpResponse.json(PUBLISHED)),
    );

    const res = await runCli(publishArgs(UPDATE_BODY, "--output", "json"));

    expect(envelope(res).warnings).toBeUndefined();
  });

  it("treats a PARTIAL refusal as a success with a warning, because it is live somewhere", async () => {
    server.use(
      http.post(apiUrl("/org/content-engine/publish"), () => HttpResponse.json(PARTIALLY_REFUSED)),
    );

    const res = await runCli(publishArgs(UPDATE_BODY, "--output", "json"));

    expect(res.exitCode).toBe(0);
    const warnings = (envelope(res).warnings ?? []).join(" ");
    expect(warnings).toContain("1 of 2 destination(s) refused");
    expect(warnings).toContain("webflow: collection not authorized");
    expect(warnings).toContain("senso publish-records retry");
  });

  it("warns that a publish with no destinations reached nobody", async () => {
    server.use(
      http.post(apiUrl("/org/content-engine/publish"), () =>
        HttpResponse.json({
          content_id: CONTENT_ID,
          version_id: VERSION_ID,
          version_num: 3,
          citeables_action: "",
          publish_status: "success",
          editorial_status: "published",
          publish_destination: "",
        }),
      ),
    );

    const res = await runCli(publishArgs(UPDATE_BODY, "--output", "json"));

    expect(res.exitCode).toBe(0);
    expect((envelope(res).warnings ?? []).join(" ")).toContain("senso destinations add");
  });

  it("warns that mark_as_published without a URL leaves the item untrackable", async () => {
    server.use(
      http.post(apiUrl("/org/content-engine/publish"), () =>
        HttpResponse.json({
          content_id: CONTENT_ID,
          version_id: VERSION_ID,
          version_num: 3,
          citeables_action: "",
          publish_status: "success",
          editorial_status: "published",
          publish_destination: "",
          marked_as_published: true,
        }),
      ),
    );

    const res = await runCli(
      publishArgs({ ...UPDATE_BODY, mark_as_published: true }, "--output", "json"),
    );

    expect(res.exitCode).toBe(0);
    expect((envelope(res).warnings ?? []).join(" ")).toContain("UNTRACKED");
  });

  it("puts the tick on stderr and the payload on stdout", async () => {
    server.use(
      http.post(apiUrl("/org/content-engine/publish"), () => HttpResponse.json(PUBLISHED)),
    );

    const res = await runCli(publishArgs(UPDATE_BODY));

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain(`Content published (${CONTENT_ID})`);
    expect(res.stdout).toContain(VERSION_ID);
    expect(res.stdout).not.toContain("Content published");
  });

  it("renders the response's own fields under --output table", async () => {
    server.use(
      http.post(apiUrl("/org/content-engine/publish"), () => HttpResponse.json(PUBLISHED)),
    );

    const res = await runCli(publishArgs(UPDATE_BODY, "--output", "table"));

    expect(res.exitCode).toBe(0);
    // A single object that CONTAINS a list is not a list: rendering
    // publish_destinations as the payload would drop publish_status, which is
    // the field this command exists to report.
    expect(res.stdout).toContain("publish_status");
    expect(res.stdout).toContain("editorial_status");
    expect(res.stderr).not.toContain("which the API did not return");
  });
});

describe("engine draft, on success", () => {
  it("says the content was saved as a draft, with the id and version on stderr", async () => {
    // Under `plain` the id is on stdout only, which a caller piping the payload
    // never reads back.
    server.use(http.post(apiUrl("/org/content-engine/draft"), () => HttpResponse.json(DRAFTED)));

    const res = await runCli(draftArgs(UPDATE_BODY));

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain(`Content saved as draft ${CONTENT_ID} (version 1)`);
    expect(res.stdout).toContain(VERSION_ID);
  });

  it("offers publishing the draft back with its content_id as the next step", async () => {
    server.use(http.post(apiUrl("/org/content-engine/draft"), () => HttpResponse.json(DRAFTED)));

    const res = await runCli(draftArgs(UPDATE_BODY, "--output", "json"));

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual(DRAFTED);
    const next = (envelope(res).next ?? []).map((s) => s.command).join(" ");
    expect(next).toContain(`senso engine publish --data '{"content_id":"${CONTENT_ID}"`);
    expect(next).toContain(`senso generated-content get ${CONTENT_ID}`);
  });

  it("warns about a new item here too, since a generation loop is where it bites", async () => {
    server.use(http.post(apiUrl("/org/content-engine/draft"), () => HttpResponse.json(DRAFTED)));

    const res = await runCli(draftArgs(BODY, "--output", "json"));

    expect((envelope(res).warnings ?? []).join(" ")).toContain("NEW content item");
  });
});
