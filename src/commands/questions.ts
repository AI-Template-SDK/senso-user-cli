import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";
import { parseEnumFlag } from "../lib/enum-arg.js";
import { usageError } from "../lib/errors.js";
import { apiExits, describeCommand, idExits } from "../lib/help.js";
import { parseId, parseIdList } from "../lib/id-arg.js";
import { parseJsonFlag } from "../lib/json-arg.js";
import { emit, emitConfirmation } from "../lib/output.js";
import type { ResourceRef } from "../lib/resource.js";
import { runAction } from "../lib/run-action.js";
import { asText } from "../lib/text.js";

/** `--type` on `questions list` is the SCOPE, not the funnel stage. */
const QUESTION_SCOPES = ["organization", "network"] as const;

/**
 * The funnel stages this group accepts, and only these.
 *
 * dto.CreateGeoQuestionRequest and dto.PatchGeoQuestionRequest both carry
 * `validate:"oneof=decision consideration awareness evaluation"`, and the tag
 * runs before services.NormalizeQuestionType — so the legacy spellings that
 * `senso prompts create` accepts (rank, topic, comparison, brand-specific) are
 * rejected here, on the same table. Two endpoints, two vocabularies.
 */
const STAGES = ["awareness", "consideration", "evaluation", "decision"] as const;

/** dto.CreateGeoQuestionRequest: `min=1,max=255` — 500 through `prompts create`. */
const MAX_QUESTION_TEXT = 255;

/** What a question request addresses, so a 404 names the record and the id space. */
function questionResource(id: string): ResourceRef {
  return {
    type: "Question",
    id,
    idField: "geo_question_id",
    list: "senso questions list",
  };
}

/** One canonical funnel stage, lowercase, or exit 2 naming the four. */
function parseStage(value: unknown): string {
  if (typeof value !== "string" || !STAGES.includes(value as (typeof STAGES)[number])) {
    throw usageError(
      typeof value === "string"
        ? `Invalid "type" in --data: "${value}".`
        : `"type" in --data must be a string naming a funnel stage.`,
      {
        field: "type",
        received: typeof value === "string" ? value : undefined,
        allowed: STAGES,
        // Deliberately strict: this endpoint's validator is a case-sensitive
        // oneof, so "Decision" and "rank" are 400s here even though
        // `senso prompts create` rewrites both.
        hint: `Exactly one of: ${STAGES.join(", ")}, lowercase. (\`senso prompts create\` also accepts the legacy spellings; this endpoint does not.)`,
      },
    );
  }
  return value;
}

/** Every tag id in the body, each checked before the question is written. */
function parseTagIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw usageError(`"tag_ids" in --data must be an array of tag ids.`, {
      field: "tag_ids",
      hint: "Tag ids come from `senso tags list`. Pass [] to attach none, e.g. --data '{\"tag_ids\":[]}'.",
    });
  }
  const entries = value.map((v, i) => {
    if (typeof v !== "string") {
      throw usageError(`"tag_ids[${String(i)}]" in --data must be a string.`, {
        field: "tag_ids",
        hint: "Every entry is a tag id from `senso tags list`.",
      });
    }
    return v;
  });
  return parseIdList(entries, {
    label: "tag_ids",
    type: "Tag",
    idField: "id",
    list: "senso tags list",
  });
}

