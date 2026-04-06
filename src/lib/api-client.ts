import pc from "picocolors";
import { getApiKey, getBaseUrl } from "./config.js";
import { version } from "./version.js";
import * as log from "../utils/logger.js";

export class ApiError extends Error {
  constructor(
    public status: number,
    public statusText: string,
    public body: unknown,
  ) {
    const msg = extractErrorMessage(body, statusText);
    super(msg);
    this.name = "ApiError";
  }
}

function extractErrorMessage(body: unknown, fallback: string): string {
  if (typeof body !== "object" || !body) return fallback;

  const b = body as Record<string, unknown>;

  if (typeof b.error === "string") return b.error;
  if (typeof b.message === "string") return b.message;
  if (typeof b.detail === "string") return b.detail;

  if (Array.isArray(b.errors) && b.errors.length > 0) {
    return b.errors
      .map((e: Record<string, unknown>) =>
        e.field ? `${e.field}: ${e.message}` : String(e.message || e),
      )
      .join("; ");
  }

  return fallback;
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

// ── Upload result handling (shared by ingest upload & kb upload) ──

export interface UploadResultItem {
  ingestion_run_id?: string;
  content_id?: string;
  filename: string;
  status: "upload_pending" | "conflict" | "duplicate" | "invalid";
  upload_url?: string;
  expires_in?: number;
  error?: string;
  existing_content_id?: string;
}

export interface UploadResponse {
  summary: { total: number; success: number; skipped: number };
  results: UploadResultItem[];
}

export async function apiStreamRequest(
  opts: RequestOptions,
): Promise<Response> {
  const apiKey = getApiKey({ apiKey: opts.apiKey });
  if (!apiKey) {
    throw new Error(
      "No API key found. Run `senso login` or set SENSO_API_KEY.",
    );
  }

  const baseUrl = getBaseUrl({ baseUrl: opts.baseUrl });
  const url = new URL(`${baseUrl}${opts.path}`);

  const res = await fetch(url.toString(), {
    method: opts.method || "POST",
    headers: {
      "X-API-Key": apiKey,
      Accept: "text/event-stream",
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
      "User-Agent": `senso-cli/${version}`,
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
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

  return res;
}

export function uploadStatusToReason(status: string, error?: string): string {
  switch (status) {
    case "conflict":
      return "A file with the same content already exists in your knowledge base.";
    case "duplicate":
      return "This file has already been uploaded.";
    case "invalid":
      return error || "This file type is not supported.";
    default:
      return error || `Unexpected status: ${status}`;
  }
}

export function printUploadSummary(
  uploaded: number,
  failed: Array<{ filename: string; reason: string }>,
  items: UploadResultItem[],
): void {
  const total = items.length;
  console.log();
  console.log(`  ${pc.bold("Upload Summary")} — ${uploaded}/${total} file(s) uploaded`);
  console.log();

  if (uploaded > 0) {
    for (const item of items) {
      if (item.status === "upload_pending" && !failed.find((f) => f.filename === item.filename)) {
        log.success(`${item.filename}`);
      }
    }
  }

  if (failed.length > 0) {
    for (const f of failed) {
      log.error(`${f.filename} — ${f.reason}`);
    }
  }

  if (uploaded > 0) {
    console.log();
    log.info("Background processing will parse, chunk, and embed the uploaded files.");
  }
  if (uploaded === 0 && total > 0) {
    console.log();
    log.error("No files were uploaded. Please review the issues above and try again.");
  }
}

export function handleUploadError(err: unknown): void {
  if (err instanceof ApiError && err.body && typeof err.body === "object" && "results" in err.body) {
    const errorResponse = err.body as UploadResponse;
    for (const item of errorResponse.results ?? []) {
      const reason = uploadStatusToReason(item.status, item.error);
      log.error(`${item.filename} — ${reason}`);
    }
    log.error("No files were uploaded. Please review the issues above and try again.");
  } else {
    log.error(formatApiError(err));
  }
}

export function formatApiError(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.status) {
      case 401:
        return "Authentication failed. Run `senso login` to update your API key.";
      case 402:
        return "Insufficient credits or spending limit reached. Check your plan at https://app.senso.ai.";
      case 403:
        return `Permission denied: ${err.message}`;
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
