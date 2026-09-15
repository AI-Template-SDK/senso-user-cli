/**
 * Command layer: `senso publish-records retry`.
 *
 * One command, no read endpoint, and four failures that mean four different
 * things. What is worth protecting is that each of them is reported as what it
 * is, because the generic mapping gets three of them wrong:
 *
 *   - a 502 is the DESTINATION refusing the content again. Rendered by the
 *     generic 5xx branch it reads "Senso API error (502) … server-side failure.
 *     Retry shortly", which blames Senso for a record that is simply back in
 *     `failed` and points the caller at a retry loop that cannot work;
 *   - a 409 means the record is not in `failed`, and `failed` is the only
 *     retryable state — so the fix is to read the state, not to retry;
 *   - the API distinguishes "no such record", "its publisher is gone" and "its
 *     content is gone" in the 404 message and nowhere else. A single `resource`
 *     would flatten all three into one sentence;
 *   - a 204 means the destination ACCEPTED it, so the record is live by the
 *     time the command returns. There is no payload, so the confirmation is a
 *     stderr tick and a JSON object naming what changed.
 *
 * Ids are publish_record_id values from `senso content verification`
 * (items[].destinations[].publish_record_id in
 * internal/api/dto/content_verification_dto.go).
 */

import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server, TEST_API_KEY } from "../setup.js";
import { apiUrl, envelope, errorEnvelope, runCli } from "../helpers.js";

const RECORD_ID = "2b7f0c93-41a8-4d6e-9f52-7c8a1e3b0d45";
const RETRY_PATH = `/org/publish-records/${RECORD_ID}/retry`;

