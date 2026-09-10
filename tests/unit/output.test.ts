/**
 * The renderer that owns stdout.
 *
 * What is worth protecting here is the generic path. Every one of ~150 commands
 * gets all three output formats from `emit` without writing a renderer of its
 * own, so a regression in this file is a regression in the whole CLI at once.
 *
 * The specific behaviors under test are the ones that were broken before it
 * existed: `--output table` silently falling back to JSON on a single object,
 * cells rendering as "[object Object]", and a column disappearing because the
 * first row happened to omit it.
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { emit, emitConfirmation, outputTable, type OutputContext } from "../../src/lib/output.js";

/** Captures both streams for one call, so a test can say which one was used. */
function capture(fn: () => void): { out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((...p: unknown[]) => {
    out.push(p.map(String).join(" "));
  });
  const errSpy = vi.spyOn(console, "error").mockImplementation((...p: unknown[]) => {
    err.push(p.map(String).join(" "));
  });
  try {
    fn();
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
  return { out: out.join("\n"), err: err.join("\n") };
}

const ctx = (format: OutputContext["format"], quiet = false): OutputContext => ({ format, quiet });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("emit, in json", () => {
  it("prints the payload unchanged, on stdout", () => {
    const payload = { roles: [{ role_id: "r1" }], total: 1 };
    const { out, err } = capture(() => {
      emit(ctx("json"), payload);
    });

    expect(JSON.parse(out)).toEqual(payload);
    expect(err).toBe("");
  });

  it("ignores a command's handcrafted plain rendering", () => {
    // A command supplying nicer human output must not be able to change what a
    // script sees. json is always the raw payload.
    const { out } = capture(() => {
      emit(ctx("json"), { a: 1 }, { plain: ["something else entirely"] });
    });

    expect(JSON.parse(out)).toEqual({ a: 1 });
  });
});

describe("emit, in table", () => {
  it("finds the list inside a wrapped response", () => {
    // The API wraps its lists under a different key per endpoint — nodes,
    // items, roles, data. Teaching 150 commands their own key was the
    // alternative to looking for the first array of objects.
    const { out } = capture(() => {
      emit(ctx("table"), { nodes: [{ id: "n1", name: "Docs" }], total: 1 });
    });

    expect(out).toContain("id");
    expect(out).toContain("n1");
    expect(out).toContain("Docs");
  });

  it("renders a bare array", () => {
    const { out } = capture(() => {
      emit(ctx("table"), [{ id: "a" }, { id: "b" }]);
    });

    expect(out).toContain("a");
    expect(out).toContain("b");
  });

  it("renders a single object as two columns rather than falling back to JSON", () => {
    // The old behavior printed JSON here, which meant `--output table` silently
    // ignored the flag on most commands in the CLI.
    const { out } = capture(() => {
      emit(ctx("table"), { org_id: "o1", name: "Acme" });
    });

    expect(out).toContain("field");
    expect(out).toContain("value");
    expect(out).toContain("org_id");
    expect(out).toContain("Acme");
    expect(out).not.toContain("{");
  });

  it("includes a column that only some rows carry", () => {
    // Keying columns off rows[0] dropped any field the first row happened to
    // omit — and a null field omitted on one row is normal in these responses.
    const { out } = capture(() => {
      emit(ctx("table"), [{ id: "a" }, { id: "b", archived_at: "2026-01-01" }]);
    });

    expect(out).toContain("archived_at");
    expect(out).toContain("2026-01-01");
  });

  it("renders a single object that CONTAINS a list as the object, not the list", () => {
    // The bug this pins: findRows used to return the first array-of-objects
    // property it saw, so `/org/me` — which carries `locations: [...]` — rendered
    // the locations and silently dropped the organization's name, slug and tier.
    // Only --output json was unaffected, which is why it went unnoticed.
    const { out } = capture(() => {
      emit(ctx("table"), {
        org_id: "o1",
        name: "Acme CU",
        slug: "acme",
        locations: [{ city: "Toronto" }],
      });
    });

    expect(out).toContain("Acme CU");
    expect(out).toContain("slug");
  });

  it("still treats a paginated envelope as the list it is", () => {
    // The other half of the same rule: `{ items: [...], total, limit, offset }`
    // is a list, because everything beside the list is pagination metadata.
    const { out } = capture(() => {
      emit(ctx("table"), {
        items: [{ id: "a" }, { id: "b" }],
        total: 2,
        limit: 50,
        offset: 0,
      });
    });

    expect(out).toContain("id");
    expect(out).toContain("a");
    expect(out).not.toContain("limit");
  });

  it("renders a nested value as JSON, not [object Object]", () => {
    const { out } = capture(() => {
      emit(ctx("table"), [{ id: "a", meta: { depth: 2 } }]);
    });

    expect(out).not.toContain("[object Object]");
    expect(out).toContain("depth");
  });

  it("joins an array of scalars instead of JSON-encoding it", () => {
    const { out } = capture(() => {
      emit(ctx("table"), [{ id: "a", tags: ["x", "y"] }]);
    });

    expect(out).toContain("x, y");
  });

  it("truncates a long cell so the table stays readable", () => {
    const long = "z".repeat(200);
    const { out } = capture(() => {
      emit(ctx("table"), [{ id: "a", note: long }]);
    });

    expect(out).toContain("…");
    expect(out).not.toContain(long);
  });

  it("flattens a newline inside a cell, which would otherwise break the grid", () => {
    const { out } = capture(() => {
      emit(ctx("table"), [{ id: "a", note: "line one\nline two" }]);
    });

    expect(out).toContain("line one line two");
  });

  it("honors the columns a command asks for, in that order", () => {
    const { out } = capture(() => {
      emit(ctx("table"), [{ z: "last", a: "first" }], { columns: ["a", "z"] });
    });

    const header = out.split("\n")[0] ?? "";
    expect(header.indexOf("a")).toBeLessThan(header.indexOf("z"));
  });

  it("says there are no results rather than printing an empty grid", () => {
    const { out } = capture(() => {
      outputTable([]);
    });
    expect(out).toContain("No results");
  });
});

describe("emit, in plain", () => {
  it("prints one labelled block per item", () => {
    const { out } = capture(() => {
      emit(ctx("plain"), { roles: [{ role_id: "r1", name: "admin" }] });
    });

    expect(out).toContain("role_id");
    expect(out).toContain("r1");
    expect(out).toContain("admin");
  });

  it("does not truncate, unlike table", () => {
    // plain is the format to reach for when you need to read a long field, so
    // truncating here would remove the only way to see one.
    const long = "z".repeat(200);
    const { out } = capture(() => {
      emit(ctx("plain"), [{ id: "a", note: long }]);
    });

    expect(out).toContain(long);
  });

  it("uses a command's handcrafted rendering when it has one", () => {
    const { out } = capture(() => {
      emit(ctx("plain"), { a: 1 }, { plain: ["  Answer: forty-two"] });
    });

    expect(out).toBe("  Answer: forty-two");
  });

  it("prints nothing at all for an empty response body", () => {
    // A 204 has no payload. Printing "undefined" would put a word on stdout
    // that a caller would then have to filter out.
    const { out } = capture(() => {
      emit(ctx("plain"), undefined);
    });

    expect(out).toBe("");
  });
});

describe("emitConfirmation", () => {
  it("puts a parseable object on stdout under json", () => {
    const { out } = capture(() => {
      emitConfirmation(ctx("json"), "Competitor deleted.");
    });

    expect(JSON.parse(out)).toEqual({ ok: true, message: "Competitor deleted." });
  });

  it("puts the tick on stderr, never stdout, for a human", () => {
    // The command produced no payload, so a caller piping it should receive an
    // empty stream rather than a sentence.
    const { out, err } = capture(() => {
      emitConfirmation(ctx("plain"), "Competitor deleted.");
    });

    expect(out).toBe("");
    expect(err).toContain("Competitor deleted.");
  });

  it("stays silent when quiet", () => {
    const { out, err } = capture(() => {
      emitConfirmation(ctx("plain", true), "Competitor deleted.");
    });

    expect(out).toBe("");
    expect(err).toBe("");
  });

  it("prefers a real payload over the synthesized one when the API returned something", () => {
    const { out } = capture(() => {
      emitConfirmation(ctx("json"), "Removed.", { removed: "search" });
    });

    expect(JSON.parse(out)).toEqual({ removed: "search" });
  });
});
