/**
 * Library: the device-authorization protocol client.
 *
 * The command tests drive the happy path and the three answers a user sees. What
 * is worth protecting *here* is the mapping itself — which HTTP response becomes
 * which outcome — because every one of those decisions is a branch the command
 * layer cannot make for itself:
 *
 *   - an `error_code` it recognizes is an answer;
 *   - a failure with no code, or an unknown one, is a protocol disagreement and
 *     must be reported, never retried and never read as "pending";
 *   - a 5xx, a 429 or a dropped connection is not an answer at all, and the
 *     caller has to be told to keep polling.
 *
 * Getting the third case wrong is the expensive one: treat a transient failure
 * as terminal and a login the user is actively approving is thrown away.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server, TEST_BASE_URL } from "../setup.js";
import {
  clampInterval,
  openBrowser,
  pollDeviceToken,
  startDeviceAuthorization,
} from "../../src/lib/device-auth.js";
import { CliError, EXIT } from "../../src/lib/errors.js";

/**
 * `execFile`, replaced.
 *
 * Spying on it is not an option — an ESM namespace object is not configurable —
 * and the real one would spawn a browser during the test run.
 */
const childProcess = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:child_process", () => childProcess);

const url = (path: string): string => `${TEST_BASE_URL}${path}`;
const poll = () => pollDeviceToken({ deviceCode: "device-code", baseUrl: TEST_BASE_URL });
const start = () => startDeviceAuthorization({ baseUrl: TEST_BASE_URL });

function tokenRespondsWith(body: Record<string, unknown>, status: number): void {
  server.use(http.post(url("/device/token"), () => HttpResponse.json(body, { status })));
}

const coded = (code: string, status: number) => ({
  body: { status, message: "prose that may be reworded at any time", error_code: code },
  status,
});

describe("polling, on the answers the CLI acts on", () => {
  it("reads authorization_pending as keep going", async () => {
    const { body, status } = coded("authorization_pending", 400);
    tokenRespondsWith(body, status);

    await expect(poll()).resolves.toEqual({ status: "pending" });
  });

  it("reads access_denied as stop", async () => {
    // 403, not 400 — the one answer in the flow that does not use 400.
    const { body, status } = coded("access_denied", 403);
    tokenRespondsWith(body, status);

    await expect(poll()).resolves.toEqual({ status: "denied" });
  });

  it("reads expired_token as stop", async () => {
    const { body, status } = coded("expired_token", 400);
    tokenRespondsWith(body, status);

    await expect(poll()).resolves.toEqual({ status: "expired" });
  });

  it("branches on the code and never on the message", async () => {
    // The server's prose is explicitly not a contract. A client that matched on
    // it would break the next time someone reworded an error.
    tokenRespondsWith(
      { status: 400, message: "approved! nearly there!", error_code: "authorization_pending" },
      400,
    );

    await expect(poll()).resolves.toEqual({ status: "pending" });
  });
});

describe("polling, on failures that are not answers", () => {
  it("asks the caller to retry a 500, because the authorization is untouched", async () => {
    tokenRespondsWith({ status: 500, message: "boom" }, 500);

    const result = await poll();

    expect(result.status).toBe("transient");
  });

  it("asks the caller to retry a rate limit rather than ending the flow", async () => {
    // Nothing rate-limits these endpoints today. If that changes, 429 must not
    // become a failed login — it is the server asking for patience.
    tokenRespondsWith({ status: 429, message: "slow down" }, 429);

    const result = await poll();

    expect(result.status).toBe("transient");
  });

  it("asks the caller to retry a dropped connection", async () => {
    server.use(http.post(url("/device/token"), () => HttpResponse.error()));

    const result = await poll();

    expect(result.status).toBe("transient");
    if (result.status === "transient") expect(result.error.exitCode).toBe(EXIT.NETWORK);
  });

  it("refuses to guess at a 400 that carries no error_code", async () => {
    // This is exactly the Content-Type rejection, and it is the one response
    // that could silently become an infinite poll.
    tokenRespondsWith({ status: 400, message: "Content-Type must be application/json" }, 400);

    await expect(poll()).rejects.toMatchObject({
      exitCode: EXIT.ERROR,
      message: expect.stringContaining("Unexpected response"),
    });
  });

  it("refuses to guess at an error_code it does not know", async () => {
    // `slow_down` is in RFC 8628 and is not implemented server-side today. If
    // it appears, stopping with a clear message beats treating it as pending.
    const { body, status } = coded("slow_down", 400);
    tokenRespondsWith(body, status);

    await expect(poll()).rejects.toBeInstanceOf(CliError);
  });

  it("reports invalid_request as a bug in the CLI, not something to retry", async () => {
    const { body, status } = coded("invalid_request", 400);
    tokenRespondsWith(body, status);

    await expect(poll()).rejects.toMatchObject({
      message: expect.stringContaining("malformed"),
    });
  });

  it("fails loudly when a 200 arrives without a key", async () => {
    // The row is consumed by now and this response was the only copy. Silence
    // here would be a login that reports success and stores nothing.
    tokenRespondsWith({ org_id: "org-1", org_name: "Acme" }, 200);

    await expect(poll()).rejects.toMatchObject({
      message: expect.stringContaining("without an API key"),
    });
  });
});

