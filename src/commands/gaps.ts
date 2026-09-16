import { Command } from "commander";
import pc from "picocolors";
import { ApiError, apiRequest } from "../lib/api-client.js";
import { parseEnumFlag, parseEnumList, parseIntFlag, requireEnumFlag } from "../lib/enum-arg.js";
import { CliError, EXIT } from "../lib/errors.js";
import { apiExits, describeCommand, idExits } from "../lib/help.js";
import { parseId, type IdSpec } from "../lib/id-arg.js";
import { emit, emitConfirmation, type NextStep } from "../lib/output.js";
import type { ResourceRef } from "../lib/resource.js";
import { runAction, type Ctx } from "../lib/run-action.js";
import * as log from "../utils/logger.js";

/**
 * The gap report: what the knowledge base could not back up, and what was
 * decided about each.
 *
 * WHO THIS IS WRITTEN FOR. An agent, more often than a person. An agent reads
 * `--help` to learn a command and reads the envelope to learn what to do next,
 * so the help below carries the whole vocabulary, every validation names the
 * flag that would fix it, and every command ends with the concrete commands for
 * this gap's problem and status.
 *
 * WHERE THAT GUIDANCE GOES, AND WHY IT MOVED. It used to be written to stderr
 * with `log.hint`. Under `--output json` — which is what every published Senso
 * skill passes, and which implies `--quiet` — stderr is silent, so the single
 * most useful thing this group computes reached nobody. It now travels in the
 * envelope's `next` and `warnings` arrays, which `emit` also prints on stderr in
 * plain and table mode. One source, both audiences.
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

const KIND_MEANING: Record<string, string> = {
  missing: "nothing in the knowledge base covers this",
  conflict: "the knowledge base contradicts a claim made somewhere else",
  kb_conflict:
    "two of your own documents contradict each other — the fix is a ruling, not new content",
  flagged: "a person marked an answer wrong",
};

const SURFACE_MEANING: Record<string, string> = {
  search_turn: "a Quick Search answer in the app",
  content: "a draft or a stored document",
  question_run: "a tracked GEO prompt's answer",
  api_search: "a search through the API, the MCP server or this CLI",
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

/**
 * The id spaces this group touches, and where each one comes from.
 *
 * Three UUID spaces flow through six commands and none of them is
 * interchangeable: a gap_id addresses the queue row, a resolution_id addresses
 * one entry in that gap's decision ledger, and a content_id addresses a stored
 * document. `parseId` rejects a malformed one with exit 2 naming the argument,
 * and the same descriptor goes to `apiRequest` so a 404 names the resource.
 */
const GAP_ID: IdSpec = {
  label: "<gapId>",
  type: "Gap",
  idField: "gap_id",
  list: "senso gaps list --status all",
};

const TAG_ID: IdSpec = { label: "--tag", type: "Tag", idField: "tag_id", list: "senso tags list" };

/** `--produced-content-id`, `--authority-content-id` and `--content-id`. */
function contentIdSpec(flag: string): IdSpec {
  return {
    label: flag,
    type: "Content",
    idField: "content_id",
    list: "senso kb get <kb_node_id>",
  };
}

/** Scoped to its gap: a resolution id is only valid against the gap it is on. */
function resolutionIdSpec(gapId: string): IdSpec {
  return {
    label: "<resolutionId>",
    type: "Gap resolution",
    idField: "resolution_id",
    list: `senso gaps get ${gapId}`,
  };
}

/** What a request addresses, so a 404 names the gap instead of saying "not found". */
function gapResource(gapId?: string): ResourceRef {
  return {
    type: "Gap",
    ...(gapId === undefined ? {} : { id: gapId }),
    idField: "gap_id",
    list: "senso gaps list --status all",
  };
}

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
      field: "--status",
      received: value,
      allowed: [...STATUSES, "all"],
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

/** Eight columns: the table caps at eight, and a longer list silently drops some. */
const LIST_COLUMNS = [
  "gap_id",
  "problem",
  "kind",
  "status",
  "origin",
  "occurrences",
  "last_seen_at",
  "claim_text",
];

