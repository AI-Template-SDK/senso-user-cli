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

const ctx = (format: OutputContext["format"], quiet = false): OutputContext => ({
  format,
  quiet,
  command: "roles list",
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("emit, in json", () => {
  it("wraps the payload in the envelope, unmodified, on stdout", () => {
    const payload = { roles: [{ role_id: "r1" }], total: 1 };
    const { out, err } = capture(() => {
      emit(ctx("json"), payload);
    });

    const envelope = JSON.parse(out) as Record<string, unknown>;
    // `data` is the API's own shape. Renaming or reshaping it here would break
    // every jq path an agent has been told to use.
    expect(envelope.data).toEqual(payload);
    expect(envelope.ok).toBe(true);
    expect(envelope.command).toBe("roles list");
    expect(err).toBe("");
  });

  it("carries the guidance that stderr cannot, because json implies quiet", () => {
    // The whole reason the envelope exists: `--output json` silences stderr,
    // and every published Senso skill passes it, so a hint written only to
    // stderr reaches nobody.
    const { out } = capture(() => {
      emit(
        ctx("json"),
        { items: [{ id: "a" }], total: 1 },
        {
          next: [{ why: "Read it", command: "senso kb get a" }],
          warnings: ["one file was skipped"],
        },
      );
    });

    const envelope = JSON.parse(out) as { next: unknown; warnings: unknown };
    expect(envelope.next).toEqual([{ why: "Read it", command: "senso kb get a" }]);
    expect(envelope.warnings).toEqual(["one file was skipped"]);
  });

  it("omits page, next and warnings when they do not apply", () => {
    const { out } = capture(() => {
      emit(ctx("json"), { a: 1 });
    });

    expect(Object.keys(JSON.parse(out) as object)).toEqual(["ok", "command", "data"]);
  });

  it("derives the page position from the payload the API already sends", () => {
    const { out } = capture(() => {
      emit(ctx("json"), { items: [{ id: "a" }, { id: "b" }], total: 10, limit: 2, offset: 4 });
    });

    const { page } = JSON.parse(out) as { page: Record<string, unknown> };
    expect(page).toMatchObject({ offset: 4, limit: 2, returned: 2, total: 10, has_more: true });
  });

  it("ignores a command's handcrafted plain rendering", () => {
    // A command supplying nicer human output must not be able to change what a
    // script sees. json is always the raw payload.
    const { out } = capture(() => {
      emit(ctx("json"), { a: 1 }, { plain: ["something else entirely"] });
    });

    expect((JSON.parse(out) as { data: unknown }).data).toEqual({ a: 1 });
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
  it("puts a parseable envelope on stdout under json", () => {
    const { out } = capture(() => {
      emitConfirmation(ctx("json"), "Competitor deleted.");
    });

    expect(JSON.parse(out)).toEqual({
      ok: true,
      command: "roles list",
      data: { action: "ok", message: "Competitor deleted." },
    });
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

  it("names what changed rather than handing back a sentence to parse", () => {
    // A confirmation used to emit { ok, message }, so the only way to learn the
    // id of what was deleted was to parse English out of the message.
    const { out } = capture(() => {
      emitConfirmation(ctx("json"), "Removed.", {
        action: "removed",
        resource: "skill",
        id: "search",
      });
    });

    expect((JSON.parse(out) as { data: unknown }).data).toEqual({
      action: "removed",
      resource: "skill",
      id: "search",
    });
  });
});

describe("emit, in plain, on shapes that used to render as JSON strings", () => {
  it("indents a nested object instead of stringifying it onto one line", () => {
    // `kb get` is the case that mattered: `content.processing_status` is the
    // whole point of the command, and it used to be buried inside an inline
    // JSON blob that an agent would have to parse out of a key/value line.
    const { out } = capture(() => {
      emit(ctx("plain"), {
        kb_node_id: "3f2a",
        content: { content_id: "c1", processing_status: "complete" },
      });
    });

    expect(out).toContain("processing_status");
    expect(out).toContain("complete");
    expect(out).not.toContain('{"content_id"');
  });

  it("renders a list that travels with extra scalars, instead of one long line", () => {
    // `questions list` carries `sort_by`, `competitors suggest` carries `mode`
    // and `cached`, `industries brands` carries `window` and `totals`. None are
    // pagination keys, so the strict envelope rule refused to see a list at all
    // and printed the whole array as a single stringified value.
    const { out } = capture(() => {
      emit(ctx("plain"), {
        questions: [{ id: "q1", text: "one" }],
        sort_by: "created_desc",
        total: 1,
      });
    });

    expect(out).toContain("sort_by");
    expect(out).toContain("q1");
    expect(out).not.toContain('[{"id"');
  });

  it("still treats an object that merely contains a list as an object", () => {
    // /org/me returns the organization with a `locations` array. Reading that
    // as the payload dropped the org's name, slug and tier from every format
    // but json, which is the bug the strict rule was written for.
    const { out } = capture(() => {
      emit(ctx("plain"), { name: "Acme", slug: "acme", locations: [{ country_code: "US" }] });
    });

    expect(out).toContain("Acme");
    expect(out).toContain("acme");
  });

  it("keeps the record's own fields when its list is empty", () => {
    // `prompts get` returns the prompt WITH its runs. An empty `runs` used to
    // print "No runs found." and nothing else, so the prompt_id, text and type
    // — the whole reason to run the command — disappeared exactly when there
    // was least other information on screen.
    const { out } = capture(() => {
      emit(ctx("plain"), { prompt_id: "p-1", text: "best crm", runs: [] }, { empty: "runs" });
    });

    expect(out).toContain("prompt_id");
    expect(out).toContain("best crm");
    expect(out).toContain("No runs found.");
  });

  it("says a list is empty rather than printing a blank envelope field", () => {
    const { out, err } = capture(() => {
      emit(
        ctx("plain"),
        { gaps: [], total: 0 },
        {
          empty: "gaps",
          emptyHint: "A gap seen once is weak and hidden. Try: senso gaps list --status weak",
        },
      );
    });

    expect(out).toContain("No gaps found.");
    // Why it might be empty belongs on stderr, where it does not pollute the
    // payload, and in `next`/`warnings` for the json caller.
    expect(err).toContain("--status weak");
  });
});

describe("emit, in table", () => {
  it("warns when a declared column exists on no row", () => {
    // This is the runtime half of the guard: `tags list` asked for `tag_id`
    // where the API returns `id`, so every row printed a blank first column and
    // the CLI looked finished.
    const { err } = capture(() => {
      outputTable([{ id: "t1", name: "pricing" }], ["tag_id", "name"]);
    });

    expect(err).toContain("tag_id");
    expect(err).toContain("did not return");
  });
});