describe("polling, on success", () => {
  it("returns the key and the organization it belongs to", async () => {
    tokenRespondsWith(
      {
        api_key: "tgr_minted",
        org_id: "org-1",
        org_name: "Acme",
        expires_at: "2026-09-28T17:04:00Z",
      },
      200,
    );

    await expect(poll()).resolves.toEqual({
      status: "authorized",
      key: {
        apiKey: "tgr_minted",
        orgId: "org-1",
        orgName: "Acme",
        expiresAt: "2026-09-28T17:04:00Z",
      },
    });
  });

  it("tolerates an empty org_name, which the server degrades to rather than fail", async () => {
    // After the key is minted the server will not 500 over a missing org name,
    // because that would lose the key. The client must not either.
    tokenRespondsWith({ api_key: "tgr_minted", org_id: "org-1", org_name: "" }, 200);

    const result = await poll();

    expect(result.status).toBe("authorized");
    if (result.status === "authorized") expect(result.key.orgName).toBe("");
  });
});

describe("opening a flow", () => {
  it("sends no credential, because the caller has none yet", async () => {
    let sawApiKey: string | null = null;
    server.use(
      http.post(url("/device/authorize"), ({ request }) => {
        sawApiKey = request.headers.get("x-api-key");
        return HttpResponse.json({
          device_code: "dc",
          user_code: "ABCD-EFGH",
          verification_uri: "https://app.senso.ai/cli/verify",
          expires_in: 300,
          interval: 5,
        });
      }),
    );

    await start();

    expect(sawApiKey).toBeNull();
  });

  it("always sends a JSON body, because the endpoint requires the content type", async () => {
    // The header is only set when there is a body, and the endpoint rejects a
    // request without it — with a 400 that carries no error_code.
    let contentType: string | null = null;
    server.use(
      http.post(url("/device/authorize"), ({ request }) => {
        contentType = request.headers.get("content-type");
        return HttpResponse.json({
          device_code: "dc",
          user_code: "ABCD-EFGH",
          verification_uri: "https://app.senso.ai/cli/verify",
        });
      }),
    );

    await start();

    expect(contentType).toContain("application/json");
  });

  it("falls back to the protocol defaults when the server omits the pacing", async () => {
    server.use(
      http.post(url("/device/authorize"), () =>
        HttpResponse.json({
          device_code: "dc",
          user_code: "ABCD-EFGH",
          verification_uri: "https://app.senso.ai/cli/verify",
        }),
      ),
    );

    await expect(start()).resolves.toMatchObject({ expiresIn: 300, interval: 5 });
  });

  it("surfaces a 500 as a server failure rather than a protocol disagreement", async () => {
    server.use(
      http.post(url("/device/authorize"), () =>
        HttpResponse.json({ status: 500, message: "boom" }, { status: 500 }),
      ),
    );

    await expect(start()).rejects.toMatchObject({ code: "server_error" });
  });
});

describe("the poll interval the server asks for", () => {
  it("is honored as sent", () => {
    expect(clampInterval(5)).toBe(5);
  });

  it("cannot become a busy loop", () => {
    // A 0 from a broken server would otherwise poll as fast as the network
    // allows, for five minutes.
    expect(clampInterval(0)).toBeGreaterThan(0);
  });

  it("cannot outlive the authorization it is polling for", () => {
    expect(clampInterval(10_000)).toBeLessThanOrEqual(60);
  });
});

describe("opening the verification page", () => {
  beforeEach(() => {
    childProcess.execFile.mockReset();
    // The real one returns a child process; only `unref` is called on it.
    childProcess.execFile.mockReturnValue({ unref: (): void => undefined });
  });

  it("opens only a web page", () => {
    // The URL comes from the server's configuration. Handing an arbitrary
    // scheme to the OS opener turns "show the page" into "run the thing".
    openBrowser("file:///etc/passwd");
    openBrowser("javascript:alert(1)");
    openBrowser("");

    expect(childProcess.execFile).not.toHaveBeenCalled();
  });

  it("passes the URL as one argument, never through a shell", () => {
    // `execFile`, not `exec`: a shell would re-parse the URL, and a query
    // string is full of characters a shell treats as syntax.
    openBrowser("https://app.senso.ai/cli/verify?a=1&b=2");

    expect(childProcess.execFile).toHaveBeenCalledTimes(1);
    const [, args] = childProcess.execFile.mock.calls[0] as [string, string[]];
    expect(args).toContain("https://app.senso.ai/cli/verify?a=1&b=2");
  });

  it("never lets a missing browser fail the login", () => {
    // Headless machines have no opener at all. This must be a no-op there, not
    // an unhandled error event taking the CLI down mid-flow.
    childProcess.execFile.mockImplementation(() => {
      throw new Error("spawn xdg-open ENOENT");
    });

    expect(() => {
      openBrowser("https://app.senso.ai/cli/verify");
    }).not.toThrow();
  });
});
