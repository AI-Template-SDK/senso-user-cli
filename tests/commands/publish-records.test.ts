/**
 * Command layer: `senso publish-records`.
 *
 * A single write command with no payload of its own, which makes it the clearest
 * test of the confirmation contract: a command that changed something and has
 * nothing to show must still be usable from a script. That means the ✓ goes to
 * stderr — piping this command yields an empty stream, not a sentence — while
 * `--output json` yields a real object a caller can parse and check.
 *
 * The other half is the URL. The record id is interpolated into the path, so the
 * assertions below pin the method, the path shape and the absence of a body: a
 * retry that quietly became a GET, or that lost the `/retry` suffix, would still
 * print "retry completed" to the user.
 */

import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server, TEST_API_KEY } from "../setup.js";
import { apiUrl, runCli } from "../helpers.js";

const RECORD_ID = "pr-9f21";

describe("publish-records retry, when the request fails", () => {
  it("exits 3 and explains how to authenticate when there is no API key", async () => {
    const res = await runCli(["publish-records", "retry", RECORD_ID], { withKey: false });

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("no API key found");
    expect(res.stderr).toContain("SENSO_API_KEY");
  });

  it("exits 3 when the API rejects the key", async () => {
    server.use(
      http.post(apiUrl("/org/publish-records/:id/retry"), () =>
        HttpResponse.json({ error: "invalid key" }, { status: 401 }),
      ),
    );

    const res = await runCli(["publish-records", "retry", RECORD_ID]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Authentication failed");
  });

  it("exits 3 when the key is valid but lacks the scope", async () => {
    server.use(
      http.post(apiUrl("/org/publish-records/:id/retry"), () =>
        HttpResponse.json({ error: "publishing is restricted" }, { status: 403 }),
      ),
    );

    const res = await runCli(["publish-records", "retry", RECORD_ID]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Permission denied");
  });

  it("exits 4 when the publish record does not exist", async () => {
    server.use(
      http.post(
        apiUrl("/org/publish-records/:id/retry"),
        () => new HttpResponse(null, { status: 404 }),
      ),
    );

    const res = await runCli(["publish-records", "retry", "pr-does-not-exist"]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Not found");
  });

  it("exits 1, not 3, when the record is not in the failed state", async () => {
    // 409 is the API's answer to retrying a record that already published. It is
    // a state problem, not a credentials problem, so a script must not react by
    // rotating its key.
    server.use(
      http.post(apiUrl("/org/publish-records/:id/retry"), () =>
        HttpResponse.json({ error: "record is not in the failed state" }, { status: 409 }),
      ),
    );

    const res = await runCli(["publish-records", "retry", RECORD_ID]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Conflict");
    expect(res.stderr).toContain("not in the failed state");
  });

  it("exits 1 on a 500 and says it is not the caller's fault", async () => {
    server.use(
      http.post(
        apiUrl("/org/publish-records/:id/retry"),
        () => new HttpResponse(null, { status: 503 }),
      ),
    );

    const res = await runCli(["publish-records", "retry", RECORD_ID]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("not your fault");
  });

  it("writes the failure to stderr as JSON, leaving stdout empty, under --output json", async () => {
    server.use(
      http.post(apiUrl("/org/publish-records/:id/retry"), () =>
        HttpResponse.json({ error: "nope" }, { status: 403 }),
      ),
    );

    const res = await runCli(["publish-records", "retry", RECORD_ID, "--output", "json"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");

    const reported: unknown = JSON.parse(res.stderr);
    expect(reported).toMatchObject({
      error: { code: "forbidden", status: 403 },
    });
  });
});

describe("publish-records retry, on the wire", () => {
  it("POSTs to /org/publish-records/<id>/retry with no body", async () => {
    let seen: Request | undefined;
    server.use(
      http.post(apiUrl("/org/publish-records/:id/retry"), ({ request }) => {
        seen = request;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await runCli(["publish-records", "retry", RECORD_ID]);

    expect(seen?.method).toBe("POST");
    expect(new URL(seen?.url ?? "").pathname).toBe(
      `/api/v1/org/publish-records/${RECORD_ID}/retry`,
    );
    expect(new URL(seen?.url ?? "").search).toBe("");
    expect(seen?.body).toBeNull();
    expect(seen?.headers.get("x-api-key")).toBe(TEST_API_KEY);
  });

  it("passes the id through untouched, including characters a URL would escape", async () => {
    let seen: Request | undefined;
    server.use(
      http.post(apiUrl("/org/publish-records/:id/retry"), ({ request, params }) => {
        seen = request;
        expect(params.id).toBe("pr-with%20space");
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await runCli(["publish-records", "retry", "pr-with%20space"]);

    expect(new URL(seen?.url ?? "").pathname).toContain("pr-with%20space");
  });
});

describe("publish-records retry, on success", () => {
  it("puts the ✓ on stderr and leaves stdout empty, so the command can be piped", async () => {
    server.use(
      http.post(
        apiUrl("/org/publish-records/:id/retry"),
        () => new HttpResponse(null, { status: 204 }),
      ),
    );

    const res = await runCli(["publish-records", "retry", RECORD_ID]);

    expect(res.exitCode).toBe(0);
    // There is no payload here. A caller redirecting stdout gets nothing.
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain(RECORD_ID);
    expect(res.stderr).toContain("retry completed");
  });

  it("prints a parseable object on stdout under --output json", async () => {
    server.use(
      http.post(
        apiUrl("/org/publish-records/:id/retry"),
        () => new HttpResponse(null, { status: 204 }),
      ),
    );

    const res = await runCli(["publish-records", "retry", RECORD_ID, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toEqual({
      ok: true,
      message: `Publish record ${RECORD_ID} retry completed.`,
    });
    expect(res.stderr).toBe("");
  });

  it("says nothing at all under --quiet", async () => {
    server.use(
      http.post(
        apiUrl("/org/publish-records/:id/retry"),
        () => new HttpResponse(null, { status: 204 }),
      ),
    );

    const res = await runCli(["publish-records", "retry", RECORD_ID, "--quiet"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr).toBe("");
  });

  it("still reports a confirmation, not the response, when the API returns a body", async () => {
    server.use(
      http.post(apiUrl("/org/publish-records/:id/retry"), () =>
        HttpResponse.json({ publish_record_id: RECORD_ID, state: "published" }),
      ),
    );

    const res = await runCli(["publish-records", "retry", RECORD_ID, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    // The retry endpoint's response has never been surfaced; the command
    // deliberately reports a confirmation instead of the record.
    expect(res.json()).toEqual({
      ok: true,
      message: `Publish record ${RECORD_ID} retry completed.`,
    });
  });

  it("renders the confirmation the same way under --output table", async () => {
    server.use(
      http.post(
        apiUrl("/org/publish-records/:id/retry"),
        () => new HttpResponse(null, { status: 204 }),
      ),
    );

    const res = await runCli(["publish-records", "retry", RECORD_ID, "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("retry completed");
  });
});
