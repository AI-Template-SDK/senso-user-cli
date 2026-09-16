/**
 * Unit: checking an id before spending a round trip on it.
 *
 * WHAT IS WORTH PROTECTING HERE. This API has five UUID id spaces — kb_node_id,
 * content_id, version_id, publish_record_id, gap_id — and they are not
 * interchangeable. Every one is a 36-character hex string, so the CLI cannot
 * tell them apart by shape; what it CAN do is refuse something that is not a
 * UUID at all, and say which space it wanted. Passing the wrong id was the
 * commonest agent mistake in the review, and it used to surface as a bare
 * "Not found." after a round trip.
 *
 * The error's structure matters as much as its text: `field` and `received` are
 * what let an agent correct its own command line without parsing a sentence.
 */

import { describe, expect, it } from "vitest";
import { EXIT } from "../../src/lib/errors.js";
import { isUuid, parseId, parseIdList, parseOptionalId } from "../../src/lib/id-arg.js";

const KB_NODE = {
  label: "<id>",
  type: "KB node",
  idField: "kb_node_id",
  list: "senso kb my-files",
};

const UUID = "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b";

describe("parseId", () => {
  it("exits 2 with the id space named when the value is not a UUID", () => {
    // Before the request, not after: the API answers a malformed id with a 400
    // that says nothing about which kind of id it wanted.
    expect.assertions(5);
    try {
      parseId("not-an-id", KB_NODE);
    } catch (err) {
      const e = err as { exitCode: number; field?: string; received?: string; hint?: string };
      expect(e.exitCode).toBe(EXIT.USAGE);
      expect(e.field).toBe("<id>");
      expect(e.received).toBe("not-an-id");
      expect(e.hint).toContain("kb_node_id");
      expect(e.hint).toContain("senso kb my-files");
    }
  });

  it("says where the ids come from even when no list command is known", () => {
    expect.assertions(1);
    try {
      parseId("nope", { label: "--run-id", type: "Eval run" });
    } catch (err) {
      expect((err as { hint?: string }).hint).toContain("not interchangeable");
    }
  });

  it("accepts a UUID in any case and returns it trimmed", () => {
    expect(parseId(`  ${UUID.toUpperCase()}  `, KB_NODE)).toBe(UUID.toUpperCase());
  });

  it("passes undefined through for an omitted optional flag", () => {
    expect(parseOptionalId(undefined, KB_NODE)).toBeUndefined();
    expect(parseOptionalId(UUID, KB_NODE)).toBe(UUID);
  });
});

describe("parseIdList", () => {
  it("names every bad id at once rather than only the first", () => {
    // `kb bulk-delete` takes up to 100 ids. Reporting them one at a time would
    // make fixing a batch a hundred round trips.
    expect.assertions(2);
    try {
      parseIdList([UUID, "bad-1", "bad-2"], { ...KB_NODE, label: "<nodeIds...>" });
    } catch (err) {
      const e = err as { message: string; received?: string };
      expect(e.message).toContain('"bad-1", "bad-2"');
      expect(e.received).toBe("bad-1, bad-2");
    }
  });

  it("returns every id trimmed when they are all valid", () => {
    expect(parseIdList([` ${UUID} `, UUID], KB_NODE)).toEqual([UUID, UUID]);
  });
});

describe("isUuid", () => {
  it("is true only for the canonical 8-4-4-4-12 form", () => {
    expect(isUuid(UUID)).toBe(true);
    expect(isUuid("3f2a1b4c5d6e4f708a9b0c1d2e3f4a5b")).toBe(false);
    expect(isUuid("")).toBe(false);
  });
});
