/**
 * The one place this CLI talks to the network.
 *
 * Everything here is worth protecting because every command inherits it: the
 * header that carries the credential, the query encoding, the timeout, and the
 * translation of an error body into a sentence a user can act on.
 *
 * The error-message extraction gets the most attention. It runs on the failure
 * path, where an unexpected body shape must not throw a second error on top of
 * the first — which is exactly what the old `${e.field}: ${e.message}` did when
 * `errors[]` held strings rather than objects.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server, TEST_API_KEY, TEST_BASE_URL } from "../setup.js";
import { ApiError, apiRequest, formatApiError } from "../../src/lib/api-client.js";

const url = (path: string) => `${TEST_BASE_URL}${path}`;
const call = <T = unknown>(path: string, extra: Record<string, unknown> = {}) =>
  apiRequest<T>({ path, apiKey: TEST_API_KEY, baseUrl: TEST_BASE_URL, ...extra });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the request", () => {
  it("sends the credential, the version and the expected accept header", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(url("/org/me"), ({ request }) => {
        seen = request;
        return HttpResponse.json({ ok: true });
      }),
    );

    await call("/org/me");

    expect(seen?.headers.get("x-api-key")).toBe(TEST_API_KEY);
    expect(seen?.headers.get("accept")).toBe("application/json");
    // The version in the User-Agent is how a support request can be tied to a
    // release without asking the user to run anything.
    expect(seen?.headers.get("user-agent")).toMatch(/^senso-cli\/\d+\.\d+\.\d+/);
  });

  it("sets Content-Type only when there is a body to describe", async () => {
    let getRequest: Request | undefined;
    let postRequest: Request | undefined;
    server.use(
      http.get(url("/org/x"), ({ request }) => {
        getRequest = request;
        return HttpResponse.json({});
      }),
      http.post(url("/org/x"), ({ request }) => {
        postRequest = request;
        return HttpResponse.json({});
      }),
    );

    await call("/org/x");
    await call("/org/x", { method: "POST", body: { a: 1 } });

    expect(getRequest?.headers.get("content-type")).toBeNull();
    expect(postRequest?.headers.get("content-type")).toBe("application/json");
  });

  it("serializes the body as JSON", async () => {
    let body: unknown;
    server.use(
      http.post(url("/org/x"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({});
      }),
    );

    await call("/org/x", { method: "POST", body: { name: "Acme", count: 2 } });

    expect(body).toEqual({ name: "Acme", count: 2 });
  });

  it("puts params on the query string and drops the undefined ones", async () => {
    // Commands pass every optional flag through unconditionally, so most calls
    // carry several undefined params. Sending `limit=undefined` would make the
    // API reject a request the user never made.
    let seen: URL | undefined;
    server.use(
      http.get(url("/org/x"), ({ request }) => {
        seen = new URL(request.url);
        return HttpResponse.json({});
      }),
    );

    await call("/org/x", { params: { limit: 10, offset: undefined, search: "a b" } });

    expect(seen?.searchParams.get("limit")).toBe("10");
    expect(seen?.searchParams.has("offset")).toBe(false);
    // Encoded, not concatenated: a search term with a space or an ampersand
    // must not become two parameters.
    expect(seen?.searchParams.get("search")).toBe("a b");
  });

  it("repeats the key for an array, which is how the API reads a multi-value filter", async () => {
    // `set` would send `statuses=weak,open` as one value — a status that does not
    // exist, so the API answers with an empty list rather than an error.
    let seen: URL | undefined;
    server.use(
      http.get(url("/org/x"), ({ request }) => {
        seen = new URL(request.url);
        return HttpResponse.json({});
      }),
    );

    await call("/org/x", { params: { statuses: ["weak", "open"], tag_ids: [], limit: 5 } });

    expect(seen?.searchParams.getAll("statuses")).toEqual(["weak", "open"]);
    // An empty array is "no filter", like undefined, not an empty value.
    expect(seen?.searchParams.has("tag_ids")).toBe(false);
    expect(seen?.searchParams.get("limit")).toBe("5");
  });

  it("sends extra headers, but never lets them replace the credential or identity", async () => {
    let seen: Request | undefined;
    server.use(
      http.post(url("/org/x"), ({ request }) => {
        seen = request;
        return HttpResponse.json({});
      }),
    );

    await call("/org/x", {
      method: "POST",
      body: { q: 1 },
      headers: {
        "X-Senso-Signals": "off",
        "X-API-Key": "someone-elses-key",
        "User-Agent": "not-the-cli",
      },
    });

    expect(seen?.headers.get("x-senso-signals")).toBe("off");
    expect(seen?.headers.get("x-api-key")).toBe(TEST_API_KEY);
    expect(seen?.headers.get("user-agent")).toMatch(/^senso-cli\//);
  });
});

describe("the response", () => {
  it("returns the parsed body", async () => {
    server.use(http.get(url("/org/x"), () => HttpResponse.json({ items: [1, 2] })));
    await expect(call("/org/x")).resolves.toEqual({ items: [1, 2] });
  });

  it("returns undefined for a 204, rather than failing to parse nothing", async () => {
    // Deletes answer 204. Trying to JSON.parse an empty body would turn a
    // successful delete into an error.
    server.use(http.delete(url("/org/x"), () => new HttpResponse(null, { status: 204 })));
    await expect(call("/org/x", { method: "DELETE" })).resolves.toBeUndefined();
  });

  it("names the endpoint when a 200 body is not JSON", async () => {
    // A proxy or a captive portal answering with HTML is the usual cause, and
    // knowing which call it happened on is most of the diagnosis.
    server.use(http.get(url("/org/x"), () => new HttpResponse("<html>hi</html>")));

    await expect(call("/org/x")).rejects.toThrow(/Invalid JSON response from \/org\/x/);
  });
});

describe("turning an error body into a message", () => {
  /** Provoke a failure with this body, and hand back the ApiError it produced. */
  const failWith = async (body: Record<string, unknown>, status = 400): Promise<ApiError> => {
    server.use(http.get(url("/org/x"), () => HttpResponse.json(body, { status })));
    try {
      await call("/org/x");
    } catch (e: unknown) {
      return e as ApiError;
    }
    throw new Error("expected the request to fail, but it succeeded");
  };

  it("reads the conventional single-field shapes", async () => {
    expect((await failWith({ error: "from error" })).message).toBe("from error");
    expect((await failWith({ message: "from message" })).message).toBe("from message");
    expect((await failWith({ detail: "from detail" })).message).toBe("from detail");
  });

  it("joins field-level validation errors", async () => {
    const err = await failWith({
      errors: [
        { field: "name", message: "is required" },
        { field: "url", message: "must be https" },
      ],
    });

    expect(err.message).toBe("name: is required; url: must be https");
  });

  it("survives an errors[] holding plain strings", async () => {
    // The old implementation destructured every entry as an object, so a list
    // of strings produced "undefined: undefined" on the failure path.
    const err = await failWith({ errors: ["first problem", "second problem"] });

    expect(err.message).toBe("first problem; second problem");
    expect(err.message).not.toContain("undefined");
  });

  it("survives an errors[] entry with no field", async () => {
    const err = await failWith({ errors: [{ message: "something broke" }] });
    expect(err.message).toBe("something broke");
  });

  it("never renders an object as [object Object]", async () => {
    const err = await failWith({ errors: [{ nested: { deep: true } }] });
    expect(err.message).not.toContain("[object Object]");
  });

  it("falls back to the status text when the body says nothing useful", async () => {
    const err = await failWith({ unexpected: "shape" }, 400);
    expect(err.status).toBe(400);
    expect(err).toBeInstanceOf(ApiError);
  });

  it("keeps a non-JSON error body as the raw text", async () => {
    server.use(http.get(url("/org/x"), () => new HttpResponse("gateway down", { status: 502 })));

    let err: ApiError | undefined;
    try {
      await call("/org/x");
    } catch (e: unknown) {
      err = e as ApiError;
    }
    expect(err?.status).toBe(502);
    expect(err?.body).toBe("gateway down");
  });
});

