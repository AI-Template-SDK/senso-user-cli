/**
 * Whether a search may become a gap in the organization's gap report.
 *
 * Senso files a search through `POST /org/search`, `/org/search/full` or
 * `/org/search/stream` that finds nothing as an API search gap. That is the
 * point for a real question, and noise for a probe: an onboarding audit, a
 * post-upload searchability check, a test suite, a monitor. The API reads
 * `X-Senso-Signals: off` to tell the two apart, and the search still runs,
 * costs credits and is recorded in history — it only never counts toward a gap.
 *
 * Two ways to say it, because they suit different callers:
 *
 *   --no-gap-signals       one search, visibly, in the command line
 *   SENSO_GAP_SIGNALS=off  every search in a session, set once — what an agent
 *                          running a scripted audit wants
 *
 * The flag can only turn signals off. The environment variable is a default,
 * and there is no way to force signals on for a single call against it; a
 * caller who set it asked for a session of probes.
 */

import { CliError, EXIT } from "./errors.js";

export const GAP_SIGNALS_HEADER = "X-Senso-Signals";

export const GAP_SIGNALS_ENV = "SENSO_GAP_SIGNALS";

/** The spellings the API accepts for "keep this out", mirrored exactly. */
const OFF = new Set(["off", "false", "0", "no", "skip", "none"]);

/** The spellings that mean "leave it eligible", which is also the default. */
const ON = new Set(["on", "true", "1", "yes", "record"]);

/**
 * Reads SENSO_GAP_SIGNALS.
 *
 * AN UNRECOGNIZED VALUE IS A USAGE ERROR, not a silent "on". The API treats
 * anything that is not a "no" as eligible, so `SENSO_GAP_SIGNALS=of` would file
 * every probe as a gap while the caller believed they had opted out — the one
 * outcome this setting exists to prevent, discovered only when the gap report
 * fills up.
 */
function envDisablesSignals(): boolean {
  const raw = process.env[GAP_SIGNALS_ENV];
  if (raw === undefined || raw.trim() === "") return false;
  const value = raw.trim().toLowerCase();
  if (OFF.has(value)) return true;
  if (ON.has(value)) return false;
  throw new CliError(`Invalid ${GAP_SIGNALS_ENV}: "${raw}".`, EXIT.USAGE, {
    code: "usage",
    hint: `Set ${GAP_SIGNALS_ENV}=off to keep searches out of the gap report, or unset it. Accepted: ${[...OFF].join(", ")} to opt out; ${[...ON].join(", ")} to leave searches eligible.`,
  });
}

/**
 * The headers a search request should carry.
 *
 * `flagValue` is Commander's value for `--no-gap-signals`: `false` when the flag
 * was passed, `true` or `undefined` otherwise. Returns an empty object when the
 * search stays eligible, so the request carries no header at all — the API's
 * default, and the same request this CLI sent before the setting existed.
 */
export function gapSignalsHeaders(flagValue: boolean | undefined): Record<string, string> {
  if (flagValue === false || envDisablesSignals()) {
    return { [GAP_SIGNALS_HEADER]: "off" };
  }
  return {};
}
