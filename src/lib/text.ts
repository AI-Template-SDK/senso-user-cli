/**
 * Turning an unknown value into text for a message.
 *
 * Validation errors echo what the caller passed, and what they passed arrives
 * as `unknown` from `JSON.parse`. `String(value)` on an object yields
 * "[object Object]", which tells an agent nothing about what it sent — so
 * `error.received` would name a field and then fail to show its value.
 *
 * The type-aware linter flags every bare `String(unknown)` for exactly this
 * reason; this is the one place that conversion is decided.
 */

/** A value as text: strings unchanged, everything else as JSON. */
export function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  // Everything reaching here came through JSON.parse, so there is no function
  // or symbol left for JSON.stringify to answer with undefined.
  return JSON.stringify(value);
}
