import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";
import { parseEnumFlag, parseIntFlag } from "../lib/enum-arg.js";
import { usageError } from "../lib/errors.js";
import { apiExits, describeCommand, idExits } from "../lib/help.js";
import { parseId, parseIdList } from "../lib/id-arg.js";
import { parseJsonFlag } from "../lib/json-arg.js";
import { emit, emitConfirmation } from "../lib/output.js";
import type { ResourceRef } from "../lib/resource.js";
import { runAction } from "../lib/run-action.js";

/** The sort orders `prompts list --sort` documents. */
const SORT_ORDERS = [
  "created_desc",
  "created_asc",
  "text_asc",
  "text_desc",
  "type_asc",
  "type_desc",
] as const;

/** Columns for the tag endpoints, which all return dto.TagResponse. */
const TAG_COLUMNS = ["id", "name", "curated"];

/** The funnel stages `type` may take, as the API stores them. */
const STAGES = ["awareness", "consideration", "evaluation", "decision"] as const;

/**
 * The legacy spellings POST /org/prompts rewrites.
 *
 * services.NormalizeQuestionType (internal/services/question_type_utils.go)
 * accepts these case-insensitively and stores the canonical stage. They are
 * accepted here for the same reason: rejecting a value the API takes would make
 * this CLI stricter than the endpoint it wraps. POST /org/questions does NOT
 * take them — its validator is a strict `oneof` — which is why `questions
 * create` has its own, narrower check.
 */
const STAGE_ALIASES: Record<string, string> = {
  "brand-specific": "decision",
  brand_specific: "decision",
  brandspecific: "decision",
  rank: "consideration",
  ranking: "consideration",
  topic: "awareness",
  "industry topic": "awareness",
  industry_topic: "awareness",
  industrytopic: "awareness",
  comparison: "evaluation",
};

/** dto.CreateOrgPromptRequest: `validate:"required,min=1,max=500"`. */
const MAX_QUESTION_TEXT = 500;

/** The API's own limit on a tag name (ErrTagNameInvalid past this). */
const MAX_TAG_NAME = 255;

/** GET /org/prompts clamps a larger page silently rather than reporting it. */
const MAX_PAGE = 100;

/** What a prompt request addresses, so a 404 names the record and the id space. */
function promptResource(id: string): ResourceRef {
  return { type: "Prompt", id, idField: "prompt_id", list: "senso prompts list" };
}

/** One funnel stage, or exit 2 naming the four the API stores. */
function parseStage(field: string, value: unknown): string {
  if (typeof value !== "string") {
    throw usageError(`"${field}" in --data must be a string naming a funnel stage.`, {
      field,
      allowed: STAGES,
      hint: `One of: ${STAGES.join(", ")}.`,
    });
  }
  const normalized = value.trim().toLowerCase();
  const canonical = STAGES.find((s) => s === normalized) ?? STAGE_ALIASES[normalized];
  if (canonical === undefined) {
    throw usageError(`Invalid "${field}" in --data: "${value}".`, {
      field,
      received: value,
      allowed: STAGES,
      hint: `One of: ${STAGES.join(", ")}. The legacy spellings brand-specific, rank, ranking, topic, industry_topic and comparison are accepted too and rewritten.`,
    });
  }
  return canonical;
}

/** The question text, checked against the length this endpoint enforces. */
function assertQuestionText(value: unknown): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw usageError(`"question_text" in --data must be a non-empty string.`, {
      field: "question_text",
      hint: `Example: --data '{"question_text":"What is the best CRM for a 20-person agency?","type":"decision"}'`,
    });
  }
  if (value.length > MAX_QUESTION_TEXT) {
    throw usageError(
      `"question_text" is ${String(value.length)} characters; this endpoint accepts at most ${String(MAX_QUESTION_TEXT)}.`,
      {
        field: "question_text",
        received: `${String(value.length)} characters`,
        hint: `Shorten the question to ${String(MAX_QUESTION_TEXT)} characters or fewer. (\`senso questions create\` accepts only 255 for the same field.)`,
      },
    );
  }
}

