/**
 * Input layer: the flags every `senso analytics` subcommand shares.
 *
 * Two things are worth protecting here, and both fail silently if they break.
 *
 * The first is the camelCase-to-API mapping in `windowParams`. Commander hands
 * an action `promptType`; the API expects `prompt_type`. If that mapping is
 * dropped or renamed, the request still succeeds — the API ignores a parameter
 * it does not recognize — and the caller gets a wider, unfiltered result set
 * back. An unapplied filter returns MORE data, so nothing looks wrong. That is
 * the failure this file is here to catch.
 *
 * The second is `normalizeBool`. `--mentioned` and `--cited` are free-text
 * strings on the command line, and a value the CLI does not understand must be
 * a usage error that names what it would have accepted — never a silently
 * dropped filter, for the same reason.
 *
 * `--prompt-type` is the same closed-set problem one level up: it is declared
 * once in `addWindowOptions` and read once in `windowParams`, so the check that
 * a misspelled funnel stage exits 2 before any request lives in `windowParams`
 * and is covered here rather than once per subcommand.
 *
 * `addWindowOptions` is tested for which flags it registers rather than for its
 * help wording: `--tag` is deliberately absent from the cited-source commands,
 * because the domain and webpage rollups have no prompt grain to resolve a tag
 * through, and offering it there would advertise a filter that does nothing.
 */

import { describe, expect, it } from "vitest";
import { Command } from "commander";
import {
  addPagingOptions,
  addWindowOptions,
  BOOL_VALUES,
  normalizeBool,
  PROMPT_TYPE_VALUES,
  windowParams,
} from "../../src/commands/analytics/filters.js";
import { CliError, EXIT } from "../../src/lib/errors.js";

/** The long flags a command registers, in registration order. */
function flagsOf(cmd: Command): string[] {
  return cmd.options.map((opt) => opt.long ?? opt.flags);
}

describe("windowParams, mapping flags to query parameters", () => {
  it("renames every flag to the name the API expects", () => {
    expect(
      windowParams({
        from: "2025-08-01",
        to: "2025-08-30",
        models: "gpt-4o,claude-sonnet",
        location: "US,US/California",
        promptType: "consideration",
        tag: "launch",
      }),
    ).toEqual({
      from: "2025-08-01",
      to: "2025-08-30",
      models: "gpt-4o,claude-sonnet",
      location: "US,US/California",
      // The two that are not a straight copy. A rename here is invisible at
      // runtime: the API ignores the unknown key and returns unfiltered rows.
      prompt_type: "consideration",
      tag: "launch",
    });
  });

  it("leaves an unsupplied filter undefined rather than sending an empty value", () => {
    // apiRequest skips undefined, so an absent flag must stay undefined —
    // `?tag=` would be a filter on the empty tag, not the absence of one.
    expect(windowParams({})).toEqual({
      from: undefined,
      to: undefined,
      models: undefined,
      location: undefined,
      prompt_type: undefined,
      tag: undefined,
    });
  });

  it("passes a comma-separated list through untouched", () => {
    // The API does the splitting. Splitting and rejoining here would silently
    // normalize a location like "US/California", which is case- and
    // punctuation-sensitive.
    expect(windowParams({ location: " US , US/California " }).location).toBe(
      " US , US/California ",
    );
  });
});

describe("windowParams, validating --prompt-type", () => {
  it("accepts every funnel stage the help text lists", () => {
    expect(PROMPT_TYPE_VALUES).toEqual(["awareness", "consideration", "evaluation", "decision"]);

    for (const value of PROMPT_TYPE_VALUES) {
      expect(windowParams({ promptType: value }).prompt_type).toBe(value);
    }
  });

  it("names every stage the flag's own description offers", () => {
    // The set validated and the set advertised have to be the same set, or the
    // help text becomes a list of values that get rejected.
    const description = addWindowOptions(new Command("summary")).options.find(
      (o) => o.long === "--prompt-type",
    )?.description;

    for (const value of PROMPT_TYPE_VALUES) expect(description).toContain(value);
  });

  it("canonicalizes the case rather than rejecting it", () => {
    // The API wants the lowercase form; refusing --prompt-type AWARENESS would
    // be pedantry, but forwarding it would be a filter the API cannot read.
    expect(windowParams({ promptType: " Awareness " }).prompt_type).toBe("awareness");
  });

  it("rejects an unrecognized stage as a usage error naming the four", () => {
    // Same reason as normalizeBool: the API ignores a filter it does not
    // recognize, so a forwarded typo returns MORE rows and looks fine.
    try {
      windowParams({ promptType: "purchase" });
      expect.unreachable("windowParams should have thrown");
    } catch (err) {
      const cliError = err as CliError;
      expect(cliError).toBeInstanceOf(CliError);
      expect(cliError.exitCode).toBe(EXIT.USAGE);
      expect(cliError.code).toBe("usage");
      expect(cliError.message).toContain("--prompt-type");
      for (const value of PROMPT_TYPE_VALUES) expect(cliError.hint).toContain(value);
    }
  });

  it("leaves the other filters alone when the flag is absent", () => {
    expect(windowParams({ tag: "launch" }).prompt_type).toBeUndefined();
  });
});

