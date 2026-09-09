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
 * The other thing worth protecting is `set-for-content`, the only command here
 * that refuses a request before making it: `--selection template` without
 * `--cta-id`, and `--cta-id` with any other selection, are both rejected by the
 * API — but a round trip to be told "cta_id must be omitted" does not tell the
 * caller which of the two flags to drop. Both branches exit 2 here instead.
 *
 * Failure branches come first, as in tests/commands/roles.test.ts.
 */

import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server, TEST_API_KEY } from "../setup.js";
import { apiUrl, runCli } from "../helpers.js";

const TEMPLATE = {
  cta_id: "cta-1",
  org_id: "org-1",
  title: "Start an application",
  description: "Book a short consultation.",
  button_label: "Apply now",
  target_url: "https://example.com/apply",
  resolved_agent_text: "Example Co. recommends: Start an application.",
  is_default: true,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
};

const SECOND_TEMPLATE = {
  ...TEMPLATE,
  cta_id: "cta-2",
  title: "Talk to sales",
  button_label: "Book a call",
  is_default: false,
};

/** The list response: templates alongside `default_cta`, which is not a page key. */
const LIST = { templates: [TEMPLATE, SECOND_TEMPLATE], default_cta: TEMPLATE, total: 2 };

const SELECTION = {
  content_id: "c-1",
  org_id: "org-1",
  selection_type: "template",
  cta_id: "cta-1",
  template: TEMPLATE,
};