/** A comma-separated flag, trimmed, with the empty entries dropped. */
function csv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Tag names, checked for the two things the API rejects. */
function parseTagNames(flag: string, value: string | undefined): string[] {
  const names = csv(value);
  const tooLong = names.filter((n) => n.length > MAX_TAG_NAME);
  if (tooLong.length > 0) {
    throw usageError(
      `Invalid ${flag}: ${tooLong.map((n) => `"${n.slice(0, 20)}…"`).join(", ")} ${tooLong.length === 1 ? "is" : "are"} longer than ${String(MAX_TAG_NAME)} characters.`,
      {
        field: flag,
        hint: `A tag name is 1-${String(MAX_TAG_NAME)} characters.`,
      },
    );
  }
  return names;
}

/** Tag ids, every bad one named at once rather than one round trip each. */
function parseTagIds(flag: string, value: string | undefined): string[] {
  return parseIdList(csv(value), {
    label: flag,
    type: "Tag",
    idField: "id",
    list: "senso tags list",
  });
}

export function registerPromptCommands(program: Command): void {
  const prompts = program
    .command("prompts")
    .description(
      "Manage prompts — the tracked GEO questions AI models are asked on your run schedule, which also seed content generation. Prompts and questions are the SAME records: `senso prompts` and `senso questions` read and write the same geo_questions rows, and prompt_id is the same UUID as geo_question_id. Use `prompts` for search, sorting, paging, run history and tags; use `questions` to change a question's funnel stage, to attach tags at creation, or to see the questions a network shares. Workflow: prompts create → prompts tags set → prompts list → (scheduled run) → prompts get. Creating a prompt does NOT run it — runs fire on the days set with `senso run-config set-schedule`. Requires the GEO product.",
    );

  describeCommand(
    prompts
      .command("list")
      .description(
        "List the organization's prompts, newest first. --search is a case-insensitive substring of the question text only (not tags); --sort orders the page.",
      )
      .option("--limit <n>", `Rows per page, 1-${String(MAX_PAGE)} (default: 50)`)
      .option("--offset <n>", "Rows to skip, 0 or more (default: 0)")
      .option("--search <query>", "Case-insensitive substring of the question text")
      .option("--sort <order>", `Sort order: ${SORT_ORDERS.join(", ")} (default: created_desc)`),
    {
      returns: [
        "prompts[].prompt_id — the prompt id, and the same UUID as geo_question_id in `senso questions list`. Takes: prompts get/delete, prompts tags *, questions patch/delete, generate sample --prompt-id",
        "prompts[].text — the question asked of the AI models",
        "prompts[].type — funnel stage: awareness (discovering the problem) | consideration (comparing approaches) | evaluation (comparing named vendors) | decision (ready to choose)",
        "prompts[].tags — tags attached to the prompt; prompts are auto-tagged in the background after creation",
        "total — prompts matching --search across all pages, not just this one",
        "limit, offset — the page actually served",
      ],
      exitCodes: {
        ...apiExits,
        2: "--sort is not one of the six orders, or --limit / --offset is not an integer in range",
        3: "no API key, or the organization does not have the GEO product",
      },
      examples: [
        { command: "senso prompts list" },
        {
          comment: "Find the prompts about one topic",
          command: 'senso prompts list --search "best crm" --sort text_asc',
        },
        {
          comment: "Just the ids",
          command: "senso prompts list --output json | jq -r '.data.prompts[].prompt_id'",
        },
      ],
      seeAlso: ["senso prompts get <promptId>", "senso questions list", "senso analytics prompts"],
    },
  ).action(
    runAction(program, async (ctx, cmdOpts: Record<string, string>) => {
      const data = await apiRequest({
        path: "/org/prompts",
        params: {
          // Checked rather than forwarded: the API ignores an unparseable limit
          // and clamps anything over 100, so `--limit 500` used to return a
          // different page than the one that was asked for, silently.
          limit: parseIntFlag("--limit", cmdOpts.limit, { min: 1, max: MAX_PAGE }),
          offset: parseIntFlag("--offset", cmdOpts.offset, { min: 0 }),
          search: cmdOpts.search,
          sort: parseEnumFlag("--sort", cmdOpts.sort, SORT_ORDERS),
        },
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
      });
      emit(ctx, data, {
        columns: ["prompt_id", "text", "type", "created_at"],
        empty: "prompts",
        emptyHint: cmdOpts.search
          ? "--search matches the question text only, as a substring. Drop it to see every prompt: `senso prompts list`."
          : "Add one with `senso prompts create --data '{\"question_text\":\"...\",\"type\":\"decision\"}'`.",
      });
    }),
  );

  describeCommand(
    prompts
      .command("create")
      .description(
        "Add a tracked prompt (a GEO question). Creating it does NOT run it — runs fire on the org's schedule.",
      )
      .requiredOption(
        "--data <json>",
        'JSON: { "question_text": "What are the best...", "type": "decision" }. question_text is 1-500 characters; type is awareness | consideration | evaluation | decision.',
      ),
    {
      returns: [
        "prompt_id — the new prompt, and the same UUID as geo_question_id under `senso questions`",
        "text, created_at, updated_at — the stored prompt",
        "type — the CANONICAL stage, which differs from what was sent when a legacy spelling was used (brand-specific → decision, rank/ranking → consideration, topic/industry_topic → awareness, comparison → evaluation)",
        "tags — always [] here: auto-tagging runs in the background, so read the tags back with `senso prompts tags list <promptId>`",
      ],
      exitCodes: {
        ...apiExits,
        2: "--data is not JSON, names an unknown key, is missing question_text or type, question_text is over 500 characters, or type is not an accepted stage",
        3: "no API key, or the organization does not have the GEO product",
      },
      examples: [
        {
          command:
            'senso prompts create --data \'{"question_text":"What is the best CRM for a 20-person agency?","type":"decision"}\'',
        },
        {
          comment: "Keep the id for the follow-up commands",
          command:
            'senso prompts create --data \'{"question_text":"...","type":"awareness"}\' --output json | jq -r .data.prompt_id',
        },
      ],
      notes: [
        "This endpoint models question_text and type only. To attach tags, use `senso prompts tags set` afterwards, or create through `senso questions create`, which takes tag_ids.",
      ],
      seeAlso: ["senso prompts tags set <promptId>", "senso questions create", "senso run-config schedule"],
    },
  ).action(
    runAction(program, async (ctx, cmdOpts: { data: string }) => {
      const body = parseJsonFlag<{ question_text?: unknown; type?: unknown }>(cmdOpts.data, {
        required: ["question_text", "type"],
      });
      assertQuestionText(body.question_text);
      const created = await apiRequest<{ prompt_id?: string }>({
        method: "POST",
        path: "/org/prompts",
        body: { ...body, type: parseStage("type", body.type) },
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
      });
      const id = created.prompt_id ?? "<promptId>";
      emit(ctx, created, {
        next: [
          { why: "Tags are assigned asynchronously; read them back", command: `senso prompts tags list ${id}` },
          { why: "Prompts run on the org schedule, not on creation", command: "senso run-config schedule" },
        ],
      });
    }),
  );

  describeCommand(
    prompts
      .command("get")
      .description(
        "Read one prompt with its full run history: every time the AI models were asked this question, what they said, who they mentioned and what they cited.",
      )
      .argument(
        "<promptId>",
        "prompt_id, from `senso prompts list`, or the identical geo_question_id from `senso questions list`. Not a content_id, run_id or tag id.",
      ),
    {
      returns: [
        "prompt_id, text, type, tags, scope — the prompt itself; scope is `org` for prompts you created",
        "runs[] — newest first, and EMPTY until the first scheduled run completes",
        "runs[].model — which model answered: chatgpt | perplexity | gemini | grok | google_ai_overviews | claude | gpt",
        "runs[].is_latest — true for the most recent run per model",
        "runs[].target_mentioned — whether your organization was mentioned",
        "runs[].target_rank — your position in the answer, 1 = first; null when not mentioned",
        "runs[].target_sov — your share of voice in this answer, 0-1",
        "runs[].target_sentiment — sentiment toward you, -1 to 1",
        "runs[].evals[] — EVERY organization mentioned, with is_target_org marking yours",
        "runs[].competitors[] — the subset of evals with is_target_org = false; the same mention_id values, not a separate list",
        "runs[].claims[] — statements the model made, each with citations[] (source_url, citation_type, order)",
      ],
      exitCodes: {
        ...idExits,
        2: "<promptId> is not a UUID",
        3: "no API key, or the organization does not have the GEO product",
        4: "no prompt with this id in your organization",
      },
      examples: [
        { command: "senso prompts get 7c9e6679-7425-40de-944b-e07fc1f90ae7" },
        {
          comment: "The latest answer per model",
          command:
            "senso prompts get 7c9e6679-7425-40de-944b-e07fc1f90ae7 --output json | jq '.data.runs[] | select(.is_latest) | {model, target_rank}'",
        },
      ],
      seeAlso: ["senso prompts list", "senso analytics prompts", "senso run-config schedule"],
    },
  ).action(
    runAction(program, async (ctx, promptId: string) => {
      const id = parseId(promptId, { label: "<promptId>", ...promptResource(promptId) });
      const data = await apiRequest<{ runs?: unknown[] }>({
        path: `/org/prompts/${id}`,
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
        resource: promptResource(id),
      });
      // An empty run history is the normal state for a prompt created since the
      // last scheduled run, and it is indistinguishable from "nothing works"
      // unless the CLI says which it is.
      const noRuns = (data.runs ?? []).length === 0;
      emit(ctx, data, {
        warnings: noRuns
          ? ["This prompt has no runs yet. Runs are produced by the scheduler, not by creating a prompt."]
          : [],
        next: noRuns
          ? [{ why: "See which days runs fire", command: "senso run-config schedule" }]
          : [{ why: "Compare this prompt against the others", command: "senso analytics prompts" }],
      });
    }),
  );

  describeCommand(
    prompts
      .command("delete")
      .description(
        "Remove a prompt and hide its run history. The record is soft-deleted: it stops appearing in every prompt, question and analytics endpoint, and there is no undelete.",
      )
      .argument(
        "<promptId>",
        "prompt_id from `senso prompts list` (identical to geo_question_id from `senso questions list`)",
      ),
    {
      returns: [
        "Nothing on stdout in plain output. Under --output json: { action: \"deleted\", resource: \"prompt\", id }",
      ],
      exitCodes: {
        ...idExits,
        2: "<promptId> is not a UUID",
        3: "no API key, or the organization does not have the GEO product",
        4: "no prompt with this id in your organization (an already deleted prompt counts)",
      },
      examples: [
        { command: "senso prompts delete 7c9e6679-7425-40de-944b-e07fc1f90ae7" },
        { command: "senso prompts delete 7c9e6679-7425-40de-944b-e07fc1f90ae7 --output json" },
      ],
      notes: [
        "`senso questions delete <id>` is the same operation on the same row. Recreating the question starts a fresh history; the old runs do not come back.",
      ],
      seeAlso: ["senso prompts list", "senso questions delete <questionId>"],
    },
  ).action(
    runAction(program, async (ctx, promptId: string) => {
      const id = parseId(promptId, { label: "<promptId>", ...promptResource(promptId) });
      await apiRequest({
        method: "DELETE",
        path: `/org/prompts/${id}`,
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
        resource: promptResource(id),
      });
      emitConfirmation(ctx, `Prompt ${id} deleted, with its run history.`, {
        action: "deleted",
        resource: "prompt",
        id,
      });
    }),
  );

  const tags = prompts
    .command("tags")
    .description(
      "Manage the tags on a prompt. Prompts are auto-tagged in the background when created, so these commands correct or extend that. <promptId> is a prompt_id from `senso prompts list`; --id/--ids take tag ids from `senso tags list` or the `id` field of `prompts tags list`. A --name/--names that the organization does not have is CREATED, and a name that exists but is uncurated (machine-minted from a search query) is ADOPTED into the org's vocabulary — a change to the whole organization, not just this prompt. `set` replaces the whole set; `add` and `remove` change one tag.",
    );

  describeCommand(
    tags
      .command("list")
      .description("List the tags currently attached to a prompt.")
      .argument("<promptId>", "prompt_id from `senso prompts list`"),
    {
      returns: [
        "A bare array of tags, with no envelope. For each:",
        "id — the tag id; pass it to `prompts tags remove --id` or `prompts tags set --ids`",
        "name — the tag name; pass it to --name / --names instead",
        "curated — true: part of the organization's working vocabulary. false: machine-minted from a search query and not yet adopted; attaching it with add/set adopts it org-wide",
      ],
      exitCodes: {
        ...idExits,
        2: "<promptId> is not a UUID",
        3: "no API key, or the organization does not have the GEO product",
        4: "no prompt with this id in your organization",
      },
      examples: [
        { command: "senso prompts tags list 7c9e6679-7425-40de-944b-e07fc1f90ae7" },
        {
          command:
            "senso prompts tags list 7c9e6679-7425-40de-944b-e07fc1f90ae7 --output json | jq -r '.data[].name'",
        },
      ],
      seeAlso: ["senso prompts tags set <promptId>", "senso tags list"],
    },
  ).action(
    runAction(program, async (ctx, promptId: string) => {
      const id = parseId(promptId, { label: "<promptId>", ...promptResource(promptId) });
      const data = await apiRequest({
        path: `/org/prompts/${id}/tags`,
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
        resource: promptResource(id),
      });
      emit(ctx, data, {
        columns: TAG_COLUMNS,
        empty: "tags",
        emptyHint: `Attach one with \`senso prompts tags add ${id} --name <tag>\`.`,
      });
    }),
  );

  describeCommand(
    tags
      .command("set")
      .description(
        "REPLACE a prompt's tags with exactly the set named. Tags on the prompt that are not named are removed.",
      )
      .argument("<promptId>", "prompt_id from `senso prompts list`")
      .option("--names <list>", "Comma-separated tag names, created if the organization lacks them")
      .option("--ids <list>", "Comma-separated existing tag UUIDs, from `senso tags list`")
      .option("--clear", "Remove every tag from the prompt. Not combinable with --names or --ids."),
    {
      returns: ["The prompt's tags after the replace: id, name, curated for each."],
      exitCodes: {
        ...idExits,
        2: "no flag was given, <promptId> or an --ids entry is not a UUID, or a name is longer than 255 characters",
        3: "no API key, or the organization does not have the GEO product",
        4: "no prompt with this id in your organization",
        1: "the API refused: a tag id that does not exist, or one from another organization",
      },
      examples: [
        {
          command:
            "senso prompts tags set 7c9e6679-7425-40de-944b-e07fc1f90ae7 --names crm,buying-guide",
        },
        { comment: "Remove every tag", command: "senso prompts tags set 7c9e6679-7425-40de-944b-e07fc1f90ae7 --clear" },
      ],
      notes: [
        "At least one of --names, --ids or --clear is required. An empty body would clear the prompt's tags, which is too destructive to be the default for a forgotten flag.",
      ],
      seeAlso: ["senso prompts tags add <promptId>", "senso prompts tags remove <promptId>", "senso tags list"],
    },
  ).action(
    runAction(
      program,
      async (ctx, promptId: string, cmdOpts: { names?: string; ids?: string; clear?: boolean }) => {
        const id = parseId(promptId, { label: "<promptId>", ...promptResource(promptId) });
        const names = parseTagNames("--names", cmdOpts.names);
        const ids = parseTagIds("--ids", cmdOpts.ids);

        if (cmdOpts.clear && (names.length > 0 || ids.length > 0)) {
          throw usageError("--clear cannot be combined with --names or --ids.", {
            field: "--clear",
            hint: "Pass --clear on its own to remove every tag, or name the tags you want the prompt to end up with.",
          });
        }
        // PUT with `{}` is how the API says "no tags", so a forgotten flag used
        // to wipe the prompt's tags and report success. Clearing now has to be
        // asked for.
        if (!cmdOpts.clear && names.length === 0 && ids.length === 0) {
          throw usageError("Provide --names, --ids or --clear.", {
            field: "--names",
            hint: "`--names a,b` sets the tags by name, `--ids <uuid>,<uuid>` by id, and `--clear` removes them all.",
          });
        }

        const body: Record<string, string[]> = {};
        if (names.length > 0) body.tag_names = names;
        if (ids.length > 0) body.tag_ids = ids;

        const data = await apiRequest({
          method: "PUT",
          path: `/org/prompts/${id}/tags`,
          body,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
          resource: promptResource(id),
        });
        emit(ctx, data, {
          columns: TAG_COLUMNS,
          empty: "tags",
          warnings: [
            cmdOpts.clear
              ? `Every tag was removed from prompt ${id}.`
              : `Prompt ${id} now has exactly these tags; any others were removed.`,
          ],
        });
      },
    ),
  );

  describeCommand(
    tags
      .command("add")
      .description("Attach one tag to a prompt, leaving its other tags in place.")
      .argument("<promptId>", "prompt_id from `senso prompts list`")
      .option("--name <name>", "Tag name, created if the organization does not have it")
      .option("--id <tagId>", "An existing tag UUID, from `senso tags list`"),
    {
      returns: [
        "Nothing: the API answers 204. To learn the id of a tag created by name, run `senso prompts tags list <promptId>`.",
        'Under --output json: { action: "attached", resource: "prompt_tag", id }',
      ],
      exitCodes: {
        ...idExits,
        2: "neither or both of --name / --id, an id that is not a UUID, or a name longer than 255 characters",
        3: "no API key, or the organization does not have the GEO product",
        4: "no prompt with this id in your organization",
        1: "the API refused: the tag id does not exist, or belongs to another organization",
      },
      examples: [
        { command: "senso prompts tags add 7c9e6679-7425-40de-944b-e07fc1f90ae7 --name buying-guide" },
        {
          command:
            "senso prompts tags add 7c9e6679-7425-40de-944b-e07fc1f90ae7 --id 3fa85f64-5717-4562-b3fc-2c963f66afa6",
        },
      ],
      seeAlso: ["senso prompts tags list <promptId>", "senso prompts tags set <promptId>", "senso tags list"],
    },
  ).action(
    runAction(program, async (ctx, promptId: string, cmdOpts: { name?: string; id?: string }) => {
      const id = parseId(promptId, { label: "<promptId>", ...promptResource(promptId) });
      const body = tagSelector(cmdOpts, "attach");
      await apiRequest({
        method: "POST",
        path: `/org/prompts/${id}/tags`,
        body,
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
        resource: promptResource(id),
      });
      emitConfirmation(
        ctx,
        `Tag attached to prompt ${id}.`,
        { action: "attached", resource: "prompt_tag", id },
        {
          next: [
            {
              why: "The API returns nothing, so read the tag back to learn its id",
              command: `senso prompts tags list ${id}`,
            },
          ],
        },
      );
    }),
  );

  describeCommand(
    tags
      .command("remove")
      .description(
        "Detach one tag from a prompt. The prompt's other tags are untouched and the tag itself stays in the organization's vocabulary.",
      )
      .argument("<promptId>", "prompt_id from `senso prompts list`")
      .option("--name <name>", "Tag name to detach")
      .option("--id <tagId>", "Tag UUID to detach, from `senso prompts tags list <promptId>`"),
    {
      returns: [
        'Nothing: the API answers 204. Under --output json: { action: "detached", resource: "prompt_tag", id }',
      ],
      exitCodes: {
        ...idExits,
        2: "neither or both of --name / --id, an id that is not a UUID, or a blank name",
        3: "no API key, or the organization does not have the GEO product",
        4: "no prompt with this id in your organization",
      },
      examples: [
        { command: "senso prompts tags remove 7c9e6679-7425-40de-944b-e07fc1f90ae7 --name buying-guide" },
        {
          command:
            "senso prompts tags remove 7c9e6679-7425-40de-944b-e07fc1f90ae7 --id 3fa85f64-5717-4562-b3fc-2c963f66afa6",
        },
      ],
      notes: [
        "This exits 0 whenever the request is accepted, including when the tag was not attached and when no tag of that name exists — the API answers 204 in every case. Confirm with `senso prompts tags list <promptId>`.",
      ],
      seeAlso: ["senso prompts tags list <promptId>", "senso prompts tags set <promptId>"],
    },
  ).action(
    runAction(program, async (ctx, promptId: string, cmdOpts: { name?: string; id?: string }) => {
      const id = parseId(promptId, { label: "<promptId>", ...promptResource(promptId) });
      const selector = tagSelector(cmdOpts, "detach");
      if (selector.tag_id !== undefined) {
        await apiRequest({
          method: "DELETE",
          path: `/org/prompts/${id}/tags/${selector.tag_id}`,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
          resource: promptResource(id),
        });
      } else {
        await apiRequest({
          method: "DELETE",
          path: `/org/prompts/${id}/tags`,
          params: { name: selector.tag_name },
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
          resource: promptResource(id),
        });
      }
      emitConfirmation(
        ctx,
        `Tag detached from prompt ${id}.`,
        { action: "detached", resource: "prompt_tag", id },
        {
          warnings: [
            "The API answers 204 whether or not the tag was attached, so this is not proof that anything changed.",
          ],
          next: [{ why: "Confirm what the prompt is tagged with now", command: `senso prompts tags list ${id}` }],
        },
      );
    }),
  );
}

