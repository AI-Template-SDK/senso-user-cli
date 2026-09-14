import pc from "picocolors";
import { getApiKey, getBaseUrl } from "./config.js";
import { version } from "./version.js";
import { missingApiKeyError } from "./errors.js";
import * as log from "../utils/logger.js";

/**
 * How long any single API call may take before it is abandoned.
 *
 * Generous, because report generation and search over a large knowledge base
 * are genuinely slow, and a timeout that fires on a working request is worse
 * than a slow one. The async job endpoints do their own polling with their own
 * budget rather than holding one request open.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Request logging for `SENSO_DEBUG=1`, on stderr.
 *
 * This is the first thing to ask for when a command misbehaves in an agent, so
 * it prints the things that actually differ between a working and a broken
 * invocation: the method, the resolved URL including query parameters, the
 * status, and how long it took.
 *
 * The API key is never printed — not even a prefix. A key prefix is enough to
 * identify an organization in a support channel, and debug output gets pasted
 * into support channels.
 */
function debugEnabled(): boolean {
  return process.env.SENSO_DEBUG === "1";
}

function logRequest(method: string, url: string): void {
  if (debugEnabled()) log.dim(`→ ${method} ${url}`);
}

function logResponse(method: string, url: string, status: number, startedAt: number): void {
  if (debugEnabled()) {
    log.dim(`← ${status} ${method} ${url} (${Date.now() - startedAt}ms)`);
  }
}

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

  // Field-level validation errors: `[{ field, message }, ...]`. Each part is
  // stringified defensively because this is an error path — an unexpected shape
  // here must not throw on top of the failure it is trying to report.
  if (Array.isArray(b.errors) && b.errors.length > 0) {
    return b.errors.map((e: unknown) => describeFieldError(e)).join("; ");
  }

  return fallback;
}

function describeFieldError(e: unknown): string {
  if (typeof e === "string") return e;
  if (typeof e !== "object" || e === null) return String(e);
  const rec = e as Record<string, unknown>;
  const message = typeof rec.message === "string" ? rec.message : JSON.stringify(e);
  return typeof rec.field === "string" ? `${rec.field}: ${message}` : message;
}

interface RequestOptions {
  method?: string;
  path: string;
  body?: unknown;
  params?: Record<string, string | number | undefined>;
  apiKey?: string;
  baseUrl?: string;
  /**
   * Override the abort budget for this one call.
   *
   * The default suits a request that should come back promptly. It does not
   * suit an endpoint that does the work inline and bills for it: a draft the
   * spec says takes 10-30 seconds is not stored anywhere, so aborting at 30
   * throws away a document the caller has already paid for. Raise it only for
   * those, and only as far as the endpoint's own ceiling.
   */
  timeoutMs?: number;
}

export async function apiRequest<T = unknown>(opts: RequestOptions): Promise<T> {
  const apiKey = getApiKey({ apiKey: opts.apiKey });
  if (!apiKey) {
    throw missingApiKeyError();
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

  const method = opts.method ?? "GET";
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const startedAt = Date.now();
  logRequest(method, url.toString());

  try {
    const res = await fetch(url.toString(), {
      method,
      headers: {
        "X-API-Key": apiKey,
        Accept: "application/json",
        ...(opts.body ? { "Content-Type": "application/json" } : {}),
        "User-Agent": `senso-cli/${version}`,
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
    logResponse(method, url.toString(), res.status, startedAt);

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
  /**
   * The created or replaced document node — the id to poll with `senso kb get`.
   * Absent on skipped items (any status other than `upload_pending`).
   */
  kb_node_id?: string;
  filename: string;
  status: "upload_pending" | "conflict" | "duplicate" | "invalid";
  upload_url?: string;
  expires_in?: number;
  error?: string;
  existing_content_id?: string;
}

export interface UploadResponse {
  summary: { total: number; success: number; skipped: number };
  /**
   * Optional because this type is an assertion, not a validation.
   * `apiRequest<T>` casts the parsed body; it does not check it. Declaring this
   * required told the compiler — and the linter — that the guards around it were
   * dead code, and removing them turned a malformed response into a raw
   * "not iterable" TypeError instead of an empty upload summary.
   */
  results?: UploadResultItem[];
}

export async function apiStreamRequest(opts: RequestOptions): Promise<Response> {
  const apiKey = getApiKey({ apiKey: opts.apiKey });
  if (!apiKey) {
    throw missingApiKeyError();
  }

  const baseUrl = getBaseUrl({ baseUrl: opts.baseUrl });
  const url = new URL(`${baseUrl}${opts.path}`);

  // No timeout here, unlike apiRequest: this is a server-sent-event stream that
  // stays open for the length of the answer, so an inactivity budget would have
  // to be per-chunk rather than per-request. The caller sees tokens as they
  // arrive and can interrupt.
  const method = opts.method ?? "POST";
  const startedAt = Date.now();
  logRequest(method, url.toString());

  const res = await fetch(url.toString(), {
    method,
    headers: {
      "X-API-Key": apiKey,
      Accept: "text/event-stream",
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
      "User-Agent": `senso-cli/${version}`,
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  logResponse(method, url.toString(), res.status, startedAt);

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
      return error ?? "This file type is not supported.";
    default:
      return error ?? `Unexpected status: ${status}`;
  }
}

/**
 * The human-readable result of an upload batch.
 *
 * All of it is stderr: it is a progress report, not the command's payload, so
 * `ingest upload --output json` emits the API response on stdout and this
 * alongside it. Silenced entirely by `quiet` — which `--output json` implies —
 * because a caller asking for a machine-readable result did not ask for a
 * per-file commentary next to it.
 */
export function printUploadSummary(
  uploaded: number,
  failed: { filename: string; reason: string }[],
  items: UploadResultItem[],
  quiet = false,
): void {
  if (quiet) return;

  const total = items.length;
  log.raw("");
  log.raw(`  ${pc.bold("Upload Summary")} — ${uploaded}/${total} file(s) uploaded`);
  log.raw("");

  if (uploaded > 0) {
    for (const item of items) {
      if (item.status === "upload_pending" && !failed.find((f) => f.filename === item.filename)) {
        log.success(item.filename);
      }
    }
  }

  if (failed.length > 0) {
    for (const f of failed) {
      log.error(`${f.filename} — ${f.reason}`);
    }
  }

  if (uploaded > 0) {
    log.raw("");
    log.info("Background processing will parse, chunk, and embed the uploaded files.");
  }
  if (uploaded === 0 && total > 0) {
    log.raw("");
    log.error("No files were uploaded. Please review the issues above and try again.");
  }
}

/**
 * A whole-batch rejection, as opposed to any other API failure.
 *
 * The upload endpoint refuses a batch by returning the same per-file `results`
 * array it returns on success, with a reason on each entry. That is the only
 * failure shape carrying detail worth unpacking; everything else is an ordinary
 * API or transport error and must be rethrown so the caller's error mapping can
 * give it its real exit code, rather than being flattened to a generic failure.
 */
export function isBatchRejection(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    typeof err.body === "object" &&
    err.body !== null &&
    "results" in err.body
  );
}

export function handleUploadError(err: unknown): void {
  if (
    err instanceof ApiError &&
    err.body &&
    typeof err.body === "object" &&
    "results" in err.body
  ) {
    const errorResponse = err.body as UploadResponse;
    // `?? []` although `results` is declared required: this is an error body,
    // so the shape is even less guaranteed than usual.
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
    if (err.message.includes("fetch failed") || err.message.includes("ECONNREFUSED")) {
      return "Could not connect to Senso API. Check your internet connection.";
    }
    return err.message;
  }
  return String(err);
}