describe("ctas list, when the request fails", () => {
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

  it("exits 3 when the organization does not have the GEO product", async () => {
    server.use(
      http.get(apiUrl("/org/ctas"), () =>
        HttpResponse.json({ error: "GEO product required" }, { status: 403 }),
      ),
    );

    const res = await runCli(["ctas", "list"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
  });

  it("exits 4 on a 404", async () => {
    server.use(http.get(apiUrl("/org/ctas"), () => new HttpResponse(null, { status: 404 })));

    const res = await runCli(["ctas", "list"]);

    expect(res.exitCode).toBe(4);
    expect(res.stderr).toContain("Not found");
  });

  it("exits 1 on a 503 from an unconfigured deployment", async () => {
    server.use(http.get(apiUrl("/org/ctas"), () => new HttpResponse(null, { status: 503 })));

    const res = await runCli(["ctas", "list"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
  });

  it("reports a malformed body rather than throwing a parse error at the user", async () => {
    server.use(http.get(apiUrl("/org/ctas"), () => new HttpResponse("<html>nope</html>")));

    const res = await runCli(["ctas", "list"]);

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("Invalid JSON response");
  });

  it("writes the failure to stderr as JSON, leaving stdout empty, under --output json", async () => {
    server.use(
      http.get(apiUrl("/org/ctas"), () => HttpResponse.json({ error: "nope" }, { status: 403 })),
    );

    const res = await runCli(["ctas", "list", "--output", "json"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");

    const reported: unknown = JSON.parse(res.stderr);
    expect(reported).toMatchObject({ error: { code: "forbidden", status: 403 } });
  });
});

describe("ctas, refusing a request before making it", () => {
  it("exits 2 when --selection template is given without --cta-id", async () => {
    const res = await runCli(["ctas", "set-for-content", "c-1", "--selection", "template"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("--cta-id is required");
  });

  it("exits 2 when --cta-id is passed with a selection that cannot carry one", async () => {
    const res = await runCli([
      "ctas",
      "set-for-content",
      "c-1",
      "--selection",
      "none",
      "--cta-id",
      "cta-1",
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("--cta-id");
  });

  it("exits 2 and names the valid values when --selection is not one of them", async () => {
    const res = await runCli(["ctas", "set-for-content", "c-1", "--selection", "banner"]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("default, template, none");
  });

  it("exits 2 when --data is not valid JSON on create", async () => {
    const res = await runCli(["ctas", "create", "--data", "{not json"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("--data");
  });

  it("exits 2 when --data is valid JSON but not an object on update", async () => {
    const res = await runCli(["ctas", "update", "cta-1", "--data", "[1,2]"]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("must be a JSON object");
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
      '{"title":"Start an application","button_label":"Apply now","target_url":"https://example.com/apply","is_default":true}',
    ]);

    expect(body).toEqual({
      title: "Start an application",
      button_label: "Apply now",
      target_url: "https://example.com/apply",
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

    await runCli(["ctas", "update", "cta-1", "--data", '{"title":"Renamed"}']);

    expect(url).toContain("/org/ctas/cta-1");
    expect(body).toEqual({ title: "Renamed" });
  });

  it("deletes /org/ctas/{ctaId} for a single template", async () => {
    let url: string | undefined;
    server.use(
      http.delete(apiUrl("/org/ctas/:ctaId"), ({ request }) => {
        url = request.url;
        return HttpResponse.json({ deleted: true });
      }),
    );

    await runCli(["ctas", "delete", "cta-9"]);

    expect(url).toContain("/org/ctas/cta-9");
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

    await runCli(["ctas", "set-default", "cta-1"]);

    // The id travels in the body, not the path: a PUT to /org/ctas/cta-1 would
    // rewrite the template instead of promoting it.
    expect(url).toContain("/org/ctas/default");
    expect(body).toEqual({ cta_id: "cta-1" });
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

    await runCli(["ctas", "for-content", "c-42"]);

    expect(url).toContain("/org/content/c-42/cta");
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
      "c-1",
      "--selection",
      "template",
      "--cta-id",
      "cta-1",
    ]);

    expect(body).toEqual({ selection_type: "template", cta_id: "cta-1" });
  });

  it("omits cta_id entirely when the selection is default", async () => {
    let body: unknown;
    server.use(
      http.put(apiUrl("/org/content/:id/cta"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ ...SELECTION, selection_type: "default", cta_id: undefined });
      }),
    );

    await runCli(["ctas", "set-for-content", "c-1", "--selection", "DEFAULT"]);

    // Also the case-folding check: parseEnumFlag canonicalizes on the way out,
    // so the API never sees "DEFAULT".
    expect(body).toEqual({ selection_type: "default" });
  });

  it("sends the file description to /org/cta-assets/upload-url in snake_case", async () => {
    let body: unknown;
    server.use(
      http.post(apiUrl("/org/cta-assets/upload-url"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ upload_url: "https://s3.example/put", image_url: "https://i" });
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
  it("prints the payload unmodified under --output json", async () => {
    server.use(http.get(apiUrl("/org/ctas"), () => HttpResponse.json(LIST)));

    const res = await runCli(["ctas", "list", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toEqual(LIST);
    expect(res.stderr).toBe("");
  });

  it("renders one row per template under --output table, despite default_cta", async () => {
    server.use(http.get(apiUrl("/org/ctas"), () => HttpResponse.json(LIST)));

    const res = await runCli(["ctas", "list", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("cta_id");
    expect(res.stdout).toContain("cta-1");
    expect(res.stdout).toContain("Talk to sales");
  });

  it("renders a readable block per template by default", async () => {
    server.use(http.get(apiUrl("/org/ctas"), () => HttpResponse.json(LIST)));

    const res = await runCli(["ctas", "list"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Start an application");
    expect(res.stdout).toContain("Book a call");
  });

  it("says so plainly when the organization has no templates", async () => {
    server.use(http.get(apiUrl("/org/ctas"), () => HttpResponse.json({ templates: [], total: 0 })));

    const res = await runCli(["ctas", "list"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("No results.");
  });
});

describe("ctas writes, on success", () => {
  it("puts the created template on stdout and the tick on stderr", async () => {
    server.use(http.post(apiUrl("/org/ctas"), () => HttpResponse.json(TEMPLATE, { status: 201 })));

    const res = await runCli([
      "ctas",
      "create",
      "--data",
      '{"title":"Start an application","button_label":"Apply now","target_url":"https://example.com/apply"}',
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Start an application");
    expect(res.stderr).toContain("CTA template created.");
    expect(res.stdout).not.toContain("CTA template created.");
  });

  it("emits only the payload under --output json on set-default", async () => {
    server.use(http.put(apiUrl("/org/ctas/default"), () => HttpResponse.json(TEMPLATE)));

    const res = await runCli(["ctas", "set-default", "cta-1", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toEqual(TEMPLATE);
    expect(res.stderr).toBe("");
  });

  it("prints the deleted flag as a payload rather than a bare tick", async () => {
    server.use(http.delete(apiUrl("/org/ctas/:ctaId"), () => HttpResponse.json({ deleted: true })));

    const res = await runCli(["ctas", "delete", "cta-9", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toEqual({ deleted: true });
  });

  it("exits 1 when the API refuses to delete the organization default", async () => {
    server.use(
      http.delete(apiUrl("/org/ctas/:ctaId"), () =>
        HttpResponse.json({ error: "cannot delete the default template" }, { status: 409 }),
      ),
    );

    const res = await runCli(["ctas", "delete", "cta-1"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("default");
  });

  it("renders a single selection as a two-column table under --output table", async () => {
    server.use(http.get(apiUrl("/org/content/:id/cta"), () => HttpResponse.json(SELECTION)));

    const res = await runCli(["ctas", "for-content", "c-1", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("selection_type");
    expect(res.stdout).toContain("template");
  });

  it("renders a selection as key/value lines by default", async () => {
    server.use(http.get(apiUrl("/org/content/:id/cta"), () => HttpResponse.json(SELECTION)));

    const res = await runCli(["ctas", "for-content", "c-1"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("content_id");
    expect(res.stdout).toContain("cta-1");
  });
});