/**
 * The one tag a single-tag command acts on, by name or by id.
 *
 * Both flags together used to be accepted with --id winning silently, so a
 * caller who meant the name watched a different tag move. Exactly one is now
 * required, and the id is checked before the request rather than coming back as
 * an unattributed 400 "Invalid tag ID".
 */
function tagSelector(
  cmdOpts: { name?: string; id?: string },
  verb: "attach" | "detach",
): { tag_id?: string; tag_name?: string } {
  const name = cmdOpts.name?.trim();
  if (cmdOpts.id && name) {
    throw usageError("Pass --name or --id, not both.", {
      field: "--id",
      hint: `Name the one tag to ${verb}: --name <tag> resolves by name, --id <tagId> by id.`,
    });
  }
  if (cmdOpts.id) {
    return {
      tag_id: parseId(cmdOpts.id, {
        label: "--id",
        type: "Tag",
        idField: "id",
        list: "senso tags list",
      }),
    };
  }
  if (name) {
    if (name.length > MAX_TAG_NAME) {
      throw usageError(
        `Invalid --name: it is longer than ${String(MAX_TAG_NAME)} characters.`,
        { field: "--name", hint: `A tag name is 1-${String(MAX_TAG_NAME)} characters.` },
      );
    }
    return { tag_name: name };
  }
  throw usageError("Provide --name or --id.", {
    field: "--name",
    hint: `Pass --name <tag> to ${verb} by name, or --id <tagId> to ${verb} by id.`,
  });
}