export function registerQuestionsCommands(program: Command): void {
  const questions = program
    .command("questions")
    .description(
      "Manage the organization's geo questions. These are the SAME records as `senso prompts`: both groups read and write the same geo_questions rows behind the same GEO product gate, and geo_question_id is the same UUID as prompt_id. Use this group for what only it does — change a question's funnel stage (`questions patch`), attach tags while creating (`questions create`), and list the questions a network shares (`questions list --type network`). Use `senso prompts` for search, sorting, paging, run history and tag management. Two meanings of \"type\" live here: `--type` on `questions list` is the SCOPE (organization | network), while `type` inside --data is the FUNNEL STAGE (awareness | consideration | evaluation | decision) and is also the `type` field in the output. `questions delete` removes the question AND its run history, exactly as `prompts delete` does.",
    );

  describeCommand(
    questions
      .command("list")
      .description(
        "List every question in the organization, or every question its network shares. Not paginated: all rows come back in one response. `senso prompts list` is the paged, searchable, sortable view of the same records.",
      )
      .option(
        "--type <scope>",
        "Which questions to list — organization (yours) or network (shared with you). This is the scope, not the funnel stage.",
        "organization",
      ),
    {
      returns: [
        "questions[].geo_question_id — the question id, and the same UUID as prompt_id. Takes: questions patch/delete, prompts get/delete, prompts tags *, generate sample --prompt-id",
        "questions[].question_text — the question asked of the AI models",
        "questions[].type — funnel stage: awareness | consideration | evaluation | decision",
        "questions[].tags — attached tags",
        "questions[].persona_name — the persona this question came from, or null",
        "total — the number of questions returned",
        'limit, offset, sort_by — always 0 / 0 / "": this endpoint neither pages nor sorts. Ignore them.',
      ],
      exitCodes: {
        ...apiExits,
        2: "--type is not organization or network",
        3: "no API key, or the organization does not have the GEO product",
      },
      examples: [
        { command: "senso questions list" },
        {
          comment: "The questions your network shares",
          command: "senso questions list --type network",
        },
        {
          command:
            "senso questions list --output json | jq -r '.data.questions[] | [.geo_question_id, .type] | @tsv'",
        },
      ],
      notes: [
        "`--type network` on an organization that belongs to no network returns an empty list rather than an error.",
      ],
      seeAlso: [
        "senso prompts list",
        "senso questions create",
        "senso questions patch <questionId>",
      ],
    },
  ).action(
    runAction(program, async (ctx, cmdOpts: Record<string, string>) => {
      const scope = parseEnumFlag("--type", cmdOpts.type, QUESTION_SCOPES);
      const data = await apiRequest({
        path: "/org/questions",
        params: { question_type: scope },
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
      });
      // geo_question_id is the id these are referenced by everywhere else — it
      // is prompt_id under another name. The envelope carries an inert `sort_by`
      // beside the list, which the shared renderer treats as a header rather
      // than as a reason to stop rendering the list.
      emit(ctx, data, {
        columns: ["geo_question_id", "question_text", "type", "created_at"],
        empty: "questions",
        emptyHint:
          scope === "network"
            ? "An organization with no network gets an empty list here. Check with `senso org get`."
            : 'Add one with `senso questions create --data \'{"question_text":"...","type":"decision"}\'`.',
      });
    }),
  );

  describeCommand(
    questions
      .command("create")
      .description(
        "Create a question, optionally with tags. Same record as `senso prompts create`; this variant takes tag_ids at creation and is stricter about the stage spelling.",
      )
      .requiredOption(
        "--data <json>",
        'JSON: { "question_text": "...", "type": "decision", "tag_ids": ["<uuid>"] }. question_text is 1-255 characters; type is exactly one of awareness, consideration, evaluation, decision.',
      ),
    {
      returns: [
        "geo_question_id — the new question, and the same UUID as prompt_id under `senso prompts`",
        "question_text, type — as stored",
        "tags — present only when tag_ids were supplied AND attached. The API attaches tags after creating the question and swallows a failure, so tag_ids sent with no tags returned means the attach failed",
        "persona_id, persona_question_id, persona_name — null for a question created here",
      ],
      exitCodes: {
        ...apiExits,
        2: "--data is not JSON, names an unknown key, is missing question_text or type, question_text is over 255 characters, type is not one of the four stages, or a tag_ids entry is not a UUID",
        3: "no API key, or the organization does not have the GEO product",
      },
      examples: [
        {
          command:
            'senso questions create --data \'{"question_text":"How do agencies choose a CRM?","type":"consideration"}\'',
        },
        {
          comment: "With tags attached at creation",
          command:
            'senso questions create --data \'{"question_text":"...","type":"decision","tag_ids":["3fa85f64-5717-4562-b3fc-2c963f66afa6"]}\'',
        },
      ],
      notes: [
        "question_text is capped at 255 characters here and at 500 through `senso prompts create`, for the same column.",
        "geo_pool_id is accepted but rarely needed: an unknown pool is silently replaced with the organization's default.",
      ],
      seeAlso: ["senso prompts create", "senso questions patch <questionId>", "senso tags list"],
    },
  ).action(
    runAction(program, async (ctx, cmdOpts: { data: string }) => {
      const body = parseJsonFlag<{
        question_text?: unknown;
        type?: unknown;
        tag_ids?: unknown;
        geo_pool_id?: unknown;
      }>(cmdOpts.data, {
        required: ["question_text", "type"],
        optional: ["tag_ids", "geo_pool_id"],
      });

      if (typeof body.question_text !== "string" || body.question_text.trim() === "") {
        throw usageError(`"question_text" in --data must be a non-empty string.`, {
          field: "question_text",
          hint: `Example: --data '{"question_text":"How do agencies choose a CRM?","type":"consideration"}'`,
        });
      }
      if (body.question_text.length > MAX_QUESTION_TEXT) {
        throw usageError(
          `"question_text" is ${String(body.question_text.length)} characters; this endpoint accepts at most ${String(MAX_QUESTION_TEXT)}.`,
          {
            field: "question_text",
            received: `${String(body.question_text.length)} characters`,
            hint: `Shorten it to ${String(MAX_QUESTION_TEXT)} characters, or use \`senso prompts create\`, which accepts 500.`,
          },
        );
      }

      const tagIds = body.tag_ids === undefined ? undefined : parseTagIds(body.tag_ids);
      const poolId =
        body.geo_pool_id === undefined
          ? undefined
          : parseId(asText(body.geo_pool_id), {
              label: "geo_pool_id",
              type: "Geo pool",
              idField: "geo_pool_id",
            });

      const created = await apiRequest<{ geo_question_id?: string; tags?: unknown[] }>({
        method: "POST",
        path: "/org/questions",
        body: {
          question_text: body.question_text,
          type: parseStage(body.type),
          ...(tagIds ? { tag_ids: tagIds } : {}),
          ...(poolId ? { geo_pool_id: poolId } : {}),
        },
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
      });

      const id = created.geo_question_id ?? "<questionId>";
      // The handler attaches tags after the insert and reports a failure only
      // through c.Error(), still answering 201 — so a missing `tags` is the only
      // signal the caller gets that its tag ids did not take.
      const tagsDropped = tagIds !== undefined && tagIds.length > 0 && !created.tags;
      emit(ctx, created, {
        warnings: tagsDropped
          ? [
              "The question was created but the response carries no tags, which means the API could not attach the tag_ids that were sent.",
            ]
          : [],
        next: [
          ...(tagsDropped
            ? [
                {
                  why: "Check which tags actually landed",
                  command: `senso prompts tags list ${id}`,
                },
              ]
            : []),
          {
            why: "Questions run on the org schedule, not on creation",
            command: "senso run-config schedule",
          },
        ],
      });
    }),
  );

  describeCommand(
    questions
      .command("patch")
      .description(
        "Change a question's funnel stage and/or its tags. This is the only command that can change the stage — the `prompts` group has no update.",
      )
      .argument(
        "<questionId>",
        "geo_question_id from `senso questions list`, or the identical prompt_id from `senso prompts list`",
      )
      .requiredOption(
        "--data <json>",
        'JSON with at least one of: { "type": "awareness|consideration|evaluation|decision" } and { "tag_ids": ["<uuid>"] }. tag_ids REPLACES the question\'s tags; pass [] to remove them all. tag_ids: null does NOT clear them — the API reads null as "field not supplied" and rejects the request.',
      ),
    {
      returns: ["The question after the update: geo_question_id, question_text, type, tags"],
      exitCodes: {
        ...idExits,
        2: "--data is not JSON, names neither type nor tag_ids, uses tag_ids: null, has a stage outside the four, or a tag id that is not a UUID; or <questionId> is not a UUID",
        3: "no API key, or the organization does not have the GEO product",
        4: "no question with this id in your organization",
      },
      examples: [
        {
          comment: "Move a question down the funnel",
          command:
            'senso questions patch 11111111-1111-4111-8111-111111111111 --data \'{"type":"decision"}\'',
        },
        {
          comment: "Remove every tag",
          command:
            "senso questions patch 11111111-1111-4111-8111-111111111111 --data '{\"tag_ids\":[]}'",
        },
        {
          command:
            'senso questions patch 11111111-1111-4111-8111-111111111111 --data \'{"type":"evaluation","tag_ids":["3fa85f64-5717-4562-b3fc-2c963f66afa6"]}\'',
        },
      ],
      notes: [
        "tag_ids is a full replacement, not an append. For an incremental change use `senso prompts tags add` / `senso prompts tags remove`.",
      ],
      seeAlso: [
        "senso prompts tags add <promptId>",
        "senso prompts tags remove <promptId>",
        "senso tags list",
      ],
    },
  ).action(
    runAction(program, async (ctx, questionId: string, cmdOpts: { data: string }) => {
      const id = parseId(questionId, { label: "<questionId>", ...questionResource(questionId) });
      const body = parseJsonFlag<{ tag_ids?: unknown; type?: unknown }>(cmdOpts.data, {
        anyOf: ["tag_ids", "type"],
      });

      // `tag_ids: null` was what this command's own help recommended for
      // clearing tags. dto.PatchGeoQuestionRequest declares TagIDs as
      // *[]uuid.UUID, so a JSON null arrives as nil — indistinguishable from
      // "not provided" — and the request comes back 400 "At least one field
      // must be provided for update". The empty array is the only value that
      // clears them.
      if (body.tag_ids === null) {
        throw usageError(`"tag_ids": null does not clear the tags.`, {
          field: "tag_ids",
          received: "null",
          hint: `The API reads null as "field not supplied". Pass an empty array instead: --data '{"tag_ids":[]}'`,
        });
      }
      if (body.type === null) {
        throw usageError(`"type": null is not a funnel stage.`, {
          field: "type",
          received: "null",
          allowed: STAGES,
          hint: `Omit the field to leave the stage unchanged, or set it to one of: ${STAGES.join(", ")}.`,
        });
      }

      const patch: Record<string, unknown> = {};
      if (body.tag_ids !== undefined) patch.tag_ids = parseTagIds(body.tag_ids);
      if (body.type !== undefined) patch.type = parseStage(body.type);

      const data = await apiRequest({
        method: "PATCH",
        path: `/org/questions/${id}`,
        body: patch,
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
        resource: questionResource(id),
      });
      emit(ctx, data, {
        warnings:
          patch.tag_ids === undefined
            ? []
            : [
                `tag_ids replaced the question's whole tag set; tags that were not listed are now detached.`,
              ],
        next: [{ why: "See the question's run history", command: `senso prompts get ${id}` }],
      });
    }),
  );

  describeCommand(
    questions
      .command("delete")
      .description(
        "Remove a question and hide its run history. Identical in effect to `senso prompts delete`: the record is soft-deleted, disappears from every question, prompt and analytics endpoint, and cannot be restored from the CLI.",
      )
      .argument(
        "<questionId>",
        "geo_question_id from `senso questions list`, or the identical prompt_id from `senso prompts list`",
      ),
    {
      returns: [
        'Nothing on stdout in plain output. Under --output json: { action: "deleted", resource: "question", id }',
      ],
      exitCodes: {
        ...idExits,
        2: "<questionId> is not a UUID",
        3: "no API key, or the organization does not have the GEO product",
        4: "no question with this id in your organization (an already deleted question counts)",
      },
      examples: [
        { command: "senso questions delete 11111111-1111-4111-8111-111111111111" },
        { command: "senso questions delete 11111111-1111-4111-8111-111111111111 --output json" },
      ],
      notes: [
        "This is not the lightweight half of a pair: the question's runs, mentions, claims and citations go with it, exactly as for `senso prompts delete`.",
      ],
      seeAlso: ["senso prompts delete <promptId>", "senso questions list"],
    },
  ).action(
    runAction(program, async (ctx, questionId: string) => {
      const id = parseId(questionId, { label: "<questionId>", ...questionResource(questionId) });
      await apiRequest({
        method: "DELETE",
        path: `/org/questions/${id}`,
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
        resource: questionResource(id),
      });
      emitConfirmation(
        ctx,
        `Question ${id} deleted, with its run history.`,
        { action: "deleted", resource: "question", id },
        {
          warnings: [
            "This removed the same row `senso prompts delete` would have, including every run recorded against it.",
          ],
        },
      );
    }),
  );
}