describe("addWindowOptions", () => {
  it("registers the six window filters every windowed command shares", () => {
    const cmd = addWindowOptions(new Command("summary"));

    expect(flagsOf(cmd)).toEqual([
      "--from",
      "--to",
      "--models",
      "--location",
      "--prompt-type",
      "--tag",
    ]);
  });

  it("omits --tag for the cited-source commands, which cannot honor it", () => {
    // Not a cosmetic difference: a tag filter the rollup cannot apply would
    // return more rows than asked for, and look like a wider result set rather
    // than a broken filter.
    const cmd = addWindowOptions(new Command("domains"), { tag: false });

    expect(flagsOf(cmd)).not.toContain("--tag");
    expect(flagsOf(cmd)).toContain("--prompt-type");
  });

  it("returns the same command so the builders can be nested", () => {
    const cmd = new Command("pages");
    expect(addWindowOptions(cmd)).toBe(cmd);
  });

  it("describes the default window, which is not simply the last 30 days", () => {
    // It ends at the most recent day with data, so a caller reading the help
    // knows why `--from`-less output can end before today.
    const from = addWindowOptions(new Command("summary")).options.find((o) => o.long === "--from");

    expect(from?.description).toContain("YYYY-MM-DD");
    expect(from?.description).toContain("most recent day with data");
  });
});

describe("addPagingOptions", () => {
  it("registers --limit and --offset", () => {
    const cmd = addPagingOptions(new Command("prompts"), 50);

    expect(flagsOf(cmd)).toEqual(["--limit", "--offset"]);
  });

  it("names the command's own default limit in the help text", () => {
    // `answers` defaults to 25 and the rest to 50; a shared string would be
    // wrong for one of them.
    const answers = addPagingOptions(new Command("answers"), 25);
    const limit = answers.options.find((o) => o.long === "--limit");

    expect(limit?.description).toContain("25");
    expect(limit?.description).toContain("100");
  });
});

describe("normalizeBool", () => {
  it("accepts every documented spelling of a boolean", () => {
    expect(BOOL_VALUES).toEqual(new Set(["true", "false", "1", "0", "yes", "no"]));

    for (const value of BOOL_VALUES) {
      expect(normalizeBool("mentioned", value)).toBe(value);
    }
  });

  it("lowercases and trims what the user typed", () => {
    // The query parameter has one spelling regardless of how it was typed.
    expect(normalizeBool("cited", "  TRUE ")).toBe("true");
    expect(normalizeBool("cited", "No")).toBe("no");
  });

  it("returns undefined when the flag was not passed at all", () => {
    // Not "false": omitting --mentioned means "do not filter on it", which is a
    // different request from asking for the answers that did not mention you.
    expect(normalizeBool("mentioned", undefined)).toBeUndefined();
  });

  it("rejects a value it does not understand as a usage error", () => {
    // Never a dropped filter: an ignored --mentioned returns every answer, and
    // a wider result set is the one mistake a reader cannot see.
    expect(() => normalizeBool("mentioned", "maybe")).toThrow(CliError);

    try {
      normalizeBool("mentioned", "maybe");
      expect.unreachable("normalizeBool should have thrown");
    } catch (err) {
      const cliError = err as CliError;
      expect(cliError.exitCode).toBe(EXIT.USAGE);
      expect(cliError.code).toBe("usage");
      expect(cliError.message).toContain("--mentioned");
      // The hint has to name the accepted values; "invalid" alone leaves the
      // caller guessing between true/false, 1/0 and yes/no.
      for (const value of BOOL_VALUES) expect(cliError.hint).toContain(value);
    }
  });

  it("rejects the empty string rather than treating it as false", () => {
    expect(() => normalizeBool("cited", "")).toThrow(CliError);
  });

  it("names the flag that was wrong, not a generic one", () => {
    // Both --mentioned and --cited go through this function on the same command.
    expect(() => normalizeBool("cited", "sometimes")).toThrow(/--cited/);
  });
});
