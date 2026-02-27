import { getApiKey, getBaseUrl } from "./config.js";
import { version } from "./version.js";

export class ApiError extends Error {
  constructor(
    public status: number,
    public statusText: string,
    public body: unknown,
  ) {
    const msg =
      typeof body === "object" && body && "error" in body
        ? (body as { error: string }).error
        : statusText;
    super(msg);
    this.name = "ApiError";
  }
}

interface RequestOptions {
  method?: string;
  path: string;
  body?: unknown;
  params?: Record<string, string | number | undefined>;
  apiKey?: string;
  baseUrl?: string;
}

export async function apiRequest<T = unknown>(
  opts: RequestOptions,
): Promise<T> {
  const apiKey = getApiKey({ apiKey: opts.apiKey });
  if (!apiKey) {
    throw new Error(
      "No API key found. Run `senso login` or set SENSO_API_KEY.",
    );
  }

  const baseUrl = getBaseUrl({ baseUrl: opts.baseUrl });
  const url = new URL(`${baseUrl}${opts.path}`);

  if (opts.params) {
    for (const [key, val] of Object.entries(opts.params)) {
      if (val !== undefined) {
        url.searchParams.set(key, String(val));
      }
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const res = await fetch(url.toString(), {
      method: opts.method || "GET",
      headers: {
        "X-API-Key": apiKey,
        Accept: "application/json",
        ...(opts.body ? { "Content-Type": "application/json" } : {}),
        "User-Agent": `senso-cli/${version}`,
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });

    if (!res.ok) {
      let body: unknown;
      const text = await res.text();
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
      throw new ApiError(res.status, res.statusText, body);
    }

    if (res.status === 204) {
      return undefined as T;
    }

    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Invalid JSON response from ${opts.path}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

export function formatApiError(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.status) {
      case 401:
        return "Authentication failed. Run `senso login` to update your API key.";
      case 403:
        return "Permission denied. Check your API key permissions.";
      case 404:
        return "Resource not found.";
      case 409:
        return `Conflict: ${err.message}`;
      default:
        if (err.status >= 500) {
          return "Server error. Try again later.";
        }
        return `API error (${err.status}): ${err.message}`;
    }
  }
  if (err instanceof Error) {
    if (err.name === "AbortError") {
      return "Request timed out. Try again later.";
    }
    if (
      err.message.includes("fetch failed") ||
      err.message.includes("ECONNREFUSED")
    ) {
      return "Could not connect to Senso API. Check your internet connection.";
    }
    return err.message;
  }
  return String(err);
}