describe("authentication", () => {
  it("refuses to make the request at all without a key", async () => {
    // No handler is registered, so if this reached the network the suite's
    // network ban would fail the test — which is the belt to this braces.
    await expect(
      apiRequest({ path: "/org/x", apiKey: undefined, baseUrl: TEST_BASE_URL }),
    ).rejects.toThrow(/no API key found/i);
  });
});

describe("formatApiError", () => {
  it("gives a human sentence for the statuses users actually hit", () => {
    expect(formatApiError(new ApiError(401, "", {}))).toMatch(/Authentication failed/);
    expect(formatApiError(new ApiError(402, "", {}))).toMatch(/credits/i);
    expect(formatApiError(new ApiError(404, "", {}))).toMatch(/not found/i);
    expect(formatApiError(new ApiError(500, "", {}))).toMatch(/Server error/i);
  });

  it("recognizes a timeout", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(formatApiError(abort)).toMatch(/timed out/i);
  });

  it("recognizes an unreachable API", () => {
    expect(formatApiError(new Error("fetch failed"))).toMatch(/Could not connect/i);
  });

  it("does not throw on a value that is not an Error", () => {
    expect(formatApiError("plain string")).toBe("plain string");
    expect(formatApiError(undefined)).toBe("undefined");
  });
});

describe("the abort budget", () => {
  /**
   * The default suits a request that should come back promptly, and most of
   * this CLI wants exactly that. It does not suit an endpoint that does the
   * work inline and charges for it — `generate industry-draft` is documented at
   * 10-30 seconds and stores nothing, so aborting at the default would discard
   * a document the caller already paid for. `timeoutMs` is the opt-out, and it
   * must actually reach the abort rather than being accepted and ignored.
   */
  it("abandons a request that outruns an explicit timeoutMs", async () => {
    server.use(
      http.get(url("/org/slow"), async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return HttpResponse.json({ ok: true });
      }),
    );

    await expect(call("/org/slow", { timeoutMs: 20 })).rejects.toThrow();
  });

  it("lets a request finish when the explicit timeoutMs is generous enough", async () => {
    server.use(
      http.get(url("/org/slow"), async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return HttpResponse.json({ ok: true });
      }),
    );

    await expect(call("/org/slow", { timeoutMs: 5_000 })).resolves.toEqual({ ok: true });
  });

  it("still applies the default when no timeoutMs is given", async () => {
    server.use(http.get(url("/org/quick"), () => HttpResponse.json({ ok: true })));

    await expect(call("/org/quick")).resolves.toEqual({ ok: true });
  });
});
