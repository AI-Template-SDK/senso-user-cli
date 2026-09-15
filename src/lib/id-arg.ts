/**
 * Checking an id before spending a round trip on it.
 *
 * This API has at least five UUID id spaces — kb_node_id, content_id,
 * version_id, publish_record_id, gap_id — and they are not interchangeable.
 * Passing the wrong one is the commonest mistake an agent makes here, because
 * every one of them is a 36-character hex string and the CLI used to accept all
 * of them silently, send the request, and report whatever came back as a bare
 * "Not found."
 *
 * Two things fix that, and both live here. A malformed id never reaches the
 * API: it exits 2 naming the argument, what was passed, and the command that
 * lists the right ids. And a well-formed id that turns out to be from the wrong
 * space produces a 404 that names the resource type, because the same
 * descriptor is handed to `apiRequest` as its `resource`.
 */

import { usageError } from "./errors.js";
import type { ResourceRef } from "./resource.js";

/** Canonical 8-4-4-4-12, any case. The API rejects anything else with a 400. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface IdSpec extends ResourceRef {
  /** How the argument appears in help: "<id>", "--content-id". */
  label: string;
}

function hintFor(spec: IdSpec): string {
  const field = spec.idField ? `the \`${spec.idField}\` field of ` : "";
  return spec.list
    ? `${spec.type} ids are ${field}\`${spec.list}\`.`
    : `Check where this id came from: ${spec.type} ids are not interchangeable with other Senso ids.`;
}

/**
 * Returns the trimmed id, or exits 2 explaining which id space was wanted.
 */
export function parseId(value: string, spec: IdSpec): string {
  const trimmed = value.trim();
  if (UUID_RE.test(trimmed)) return trimmed;
  throw usageError(`Invalid ${spec.label}: "${value}" is not a UUID.`, {
    field: spec.label,
    received: value,
    hint: hintFor(spec),
  });
}

/** Optional form: `undefined` passes through, anything present is checked. */
export function parseOptionalId(value: string | undefined, spec: IdSpec): string | undefined {
  return value === undefined ? undefined : parseId(value, spec);
}

/**
 * Every id in a variadic argument, with every bad one named at once.
 *
 * Reporting only the first would make fixing a batch of 100 a hundred round
 * trips. De-duplication is the caller's business — `kb bulk-delete` warns about
 * duplicates rather than silently collapsing them, because the count it reports
 * has to be the count that was deleted.
 */
export function parseIdList(values: string[], spec: IdSpec): string[] {
  const bad = values.filter((v) => !UUID_RE.test(v.trim()));
  if (bad.length > 0) {
    throw usageError(
      `Invalid ${spec.label}: ${bad.map((b) => `"${b}"`).join(", ")} ${bad.length === 1 ? "is not a UUID" : "are not UUIDs"}.`,
      {
        field: spec.label,
        received: bad.join(", "),
        hint: hintFor(spec),
      },
    );
  }
  return values.map((v) => v.trim());
}

/** True when a string is a UUID, for commands that branch rather than throw. */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value.trim());
}
