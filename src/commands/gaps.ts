import { Command } from "commander";
import pc from "picocolors";
import { ApiError, apiRequest } from "../lib/api-client.js";
import { parseEnumFlag, parseIntFlag } from "../lib/enum-arg.js";
import { CliError, EXIT } from "../lib/errors.js";
import { emit, emitConfirmation } from "../lib/output.js";
import { runAction, type Ctx } from "../lib/run-action.js";
import * as log from "../utils/logger.js";

/**
 * The gap report: what the knowledge base could not back up, and what was
 * decided about each.
 *
 * WHO THIS IS WRITTEN FOR. An agent, more often than a person. An agent reads
 * `--help` to learn a command and reads stderr to learn what to do next, so the
 * descriptions below carry the whole lifecycle, every validation names the flag
 * that would fix it, and `get` ends with the concrete commands for this gap's
 * problem and status. None of that guidance touches stdout: under
 * `--output json` the payload is the API's own response and nothing else.
 *
 * WHAT IS CHECKED BEFORE THE REQUEST. Every closed set, every id, and the
 * resolution matrix — a write must name what it produced, a ruling must name the
 * document it is about. The API enforces the same rules with a 400; catching
 * them here turns a round trip into exit 2 with the missing flag named.
 */

const STATUSES = [
  "weak",
  "open",
  "reopened",
  "addressed",
  "resolved",
  "dismissed",
  "dormant",
] as const;
const PROBLEMS = ["conflict", "not_found", "no_source", "flagged"] as const;
const SURFACES = ["search_turn", "content", "question_run", "api_search"] as const;
const ORIGINS = [
  "claim",
  "unanswered_question",
  "documents_didnt_answer",
  "flagged_answer",
  "api_unanswered_question",
] as const;
const KINDS = ["missing", "conflict", "kb_conflict", "flagged"] as const;
const SORTS = ["severity", "recent", "demand"] as const;
const RULING_SIDES = ["kb", "claim", "document"] as const;

const RESOLUTION_TYPES = [
  "answered",
  "content_added",
  "content_updated",
  "ruled_kb_correct",
  "ruled_claim_correct",
  "ruled_document",
  "dismissed",
  "not_relevant",
  "we_dont_do_this",
  "source_irrelevant",
] as const;
type ResolutionType = (typeof RESOLUTION_TYPES)[number];

/** What the list returns when no --status is given. Mirrors the API default. */
const DEFAULT_STATUSES = ["open", "reopened", "addressed"];

/** Plain-language meanings, used in help text and in `get`. */
const PROBLEM_MEANING: Record<string, string> = {
  not_found: "a question nothing in the knowledge base answered",
  no_source: "a claim nothing in the knowledge base backs up",
  conflict: "the knowledge base contradicts what was said, or two documents contradict each other",
  flagged: "a person marked an answer wrong",
};

const ORIGIN_MEANING: Record<string, string> = {
  claim: "an evaluator extracted this claim and could not verify it",
  unanswered_question: "a colleague asked in Quick Search and nothing was found",
  documents_didnt_answer: "Quick Search found documents and still could not answer",
  flagged_answer: "a person marked a Quick Search answer wrong",
  api_unanswered_question: "a search through the API, the MCP server or the CLI found nothing",
};

const STATUS_MEANING: Record<string, string> = {
  weak: "seen once — hidden from the default list, opens if it is seen again",
  open: "outstanding work",
  reopened: "came back after it had been addressed or resolved",
  addressed: "a fix is recorded; it resolves when a later search or evaluation confirms it",
  resolved: "closed by evidence or by a decision",
  dismissed: "closed by a person; seeing it again does not reopen it",
  dormant: "not seen recently; it returns if it is seen again",
};

/**
 * What each resolution does to the gap, and what it requires.
 *
 * Mirrors senso-api's `statusAfterResolution` and `validateResolution`. `status`
 * null means the decision is recorded and the gap does not move — a ruling that
 * a document is stale leaves the gap open until that document is updated.
 */
const RESOLUTION_EFFECT: Record<
  ResolutionType,
  { status: string | null; requires?: "produced" | "authority"; meaning: string }