/** One table row per gap. The column names are the CLI's own, not the API's. */
function listRow(gap: GapRow): Record<string, unknown> {
  return {
    gap_id: gap.gap_id,
    problem: gap.problem,
    kind: gap.kind,
    status: gap.status,
    origin: gap.origin?.kind,
    occurrences: gap.occurrence_count,
    last_seen_at: gap.last_seen_at,
    claim_text: gap.claim_text,
  };
}

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
    // The id on the second line, before anything else about the gap: it is what
    // every other command in this group takes, and an agent reading a block
    // should not have to scan to the bottom of it to find the argument.
    lines.push(`     ${pc.dim(`gap_id: ${gap.gap_id}`)}`);
    lines.push(
      `     problem: ${gap.problem ?? "?"}   status: ${gap.status ?? "?"}   kind: ${gap.kind ?? "?"}   origin: ${gap.origin?.kind ?? "unknown"}`,
    );
    lines.push(`     ${demandLine(gap)}   last seen ${gap.last_seen_at ?? "?"}`);
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
 * What to do about this gap: runnable commands, plus the facts behind them.
 *
 * `next` is the list of commands, each with the one clause that says when to
 * run it. `notes` is what an agent has to know but cannot run — that a gap is
 * already closed, that a weak gap is hidden, that a flagged answer has not been
 * diagnosed yet. They are separated because they land in different places: the
 * envelope's `next` and `warnings`. Both are printed on stderr in plain and
 * table mode, and both survive `--output json`, which is the whole point —
 * everything this function computes used to be written with `log.hint` and was
 * therefore invisible to every caller that passed `--output json`.
 *
 * Built from the problem and the status together because the right act differs
 * by both: a conflict needs a ruling, an unanswered question needs writing, and
 * a closed gap needs nothing unless the decision was wrong.
 */
export interface GapGuidance {
  next: NextStep[];
  notes: string[];
}

