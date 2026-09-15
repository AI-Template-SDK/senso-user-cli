/**
 * The parts of `--help` that Commander does not model.
 *
 * Commander gives a command a description, its arguments and its options. For a
 * person that is enough, because a person has a browser and a colleague. For an
 * agent it is not: the three questions it cannot answer from an option list are
 * "what comes back", "what does a failure mean", and "what does a correct
 * invocation look like". Left unanswered, it invents all three.
 *
 * So every leaf command adds the same four sections through this helper, and a
 * policy test fails if one of them is missing. Using a helper rather than 200
 * hand-written `addHelpText` blocks is what keeps the order, the indentation
 * and the wording identical everywhere — an agent reading its second Senso
 * command should already know where to look.
 */

import type { Command } from "commander";

/** What every exit code means for this CLI, before a command narrows it. */
const DEFAULT_EXITS: Record<number, string> = {
  0: "success",
  1: "the API or the runtime refused the request",
  2: "usage error: a flag or argument was rejected before any request was made",
  3: "authentication: no key, or the key was rejected",
  4: "not found",
  5: "network failure or timeout",
};

export interface CommandDoc {
  /**
   * The fields that come back and what they mean, one per line.
   *
   * Every status or enum field MUST list its values here — an agent that reads
   * `processing_status: "pending"` and cannot see the set it belongs to has no
   * way to know whether to poll or to give up.
   */
  returns?: string[];
  /**
   * What this command's exit codes mean, where they are more specific than the
   * defaults. Codes the command cannot produce are left out.
   */
  exitCodes?: Record<number, string>;
  /** Realistic invocations. The first should be the commonest one. */
  examples?: { comment?: string; command: string }[];
  /** Related commands, as bare command lines. */
  seeAlso?: string[];
  /** Anything else an agent must know: billing, async behavior, replacement. */
  notes?: string[];
}

function block(title: string, lines: string[]): string[] {
  return lines.length === 0 ? [] : ["", `${title}:`, ...lines.map((l) => `  ${l}`)];
}

/**
 * Appends the standard sections to a command's help output.
 *
 * Returns the command so it can be chained onto a `.command()` builder.
 */
export function describeCommand(cmd: Command, doc: CommandDoc): Command {
  const lines: string[] = [];

  lines.push(...block("Returns", doc.returns ?? []));

  if (doc.exitCodes) {
    const codes = Object.keys(doc.exitCodes)
      .map(Number)
      .sort((a, b) => a - b)
      .map((code) => `${String(code)}  ${doc.exitCodes?.[code] ?? DEFAULT_EXITS[code] ?? ""}`);
    lines.push(...block("Exit codes", codes));
  }

  if (doc.notes && doc.notes.length > 0) {
    lines.push(...block("Notes", doc.notes));
  }

  if (doc.examples && doc.examples.length > 0) {
    const ex: string[] = [];
    for (const e of doc.examples) {
      if (e.comment) ex.push(`# ${e.comment}`);
      ex.push(e.command);
    }
    lines.push(...block("Examples", ex));
  }

  if (doc.seeAlso && doc.seeAlso.length > 0) {
    lines.push(...block("See also", doc.seeAlso));
  }

  if (lines.length > 0) {
    cmd.addHelpText("after", lines.join("\n"));
  }
  return cmd;
}

/**
 * The exit codes every command that calls the API can produce.
 *
 * Spread into `exitCodes` and override the ones that need a command-specific
 * sentence: `{ ...apiExits, 4: "no KB node with this id in your organization" }`.
 */
export const apiExits: Record<number, string> = {
  0: DEFAULT_EXITS[0] ?? "success",
  1: DEFAULT_EXITS[1] ?? "",
  2: DEFAULT_EXITS[2] ?? "",
  3: DEFAULT_EXITS[3] ?? "",
  5: DEFAULT_EXITS[5] ?? "",
};

/** The same, for a command that addresses a record by id and so can 404. */
export const idExits: Record<number, string> = {
  ...apiExits,
  4: DEFAULT_EXITS[4] ?? "",
};

/** For a command that touches nothing but the local machine. */
export const localExits: Record<number, string> = {
  0: DEFAULT_EXITS[0] ?? "success",
  1: "the operation failed",
  2: DEFAULT_EXITS[2] ?? "",
};