> = {
  answered: {
    status: "addressed",
    requires: "produced",
    meaning: "an answer was written into the knowledge base",
  },
  content_added: {
    status: "addressed",
    requires: "produced",
    meaning: "a new document was added",
  },
  content_updated: {
    status: "addressed",
    requires: "produced",
    meaning: "an existing document was improved",
  },
  ruled_kb_correct: {
    status: "resolved",
    meaning: "the knowledge base was already right; the claim was wrong",
  },
  ruled_claim_correct: {
    status: null,
    requires: "authority",
    meaning:
      "the claim is right and the named document is stale; update that document next and record content_updated",
  },
  ruled_document: {
    status: null,
    requires: "authority",
    meaning:
      "of two contradicting documents, the named one is right; update the other and record content_updated",
  },
  dismissed: { status: "dismissed", meaning: "it does not matter" },
  not_relevant: { status: "dismissed", meaning: "nothing was wrong" },
  we_dont_do_this: {
    status: "resolved",
    meaning: "the organization does not do this, and recording that is the fix",
  },
  source_irrelevant: {
    status: "dismissed",
    requires: "authority",
    meaning: "the answer used the wrong source; the named document should not have been used",
  },
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An id argument or flag. The API answers a malformed id with a 400. */
function parseUuid(label: string, value: string, hint: string): string {
  const trimmed = value.trim();
  if (!UUID_RE.test(trimmed)) {
    throw new CliError(`Invalid ${label}: "${value}" is not a UUID.`, EXIT.USAGE, {
      code: "usage",
      hint,
    });
  }
  return trimmed;
}

const GAP_ID_HINT = "Gap ids are the `gap_id` field of `senso gaps list`.";

/** Commander collector for a repeatable, comma-separable flag. */
function collect(value: string, previous: string[] = []): string[] {
  return [
    ...previous,
    ...value
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v.length > 0),
  ];
}

/**
 * A value that is present, checked against its closed set.
 *
 * `parseEnumFlag` passes `undefined` through for an omitted optional flag; here
 * the value is always given, so the only outcomes are a member of the set or the
 * usage error naming the valid values.
 */
function requireEnum<T extends string>(flag: string, value: string, allowed: readonly T[]): T {
  const parsed = parseEnumFlag(flag, value, allowed);
  if (parsed === undefined) {
    throw new CliError(`Missing ${flag}.`, EXIT.USAGE, {
      code: "usage",
      hint: `Must be one of: ${allowed.join(", ")}.`,
    });
  }
  return parsed;
}

/** Every value in a repeatable flag, checked against its closed set. */
function parseEnumList<T extends string>(
  flag: string,
  values: string[] | undefined,
  allowed: readonly T[],
): T[] | undefined {
  if (values === undefined || values.length === 0) return undefined;
  return values.map((v) => requireEnum(flag, v, allowed));
}

/**
 * `--status all` is shorthand for every status, including the hidden ones.
 *
 * Checked here rather than through `parseEnumFlag` so a typo's hint can offer
 * `all` alongside the real statuses — it is the value an agent looking for
 * "everything" most needs to learn exists.
 */
function parseStatuses(values: string[] | undefined): string[] | undefined {
  if (values === undefined || values.length === 0) return undefined;
  if (values.some((v) => v.toLowerCase() === "all")) return [...STATUSES];
  return values.map((value) => {
    const match = STATUSES.find((s) => s === value.toLowerCase());
    if (match) return match;
    throw new CliError(`Invalid --status: "${value}".`, EXIT.USAGE, {
      code: "usage",
      hint: `Must be one of: ${STATUSES.join(", ")} — or all, for every status.`,
    });
  });
}

// ---------------------------------------------------------------------------
// Response shapes — assertions about the API, not validations of it
// ---------------------------------------------------------------------------

interface GapOrigin {
  kind?: string;
  surface?: string;
  subject_id?: string;
  title?: string;
  model_label?: string;
  kb_node_id?: string;
}

interface GapRow {
  gap_id: string;
  kind?: string;
  problem?: string;
  status?: string;
  claim_text?: string;
  occurrence_count?: number;
  asker_count?: number;
  api_occurrence_count?: number;
  surfaces?: string[];
  first_seen_at?: string;
  last_seen_at?: string;
  status_changed_at?: string;
  awaiting_update?: boolean;
  contradicting_content_id?: string;
  contradicting_content_title?: string;
  suggested_content_id?: string;
  suggested_content_title?: string;
  assigned_user_name?: string;
  tags?: { name?: string }[];
  origin?: GapOrigin;
}

interface GapList {
  gaps?: GapRow[];
  total?: number;
  limit?: number;
  offset?: number;
}

interface GapResolution {
  resolution_id: string;
  resolution_type?: string;
  ruling_side?: string;
  produced_content_id?: string;
  authority_content_id?: string;
  notes?: string;
  resolved_by_name?: string;
  created_at?: string;
}

interface GapSource {
  content_id?: string;
  kb_node_id?: string;
  title?: string;
  available?: boolean;
}