export function nextSteps(detail: GapDetail): GapGuidance {
  const gap = detail.gap;
  if (!gap) return { next: [], notes: [] };
  const id = gap.gap_id;
  const latest = detail.resolutions?.[0];
  const undo: NextStep | null = latest
    ? {
        why: "Retract the latest decision if it was wrong",
        command: `senso gaps undo ${id} ${latest.resolution_id}`,
      }
    : null;

  switch (gap.status) {
    case "resolved":
      return {
        next: undo ? [undo] : [],
        notes: [
          "Resolved. Nothing to do.",
          ...(undo ? [] : ["It was closed by evidence — a later answer or evaluation."]),
        ],
      };
    case "dismissed":
      return {
        next: undo ? [undo] : [],
        notes: ["Dismissed. Seeing it again will not reopen it."],
      };
    case "addressed":
      return {
        next: undo ? [undo] : [],
        notes: [
          "Addressed. A fix is recorded and the gap resolves when a later search or evaluation confirms it. Nothing to do unless the fix was wrong.",
        ],
      };
  }

  const next: NextStep[] = [];
  const notes: string[] = [];
  if (gap.status === "weak") {
    notes.push(
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
        next.push({
          why: "Something nearly matched — see which documents, without generating an answer",
          command: `senso search context ${JSON.stringify(gap.claim_text ?? "")}`,
        });
      }
      next.push({ why: "Write the answer into the knowledge base", command: write });
      next.push({ why: "Then record that it answers this gap", command: record });
      const found = (detail.lead_evidence?.sources ?? []).find((s) => s.kb_node_id);
      if (found) {
        next.push({
          why: `Or improve a document the search already found — "${found.title ?? "untitled"}"`,
          command: `senso kb update-raw ${found.kb_node_id ?? ""} --data '{...}', then senso gaps answer ${id} --content-id ${found.content_id ?? ""} --updated`,
        });
      }
      if (gap.origin?.kind === "api_unanswered_question") {
        notes.push(
          "This came from a search through the API, the MCP server or the CLI. It also resolves on its own when a later API search for the same question returns a sourced answer.",
        );
        next.push({
          why: "The searches were probes or tests rather than a real need — send future probes with --no-gap-signals",
          command: `senso gaps dismiss ${id}`,
        });
      } else {
        next.push({
          why: "Nobody actually needs this answered",
          command: `senso gaps dismiss ${id}`,
        });
      }
      break;
    }
    case "no_source":
      next.push({ why: "The claim is true — write it down", command: `${write}, then ${record}` });
      next.push({
        why: "The organization does not do this",
        command: `senso gaps resolve ${id} --type we_dont_do_this`,
      });
      next.push({
        why: "The claim is wrong and the knowledge base is right",
        command: `senso gaps resolve ${id} --type ruled_kb_correct`,
      });
      next.push({ why: "It does not matter", command: `senso gaps dismiss ${id}` });
      break;
    case "conflict": {
      const doc = gap.contradicting_content_id ?? "<content_id>";
      if (gap.kind === "kb_conflict") {
        notes.push("Two of your own documents disagree, so the fix is a ruling, not new content.");
        next.push({
          why: "Name the document that is right",
          command: `senso gaps resolve ${id} --type ruled_document --authority-content-id <content_id of the correct document>`,
        });
      } else {
        next.push({
          why: "The knowledge base is right",
          command: `senso gaps resolve ${id} --type ruled_kb_correct`,
        });
        next.push({
          why: "The claim is right and the document is stale",
          command: `senso gaps resolve ${id} --type ruled_claim_correct --authority-content-id ${doc}`,
        });
      }
      next.push({
        why: "After updating the stale document",
        command: `senso gaps answer ${id} --content-id <content_id> --updated`,
      });
      next.push({ why: "It does not matter", command: `senso gaps dismiss ${id}` });
      break;
    }
    case "flagged":
      notes.push(
        "Read the feedback above first — nothing has been diagnosed yet: a flagged answer records that a person disagreed, not what was wrong.",
      );
      next.push({
        why: "The answer was wrong — write the correct fact",
        command: `${write}, then ${record}`,
      });
      next.push({
        why: "It used the wrong source",
        command: `senso gaps resolve ${id} --type source_irrelevant --authority-content-id <content_id of that source>`,
      });
      next.push({
        why: "Nothing was wrong",
        command: `senso gaps resolve ${id} --type not_relevant`,
      });
      break;
    default:
      next.push({ why: "See what can be recorded", command: `senso gaps resolve --help` });
  }
  return { next, notes };
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
      field: "<gapId>",
      received: gapId,
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
  /** Command-specific follow-ups, appended before the undo command. */
  extraNext?: NextStep[];
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
      resource: gapResource(gapId),
      apiKey: ctx.apiKey,
      baseUrl: ctx.baseUrl,
    });
  } catch (err) {
    notFoundAware(err, gapId);
  }

  // The tick is the only thing left on stderr by hand: it is decoration, and it
  // has no machine-readable counterpart to duplicate. Everything a caller has to
  // ACT on — what the gap now is, how to undo this, what the API did not check —
  // goes through the envelope, which prints to stderr here and to stdout under
  // --output json.
  if (!ctx.quiet) {
    log.success(`Recorded ${input.type} on gap ${gapId}: ${effect.meaning}.`);
  }

  const warnings: string[] = [
    effect.status
      ? `The gap is now ${effect.status} — ${STATUS_MEANING[effect.status] ?? ""}.`
      : `${input.type} does not change the gap's status: it does not change until the follow-up is recorded.`,
  ];
  if (effect.status === "dismissed") {
    warnings.push("A dismissed gap stays closed even if the same question is asked again.");
  }
  if (input.producedContentId !== undefined) {
    // The API records whatever content id it is given: a well-formed id that
    // belongs to nothing, or to another organization, still moves the gap to
    // addressed. That is the one way this command can quietly do the wrong thing.
    warnings.push(
      `The API does not verify content ids: confirm ${input.producedContentId} is the document you meant.`,
    );
  }

  const next: NextStep[] = [];
  if (effect.status === null) {
    next.push({
      why: "The gap stays open until the losing document is corrected",
      command: `senso gaps answer ${gapId} --content-id <content_id of the corrected document> --updated`,
    });
  } else if (effect.status === "addressed") {
    next.push({
      why: "The gap is addressed, not resolved — check it after the next search or evaluation",
      command: `senso gaps get ${gapId}`,
    });
  }
  next.push(...(input.extraNext ?? []));
  next.push({
    why: "Retract this decision if it was wrong",
    command: `senso gaps undo ${gapId} ${saved.resolution_id}`,
  });

  emit(ctx, saved, {
    columns: [
      "resolution_id",
      "resolution_type",
      "produced_content_id",
      "authority_content_id",
      "notes",
      "created_at",
    ],
    next,
    warnings,
  });
}

