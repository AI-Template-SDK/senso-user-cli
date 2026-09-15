/**
 * What a request was addressing, so a failure can name it.
 *
 * The CLI's 404 used to read "Not found." for every command. That is the least
 * useful thing it could say to an agent: this API has at least five UUID id
 * spaces (kb_node_id, content_id, version_id, publish_record_id, gap_id) and
 * they are not interchangeable, so "not found" without a noun leaves the caller
 * unable to tell a wrong id from a wrong id SPACE from a deleted record.
 *
 * A command passes one of these to `apiRequest`; `ApiError` carries it, and
 * `toCliError` turns it into "KB node 3f2a… not found in organization acme."
 * with a hint naming the command that lists them.
 *
 * Kept in its own module because both api-client.ts and errors.ts need the type
 * and they already import each other.
 */

export interface ResourceRef {
  /** Human noun, capitalized as it should appear mid-sentence: "KB node". */
  type: string;
  /** The id that was addressed, when the command has one. */
  id?: string;
  /** The field this id is called on the wire: "kb_node_id". */
  idField?: string;
  /** A command that lists these, for the hint: "senso kb my-files". */
  list?: string;
}

/** "KB node 3f2a…" or just "KB node" when the command addresses a collection. */
export function describeResource(ref: ResourceRef): string {
  return ref.id ? `${ref.type} ${ref.id}` : ref.type;
}
