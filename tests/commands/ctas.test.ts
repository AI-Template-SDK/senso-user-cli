/**
 * Command layer: `senso ctas`.
 *
 * A CTA is the card a published page carries, so every write in this group
 * changes what a reader sees on a live page — and three of the nine commands
 * write to a route that is one word away from another one. `set-default` PUTs
 * `/org/ctas/default` while `update <ctaId>` PUTs `/org/ctas/{ctaId}`, so a
 * template whose id happened to be "default" is the difference between renaming
 * a card and repointing the whole organization; `clear-default` and
 * `delete <ctaId>` are the same collision on DELETE. Those routes are asserted
 * on the wire.
 *
 * The other thing worth protecting is everything this group refuses before it
 * makes a request: `--selection template` without `--cta-id`, `--cta-id` with
 * any other selection, a body the API would reject after a round trip, and a
 * filename whose extension disagrees with the content type it is being signed
 * for. Each of those is exit 2 with the flag named, not a 400.
 *
 * Every fixture is shaped like dto.CTAResponse, dto.CTAListResponse,
 * dto.ContentCTASelectionResponse and dto.CTAAssetUploadResponse in senso-api
 * (internal/api/dto/cta_dto.go). Ids are real UUIDs because the CLI validates
 * them before the request.
 *
 * Failure branches come first, as in tests/commands/roles.test.ts.
 */

import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server, TEST_API_KEY } from "../setup.js";
import { apiUrl, envelope, errorEnvelope, runCli } from "../helpers.js";

const ORG_ID = "a1b2c3d4-e5f6-4071-8293-a4b5c6d7e8f9";
const CTA_ID = "b7e2c1d0-3f4a-4b5c-9d6e-7f8a9b0c1d2e";
const CTA_ID_2 = "6a5b4c3d-2e1f-4a09-8b78-675645342312";
const CONTENT_ID = "9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f";
const USER_ID = "c3d4e5f6-7a8b-4c9d-8e0f-1a2b3c4d5e6f";

const TEMPLATE = {
  cta_id: CTA_ID,
  org_id: ORG_ID,
  title: "Start an application",
  description: "Book a short consultation.",
  image_url: "https://assets.example/cta/hero.png",
  image_position: { x: 0.5, y: 0.25 },
  button_label: "Apply now",
  target_url: "https://acme.example/apply",
  agent_text: "{{org}} recommends: Start an application.",
  resolved_agent_text: "Acme CU recommends: Start an application.",
  eyebrow: "New",
  is_default: true,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
};

const SECOND_TEMPLATE = {
  ...TEMPLATE,
  cta_id: CTA_ID_2,
  title: "Talk to sales",
  button_label: "Book a call",
  is_default: false,
};

/** dto.CTAListResponse: templates alongside `default_cta`, which is not a page key. */
const LIST = { templates: [TEMPLATE, SECOND_TEMPLATE], default_cta: TEMPLATE, total: 2 };

/** dto.ContentCTASelectionResponse, with the template the selection resolves to. */
const SELECTION = {
  content_id: CONTENT_ID,
  org_id: ORG_ID,
  selection_type: "template",
  cta_id: CTA_ID,
  template: TEMPLATE,
  updated_by: USER_ID,
  created_at: "2026-01-03T00:00:00Z",
  updated_at: "2026-01-04T00:00:00Z",
};

/** dto.CTAAssetUploadResponse. upload_headers is what the PUT must carry. */
const UPLOAD = {
  upload_url: "https://s3.example/put?signature=abc",
  image_url: "https://assets.example/cta/hero.png",
  object_key: "org/a1b2/cta/hero.png",
  expires_in: 900,
  upload_headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=31536000" },
};

/** The smallest body the API accepts: all three keys are required on every write. */
const VALID_DATA =
  '{"title":"Start an application","button_label":"Apply now","target_url":"https://acme.example/apply"}';