/** The same ten lines as one paragraph, for the command's description. */
function resolutionTypeTable(): string {
  return resolutionTypeLines().join(" ");
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

/**
 * One line per value of a closed set, with what it means.
 *
 * The meanings are the same constants the plain renderer and the validation
 * messages use, so `--help` cannot describe a vocabulary the output does not
 * speak. An agent that reads `"status": "weak"` and cannot see the set it
 * belongs to has no way to know whether to act or to wait.
 */
function meaningLines(values: readonly string[], meanings: Record<string, string>): string[] {
  return values.map((v) => `  ${v} — ${meanings[v] ?? ""}`);
}

/** Every enum on a gap row, for the `Returns` block of `list` and `get`. */
const GAP_VOCABULARY: string[] = [
  "problem — which queue the gap is in:",
  ...meaningLines(PROBLEMS, PROBLEM_MEANING),
  "status — where it is in its life:",
  ...meaningLines(STATUSES, STATUS_MEANING),
  "kind — the shape of the fix:",
  ...meaningLines(KINDS, KIND_MEANING),
  "origin.kind — where it came from:",
  ...meaningLines(ORIGINS, ORIGIN_MEANING),
  "origin.surface — where it was last seen:",
  ...meaningLines(SURFACES, SURFACE_MEANING),
];

/** The demand counters and the flags that change what you do about a gap. */
const GAP_ROW_RETURNS: string[] = [
  "gap_id — the id every other gaps command takes",
  "occurrence_count / asker_count / api_occurrence_count — total sightings, distinct people, and calls from API, MCP or CLI keys, counted separately",
  "awaiting_update — true when a ruling is recorded and the losing document has not been corrected yet",
  "contradicting_content_id — verified: this document contradicts the claim",
  "suggested_content_id — an UNVERIFIED evaluator hint; check it before acting on it",
  "latest_resolution.resolution_id — what `senso gaps undo` takes",
];

/** The ten resolution types, one per line, for a help block. */
function resolutionTypeLines(): string[] {
  return RESOLUTION_TYPES.map((type) => {
    const e = RESOLUTION_EFFECT[type];
    const needs =
      e.requires === "produced"
        ? " Needs --produced-content-id."
        : e.requires === "authority"
          ? " Needs --authority-content-id."
          : "";
    return `${type} → ${e.status ?? "no status change"}: ${e.meaning}.${needs}`;
  });
}

/** What a resolution comes back as, shared by resolve, answer and dismiss. */
const RESOLUTION_RETURNS: string[] = [
  "resolution_id — pass it to `senso gaps undo <gapId> <resolutionId>` to retract this decision",
  "resolution_type — the type that was recorded, which decides the gap's new status",
  "produced_content_id / authority_content_id — the ids this decision named, echoed back unverified",
  "resolved_by_name — empty when the call was made with an organization API key: the ledger entry has no author",
  "created_at — when it was recorded. Nothing stops the same decision being recorded twice; a second call appends another entry",
];

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

  const list = gaps
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
          tag_ids: cmdOpts.tag?.map((t) => parseId(t, TAG_ID)),
          search: cmdOpts.search,
          sort: parseEnumFlag("--sort", cmdOpts.sort, SORTS),
          limit: parseIntFlag("--limit", cmdOpts.limit, { min: 1, max: 100 }),
          offset: parseIntFlag("--offset", cmdOpts.offset, { min: 0 }),
        };

        const data = await apiRequest<GapList>({
          path: "/org/gaps",
          params,
          resource: gapResource(),
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });

        const rows = data.gaps ?? [];
        const offset = data.offset ?? 0;
        const defaultView = params.statuses === undefined;

        // An empty default view is the costly case, and it is why this guidance
        // is in `next` rather than on stderr: `{"gaps":[],"total":0}` reads as
        // "no work to do" to a JSON caller, when the organization may have
        // dozens of weak gaps that the default filter hides.
        const next: NextStep[] = [];
        const first = rows[0];
        if (first) {
          next.push({
            why: "Read the evidence and the exact commands for one gap",
            command: `senso gaps get ${first.gap_id}`,
          });
        } else if (defaultView) {
          next.push({
            why: "A gap seen once is weak and hidden from the default view — these are the new ones",
            command: "senso gaps list --status weak",
          });
          next.push({
            why: "Every gap, including the closed and dormant ones",
            command: "senso gaps list --status all",
          });
        }

        emit(ctx, data, {
          table: { rows: rows.map(listRow), columns: LIST_COLUMNS },
          ...(rows.length === 0 ? {} : { plain: listBlocks(rows, offset) }),
          empty: "gaps",
          emptyHint: defaultView
            ? `The default view is ${DEFAULT_STATUSES.join(", ")}; a gap seen once is weak and hidden from it.`
            : "No gap matches these filters. Widen them, or run `senso gaps list --status all`.",
          next,
        });
      }),
    );

  describeCommand(list, {
    returns: [
      "gaps[] — one row per gap, most severe first, plus total, limit and offset",
      ...GAP_ROW_RETURNS,
      ...GAP_VOCABULARY,
      "next[] — when the default view comes back empty, the commands that widen it",
    ],
    exitCodes: {
      ...apiExits,
      0: "listed — an empty page is still 0",
      2: "a filter value is outside its set, --tag is not a UUID, --limit is outside 1-100, or --offset is negative",
      3: "no API key, the key was rejected, or the organization does not have the product the gap report belongs to",
    },
    notes: [
      "--sort severity (the default) orders conflict, then kb_conflict, then missing, breaking ties by how often the gap was seen and then by recency. --sort recent is newest sighting first; --sort demand is most distinct askers first.",
      "Under --output json every hint below is silent; the same guidance is in the envelope's `next` array.",
    ],
    examples: [
      { comment: "The working queue: open, reopened and addressed", command: "senso gaps list" },
      {
        comment: "The new API-search gaps, which the default view hides",
        command: "senso gaps list --status weak --origin api_unanswered_question",
      },
      {
        comment: "Just the ids, for a loop",
        command: "senso gaps list --problem conflict --output json | jq -r '.data.gaps[].gap_id'",
      },
    ],
    seeAlso: ["senso gaps get <gapId>", "senso gaps answer <gapId>", "senso tags list"],
  });

  const get = gaps
    .command("get <gapId>")
    .description(
      "Get one gap in full: the gap, every sighting behind it, every decision recorded against it, and the evidence — what the search found (retrieval counts and best score), the quote and reasoning behind a judged claim, the documents weighed or cited with their kb_node_id and content_id, and any feedback a person left. Plain output ends with the exact commands to act on this gap, chosen from its problem and status.",
    )
    .action(
      runAction(program, async (ctx: Ctx, rawId: string) => {
        const gapId = parseId(rawId, GAP_ID);
        const data = await apiRequest<GapDetail>({
          path: `/org/gaps/${gapId}`,
          resource: gapResource(gapId),
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        const guidance = nextSteps(data);
        emit(ctx, data, {
          plain: detailLines(data),
          // Explicit rows: `resolutions` is a known list key, so the generic
          // renderer would treat a gap with a decision ledger as a LIST of
          // decisions and drop the gap itself — and a gap with none would
          // render as "No resolutions found."
          table: { rows: data.gap ? [listRow(data.gap)] : [], columns: LIST_COLUMNS },
          next: guidance.next,
          warnings: guidance.notes,
        });
      }),
    );

  describeCommand(get, {
    returns: [
      "gap — the row, as in `gaps list`",
      "occurrences[] — every sighting: when, what was asked, who asked, and the subject it happened on",
      "resolutions[] — the decision ledger, newest first; resolution_id is what `senso gaps undo` takes",
      "lead_evidence.retrieval.raw_result_count / filtered_result_count — candidates before and after the relevance filter. 0 raw means nothing matched at all, so write new content; raw above 0 with 0 filtered means something nearly matched, so improving an existing document may be enough",
      "lead_evidence.quote / reasoning / suggested_fix / confidence — the judge's own account of itself",
      "lead_evidence.evidence[] — documents weighed, with their relation to the claim",
      "lead_evidence.sources[] — documents the answer cited, with kb_node_id (null when that document has been deleted) and content_id",
      "lead_evidence.feedback[] — what the person who flagged the answer wrote",
      ...GAP_ROW_RETURNS,
      ...GAP_VOCABULARY,
      "next[] — the commands for THIS gap's problem and status, with its id substituted",
      "warnings[] — what cannot be run: that the gap is already closed, that a weak gap is hidden, that a flagged answer has not been diagnosed",
    ],
    exitCodes: {
      ...idExits,
      2: "<gapId> is not a UUID",
      4: "no gap with this id in this organization",
    },
    notes: [
      "<gapId> is a gap_id. The content ids this command prints belong to a different space and are not accepted here; a kb_node_id is not accepted either.",
      "The sightings shown are capped by the API; occurrence_count on the gap is the true total.",
    ],
    examples: [
      { command: "senso gaps get 7c9e6d2a-1f34-4b8e-9a17-2c5d8e0f1b3a" },
      {
        comment: "Just the commands to run next",
        command:
          "senso gaps get 7c9e6d2a-1f34-4b8e-9a17-2c5d8e0f1b3a --output json | jq -r '.next[].command'",
      },
    ],
    seeAlso: [
      "senso gaps answer <gapId>",
      "senso gaps resolve <gapId>",
      "senso gaps dismiss <gapId>",
      "senso kb create-raw",
    ],
  });

  const resolve = gaps
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
          const gapId = parseId(rawId, GAP_ID);
          const type = requireEnumFlag("--type", cmdOpts.type, RESOLUTION_TYPES);
          await recordResolution(ctx, gapId, {
            type,
            producedContentId:
              cmdOpts.producedContentId === undefined
                ? undefined
                : parseId(cmdOpts.producedContentId, contentIdSpec("--produced-content-id")),
            authorityContentId:
              cmdOpts.authorityContentId === undefined
                ? undefined
                : parseId(cmdOpts.authorityContentId, {
                    ...contentIdSpec("--authority-content-id"),
                    list: `senso gaps get ${gapId}`,
                  }),
            rulingSide: parseEnumFlag("--ruling-side", cmdOpts.rulingSide, RULING_SIDES),
            notes: cmdOpts.notes,
          });
        },
      ),
    );

  describeCommand(resolve, {
    returns: RESOLUTION_RETURNS,
    exitCodes: {
      ...idExits,
      2: "--type is not one of the ten, the type needs a flag that was not given, or an id is not a UUID",
      4: "no gap with this id in this organization (the API answers this with a 400; the CLI reports it as 4)",
    },
    notes: [
      "The ten types, with the status each leaves the gap in:",
      ...resolutionTypeLines().map((l) => `  ${l}`),
      "--ruling-side is informational only: it is recorded on the ledger entry and is never cross-checked against --type.",
      "Nothing makes this idempotent. Recording the same decision twice appends a second ledger entry.",
      "With an organization API key the entry has no author, so resolved_by_name comes back empty.",
    ],
    examples: [
      {
        comment: "Two of your own documents disagree, and this one is right",
        command:
          "senso gaps resolve <gapId> --type ruled_document --authority-content-id <content_id>",
      },
      {
        comment: "The organization simply does not do this",
        command: "senso gaps resolve <gapId> --type we_dont_do_this --notes 'We do not ship to EU'",
      },
    ],
    seeAlso: [
      "senso gaps answer <gapId>",
      "senso gaps dismiss <gapId>",
      "senso gaps undo <gapId> <resolutionId>",
    ],
  });

  const answer = gaps
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
          const gapId = parseId(rawId, GAP_ID);
          const contentId = parseId(cmdOpts.contentId, contentIdSpec("--content-id"));
          await recordResolution(ctx, gapId, {
            type: cmdOpts.updated ? "content_updated" : "answered",
            producedContentId: contentId,
            notes: cmdOpts.notes,
          });
        },
      ),
    );

  describeCommand(answer, {
    returns: RESOLUTION_RETURNS,
    exitCodes: {
      ...idExits,
      2: "<gapId> or --content-id is not a UUID",
      4: "no gap with this id in this organization",
    },
    notes: [
      "Both forms land the gap in `addressed`: --updated changes only the type that is recorded (content_updated rather than answered), not the resulting status.",
      "The API does not check the content id. A well-formed id belonging to nothing, or to another organization, is recorded and the gap moves anyway — which is the one way this command can quietly do the wrong thing. The id is echoed in `warnings` so it can be checked.",
      "`addressed` is not `resolved`: the gap resolves when a later search or evaluation confirms the answer. For an API-search gap that is the next API search for the same question that returns a sourced answer.",
    ],
    examples: [
      {
        comment: "The usual last step after writing the answer",
        command: "senso gaps answer <gapId> --content-id <id from kb create-raw>",
      },
      {
        comment: "An existing document was improved instead",
        command: "senso gaps answer <gapId> --content-id <content_id> --updated",
      },
    ],
    seeAlso: [
      "senso kb create-raw",
      "senso gaps get <gapId>",
      "senso gaps undo <gapId> <resolutionId>",
    ],
  });

  const dismiss = gaps
    .command("dismiss <gapId>")
    .description(
      "Close a gap that does not need fixing — integration noise, a test or probe search, a question nobody needs answered. Records `dismissed`. A dismissed gap stays closed even if it is seen again; only `gaps undo` reopens it. To keep future probe searches out of the report, run them with `senso search --no-gap-signals`.",
    )
    .option("--notes <text>", "Why it does not matter, in a sentence")
    .action(
      runAction(program, async (ctx: Ctx, rawId: string, cmdOpts: { notes?: string }) => {
        const gapId = parseId(rawId, GAP_ID);
        await recordResolution(ctx, gapId, {
          type: "dismissed",
          notes: cmdOpts.notes,
          extraNext: [
            {
              why: "Stop probe searches from filing gaps at all",
              command: 'senso search "..." --no-gap-signals',
            },
          ],
        });
      }),
    );

  describeCommand(dismiss, {
    returns: RESOLUTION_RETURNS,
    exitCodes: {
      ...idExits,
      2: "<gapId> is not a UUID",
      4: "no gap with this id in this organization",
    },
    notes: [
      "A dismissed gap stays closed even if the same question is asked again — unlike resolved, which reopens on new evidence. Only `gaps undo` reverses it.",
      "dismissed means 'it does not matter'. `resolve --type not_relevant` means 'nothing was wrong' and `resolve --type we_dont_do_this` means 'the organization does not do this, and recording that IS the fix'. All three close the gap; the ledger keeps which one you meant.",
      "There is no confirmation prompt: the decision is a ledger entry, and `gaps undo` retracts it.",
    ],
    examples: [
      { command: "senso gaps dismiss <gapId> --notes 'load-test probe'" },
      {
        comment: "The upstream fix for probe traffic",
        command: 'senso search "..." --no-gap-signals',
      },
    ],
    seeAlso: ["senso gaps resolve <gapId>", "senso gaps undo <gapId> <resolutionId>"],
  });

  const undo = gaps
    .command("undo <gapId> <resolutionId>")
    .description(
      "Retract one recorded decision. The gap's status is recomputed from the decisions that remain — undoing the newer of two returns it to what the older one implied, and undoing the only one makes it open again. Resolution ids are on `gaps get` and in the output of `resolve`, `answer` and `dismiss`.",
    )
    .action(
      runAction(program, async (ctx: Ctx, rawGapId: string, rawResolutionId: string) => {
        const gapId = parseId(rawGapId, GAP_ID);
        const resolutionId = parseId(rawResolutionId, resolutionIdSpec(gapId));
        try {
          await apiRequest({
            method: "DELETE",
            path: `/org/gaps/${gapId}/resolutions/${resolutionId}`,
            resource: gapResource(gapId),
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });
        } catch (err) {
          if (err instanceof ApiError && err.status === 404) {
            // Two different 404s, and the API already says which: "Gap not
            // found" means the first id is wrong, anything else means the
            // resolution is not on this gap. Reporting both as "either id is
            // wrong" left the caller to guess, and the commonest cause is the
            // two positional UUIDs typed the other way round.
            const gapMissing = /gap not found/i.test(err.message);
            throw new CliError(
              gapMissing
                ? `Gap ${gapId} not found in this organization.`
                : `Gap ${gapId} has no resolution ${resolutionId} in this organization.`,
              EXIT.NOT_FOUND,
              {
                code: "not_found",
                status: 404,
                field: gapMissing ? "<gapId>" : "<resolutionId>",
                received: gapMissing ? gapId : resolutionId,
                hint: gapMissing
                  ? `Check the order — the gap id comes first, then the resolution id. \`senso gaps list --status all\` lists every gap.`
                  : `The resolution belongs to another gap or was already undone. \`senso gaps get ${gapId}\` lists its current decisions.`,
                cause: err,
              },
            );
          }
          throw err;
        }
        emitConfirmation(
          ctx,
          `Resolution ${resolutionId} undone. The gap's status was recomputed from the decisions that remain — read it with \`senso gaps get ${gapId}\`.`,
          { action: "undone", resource: "gap_resolution", id: resolutionId, gap_id: gapId },
          {
            next: [
              {
                why: "The status was recomputed from the decisions that remain — read the new one",
                command: `senso gaps get ${gapId}`,
              },
            ],
          },
        );
      }),
    );

  describeCommand(undo, {
    returns: [
      "action — `undone`",
      "resource — `gap_resolution`",
      "id — the resolution_id that was retracted; gap_id — the gap it was on",
      "The new status is NOT returned: the API answers 204. `next` carries the command that reads it.",
    ],
    exitCodes: {
      ...idExits,
      2: "<gapId> or <resolutionId> is not a UUID",
      4: "no such gap, or that resolution is not on this gap (it may belong to another gap, or already be undone)",
    },
    notes: [
      "Two UUIDs in different id spaces, positional and easy to transpose: <gapId> comes from `senso gaps list`, <resolutionId> from `senso gaps get <gapId>` or from the output of resolve, answer or dismiss.",
      "The gap's status is recomputed from the decisions that remain: undoing the newer of two returns it to what the older one implied, and undoing the only one makes it open again.",
    ],
    examples: [
      { command: "senso gaps undo <gapId> <resolutionId>" },
      {
        comment: "The resolution ids currently on a gap",
        command: "senso gaps get <gapId> --output json | jq -r '.data.resolutions[].resolution_id'",
      },
    ],
    seeAlso: ["senso gaps get <gapId>", "senso gaps resolve <gapId>"],
  });
}
