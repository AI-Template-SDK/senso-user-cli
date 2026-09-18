/**
 * Command layer: `senso engine`.
 *
 * These two commands are the only ones in the CLI that push content outside the
 * organization, so what goes on the wire is not a detail — it is the difference
 * between a draft sitting in review and an article live on a customer's site.
 * `publish` and `draft` take the same flags and print the same shape of result;
 * only the path distinguishes them, which is exactly the kind of thing a
 * refactor gets wrong quietly.
 *
 * The second thing worth protecting is the precedence rule. `--publisher-ids`
 * is documented to override any `publisher_ids` inside `--data`, and omitting it
 * means "every configured destination". Getting that backwards would publish to
 * destinations the caller explicitly narrowed away from, and nothing the user
 * sees would say so.
 *
 * The third is that a publish answers 200 even when a destination failed. The
 * outcome is per-destination, under `publish_destinations[].status`, so
 * `publish` used to print "Content published." over a publish that reached
 * nothing. Success is now read out of the body: a partial failure warns, and
 * every destination failing exits 1.
 */

import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server, TEST_API_KEY } from "../setup.js";
import { apiUrl, runCli } from "../helpers.js";

const PUBLISH_BODY = {
  geo_question_id: "q-1",
  raw_markdown: "# Hello\n\nBody.",
  seo_title: "Hello",
  summary: "A greeting.",
};

const RESULT = {
  content_id: "c-1",
  status: "published",
  publish_records: [{ publish_record_id: "pr-1", publisher_id: "pub-1", state: "live" }],
};

const DRAFT_RESULT = { content_id: "c-2", status: "draft" };