describe("ctas, when the request fails", () => {
  it("exits 3 and explains how to authenticate when there is no API key", async () => {
    const res = await runCli(["ctas", "list"], { withKey: false });

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("no API key found");
  });

  it("exits 3 when the API rejects the key", async () => {
    server.use(
      http.get(apiUrl("/org/ctas"), () =>
        HttpResponse.json({ error: "invalid key" }, { status: 401 }),
      ),
    );

    const res = await runCli(["ctas", "list"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Authentication failed");
  });

  it("exits 3 and blames the plan when the organization lacks the GEO product", async () => {
    server.use(
      http.get(apiUrl("/org/ctas"), () =>
        HttpResponse.json({ error: "GEO product required" }, { status: 403 }),
      ),
    );

    const res = await runCli(["ctas", "list"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("does not have the product");
  });

  it("exits 4 naming the template and where its id comes from", async () => {
    server.use(
      http.put(apiUrl("/org/ctas/:ctaId"), () =>
        HttpResponse.json({ error: "CTA template not found" }, { status: 404 }),
      ),
    );

    const res = await runCli(["ctas", "update", CTA_ID, "--data", VALID_DATA, "--output", "json"]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");

    const { error } = errorEnvelope(res);
    expect(error.code).toBe("not_found");
    expect(error.message).toContain(`CTA template ${CTA_ID}`);
    expect(error.field).toBe("cta_id");
    expect(error.hint).toContain("senso ctas list");
  });

  it("tells the two 404s of set-for-content apart, naming the template when it is the missing one", async () => {
    // The route can miss on the content OR on the template named by --cta-id.
    // Reported identically, a caller cannot tell which id it got wrong.
    server.use(
      http.put(apiUrl("/org/content/:id/cta"), () =>
        HttpResponse.json({ error: "CTA template not found" }, { status: 404 }),
      ),
    );

    const res = await runCli([
      "ctas",
      "set-for-content",
      CONTENT_ID,
      "--selection",
      "template",
      "--cta-id",
      CTA_ID,
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(4);
    const { error } = errorEnvelope(res);
    expect(error.message).toContain(`CTA template ${CTA_ID}`);
    expect(error.field).toBe("cta_id");
  });

  it("blames the content when set-for-content misses and no template was named", async () => {
    server.use(
      http.put(apiUrl("/org/content/:id/cta"), () =>
        HttpResponse.json({ error: "Content not found" }, { status: 404 }),
      ),
    );

    const res = await runCli([
      "ctas",
      "set-for-content",
      CONTENT_ID,
      "--selection",
      "none",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(4);
    const { error } = errorEnvelope(res);
    expect(error.message).toContain(`Content ${CONTENT_ID}`);
    expect(error.field).toBe("content_id");
    expect(error.hint).toContain("content-engine content");
  });

  it("exits 1 on a 409, naming the command that has to run first", async () => {
    server.use(
      http.delete(apiUrl("/org/ctas/:ctaId"), () =>
        HttpResponse.json({ error: "default CTA template cannot be deleted" }, { status: 409 }),
      ),
    );

    const res = await runCli(["ctas", "delete", CTA_ID, "--output", "json"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");

    const { error } = errorEnvelope(res);
    expect(error.code).toBe("conflict");
    expect(error.status).toBe(409);
    expect(error.field).toBe("<ctaId>");
    // "cannot be deleted" does not say what to do; `clear-default` does.
    expect(error.hint).toContain("senso ctas clear-default");
  });

  it("exits 1 on a 503 and says it is NOT a transient failure", async () => {
    // Image storage that is not configured on this deployment will not become
    // configured because the caller retried.
    server.use(
      http.post(apiUrl("/org/cta-assets/upload-url"), () =>
        HttpResponse.json({ error: "CTA image storage is not configured" }, { status: 503 }),
      ),
    );

    const res = await runCli([
      "ctas",
      "upload-url",
      "--filename",
      "hero.png",
      "--content-type",
      "image/png",
      "--size",
      "245760",
    ]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("not a transient failure");
    expect(res.stderr).not.toContain("Retry shortly");
  });

  it("reports a malformed body rather than throwing a parse error at the user", async () => {
    server.use(http.get(apiUrl("/org/ctas"), () => new HttpResponse("<html>nope</html>")));

    const res = await runCli(["ctas", "list"]);

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("Invalid JSON response");
  });

  it("writes the failure envelope to stderr, leaving stdout empty, under --output json", async () => {
    server.use(
      http.get(apiUrl("/org/ctas"), () => HttpResponse.json({ error: "nope" }, { status: 403 })),
    );

    const res = await runCli(["ctas", "list", "--output", "json"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");

    const reported = errorEnvelope(res);
    expect(reported.ok).toBe(false);
    expect(reported.command).toBe("ctas list");
    expect(reported.error).toMatchObject({ code: "forbidden", status: 403 });
  });
});

describe("ctas, refusing a request before making it", () => {
  // No handler is registered in this block: setup.ts fails any request that
  // reaches the network, so each of these also proves nothing was sent.
  it("exits 2 when --selection template is given without --cta-id", async () => {
    const res = await runCli([
      "ctas",
      "set-for-content",
      CONTENT_ID,
      "--selection",
      "template",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");

    const { error } = errorEnvelope(res);
    expect(error.field).toBe("--cta-id");
    expect(error.message).toContain("--cta-id is required");
  });

  it("exits 2 when --cta-id is passed with a selection that cannot carry one", async () => {
    const res = await runCli([
      "ctas",
      "set-for-content",
      CONTENT_ID,
      "--selection",
      "none",
      "--cta-id",
      CTA_ID,
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");

    const { error } = errorEnvelope(res);
    expect(error.field).toBe("--cta-id");
    expect(error.received).toBe(CTA_ID);
  });

  it("exits 2 and names the valid values when --selection is not one of them", async () => {
    const res = await runCli([
      "ctas",
      "set-for-content",
      CONTENT_ID,
      "--selection",
      "banner",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    const { error } = errorEnvelope(res);
    expect(error.allowed).toEqual(["default", "template", "none"]);
  });

  it("exits 2 with the id named when <contentId> is not a UUID", async () => {
    const res = await runCli(["ctas", "for-content", "c-1", "--output", "json"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");

    const { error } = errorEnvelope(res);
    expect(error.code).toBe("usage");
    expect(error.field).toBe("<contentId>");
    expect(error.received).toBe("c-1");
  });

  it("exits 2 with the id named when <ctaId> is not a UUID", async () => {
    const res = await runCli(["ctas", "delete", "cta-1", "--output", "json"]);

    expect(res.exitCode).toBe(2);
    const { error } = errorEnvelope(res);
    expect(error.field).toBe("<ctaId>");
    expect(error.hint).toContain("senso ctas list");
  });

  it("exits 2 when --data is not valid JSON on create", async () => {
    const res = await runCli(["ctas", "create", "--data", "{not json"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("--data");
  });

  it("exits 2 when --data is valid JSON but not an object on update", async () => {
    const res = await runCli(["ctas", "update", CTA_ID, "--data", "[1,2]"]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("must be a JSON object");
  });

  it("exits 2 naming the keys the API requires on every write", async () => {
    const res = await runCli(["ctas", "create", "--data", '{"title":"Start"}', "--output", "json"]);

    expect(res.exitCode).toBe(2);
    const { error } = errorEnvelope(res);
    expect(error.message).toContain("button_label");
    expect(error.message).toContain("target_url");
  });

  it("exits 2 rather than sending a key the API would silently drop", async () => {
    const res = await runCli([
      "ctas",
      "create",
      "--data",
      '{"title":"Start","button_label":"Apply","target_url":"https://acme.example/a","subtitle":"typo"}',
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    const { error } = errorEnvelope(res);
    expect(error.message).toContain("subtitle");
  });

  it("exits 2 when target_url is relative, which the API reports only as Invalid value", async () => {
    const res = await runCli([
      "ctas",
      "create",
      "--data",
      '{"title":"Start","button_label":"Apply","target_url":"/apply"}',
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    const { error } = errorEnvelope(res);
    expect(error.field).toBe("--data.target_url");
    expect(error.received).toBe("/apply");
  });

  it("exits 2 when a value is past the length the API validates it against", async () => {
    const res = await runCli([
      "ctas",
      "create",
      "--data",
      JSON.stringify({
        title: "Start an application",
        button_label: "x".repeat(121),
        target_url: "https://acme.example/apply",
      }),
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    const { error } = errorEnvelope(res);
    expect(error.field).toBe("--data.button_label");
    expect(error.message).toContain("the maximum is 120");
  });

  it("exits 2 when image_position is outside the 0 to 1 focal square", async () => {
    const res = await runCli([
      "ctas",
      "create",
      "--data",
      '{"title":"Start","button_label":"Apply","target_url":"https://acme.example/a","image_position":{"x":1.5,"y":0.2}}',
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    const { error } = errorEnvelope(res);
    expect(error.field).toBe("--data.image_position.x");
  });

  it("exits 2 when --content-type is not an accepted image type", async () => {
    const res = await runCli([
      "ctas",
      "upload-url",
      "--filename",
      "hero.tiff",
      "--content-type",
      "image/tiff",
      "--size",
      "1024",
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("image/png");
  });

  it("exits 2 when the filename's extension disagrees with --content-type", async () => {
    // The API answers "unsupported CTA image content type", which reads as
    // though the media type were wrong rather than the pairing.
    const res = await runCli([
      "ctas",
      "upload-url",
      "--filename",
      "hero.jpg",
      "--content-type",
      "image/png",
      "--size",
      "1024",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    const { error } = errorEnvelope(res);
    expect(error.field).toBe("--filename");
    expect(error.allowed).toEqual([".png"]);
  });

  it("exits 2 when --size is past the 10 MiB ceiling", async () => {
    const res = await runCli([
      "ctas",
      "upload-url",
      "--filename",
      "hero.png",
      "--content-type",
      "image/png",
      "--size",
      "10485761",
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("out of range");
  });

  it("exits 2 when --size is not a whole number", async () => {
    const res = await runCli([
      "ctas",
      "upload-url",
      "--filename",
      "hero.png",
      "--content-type",
      "image/png",
      "--size",
      "big",
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("not a whole number");
  });
});

describe("ctas, on the wire", () => {
  it("reads the templates from /org/ctas with the key as X-API-Key", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/ctas"), ({ request }) => {
        seen = request;
        return HttpResponse.json(LIST);
      }),
    );

    await runCli(["ctas", "list"]);

    expect(seen?.method).toBe("GET");
    expect(seen?.headers.get("x-api-key")).toBe(TEST_API_KEY);
  });

  it("posts the --data body to /org/ctas verbatim on create", async () => {
    let body: unknown;
    server.use(
      http.post(apiUrl("/org/ctas"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(TEMPLATE, { status: 201 });
      }),
    );

    await runCli([
      "ctas",
      "create",
      "--data",
      '{"title":"Start an application","button_label":"Apply now","target_url":"https://acme.example/apply","is_default":true}',
    ]);

    expect(body).toEqual({
      title: "Start an application",
      button_label: "Apply now",
      target_url: "https://acme.example/apply",
      is_default: true,
    });
  });

  it("puts the body to /org/ctas/{ctaId} on update, not to the default route", async () => {
    let url: string | undefined;
    let body: unknown;
    server.use(
      http.put(apiUrl("/org/ctas/:ctaId"), async ({ request }) => {
        url = request.url;
        body = await request.json();
        return HttpResponse.json(TEMPLATE);
      }),
    );

    await runCli(["ctas", "update", CTA_ID, "--data", VALID_DATA]);

    expect(url).toContain(`/org/ctas/${CTA_ID}`);
    expect(body).toEqual({
      title: "Start an application",
      button_label: "Apply now",
      target_url: "https://acme.example/apply",
    });
  });

  it("deletes /org/ctas/{ctaId} for a single template", async () => {
    let url: string | undefined;
    server.use(
      http.delete(apiUrl("/org/ctas/:ctaId"), ({ request }) => {
        url = request.url;
        return HttpResponse.json({ deleted: true });
      }),
    );

    await runCli(["ctas", "delete", CTA_ID_2]);

    expect(url).toContain(`/org/ctas/${CTA_ID_2}`);
  });

  it("sends set-default as a PUT to /org/ctas/default carrying cta_id in the body", async () => {
    let url: string | undefined;
    let body: unknown;
    server.use(
      http.put(apiUrl("/org/ctas/default"), async ({ request }) => {
        url = request.url;
        body = await request.json();
        return HttpResponse.json(TEMPLATE);
      }),
    );

    await runCli(["ctas", "set-default", CTA_ID]);

    // The id travels in the body, not the path: a PUT to /org/ctas/<id> would
    // rewrite the template instead of promoting it.
    expect(url).toContain("/org/ctas/default");
    expect(body).toEqual({ cta_id: CTA_ID });
  });

  it("sends clear-default as a bodyless DELETE to /org/ctas/default", async () => {
    let seen: Request | undefined;
    server.use(
      http.delete(apiUrl("/org/ctas/default"), ({ request }) => {
        seen = request;
        return HttpResponse.json({ cleared: true });
      }),
    );

    await runCli(["ctas", "clear-default"]);

    expect(seen?.method).toBe("DELETE");
    expect(seen?.url).toContain("/org/ctas/default");
    expect(await seen?.text()).toBe("");
  });

  it("reads a content item's selection from /org/content/{id}/cta", async () => {
    let url: string | undefined;
    server.use(
      http.get(apiUrl("/org/content/:id/cta"), ({ request }) => {
        url = request.url;
        return HttpResponse.json(SELECTION);
      }),
    );

    await runCli(["ctas", "for-content", CONTENT_ID]);

    expect(url).toContain(`/org/content/${CONTENT_ID}/cta`);
  });

  it("sends selection_type and cta_id when a template is pinned", async () => {
    let body: unknown;
    server.use(
      http.put(apiUrl("/org/content/:id/cta"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(SELECTION);
      }),
    );

    await runCli([
      "ctas",
      "set-for-content",
      CONTENT_ID,
      "--selection",
      "template",
      "--cta-id",
      CTA_ID,
    ]);

    expect(body).toEqual({ selection_type: "template", cta_id: CTA_ID });
  });

  it("omits cta_id entirely when the selection is default", async () => {
    let body: unknown;
    server.use(
      http.put(apiUrl("/org/content/:id/cta"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({
          content_id: CONTENT_ID,
          org_id: ORG_ID,
          selection_type: "default",
          template: TEMPLATE,
        });
      }),
    );

    await runCli(["ctas", "set-for-content", CONTENT_ID, "--selection", "DEFAULT"]);

    // Also the case-folding check: parseEnumFlag canonicalizes on the way out,
    // so the API never sees "DEFAULT".
    expect(body).toEqual({ selection_type: "default" });
  });

  it("sends the file description to /org/cta-assets/upload-url in snake_case", async () => {
    let body: unknown;
    server.use(
      http.post(apiUrl("/org/cta-assets/upload-url"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(UPLOAD);
      }),
    );

    await runCli([
      "ctas",
      "upload-url",
      "--filename",
      "hero.png",
      "--content-type",
      "image/png",
      "--size",
      "245760",
    ]);

    expect(body).toEqual({
      filename: "hero.png",
      content_type: "image/png",
      file_size_bytes: 245760,
    });
  });
});

describe("ctas list, on success", () => {
  it("wraps the payload, unmodified, in the envelope under --output json", async () => {
    server.use(http.get(apiUrl("/org/ctas"), () => HttpResponse.json(LIST)));

    const res = await runCli(["ctas", "list", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual(LIST);
    expect(envelope(res).command).toBe("ctas list");
    expect(res.stderr).toBe("");
  });

  it("renders one row per template under --output table, despite default_cta", async () => {
    // `default_cta` sits alongside `templates` and is not a pagination key, so
    // the generic row-finder declines the response; the command names the rows.
    server.use(http.get(apiUrl("/org/ctas"), () => HttpResponse.json(LIST)));

    const res = await runCli(["ctas", "list", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("cta_id");
    expect(res.stdout).toContain(CTA_ID);
    expect(res.stdout).toContain("Talk to sales");
    expect(res.stderr).not.toContain("did not return");
  });

  it("renders a readable block per template by default", async () => {
    server.use(http.get(apiUrl("/org/ctas"), () => HttpResponse.json(LIST)));

    const res = await runCli(["ctas", "list"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Start an application");
    expect(res.stdout).toContain("Book a call");
  });

  it("says so plainly, and says how to fix it, when the organization has no templates", async () => {
    server.use(http.get(apiUrl("/org/ctas"), () => HttpResponse.json({ templates: [], total: 0 })));

    const res = await runCli(["ctas", "list"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("No CTA templates found.");
    expect(res.stderr).toContain("senso ctas create");
  });

  it("points out that templates exist but none of them is the organization default", async () => {
    // Items on the `default` selection then carry no card at all, which is not
    // visible from the list itself.
    server.use(
      http.get(apiUrl("/org/ctas"), () =>
        HttpResponse.json({ templates: [{ ...TEMPLATE, is_default: false }], total: 1 }),
      ),
    );

    const res = await runCli(["ctas", "list", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(envelope(res).next?.[0]?.command).toBe("senso ctas set-default <cta_id>");
  });
});

describe("ctas writes, on success", () => {
  it("puts the created template on stdout and the tick on stderr", async () => {
    server.use(http.post(apiUrl("/org/ctas"), () => HttpResponse.json(TEMPLATE, { status: 201 })));

    const res = await runCli(["ctas", "create", "--data", VALID_DATA]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Start an application");
    expect(res.stderr).toContain("Created CTA template");
    expect(res.stdout).not.toContain("Created CTA template");
  });

  it("says out loud when a write reached pages that are already published", async () => {
    server.use(
      http.put(apiUrl("/org/ctas/default"), () =>
        HttpResponse.json({ ...TEMPLATE, live_update_queued: true, live_update_count: 12 }),
      ),
    );

    const res = await runCli(["ctas", "set-default", CTA_ID, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(envelope(res).warnings?.join(" ")).toContain("12 live pages");
  });

  it("emits the promoted template as the payload under --output json on set-default", async () => {
    server.use(http.put(apiUrl("/org/ctas/default"), () => HttpResponse.json(TEMPLATE)));

    const res = await runCli(["ctas", "set-default", CTA_ID, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual(TEMPLATE);
    expect(res.stderr).toBe("");
  });

  it("names what was deleted on stdout under --output json, rather than a sentence", async () => {
    server.use(http.delete(apiUrl("/org/ctas/:ctaId"), () => HttpResponse.json({ deleted: true })));

    const res = await runCli(["ctas", "delete", CTA_ID_2, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual({ action: "deleted", resource: "cta_template", id: CTA_ID_2 });
    expect(envelope(res).warnings?.join(" ")).toContain("fall back to the organization default");
  });

  it("puts the clear-default confirmation on stderr and leaves stdout empty", async () => {
    server.use(
      http.delete(apiUrl("/org/ctas/default"), () => HttpResponse.json({ cleared: true })),
    );

    const res = await runCli(["ctas", "clear-default"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("default");
  });

  it("warns when the API stored a selection different from the one that was asked for", async () => {
    // Pinning the template that is already the organization default is stored
    // as `default`, so a caller verifying its own write finds a selection_type
    // it never asked for.
    server.use(
      http.put(apiUrl("/org/content/:id/cta"), () =>
        HttpResponse.json({ ...SELECTION, selection_type: "default" }),
      ),
    );

    const res = await runCli([
      "ctas",
      "set-for-content",
      CONTENT_ID,
      "--selection",
      "template",
      "--cta-id",
      CTA_ID,
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    expect(envelope(res).warnings?.join(" ")).toContain('Stored as selection_type "default"');
  });

  it("renders a single selection as a two-column table under --output table", async () => {
    server.use(http.get(apiUrl("/org/content/:id/cta"), () => HttpResponse.json(SELECTION)));

    const res = await runCli(["ctas", "for-content", CONTENT_ID, "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("selection_type");
    expect(res.stdout).toContain("template");
  });

  it("renders a selection as key/value lines by default, the template nested", async () => {
    server.use(http.get(apiUrl("/org/content/:id/cta"), () => HttpResponse.json(SELECTION)));

    const res = await runCli(["ctas", "for-content", CONTENT_ID]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("content_id");
    expect(res.stdout).toContain(CTA_ID);
    expect(res.stdout).toContain("button_label");
    expect(res.stdout).not.toContain("[object Object]");
  });

  it("hands back a runnable upload command, since the CLI never uploads the bytes", async () => {
    server.use(http.post(apiUrl("/org/cta-assets/upload-url"), () => HttpResponse.json(UPLOAD)));

    const res = await runCli([
      "ctas",
      "upload-url",
      "--filename",
      "hero.png",
      "--content-type",
      "image/png",
      "--size",
      "245760",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual(UPLOAD);

    const next = envelope(res).next ?? [];
    expect(next[0]?.command).toContain(UPLOAD.upload_url);
    expect(next[1]?.command).toContain(UPLOAD.image_url);
  });
});
