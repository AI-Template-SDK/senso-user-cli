/**
 * The gap-signal opt-out: what reaches the API, from the flag and from the
 * environment.
 *
 * The case worth the most attention is the typo. The API treats any value that
 * is not a "no" as eligible, so a misspelled environment variable would quietly
 * file every probe as a gap while the caller believed they had opted out.
 */

import { afterEach, describe, expect, it } from "vitest";
import { GAP_SIGNALS_ENV, gapSignalsHeaders } from "../../src/lib/gap-signals.js";
import { CliError, EXIT } from "../../src/lib/errors.js";

afterEach(() => {
  delete process.env.SENSO_GAP_SIGNALS;
});

describe("gapSignalsHeaders", () => {
  it("sends no header by default, which is the API's own default", () => {
    expect(gapSignalsHeaders(undefined)).toEqual({});
    expect(gapSignalsHeaders(true)).toEqual({});
  });

  it("sends off when --no-gap-signals was passed", () => {
    expect(gapSignalsHeaders(false)).toEqual({ "X-Senso-Signals": "off" });
  });

  it("sends off for every spelling of no the API accepts, in any case", () => {
    for (const value of ["off", "OFF", " false ", "0", "no", "skip", "none"]) {
      process.env[GAP_SIGNALS_ENV] = value;
      expect(gapSignalsHeaders(undefined), value).toEqual({ "X-Senso-Signals": "off" });
    }
  });

  it("leaves searches eligible for an explicit yes, or an empty value", () => {
    for (const value of ["on", "true", "1", "yes", "record", ""]) {
      process.env[GAP_SIGNALS_ENV] = value;
      expect(gapSignalsHeaders(undefined), value).toEqual({});
    }
  });

  it("lets the flag opt out even when the environment says on", () => {
    process.env[GAP_SIGNALS_ENV] = "on";
    expect(gapSignalsHeaders(false)).toEqual({ "X-Senso-Signals": "off" });
  });

  it("refuses a value it does not recognize, rather than silently leaving signals on", () => {
    process.env[GAP_SIGNALS_ENV] = "of";
    let caught: unknown;
    try {
      gapSignalsHeaders(undefined);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CliError);
    expect((caught as CliError).exitCode).toBe(EXIT.USAGE);
    expect((caught as CliError).message).toContain("SENSO_GAP_SIGNALS");
    expect((caught as CliError).hint).toContain("off");
  });
});
