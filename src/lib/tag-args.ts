/**
 * Shared helpers for building request bodies for the tag attach/detach endpoints.
 * Used by the `tags` subcommand groups under prompts, content, and kb.
 */

function parseCsv(v: string | undefined): string[] {
  if (!v) return [];
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Builds the body for PUT /tags endpoints. Supply --names (csv) and/or --ids (csv).
 * Returns an empty object if neither is set (interpreted by the API as "clear all").
 */
export function buildSetTagsBody(cmdOpts: { names?: string; ids?: string }): Record<string, string[]> {
  const body: Record<string, string[]> = {};
  const names = parseCsv(cmdOpts.names);
  const ids = parseCsv(cmdOpts.ids);
  if (names.length > 0) body.tag_names = names;
  if (ids.length > 0) body.tag_ids = ids;
  return body;
}

/**
 * Builds the body for POST /tags (attach single). Prefers --id over --name.
 * Returns null if neither was supplied.
 */
export function buildAttachTagBody(cmdOpts: { name?: string; id?: string }): Record<string, string> | null {
  if (cmdOpts.id) return { tag_id: cmdOpts.id };
  if (cmdOpts.name) return { tag_name: cmdOpts.name };
  return null;
}
