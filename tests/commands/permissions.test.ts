/**
 * Command layer: `senso permissions`.
 *
 * A read-only catalogue endpoint, and the reason it is worth a test file is the
 * column list. `permissions list` is the command a role-management UI or an
 * agent reads to discover what scopes exist, so the four fields it promises —
 * key, name, category, description — are an interface, not a presentation
 * choice. A response that renamed `key` would still render something plausible
 * without the assertions below.
 *
 * The failure branches come first because they are what a discovery step has to
 * handle: a caller that cannot list permissions must be able to tell "your key
 * is wrong" from "the API is down" without parsing English.
 */

import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server, TEST_API_KEY } from "../setup.js";
import { apiUrl, runCli } from "../helpers.js";

const PERMISSIONS = {
  permissions: [
    {
      key: "content.write",
      name: "Write content",
      category: "content",
      description: "Create and edit content items",
    },
    {
      key: "org.admin",
      name: "Administer org",
      category: "organization",
      description: "Manage members, roles and billing",
    },
  ],
};

describe("permissions list, when the request fails", () => {
  it("exits 3 and explains how to authenticate when there is no API key", async () => {
    const res = await runCli(["permissions", "list"], { withKey: false });

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("no API key found");
    expect(res.stderr).toContain("SENSO_API_KEY");
  });

  it("exits 3 when the API rejects the key", async () => {
    server.use(
      http.get(apiUrl("/org/permissions"), () =>
        HttpResponse.json({ error: "invalid key" }, { status: 401 }),
      ),
    );

    const res = await runCli(["permissions", "list"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Authentication failed");
  });

  it("exits 3 when the key is valid but lacks the scope", async () => {
    server.use(
      http.get(apiUrl("/org/permissions"), () =>
        HttpResponse.json({ error: "not permitted" }, { status: 403 }),
      ),
    );

    const res = await runCli(["permissions", "list"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Permission denied");
  });

  it("exits 4 on a 404", async () => {
    server.use(http.get(apiUrl("/org/permissions"), () => new HttpResponse(null, { status: 404 })));

    const res = await runCli(["permissions", "list"]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Not found");
  });

  it("exits 1 on a 500 and says it is not the caller's fault", async () => {
    server.use(http.get(apiUrl("/org/permissions"), () => new HttpResponse(null, { status: 502 })));

    const res = await runCli(["permissions", "list"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("not your fault");
  });

  it("reports a malformed body rather than throwing a parse error at the user", async () => {
    server.use(http.get(apiUrl("/org/permissions"), () => new HttpResponse("<html>nope</html>")));

    const res = await runCli(["permissions", "list"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Invalid JSON response");
  });

  it("writes the failure to stderr as JSON, leaving stdout empty, under --output json", async () => {
    server.use(
      http.get(apiUrl("/org/permissions"), () =>
        HttpResponse.json({ error: "nope" }, { status: 403 }),
      ),
    );

    const res = await runCli(["permissions", "list", "--output", "json"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");

    const reported: unknown = JSON.parse(res.stderr);
    expect(reported).toMatchObject({
      error: { code: "forbidden", status: 403 },
    });
  });
});

describe("permissions list, on the wire", () => {
  it("issues a plain GET to /org/permissions with no query and no body", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/permissions"), ({ request }) => {
        seen = request;
        return HttpResponse.json(PERMISSIONS);
      }),
    );

    await runCli(["permissions", "list"]);

    expect(seen?.method).toBe("GET");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/permissions");
    expect(new URL(seen?.url ?? "").search).toBe("");
    expect(seen?.headers.get("x-api-key")).toBe(TEST_API_KEY);
    expect(seen?.body).toBeNull();
  });
});

describe("permissions list, on success", () => {
  it("prints the payload unmodified under --output json", async () => {
    server.use(http.get(apiUrl("/org/permissions"), () => HttpResponse.json(PERMISSIONS)));

    const res = await runCli(["permissions", "list", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toEqual(PERMISSIONS);
    expect(res.stderr).toBe("");
  });

  it("shows the four columns a role editor needs under --output table", async () => {
    server.use(http.get(apiUrl("/org/permissions"), () => HttpResponse.json(PERMISSIONS)));

    const res = await runCli(["permissions", "list", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    for (const column of ["key", "name", "category", "description"]) {
      expect(res.stdout).toContain(column);
    }
    expect(res.stdout).toContain("content.write");
    expect(res.stdout).toContain("organization");
  });

  it("renders a readable block per permission by default", async () => {
    server.use(http.get(apiUrl("/org/permissions"), () => HttpResponse.json(PERMISSIONS)));

    const res = await runCli(["permissions", "list"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("org.admin");
    // plain never truncates, so the long description survives intact.
    expect(res.stdout).toContain("Manage members, roles and billing");
  });

  it("exits 0 and prints nothing alarming when the catalogue is empty", async () => {
    server.use(http.get(apiUrl("/org/permissions"), () => HttpResponse.json({ permissions: [] })));

    const res = await runCli(["permissions", "list"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("permissions");
  });
});