describe("engine publish, when the request fails", () => {
  it("exits 3 and explains how to authenticate when there is no API key", async () => {
    const res = await runCli(["engine", "publish", "--data", JSON.stringify(PUBLISH_BODY)], {
      withKey: false,
    });

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

    const res = await runCli(["engine", "publish", "--data", JSON.stringify(PUBLISH_BODY)]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Authentication failed");
  });

  it("exits 3 when the key is valid but may not publish", async () => {
    server.use(
      http.post(apiUrl("/org/content-engine/publish"), () =>
        HttpResponse.json({ error: "publishing requires the content scope" }, { status: 403 }),
      ),
    );

    const res = await runCli(["engine", "publish", "--data", JSON.stringify(PUBLISH_BODY)]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Permission denied");
  });

  it("exits 4 when the geo question does not exist", async () => {
    server.use(
      http.post(
        apiUrl("/org/content-engine/publish"),
        () => new HttpResponse(null, { status: 404 }),
      ),
    );

    const res = await runCli(["engine", "publish", "--data", JSON.stringify(PUBLISH_BODY)]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Not found");
  });

  it("exits 1, not 3, when the organization is out of credits", async () => {
    // 402 is deliberately not an auth failure: the key is fine, so retrying with
    // a different key is the wrong reaction.
    server.use(
      http.post(apiUrl("/org/content-engine/publish"), () =>
        HttpResponse.json({ error: "no credits" }, { status: 402 }),
      ),
    );

    const res = await runCli(["engine", "publish", "--data", JSON.stringify(PUBLISH_BODY)]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Insufficient credits");
  });

  it("exits 1 on a 500 and says it is not the caller's fault", async () => {
    server.use(
      http.post(
        apiUrl("/org/content-engine/publish"),
        () => new HttpResponse(null, { status: 500 }),
      ),
    );

    const res = await runCli(["engine", "publish", "--data", JSON.stringify(PUBLISH_BODY)]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("not your fault");
  });

  it("writes the failure to stderr as JSON, leaving stdout empty, under --output json", async () => {
    server.use(
      http.post(apiUrl("/org/content-engine/publish"), () =>
        HttpResponse.json({ error: "nope" }, { status: 403 }),
      ),
    );

    const res = await runCli([
      "engine",
      "publish",
      "--data",
      JSON.stringify(PUBLISH_BODY),
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(3);
    // A publishing pipeline that reads stdout must not mistake an error object
    // for a publish result.
    expect(res.stdout).toBe("");

    const reported: unknown = JSON.parse(res.stderr);
    expect(reported).toMatchObject({
      error: { code: "forbidden", status: 403 },
    });
  });
});

describe("engine publish and draft, when the flag is wrong", () => {
  it("exits 2 when publish's --data is not valid JSON, without making a request", async () => {
    // No handler registered: reaching the network would fail this test, which
    // is how "nothing is published before the flag is validated" is proven.
    const res = await runCli(["engine", "publish", "--data", "{geo_question_id: q-1}"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Invalid JSON in --data");
  });

  it("exits 2 when draft's --data is not valid JSON, without making a request", async () => {
    const res = await runCli(["engine", "draft", "--data", "still not json"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Invalid JSON in --data");
  });

  it("exits 2 when --data is valid JSON but not an object", async () => {
    const res = await runCli(["engine", "publish", "--data", "[]"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("--data must be a JSON object");
  });

  it("reports the usage failure as JSON on stderr under --output json", async () => {
    const res = await runCli(["engine", "draft", "--data", "{,}", "--output", "json"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(JSON.parse(res.stderr)).toMatchObject({ error: { code: "invalid_json" } });
  });
});

describe("engine publish, on the wire", () => {
  it("POSTs /org/content-engine/publish with the --data object forwarded verbatim", async () => {
    let seen: Request | undefined;
    server.use(
      http.post(apiUrl("/org/content-engine/publish"), ({ request }) => {
        seen = request.clone();
        return HttpResponse.json(RESULT);
      }),
    );

    await runCli(["engine", "publish", "--data", JSON.stringify(PUBLISH_BODY)]);

    expect(seen?.method).toBe("POST");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/content-engine/publish");
    expect(seen?.headers.get("content-type")).toBe("application/json");
    expect(seen?.headers.get("x-api-key")).toBe(TEST_API_KEY);
    // No publisher_ids key at all when the flag was not passed: absent means
    // "every configured destination", which is not the same as an empty list.
    await expect(seen?.json()).resolves.toEqual(PUBLISH_BODY);
  });

  it("adds publisher_ids to the body when --publisher-ids is given", async () => {
    let seen: Request | undefined;
    server.use(
      http.post(apiUrl("/org/content-engine/publish"), ({ request }) => {
        seen = request.clone();
        return HttpResponse.json(RESULT);
      }),
    );

    await runCli([
      "engine",
      "publish",
      "--data",
      JSON.stringify(PUBLISH_BODY),
      "--publisher-ids",
      "pub-1",
      "pub-2",
    ]);

    await expect(seen?.json()).resolves.toEqual({
      ...PUBLISH_BODY,
      publisher_ids: ["pub-1", "pub-2"],
    });
  });

  it("lets --publisher-ids override publisher_ids inside --data", async () => {
    let seen: Request | undefined;
    server.use(
      http.post(apiUrl("/org/content-engine/publish"), ({ request }) => {
        seen = request.clone();
        return HttpResponse.json(RESULT);
      }),
    );

    await runCli([
      "engine",
      "publish",
      "--data",
      JSON.stringify({ ...PUBLISH_BODY, publisher_ids: ["from-data"] }),
      "--publisher-ids",
      "from-flag",
    ]);

    // The flag wins. Merging the two, or letting --data win, would publish to a
    // destination the caller narrowed away from.
    await expect(seen?.json()).resolves.toMatchObject({ publisher_ids: ["from-flag"] });
  });

  it("keeps publisher_ids from --data when the flag is absent", async () => {
    let seen: Request | undefined;
    server.use(
      http.post(apiUrl("/org/content-engine/publish"), ({ request }) => {
        seen = request.clone();
        return HttpResponse.json(RESULT);
      }),
    );

    await runCli([
      "engine",
      "publish",
      "--data",
      JSON.stringify({ ...PUBLISH_BODY, publisher_ids: ["from-data"] }),
    ]);

    await expect(seen?.json()).resolves.toMatchObject({ publisher_ids: ["from-data"] });
  });

  it("forwards mark_as_published and manual_published_at untouched", async () => {
    let seen: Request | undefined;
    server.use(
      http.post(apiUrl("/org/content-engine/publish"), ({ request }) => {
        seen = request.clone();
        return HttpResponse.json(RESULT);
      }),
    );

    await runCli([
      "engine",
      "publish",
      "--data",
      JSON.stringify({
        ...PUBLISH_BODY,
        mark_as_published: true,
        manual_published_at: "2026-06-11T00:00:00Z",
      }),
    ]);

    await expect(seen?.json()).resolves.toMatchObject({
      mark_as_published: true,
      manual_published_at: "2026-06-11T00:00:00Z",
    });
  });
});

describe("engine draft, on the wire", () => {
  it("POSTs /org/content-engine/draft, a different path from publish", async () => {
    let seen: Request | undefined;
    server.use(
      http.post(apiUrl("/org/content-engine/draft"), ({ request }) => {
        seen = request.clone();
        return HttpResponse.json(DRAFT_RESULT);
      }),
    );

    await runCli(["engine", "draft", "--data", JSON.stringify(PUBLISH_BODY)]);

    expect(seen?.method).toBe("POST");
    // If this ever became the publish path, a review step would go live.
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/content-engine/draft");
    await expect(seen?.json()).resolves.toEqual(PUBLISH_BODY);
  });
});

describe("engine publish, on success", () => {
  it("prints the payload unmodified under --output json, with no tick beside it", async () => {
    server.use(http.post(apiUrl("/org/content-engine/publish"), () => HttpResponse.json(RESULT)));

    const res = await runCli([
      "engine",
      "publish",
      "--data",
      JSON.stringify(PUBLISH_BODY),
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toEqual(RESULT);
    expect(res.stderr).toBe("");
  });

  it("puts the tick on stderr and the publish records on stdout", async () => {
    server.use(http.post(apiUrl("/org/content-engine/publish"), () => HttpResponse.json(RESULT)));

    const res = await runCli(["engine", "publish", "--data", JSON.stringify(PUBLISH_BODY)]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("pr-1");
    expect(res.stderr).toContain("Content published");
    expect(res.stdout).not.toContain("Content published");
  });

  it("renders the result under --output table", async () => {
    server.use(http.post(apiUrl("/org/content-engine/publish"), () => HttpResponse.json(RESULT)));

    const res = await runCli([
      "engine",
      "publish",
      "--data",
      JSON.stringify(PUBLISH_BODY),
      "--output",
      "table",
    ]);

    expect(res.exitCode).toBe(0);
    // The response is a single object that carries a `publish_records` list, so
    // it renders as the object's own fields — the nested list becomes one cell.
    // Rendering the list instead would drop content_id and status, which is the
    // regression tests/unit/output.test.ts pins.
    expect(res.stdout).toContain("content_id");
    expect(res.stdout).toContain("status");
    expect(res.stdout).toContain("publish_records");
  });
});

describe("engine draft, on success", () => {
  it("says the content was saved as a draft, not published", async () => {
    server.use(
      http.post(apiUrl("/org/content-engine/draft"), () => HttpResponse.json(DRAFT_RESULT)),
    );

    const res = await runCli(["engine", "draft", "--data", JSON.stringify(PUBLISH_BODY)]);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain("saved as draft");
    expect(res.stdout).toContain("c-2");
  });

  it("prints the payload alone under --output json", async () => {
    server.use(
      http.post(apiUrl("/org/content-engine/draft"), () => HttpResponse.json(DRAFT_RESULT)),
    );

    const res = await runCli([
      "engine",
      "draft",
      "--data",
      JSON.stringify(PUBLISH_BODY),
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toEqual(DRAFT_RESULT);
    expect(res.stderr).toBe("");
  });
});

describe("engine publish, when a destination fails", () => {
  const DEST_PATH = "/org/content-engine/publish";
  const DATA = '{"raw_markdown":"# Hi","seo_title":"Hi"}';

  it("exits 1 with an empty stdout when every destination failed", async () => {
    server.use(
      http.post(apiUrl(DEST_PATH), () =>
        HttpResponse.json({
          content_id: "c-1",
          version_id: "v-1",
          version_num: 2,
          publish_destinations: [
            { publisher: "citeables", status: "failed", error_msg: "upstream 502" },
          ],
        }),
      ),
    );

    const res = await runCli(["engine", "publish", "--data", DATA]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("upstream 502");
  });

  it("names the content id in the error, so a retry can target it", async () => {
    server.use(
      http.post(apiUrl(DEST_PATH), () =>
        HttpResponse.json({
          content_id: "c-42",
          version_id: "v-7",
          publish_destinations: [{ publisher: "citeables", status: "failed", error_msg: "boom" }],
        }),
      ),
    );

    const res = await runCli(["engine", "publish", "--data", DATA]);

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("c-42");
  });

  it("warns but exits 0 when only some destinations failed", async () => {
    server.use(
      http.post(apiUrl(DEST_PATH), () =>
        HttpResponse.json({
          content_id: "c-1",
          publish_destinations: [
            { publisher: "citeables", status: "success", display_url: "https://x/y" },
            { publisher: "webflow", status: "failed", error_msg: "auth expired" },
          ],
        }),
      ),
    );

    const res = await runCli(["engine", "publish", "--data", DATA]);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain("auth expired");
    expect(res.stderr).toContain("1 of 2");
    expect(res.stdout).toContain("c-1");
  });

  it("reports plain success when every destination succeeded", async () => {
    server.use(
      http.post(apiUrl(DEST_PATH), () =>
        HttpResponse.json({
          content_id: "c-1",
          publish_destinations: [{ publisher: "citeables", status: "success" }],
        }),
      ),
    );

    const res = await runCli(["engine", "publish", "--data", DATA]);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain("Content published.");
  });

  /**
   * `mark_as_published` records content as already live elsewhere without
   * pushing it anywhere, so an empty destination list is the expected shape —
   * not a publish that reached nothing.
   */
  it("treats an absent destination list as success, not total failure", async () => {
    server.use(
      http.post(apiUrl(DEST_PATH), () =>
        HttpResponse.json({ content_id: "c-1", version_id: "v-1", marked_as_published: true }),
      ),
    );

    const res = await runCli([
      "engine",
      "publish",
      "--data",
      '{"raw_markdown":"# Hi","seo_title":"Hi","mark_as_published":true}',
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain("Content published.");
  });

  it("says nothing on stderr under --quiet, whatever the outcome", async () => {
    server.use(
      http.post(apiUrl(DEST_PATH), () =>
        HttpResponse.json({
          content_id: "c-1",
          publish_destinations: [
            { publisher: "citeables", status: "success" },
            { publisher: "webflow", status: "failed", error_msg: "auth expired" },
          ],
        }),
      ),
    );

    const res = await runCli(["engine", "publish", "--data", DATA, "--quiet"]);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toBe("");
  });
});

describe("engine draft and publish, the fields the API accepts", () => {
  /**
   * `content_id` reaches the API and is what makes an edit loop revise one item
   * instead of littering new ones. It was absent from the --data help, so an
   * agent working from `--help` had no way to discover it.
   */
  it("forwards content_id on a draft", async () => {
    let body: unknown;
    server.use(
      http.post(apiUrl("/org/content-engine/draft"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ content_id: "c-1", version_id: "v-2", version_num: 2 });
      }),
    );

    const res = await runCli([
      "engine",
      "draft",
      "--data",
      '{"content_id":"c-1","raw_markdown":"# Hi","seo_title":"Hi"}',
    ]);

    expect(res.exitCode).toBe(0);
    expect(body).toEqual({ content_id: "c-1", raw_markdown: "# Hi", seo_title: "Hi" });
  });

  it("documents content_id in the draft --data help", async () => {
    const res = await runCli(["engine", "draft", "--help"]);

    expect(res.stdout + res.stderr).toContain("content_id");
  });

  it("documents content_id in the publish --data help", async () => {
    const res = await runCli(["engine", "publish", "--help"]);

    expect(res.stdout + res.stderr).toContain("content_id");
  });
});

describe("engine publish, statuses that are not `failed` but are not success", () => {
  const DEST_PATH = "/org/content-engine/publish";
  const DATA = '{"raw_markdown":"# Hi","seo_title":"Hi"}';

  /**
   * The server tests POSITIVELY for `success`; "not failed" is not "landed".
   * A `pending` destination carries an error_msg — "publish record saved but
   * enqueue failed" — and an earlier version of this command, which counted
   * only `failed`, reported an all-`pending` publish as a clean success.
   */
  it("treats an all-pending publish as a total failure, not a success", async () => {
    server.use(
      http.post(apiUrl(DEST_PATH), () =>
        HttpResponse.json({
          content_id: "c-1",
          version_id: "v-1",
          publish_destinations: [
            {
              publisher: "citeables",
              status: "pending",
              error_msg: "publish record saved but enqueue failed: queue down",
            },
          ],
        }),
      ),
    );

    const res = await runCli(["engine", "publish", "--data", DATA]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("enqueue failed");
  });

  it("counts a failed and a pending destination as two problems, not one", async () => {
    server.use(
      http.post(apiUrl(DEST_PATH), () =>
        HttpResponse.json({
          content_id: "c-1",
          publish_destinations: [
            { publisher: "citeables", status: "failed", error_msg: "boom" },
            { publisher: "webflow", status: "pending", error_msg: "enqueue failed" },
          ],
        }),
      ),
    );

    const res = await runCli(["engine", "publish", "--data", DATA]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
  });

  /**
   * `queued` is the async path's accepted state — nothing is live yet, so
   * "Content published." would be a claim the caller acts on wrongly.
   */
  it("says a fully queued publish is queued, not published", async () => {
    server.use(
      http.post(apiUrl(DEST_PATH), () =>
        HttpResponse.json({
          content_id: "c-1",
          publish_destinations: [
            { publisher: "citeables", status: "queued" },
            { publisher: "webflow", status: "queued" },
          ],
        }),
      ),
    );

    const res = await runCli(["engine", "publish", "--data", DATA]);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain("queued at 2");
    expect(res.stderr).not.toContain("Content published.");
  });

  /**
   * --output json implies --quiet, which suppresses the per-destination lines,
   * so the error itself has to carry the reasons or a JSON caller learns
   * nothing about why the publish failed.
   */
  it("carries the failure reasons in the error under --output json", async () => {
    server.use(
      http.post(apiUrl(DEST_PATH), () =>
        HttpResponse.json({
          content_id: "c-9",
          publish_destinations: [
            { publisher: "citeables", status: "failed", error_msg: "upstream 502" },
          ],
        }),
      ),
    );

    const res = await runCli(["engine", "publish", "--data", DATA, "--output", "json"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("upstream 502");
    expect(res.stderr).toContain("c-9");
  });

  it("does not throw on a body with no destinations field at all", async () => {
    server.use(http.post(apiUrl(DEST_PATH), () => new HttpResponse(null, { status: 204 })));

    const res = await runCli(["engine", "publish", "--data", DATA]);

    expect(res.exitCode).toBe(0);
  });
});