describe("publish-records retry, when the id is wrong", () => {
  it("exits 2 without a request when the id is not a UUID", async () => {
    // No handler registered: a request here would fail the test.
    const res = await runCli(["publish-records", "retry", "pr-1", "--output", "json"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    const err = errorEnvelope(res);
    expect(err.error.code).toBe("usage");
    expect(err.error.field).toBe("<publishRecordId>");
    expect(err.error.received).toBe("pr-1");
    expect(err.error.hint).toContain("senso content verification");
  });

  it("names the record on a plain 404", async () => {
    server.use(
      http.post(apiUrl(RETRY_PATH), () =>
        HttpResponse.json({ error: "publish record not found" }, { status: 404 }),
      ),
    );

    const res = await runCli(["publish-records", "retry", RECORD_ID, "--output", "json"]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
    const err = errorEnvelope(res);
    expect(err.error.code).toBe("not_found");
    expect(err.error.message).toBe(`Publish record ${RECORD_ID} not found.`);
    expect(err.error.field).toBe("publish_record_id");
  });

  it("says the PUBLISHER is gone when that is what the 404 was about", async () => {
    // Retrying is pointless: the destination was removed from the organization.
    server.use(
      http.post(apiUrl(RETRY_PATH), () =>
        HttpResponse.json({ error: "publisher not found for publish record" }, { status: 404 }),
      ),
    );

    const res = await runCli(["publish-records", "retry", RECORD_ID, "--output", "json"]);

    expect(res.exitCode).toBe(4);
    const err = errorEnvelope(res);
    expect(err.error.message).toContain("publisher for publish record");
    expect(err.error.hint).toContain("senso destinations list");
  });

  it("says the CONTENT is gone when that is what the 404 was about", async () => {
    server.use(
      http.post(apiUrl(RETRY_PATH), () =>
        HttpResponse.json({ error: "content not found" }, { status: 404 }),
      ),
    );

    const res = await runCli(["publish-records", "retry", RECORD_ID]);

    expect(res.exitCode).toBe(4);
    expect(res.stderr).toContain("content behind publish record");
  });
});

describe("publish-records retry, when the record is not retryable", () => {
  it("exits 1 on a 409 saying only a failed record can be retried", async () => {
    server.use(
      http.post(apiUrl(RETRY_PATH), () =>
        HttpResponse.json({ error: "publish record is live", state: "live" }, { status: 409 }),
      ),
    );

    const res = await runCli(["publish-records", "retry", RECORD_ID, "--output", "json"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    const err = errorEnvelope(res);
    expect(err.error.code).toBe("conflict");
    expect(err.error.status).toBe(409);
    expect(err.error.message).toContain("only a record in `failed` can be retried");
    expect(err.error.hint).toContain("senso content verification");
    expect(err.error.details).toMatchObject({ api_message: "publish record is live" });
  });
});

describe("publish-records retry, when the destination refuses it again", () => {
  it("exits 1 on a 502 and blames the destination, not Senso", async () => {
    server.use(
      http.post(apiUrl(RETRY_PATH), () =>
        HttpResponse.json({ error: "adapter returned 401 from webflow" }, { status: 502 }),
      ),
    );

    const res = await runCli(["publish-records", "retry", RECORD_ID]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("The destination refused the retry");
    expect(res.stderr).toContain("back in `failed`");
    // The generic 5xx wording would send the caller into a retry loop that
    // cannot succeed, and would name the wrong culprit.
    expect(res.stderr).not.toContain("server-side failure");
    expect(res.stderr).not.toContain("Senso API error");
  });

  it("carries the API's own message and the failing id in the error envelope", async () => {
    server.use(
      http.post(apiUrl(RETRY_PATH), () =>
        HttpResponse.json({ error: "adapter returned 401 from webflow" }, { status: 502 }),
      ),
    );

    const res = await runCli(["publish-records", "retry", RECORD_ID, "--output", "json"]);

    expect(res.exitCode).toBe(1);
    const err = errorEnvelope(res);
    expect(err.error.status).toBe(502);
    expect(err.error.received).toBe(RECORD_ID);
    expect(err.error.details).toMatchObject({ api_message: "adapter returned 401 from webflow" });
    expect(err.error.hint).toContain("last_error");
    expect(err.error.request).toMatchObject({ method: "POST", path: RETRY_PATH });
  });
});

describe("publish-records retry, when the request fails for other reasons", () => {
  it("exits 3 and explains how to authenticate when there is no API key", async () => {
    const res = await runCli(["publish-records", "retry", RECORD_ID], { withKey: false });

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("no API key found");
  });

  it("exits 3 when the key may not update content", async () => {
    server.use(
      http.post(apiUrl(RETRY_PATH), () =>
        HttpResponse.json({ error: "missing permission update:content" }, { status: 403 }),
      ),
    );

    const res = await runCli(["publish-records", "retry", RECORD_ID]);

    expect(res.exitCode).toBe(3);
    expect(res.stderr).toContain("Permission denied");
  });

  it("exits 1 on a 500 and offers a retry, which here is the right advice", async () => {
    server.use(http.post(apiUrl(RETRY_PATH), () => new HttpResponse(null, { status: 500 })));

    const res = await runCli(["publish-records", "retry", RECORD_ID]);

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("Retry shortly");
  });
});

describe("publish-records retry, on the wire", () => {
  it("POSTs to the record's retry route with no body", async () => {
    let seen: Request | undefined;
    server.use(
      http.post(apiUrl(RETRY_PATH), ({ request }) => {
        seen = request.clone();
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await runCli(["publish-records", "retry", RECORD_ID]);

    expect(seen?.method).toBe("POST");
    expect(new URL(seen?.url ?? "").pathname).toBe(`/api/v1${RETRY_PATH}`);
    expect(seen?.headers.get("x-api-key")).toBe(TEST_API_KEY);
    await expect(seen?.text()).resolves.toBe("");
  });

  it("trims and forwards an id with surrounding whitespace", async () => {
    let seen: Request | undefined;
    server.use(
      http.post(apiUrl(RETRY_PATH), ({ request }) => {
        seen = request;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const res = await runCli(["publish-records", "retry", ` ${RECORD_ID} `]);

    expect(res.exitCode).toBe(0);
    expect(new URL(seen?.url ?? "").pathname).toBe(`/api/v1${RETRY_PATH}`);
  });
});

describe("publish-records retry, on success", () => {
  it("says the record is live on stderr and leaves stdout empty", async () => {
    // 204 means the destination accepted the content: the record is already
    // live by the time this returns, so there is nothing to poll.
    server.use(http.post(apiUrl(RETRY_PATH), () => new HttpResponse(null, { status: 204 })));

    const res = await runCli(["publish-records", "retry", RECORD_ID]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain(`Publish record ${RECORD_ID} is now live.`);
  });

  it("gives a JSON caller an object naming what changed, not a sentence", async () => {
    server.use(http.post(apiUrl(RETRY_PATH), () => new HttpResponse(null, { status: 204 })));

    const res = await runCli(["publish-records", "retry", RECORD_ID, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual({
      action: "retried",
      resource: "publish_record",
      id: RECORD_ID,
      state: "live",
    });
    expect(envelope(res).command).toBe("publish-records retry");
    expect((envelope(res).next ?? []).map((s) => s.command)).toContain(
      "senso content verification --status published",
    );
    expect(res.stderr).toBe("");
  });
});
