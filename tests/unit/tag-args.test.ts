/**
 * How a comma-separated `--names a,b,c` becomes a request body.
 *
 * Three groups of commands (prompts, content, kb) share these two builders, so
 * a change here changes tagging everywhere at once. Two things are worth
 * protecting:
 *
 *   1. The trimming and the dropping of empty entries. `--names "a, b,"` is what
 *      a human types, and a tag literally named " b" or "" is not what they
 *      meant — it is a tag the API would create and nobody could ever match.
 *   2. The empty result of buildSetTagsBody. `{}` is not "do nothing": the PUT
 *      endpoint reads it as "clear every tag". That makes an accidental `{}`
 *      destructive, which is why the empty-input case is asserted explicitly
 *      rather than left implied.
 */

import { describe, expect, it } from "vitest";
import { buildAttachTagBody, buildSetTagsBody } from "../../src/lib/tag-args.js";

describe("building the body for setting tags", () => {
  it("splits a comma-separated list of names", () => {
    expect(buildSetTagsBody({ names: "alpha,beta,gamma" })).toEqual({
      tag_names: ["alpha", "beta", "gamma"],
    });
  });

  it("splits a comma-separated list of ids", () => {
    expect(buildSetTagsBody({ ids: "id-1,id-2" })).toEqual({ tag_ids: ["id-1", "id-2"] });
  });

  it("sends both lists when both flags are supplied", () => {
    // Not either/or: the endpoint accepts tags identified either way in one
    // call, and dropping one of the two would silently lose half the request.
    expect(buildSetTagsBody({ names: "alpha", ids: "id-1" })).toEqual({
      tag_names: ["alpha"],
      tag_ids: ["id-1"],
    });
  });

  it("trims the whitespace a human leaves after each comma", () => {
    expect(buildSetTagsBody({ names: " alpha , beta ,gamma " })).toEqual({
      tag_names: ["alpha", "beta", "gamma"],
    });
  });

  it("drops empty entries from a trailing or doubled comma", () => {
    expect(buildSetTagsBody({ names: "alpha,,beta," })).toEqual({ tag_names: ["alpha", "beta"] });
  });

  it("drops an entry that is only whitespace", () => {
    expect(buildSetTagsBody({ names: "alpha,   ,beta" })).toEqual({ tag_names: ["alpha", "beta"] });
  });

  it("keeps a single value with no commas in it", () => {
    expect(buildSetTagsBody({ names: "alpha" })).toEqual({ tag_names: ["alpha"] });
  });

  it("omits a key entirely when its flag held nothing usable", () => {
    // Present-but-empty and absent must produce the same body. Sending
    // `tag_names: []` alongside real ids would clear the names on an endpoint
    // that replaces what it is given.
    expect(buildSetTagsBody({ names: " , ", ids: "id-1" })).toEqual({ tag_ids: ["id-1"] });
  });

  it("returns {} when nothing was supplied, which the API reads as 'clear all'", () => {
    // The non-obvious part of this module. `senso ... tags set <id>` with no
    // flags is a destructive call, not a no-op, and the command layer is what
    // decides whether to ask first — so this builder must keep returning {}
    // rather than growing a guard that would move that decision here.
    expect(buildSetTagsBody({})).toEqual({});
    expect(buildSetTagsBody({ names: "", ids: "" })).toEqual({});
    expect(buildSetTagsBody({ names: ",,", ids: "  " })).toEqual({});
  });
});

describe("building the body for attaching one tag", () => {
  it("uses the id when one is supplied", () => {
    expect(buildAttachTagBody({ id: "id-1" })).toEqual({ tag_id: "id-1" });
  });

  it("uses the name when no id is supplied", () => {
    expect(buildAttachTagBody({ name: "alpha" })).toEqual({ tag_name: "alpha" });
  });

  it("prefers the id over the name when both are given", () => {
    // An id is unambiguous and a name is not, so the more precise flag wins.
    // Sending both would let the server pick, which makes the same command mean
    // different things against different API versions.
    expect(buildAttachTagBody({ id: "id-1", name: "alpha" })).toEqual({ tag_id: "id-1" });
  });

  it("falls through to the name when the id flag is present but empty", () => {
    // `--id ""` is what an unset shell variable expands to.
    expect(buildAttachTagBody({ id: "", name: "alpha" })).toEqual({ tag_name: "alpha" });
  });

  it("returns null when neither was supplied, so the caller can raise a usage error", () => {
    expect(buildAttachTagBody({})).toBeNull();
    expect(buildAttachTagBody({ id: "", name: "" })).toBeNull();
  });

  it("does not trim a single value, because it was not part of a list", () => {
    // Documenting current behavior rather than asserting it is ideal: the CSV
    // path trims and this one does not, and a caller passing " alpha" gets a
    // lookup for " alpha".
    expect(buildAttachTagBody({ name: " alpha " })).toEqual({ tag_name: " alpha " });
  });
});