interface GapEvidence {
  prompt?: string;
  answer_text?: string;
  source_text?: string;
  quote?: string;
  reasoning?: string;
  suggested_fix?: string;
  confidence?: string;
  searches?: { query?: string; result_count?: number }[];
  evidence?: { content_id?: string; title?: string; relation?: string }[];
  sources?: GapSource[];
  feedback?: { user_name?: string; comment?: string; created_at?: string }[];
  retrieval?: { raw_result_count?: number; filtered_result_count?: number; top_score?: number };
}

interface GapDetail {
  gap?: GapRow;
  occurrences?: {
    subject_type?: string;
    subject_id?: string;
    question?: string;
    source_text?: string;
    asked_by_name?: string;
    occurred_at?: string;
  }[];
  resolutions?: GapResolution[];
  lead_evidence?: GapEvidence;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Seven columns: the table caps at eight, and a longer list silently drops some. */
const LIST_COLUMNS = [
  "gap_id",
  "problem",
  "status",
  "origin",
  "occurrences",
  "last_seen_at",
  "claim_text",
];

function demandLine(gap: GapRow): string {
  const n = gap.occurrence_count ?? 0;
  const people = gap.asker_count ?? 0;
  const calls = gap.api_occurrence_count ?? 0;
  return `seen ${String(n)} time${n === 1 ? "" : "s"} — ${String(people)} ${people === 1 ? "person" : "people"}, ${String(calls)} API call${calls === 1 ? "" : "s"}`;
}

function listBlocks(gaps: GapRow[], offset: number): string[] {
  const lines: string[] = [""];
  gaps.forEach((gap, i) => {
    lines.push(`  ${pc.dim(`${String(offset + i + 1)}.`)} ${pc.bold(gap.claim_text ?? "")}`);
    lines.push(
      `     problem: ${gap.problem ?? "?"}   status: ${gap.status ?? "?"}   origin: ${gap.origin?.kind ?? "unknown"}`,
    );
    lines.push(`     ${demandLine(gap)}   last seen ${gap.last_seen_at ?? "?"}`);
    lines.push(`     ${pc.dim(`gap_id: ${gap.gap_id}`)}`);
    lines.push("");
  });
  return lines;
}

function section(title: string, body: string[]): string[] {
  return body.length === 0 ? [] : ["", `  ${pc.bold(title)}`, ...body];
}

function detailLines(detail: GapDetail): string[] {
  const gap = detail.gap;
  if (!gap) return ["  (the response carried no gap)"];

  const out: string[] = [
    "",
    `  ${pc.bold(gap.claim_text ?? "")}`,
    `  ${pc.dim(`gap_id: ${gap.gap_id}`)}`,
    "",
  ];
  const field = (label: string, value: string) => out.push(`  ${label.padEnd(10)} ${value}`);

  field("Problem", `${gap.problem ?? "?"} — ${PROBLEM_MEANING[gap.problem ?? ""] ?? ""}`);
  field(
    "Status",
    `${gap.status ?? "?"} — ${STATUS_MEANING[gap.status ?? ""] ?? ""}${gap.status_changed_at ? ` (since ${gap.status_changed_at})` : ""}`,
  );
  if (gap.awaiting_update) {
    field("", "a ruling is recorded and the losing document has not been updated yet");
  }
  field(
    "Origin",
    `${gap.origin?.kind ?? "unknown"} — ${ORIGIN_MEANING[gap.origin?.kind ?? ""] ?? ""}`,
  );
  if (gap.origin?.title && gap.origin.title !== gap.claim_text) field("Subject", gap.origin.title);
  field(
    "Demand",
    `${demandLine(gap)}; first seen ${gap.first_seen_at ?? "?"}, last ${gap.last_seen_at ?? "?"}`,
  );
  const tags = (gap.tags ?? []).map((t) => t.name).filter(Boolean);
  if (tags.length > 0) field("Topics", tags.join(", "));
  if (gap.assigned_user_name) field("Assigned", gap.assigned_user_name);
  if (gap.contradicting_content_id) {
    field(
      "Conflicts",
      `${gap.contradicting_content_title ?? "a document"} (content_id: ${gap.contradicting_content_id})`,
    );
  }
  if (gap.suggested_content_id) {
    field(
      "Suggested",
      `${gap.suggested_content_title ?? "a document"} (content_id: ${gap.suggested_content_id}) — an unverified hint from the evaluator`,
    );
  }

  const ev = detail.lead_evidence ?? {};
  const evidence: string[] = [];
  if (ev.retrieval) {
    const r = ev.retrieval;
    evidence.push(
      `    Retrieval: ${String(r.raw_result_count ?? "?")} candidates before the relevance filter, ${String(r.filtered_result_count ?? "?")} after${typeof r.top_score === "number" ? `; best score ${r.top_score.toFixed(2)}` : ""}.`,
    );
    if (r.raw_result_count === 0) {
      evidence.push("    Nothing in the knowledge base matched at all — this needs new content.");
    } else if (r.filtered_result_count === 0) {
      evidence.push(
        "    Something matched but scored below the bar — improving an existing document may be enough.",
      );
    }
  }
  if (ev.quote) evidence.push(`    Knowledge base quote: ${ev.quote}`);
  if (ev.reasoning) evidence.push(`    Reasoning: ${ev.reasoning}`);
  if (ev.suggested_fix) evidence.push(`    Suggested fix: ${ev.suggested_fix}`);
  if (ev.confidence) evidence.push(`    Confidence: ${ev.confidence}`);
  if (ev.answer_text) evidence.push(`    The answer given: ${ev.answer_text}`);
  for (const s of ev.searches ?? []) {
    evidence.push(`    Searched: "${s.query ?? ""}" (${String(s.result_count ?? "?")} results)`);
  }
  for (const e of ev.evidence ?? []) {
    evidence.push(
      `    Weighed: ${e.title ?? "untitled"} — ${e.relation ?? "?"} (content_id: ${e.content_id ?? "?"})`,
    );
  }
  for (const s of ev.sources ?? []) {
    evidence.push(
      `    Cited: ${s.title ?? "untitled"} (kb_node_id: ${s.kb_node_id ?? "deleted"}, content_id: ${s.content_id ?? "?"})`,
    );
  }
  for (const f of ev.feedback ?? []) {
    evidence.push(`    Feedback from ${f.user_name ?? "someone"}: ${f.comment ?? "(no comment)"}`);
  }
  out.push(...section("Evidence", evidence));

  out.push(
    ...section(
      `Sightings (${String(detail.occurrences?.length ?? 0)} shown)`,
      (detail.occurrences ?? []).map(
        (o) =>
          `    ${o.occurred_at ?? "?"}  ${o.question ?? o.source_text ?? ""}${o.asked_by_name ? `  — ${o.asked_by_name}` : ""}  ${pc.dim(`${o.subject_type ?? ""} ${o.subject_id ?? ""}`)}`,
      ),
    ),
  );

  out.push(
    ...section(
      "Decisions",
      (detail.resolutions ?? []).map(
        (r) =>
          `    ${r.created_at ?? "?"}  ${r.resolution_type ?? "?"}${r.notes ? ` — ${r.notes}` : ""}${r.resolved_by_name ? `  (${r.resolved_by_name})` : ""}  ${pc.dim(`resolution_id: ${r.resolution_id}`)}`,
      ),
    ),
  );
  out.push("");
  return out;
}

/**
 * What to do about this gap, as commands.
 *
 * Written to stderr after `get`, never to stdout. Built from the problem and the
 * status together because the right act differs by both: a conflict needs a
 * ruling, an unanswered question needs writing, and a closed gap needs nothing
 * unless the decision was wrong.
 */
export function nextSteps(detail: GapDetail): string[] {
  const gap = detail.gap;
  if (!gap) return [];
  const id = gap.gap_id;
  const latest = detail.resolutions?.[0];
  const undo = latest
    ? `If that was wrong, undo the latest decision: senso gaps undo ${id} ${latest.resolution_id}`
    : null;

  switch (gap.status) {
    case "resolved":
      return [
        "Resolved. Nothing to do.",
        ...(undo ? [undo] : ["It was closed by evidence — a later answer or evaluation."]),
      ];
    case "dismissed":
      return ["Dismissed. Seeing it again will not reopen it.", ...(undo ? [undo] : [])];
    case "addressed":
      return [
        "Addressed. A fix is recorded and the gap resolves when a later search or evaluation confirms it. Nothing to do unless the fix was wrong.",
        ...(undo ? [undo] : []),
      ];
  }

  const steps: string[] = [];
  if (gap.status === "weak") {
    steps.push(
      "Seen once, so it is hidden from the default list. It opens if it is seen again; you can act now or wait.",
    );
  }

  const write = `senso kb create-raw --data '{"title":"...","text":"..."}'`;
  const record = `senso gaps answer ${id} --content-id <id from create-raw>`;

  switch (gap.problem) {
    case "not_found": {
      const retrieval = detail.lead_evidence?.retrieval;
      if (
        retrieval &&
        (retrieval.raw_result_count ?? 0) > 0 &&
        retrieval.filtered_result_count === 0
      ) {
        steps.push(
          `Something nearly matched. See which documents, without generating an answer: senso search context ${JSON.stringify(gap.claim_text ?? "")}`,
        );
      }
      steps.push(`Write the answer into the knowledge base: ${write}`);
      steps.push(`Then record it: ${record}`);
      const found = (detail.lead_evidence?.sources ?? []).find((s) => s.kb_node_id);
      if (found) {
        steps.push(
          `Or improve a document the search already found — "${found.title ?? "untitled"}": senso kb update-raw ${found.kb_node_id ?? ""} --data '{...}', then senso gaps answer ${id} --content-id ${found.content_id ?? ""} --updated`,
        );
      }
      if (gap.origin?.kind === "api_unanswered_question") {
        steps.push(
          "This came from a search through the API, the MCP server or the CLI. It also resolves on its own when a later API search for the same question returns a sourced answer.",
        );
        steps.push(
          `If the searches were probes or tests rather than a real need: senso gaps dismiss ${id} — and send future probes with --no-gap-signals.`,
        );
      } else {
        steps.push(`If nobody actually needs this answered: senso gaps dismiss ${id}`);
      }
      break;
    }
    case "no_source":
      steps.push(`If the claim is true, write it down: ${write}, then ${record}`);
      steps.push(
        `If the organization does not do this: senso gaps resolve ${id} --type we_dont_do_this`,
      );
      steps.push(
        `If the claim is wrong and the knowledge base is right: senso gaps resolve ${id} --type ruled_kb_correct`,
      );
      steps.push(`If it does not matter: senso gaps dismiss ${id}`);
      break;
    case "conflict": {
      const doc = gap.contradicting_content_id ?? "<content_id>";
      if (gap.kind === "kb_conflict") {
        steps.push(
          `Two documents disagree. Name the one that is right: senso gaps resolve ${id} --type ruled_document --authority-content-id <content_id of the correct document>`,
        );
      } else {
        steps.push(
          `If the knowledge base is right: senso gaps resolve ${id} --type ruled_kb_correct`,
        );
        steps.push(
          `If the claim is right and the document is stale: senso gaps resolve ${id} --type ruled_claim_correct --authority-content-id ${doc}`,
        );
      }
      steps.push(
        `After updating the stale document: senso gaps answer ${id} --content-id <content_id> --updated`,
      );
      steps.push(`If it does not matter: senso gaps dismiss ${id}`);
      break;
    }
    case "flagged":
      steps.push("Read the feedback above first — nothing has been diagnosed yet.");
      steps.push(`If the answer was wrong, write the correct fact: ${write}, then ${record}`);
      steps.push(
        `If it used the wrong source: senso gaps resolve ${id} --type source_irrelevant --authority-content-id <content_id of that source>`,
      );
      steps.push(`If nothing was wrong: senso gaps resolve ${id} --type not_relevant`);
      break;
    default:
      steps.push(`See what can be recorded: senso gaps resolve --help`);
  }
  return steps;
}

function printSteps(ctx: Ctx, heading: string, steps: string[]): void {
  if (ctx.quiet || steps.length === 0) return;
  log.info(heading);
  for (const step of steps) log.hint(step);
}

/**
 * Turns the API's 400 for an unknown gap into the 404 it means.
 *
 * `GET /org/gaps/{id}` answers an unknown gap with 404, but recording a
 * resolution against one answers 400 "gap not found". An agent branching on
 * exit codes should see the same "does not exist" for both.
 */
function notFoundAware(err: unknown, gapId: string): never {
  if (err instanceof ApiError && err.status === 400 && /gap not found/i.test(err.message)) {
    throw new CliError(`Gap ${gapId} not found.`, EXIT.NOT_FOUND, {
      code: "not_found",
      status: 400,
      hint: "It may be in another organization, or the id is wrong. `senso gaps list --status all` shows every gap.",
      cause: err,
    });
  }
  throw err;
}

// ---------------------------------------------------------------------------
// Recording a resolution — shared by resolve, dismiss and answer
// ---------------------------------------------------------------------------

interface ResolutionInput {
  type: ResolutionType;
  producedContentId?: string;
  authorityContentId?: string;
  rulingSide?: string;
  notes?: string;
}

async function recordResolution(ctx: Ctx, gapId: string, input: ResolutionInput): Promise<void> {
  const effect = RESOLUTION_EFFECT[input.type];
  if (effect.requires === "produced" && input.producedContentId === undefined) {
    throw new CliError(
      `--type ${input.type} needs --produced-content-id: a write that produced nothing is not a fix.`,
      EXIT.USAGE,
      {
        code: "usage",
        hint: `Pass the content id of what was written — the \`id\` from \`senso kb create-raw\`, or a \`content_id\` from \`senso kb get\`. Shortcut: senso gaps answer ${gapId} --content-id <id>`,
      },
    );
  }
  if (effect.requires === "authority" && input.authorityContentId === undefined) {
    throw new CliError(
      `--type ${input.type} needs --authority-content-id: the decision has to name the document it is about.`,
      EXIT.USAGE,
      {
        code: "usage",
        hint: `\`senso gaps get ${gapId}\` lists the documents involved, with their content ids.`,
      },
    );
  }

  const body: Record<string, unknown> = { resolution_type: input.type };
  if (input.producedContentId !== undefined) body.produced_content_id = input.producedContentId;
  if (input.authorityContentId !== undefined) body.authority_content_id = input.authorityContentId;
  if (input.rulingSide !== undefined) body.ruling_side = input.rulingSide;
  if (input.notes !== undefined) body.notes = input.notes;

  let saved: GapResolution;
  try {
    saved = await apiRequest<GapResolution>({
      method: "POST",
      path: `/org/gaps/${gapId}/resolutions`,
      body,
      apiKey: ctx.apiKey,
      baseUrl: ctx.baseUrl,
    });
  } catch (err) {
    notFoundAware(err, gapId);
  }

  if (!ctx.quiet) {
    log.success(`Recorded ${input.type} on gap ${gapId}: ${effect.meaning}.`);
    if (effect.status) {
      log.hint(`The gap is now ${effect.status} — ${STATUS_MEANING[effect.status] ?? ""}.`);
    } else {
      log.hint("The gap's status does not change until the follow-up is recorded.");
    }
    log.hint(`Undo: senso gaps undo ${gapId} ${saved.resolution_id}`);
  }
  emit(ctx, saved, {
    columns: [
      "resolution_id",
      "resolution_type",
      "produced_content_id",
      "authority_content_id",
      "notes",
      "created_at",
    ],
  });
}

function resolutionTypeTable(): string {
  return RESOLUTION_TYPES.map((type) => {
    const e = RESOLUTION_EFFECT[type];
    const needs =
      e.requires === "produced"
        ? " Needs --produced-content-id."
        : e.requires === "authority"
          ? " Needs --authority-content-id."
          : "";
    return `${type} → ${e.status ?? "no status change"}: ${e.meaning}.${needs}`;
  }).join(" ");
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

interface ListOptions {
  status?: string[];
  problem?: string[];
  surface?: string[];
  origin?: string[];
  kind?: string[];
  tag?: string[];
  search?: string;
  sort?: string;
  limit?: string;
  offset?: string;
}

export function registerGapsCommands(program: Command): void {
  const gaps = program
    .command("gaps")
    .description(
      "The gap report: questions and claims your knowledge base could not back up, and what was decided about each — the same queue the Senso app shows. Each gap has a PROBLEM (not_found: a question nothing answered; no_source: a claim nothing backs; conflict: the knowledge base contradicts it; flagged: a person marked an answer wrong), a STATUS (weak: seen once and hidden by default; open; reopened; addressed: a fix is recorded and awaits confirmation; resolved; dismissed; dormant), and an ORIGIN saying where it came from. A search through the API, the MCP server or this CLI that finds nothing files an api_unanswered_question gap: weak on the first call, open on the second, and resolved by a later API search that finds a sourced answer. Typical loop: `gaps list` to find work, `gaps get <id>` for the evidence and the exact next commands, write content with `kb create-raw`, then `gaps answer <id> --content-id <id>`; or `gaps dismiss <id>` for noise. Every decision can be undone with `gaps undo`.",
    );

  gaps
    .command("list")
    .description(
      "List gaps, most severe first. With no --status, only open, reopened and addressed gaps are returned — a gap seen once is weak and hidden, so pass --status weak (or --status all) to see new API search gaps. Repeat a filter or comma-separate it to OR values; different filters are ANDed. Plain output ends with the paging position and the command to read a gap.",
    )
    .option(
      "--status <status>",
      `Filter by status, repeatable: ${STATUSES.join(", ")}, or all (default open, reopened, addressed)`,
      collect,
    )
    .option("--problem <problem>", `Filter by problem, repeatable: ${PROBLEMS.join(", ")}`, collect)
    .option(
      "--origin <origin>",
      `Filter by origin, repeatable: ${ORIGINS.join(", ")}. api_unanswered_question is a search through the API, MCP server or CLI that found nothing`,
      collect,
    )
    .option(
      "--surface <surface>",
      `Filter by where it was seen, repeatable: ${SURFACES.join(", ")}`,
      collect,
    )
    .option("--kind <kind>", `Filter by kind, repeatable: ${KINDS.join(", ")}`, collect)
    .option("--tag <tagId>", "Filter by topic tag id, repeatable (see `senso tags list`)", collect)
    .option("--search <text>", "Only gaps whose text contains this")
    .option("--sort <order>", `${SORTS.join(" | ")} (default severity)`)
    .option("--limit <n>", "Page size, 1-100 (default 50)")
    .option("--offset <n>", "Number of gaps to skip (default 0)")
    .action(
      runAction(program, async (ctx: Ctx, cmdOpts: ListOptions) => {
        const params = {
          statuses: parseStatuses(cmdOpts.status),
          problems: parseEnumList("--problem", cmdOpts.problem, PROBLEMS),
          origin_kinds: parseEnumList("--origin", cmdOpts.origin, ORIGINS),
          surfaces: parseEnumList("--surface", cmdOpts.surface, SURFACES),
          kinds: parseEnumList("--kind", cmdOpts.kind, KINDS),
          tag_ids: cmdOpts.tag?.map((t) =>
            parseUuid("--tag", t, "Tag ids are the `tag_id` field of `senso tags list`."),
          ),
          search: cmdOpts.search,
          sort: parseEnumFlag("--sort", cmdOpts.sort, SORTS),
          limit: parseIntFlag("--limit", cmdOpts.limit, { min: 1, max: 100 }),
          offset: parseIntFlag("--offset", cmdOpts.offset, { min: 0 }),
        };

        const data = await apiRequest<GapList>({
          path: "/org/gaps",
          params,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });

        const rows = data.gaps ?? [];
        const offset = data.offset ?? 0;
        emit(ctx, data, {
          table: {
            rows: rows.map((g) => ({
              gap_id: g.gap_id,
              problem: g.problem,
              status: g.status,
              origin: g.origin?.kind,
              occurrences: g.occurrence_count,
              last_seen_at: g.last_seen_at,
              claim_text: g.claim_text,
            })),
            columns: LIST_COLUMNS,
          },
          plain: rows.length === 0 ? [] : listBlocks(rows, offset),
        });

        if (ctx.quiet) return;
        const total = data.total ?? rows.length;
        if (rows.length === 0) {
          if (params.statuses === undefined) {
            log.info(`No gaps in the working view (${DEFAULT_STATUSES.join(", ")}).`);
            log.hint(
              "A gap seen once is weak and hidden by default. Try: senso gaps list --status weak — or --status all for everything, closed gaps included.",
            );
          } else {
            log.info("No gaps match these filters.");
          }
          return;
        }
        log.info(
          `Showing ${String(offset + 1)}–${String(offset + rows.length)} of ${String(total)}.`,
        );
        if (offset + rows.length < total) {
          log.hint(`Next page: add --offset ${String(offset + rows.length)}`);
        }
        log.hint("Evidence and next steps for one gap: senso gaps get <gap_id>");
      }),
    );

  gaps
    .command("get <gapId>")
    .description(
      "Get one gap in full: the gap, every sighting behind it, every decision recorded against it, and the evidence — what the search found (retrieval counts and best score), the quote and reasoning behind a judged claim, the documents weighed or cited with their kb_node_id and content_id, and any feedback a person left. Plain output ends with the exact commands to act on this gap, chosen from its problem and status.",
    )
    .action(
      runAction(program, async (ctx: Ctx, rawId: string) => {
        const gapId = parseUuid("gap id", rawId, GAP_ID_HINT);
        const data = await apiRequest<GapDetail>({
          path: `/org/gaps/${gapId}`,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data, { plain: detailLines(data) });
        printSteps(ctx, "What you can do:", nextSteps(data));
      }),
    );

  gaps
    .command("resolve <gapId>")
    .description(
      `Record what was done about a gap, and move it accordingly. Types, with the status each leaves the gap in: ${resolutionTypeTable()} For the two common cases use the shortcuts \`gaps answer\` and \`gaps dismiss\`. Undo any decision with \`gaps undo\`.`,
    )
    .requiredOption("--type <type>", `One of: ${RESOLUTION_TYPES.join(", ")}`)
    .option(
      "--produced-content-id <id>",
      "The content that was written — required for answered, content_added and content_updated",
    )
    .option(
      "--authority-content-id <id>",
      "The document the decision is about — required for ruled_claim_correct, ruled_document and source_irrelevant",
    )
    .option("--ruling-side <side>", `Which side a ruling found correct: ${RULING_SIDES.join(", ")}`)
    .option("--notes <text>", "Why, in a sentence — shown on the gap's timeline")
    .action(
      runAction(
        program,
        async (
          ctx: Ctx,
          rawId: string,
          cmdOpts: {
            type: string;
            producedContentId?: string;
            authorityContentId?: string;
            rulingSide?: string;
            notes?: string;
          },
        ) => {
          const gapId = parseUuid("gap id", rawId, GAP_ID_HINT);
          const type = requireEnum("--type", cmdOpts.type, RESOLUTION_TYPES);
          await recordResolution(ctx, gapId, {
            type,
            producedContentId:
              cmdOpts.producedContentId === undefined
                ? undefined
                : parseUuid(
                    "--produced-content-id",
                    cmdOpts.producedContentId,
                    "Content ids are the `id` from `senso kb create-raw`, or `content_id` from `senso kb get`.",
                  ),
            authorityContentId:
              cmdOpts.authorityContentId === undefined
                ? undefined
                : parseUuid(
                    "--authority-content-id",
                    cmdOpts.authorityContentId,
                    `\`senso gaps get ${gapId}\` lists the documents involved, with their content ids.`,
                  ),
            rulingSide: parseEnumFlag("--ruling-side", cmdOpts.rulingSide, RULING_SIDES),
            notes: cmdOpts.notes,
          });
        },
      ),
    );

  gaps
    .command("answer <gapId>")
    .description(
      "Record that content was written to fix a gap — the usual last step after `senso kb create-raw`. Records `answered` (or `content_updated` with --updated, when an existing document was improved instead). The gap becomes addressed and resolves when a later search or evaluation confirms the answer; for an API search gap, that is the next API search for the same question that returns a sourced answer.",
    )
    .requiredOption(
      "--content-id <id>",
      "The content that answers it: the `id` from `senso kb create-raw`, or a `content_id` from `senso kb get`",
    )
    .option("--updated", "An existing document was improved, rather than a new one written")
    .option("--notes <text>", "What was written, in a sentence")
    .action(
      runAction(
        program,
        async (
          ctx: Ctx,
          rawId: string,
          cmdOpts: { contentId: string; updated?: boolean; notes?: string },
        ) => {
          const gapId = parseUuid("gap id", rawId, GAP_ID_HINT);
          const contentId = parseUuid(
            "--content-id",
            cmdOpts.contentId,
            "Content ids are the `id` from `senso kb create-raw`, or `content_id` from `senso kb get`.",
          );
          await recordResolution(ctx, gapId, {
            type: cmdOpts.updated ? "content_updated" : "answered",
            producedContentId: contentId,
            notes: cmdOpts.notes,
          });
        },
      ),
    );

  gaps
    .command("dismiss <gapId>")
    .description(
      "Close a gap that does not need fixing — integration noise, a test or probe search, a question nobody needs answered. Records `dismissed`. A dismissed gap stays closed even if it is seen again; only `gaps undo` reopens it. To keep future probe searches out of the report, run them with `senso search --no-gap-signals`.",
    )
    .option("--notes <text>", "Why it does not matter, in a sentence")
    .action(
      runAction(program, async (ctx: Ctx, rawId: string, cmdOpts: { notes?: string }) => {
        const gapId = parseUuid("gap id", rawId, GAP_ID_HINT);
        await recordResolution(ctx, gapId, { type: "dismissed", notes: cmdOpts.notes });
      }),
    );

  gaps
    .command("undo <gapId> <resolutionId>")
    .description(
      "Retract one recorded decision. The gap's status is recomputed from the decisions that remain — undoing the newer of two returns it to what the older one implied, and undoing the only one makes it open again. Resolution ids are on `gaps get` and in the output of `resolve`, `answer` and `dismiss`.",
    )
    .action(
      runAction(program, async (ctx: Ctx, rawGapId: string, rawResolutionId: string) => {
        const gapId = parseUuid("gap id", rawGapId, GAP_ID_HINT);
        const resolutionId = parseUuid(
          "resolution id",
          rawResolutionId,
          `Resolution ids are listed under Decisions in \`senso gaps get ${gapId}\`.`,
        );
        try {
          await apiRequest({
            method: "DELETE",
            path: `/org/gaps/${gapId}/resolutions/${resolutionId}`,
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });
        } catch (err) {
          if (err instanceof ApiError && err.status === 404) {
            throw new CliError(
              `Gap ${gapId} has no resolution ${resolutionId} in this organization.`,
              EXIT.NOT_FOUND,
              {
                code: "not_found",
                status: 404,
                hint: `Either id is wrong, or the resolution belongs to another gap or was already undone. \`senso gaps get ${gapId}\` lists its current decisions.`,
                cause: err,
              },
            );
          }
          throw err;
        }
        emitConfirmation(
          ctx,
          `Resolution ${resolutionId} undone. The gap's status was recomputed from the decisions that remain — read it with \`senso gaps get ${gapId}\`.`,
          { ok: true, gap_id: gapId, resolution_id: resolutionId },
        );
      }),
    );
}
