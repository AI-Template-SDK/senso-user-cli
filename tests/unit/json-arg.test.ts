/**
 * The boundary between "you typed it wrong" and "the server said no".
 *
 * A third of the commands take a raw body as `--data '{...}'`, and the single
 * most common way to get one wrong is shell quoting — an unquoted brace, a
 * `$name` the shell expanded, a Windows terminal that ate the single quotes.
 * What is worth protecting here is that none of those reach the API at all:
 * they are usage errors (exit 2) carrying a hint that shows the quoting, and
 * they name the flag they came from so a command taking both `--data` and
 * `--metadata` can say which one is broken.
 *
 * The second half is the "valid JSON, wrong shape" case. `--data '[1,2]'` and
 * `--data '"x"'` parse cleanly, and without this check they would travel to the
 * endpoint and come back as a 400 that blames the API for the user's typo.
 */

import { describe, expect, it } from "vitest";
import { parseJsonFlag } from "../../src/lib/json-arg.js";
import { CliError, EXIT } from "../../src/lib/errors.js";

/** Runs the parse and hands back the CliError it threw. */
function failure(value: string, flag?: string): CliError {
  try {
    parseJsonFlag(value, flag);
  } catch (err) {
    expect(err).toBeInstanceOf(CliError);
    return err as CliError;
  }
  throw new Error(`expected ${value} to be rejected`);
}

describe("parsing a JSON object off the command line", () => {
  it("returns the parsed object", () => {
    expect(parseJsonFlag('{"name":"Acme","count":2}')).toEqual({ name: "Acme", count: 2 });
  });

  it("accepts an empty object, which is a meaningful body", () => {
    expect(parseJsonFlag("{}")).toEqual({});
  });

  it("keeps nested structure intact rather than flattening it", () => {
    expect(parseJsonFlag('{"meta":{"tags":["a","b"]}}')).toEqual({ meta: { tags: ["a", "b"] } });
  });

  it("narrows to the type the caller asserted", () => {
    // The generic is a caller-supplied assertion about the body's shape, which
    // is what lets a command write `body.name` without a cast at the call site.
    const body = parseJsonFlag<{ name: string }>('{"name":"Acme"}');
    expect(body.name).toBe("Acme");
  });
});

describe("rejecting malformed JSON", () => {
  it("treats it as a usage error rather than a generic failure", () => {
    // Exit 2, not 1: nothing was sent, so a caller retrying on 1 would retry a
    // request that can never succeed.
    expect(failure("{not json}").exitCode).toBe(EXIT.USAGE);
    expect(failure("{not json}").code).toBe("invalid_json");
  });

  it("shows the shell quoting in the hint, because that is usually the fault", () => {
    const err = failure("{name: Acme}");

    expect(err.hint).toContain("quoted for your shell");
    expect(err.hint).toContain(`'{"key":"value"}'`);
  });

  it("keeps the parser's own complaint reachable for debug output", () => {
    expect(failure("{").cause).toBeInstanceOf(Error);
  });

  it("rejects an empty string instead of treating it as an empty body", () => {
    expect(failure("").exitCode).toBe(EXIT.USAGE);
  });
});

describe("rejecting valid JSON that is not an object", () => {
  it("says it got an array when handed one", () => {
    const err = failure("[1,2]");

    expect(err.exitCode).toBe(EXIT.USAGE);
    expect(err.message).toContain("must be a JSON object");
    // Naming what arrived is what turns this from "no" into "no, and here is
    // the difference": typeof [] is "object", so the array case has to be
    // called out by name or the message reads as a contradiction.
    expect(err.hint).toContain("an array");
  });

  it("says it got a string when handed a quoted scalar", () => {
    expect(failure('"just a string"').hint).toContain("string");
  });

  it("says it got a number when handed a bare number", () => {
    expect(failure("42").hint).toContain("number");
  });

  it("says it got a boolean when handed one", () => {
    expect(failure("true").hint).toContain("boolean");
  });

  it("rejects a bare null, which typeof alone would call an object", () => {
    const err = failure("null");
    expect(err.exitCode).toBe(EXIT.USAGE);
    expect(err.message).toContain("must be a JSON object");
  });

  it("shows an example of the shape it wanted", () => {
    expect(failure("[]").hint).toContain(`'{"name":"value"}'`);
  });
});

describe("naming the flag that was wrong", () => {
  it("defaults to --data, the flag most commands use", () => {
    expect(failure("nope").message).toContain("--data");
    expect(failure("[]").message).toContain("--data");
  });

  it("uses the flag it was given, so two JSON flags stay distinguishable", () => {
    // A command taking both --data and --metadata must be able to say which
    // one the user has to fix.
    const malformed = failure("nope", "--metadata");
    expect(malformed.message).toContain("--metadata");
    expect(malformed.message).not.toContain("--data");

    const wrongShape = failure("[]", "--metadata");
    expect(wrongShape.message).toContain("--metadata");
    expect(wrongShape.hint).toContain("--metadata");
  });
});
