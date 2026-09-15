/**
 * Retrying one destination without republishing the whole item.
 *
 * A publish_record is one content item published to one destination. The group
 * used to promise "Inspect and retry" and offer only `retry` — there is no read
 * endpoint here at all, and the ids come from `senso content verification`, so
 * the group's first job is to say where they come from.
 *
 * The retry itself is SYNCHRONOUS: 204 means the destination accepted the
 * content and the record is now live. A second refusal comes back as 502, which
 * the generic error layer renders as "Senso API error (502). This is not your
 * fault." — implying an outage when the real cause is the destination refusing
 * the content again. Both of those are corrected here.
 */

import { Command } from "commander";
import { ApiError, apiRequest } from "../lib/api-client.js";
import { CliError, EXIT } from "../lib/errors.js";
import { describeCommand, idExits } from "../lib/help.js";
import { parseId, type IdSpec } from "../lib/id-arg.js";
import { emitConfirmation } from "../lib/output.js";
import { runAction } from "../lib/run-action.js";

const PUBLISH_RECORD: IdSpec = {
  label: "<publishRecordId>",
  type: "Publish record",
  idField: "publish_record_id",
  list: "senso content verification --status published",
};

/** How to read a record's current state before retrying it. */
const READ_STATE =
  "senso content verification --status published --output json | jq -r '.data.items[].destinations[] | \"\\(.publish_record_id) \\(.state)\"'";

/** The same listing, showing why a destination refused. */
const READ_LAST_ERROR =
  "senso content verification --status published --output json | jq -r '.data.items[].destinations[] | \"\\(.publish_record_id) \\(.last_error)\"'";

/**
 * The three 404s and the 502, each of which needs a different response.
 *
 * The API distinguishes "no such record", "its publisher is gone" and "its
 * content is gone" in the message and nowhere else, so passing a `resource` to
 * `apiRequest` would have flattened all three into one sentence. They are
 * separated here instead, and the 502 is re-reported as what it is.
 */
function refine(err: unknown, id: string): unknown {
  if (!(err instanceof ApiError)) return err;

  if (err.status === 502) {
    return new CliError(
      `The destination refused the retry; publish record ${id} is back in \`failed\`.`,
      EXIT.ERROR,
      {
        code: "error",
        status: 502,
        field: "<publishRecordId>",
        received: id,
        hint: `Read last_error for this destination with: ${READ_LAST_ERROR}`,
        details: { api_message: err.message },
        request: err.request,
        cause: err,
      },
    );
  }

  if (err.status === 409) {
    return new CliError(
      `Publish record ${id} is not in a retryable state; only a record in \`failed\` can be retried.`,
      EXIT.ERROR,
      {
        code: "conflict",
        status: 409,
        field: "<publishRecordId>",
        received: id,
        hint: `Read its current state first: ${READ_STATE}`,
        details: { api_message: err.message },
        request: err.request,
        cause: err,
      },
    );
  }

  if (err.status === 404) {
    const what = /publisher/i.test(err.message)
      ? `The publisher for publish record ${id} no longer exists.`
      : /content/i.test(err.message)
        ? `The content behind publish record ${id} no longer exists.`
        : `Publish record ${id} not found.`;
    const hint = /publisher/i.test(err.message)
      ? "The destination was removed from the organization. See what is configured with: senso destinations list"
      : `List the records that exist with: ${READ_STATE}`;
    return new CliError(what, EXIT.NOT_FOUND, {
      code: "not_found",
      status: 404,
      field: "publish_record_id",
      received: id,
      hint,
      details: { api_message: err.message },
      request: err.request,
      cause: err,
    });
  }

  return err;
}

export function registerPublishRecordsCommands(program: Command): void {
  const pr = program
    .command("publish-records")
    .description(
      "Retry a publish that failed for ONE destination, without republishing the whole item. A publish_record is one content item published to one destination. There is no list command here — a publish_record_id comes from `senso content verification` (items[].destinations[].publish_record_id) or `senso content citation-details <content_id>` (destinations[].publish_record_id). States: live (reachable at external_url), pending (queued), publishing (the adapter is running), failed (THE ONLY RETRYABLE STATE), unpublishing, unpublished. The same id is what `senso content unpublish --publish-record-ids` takes.",
    );

  describeCommand(
    pr
      .command("retry")
      .description(
        "Re-run the publish for one content+destination pair that failed. Synchronous: the command returns once the destination has answered, and the record is already live or failed again by then. The adapter has a 15-second timeout server-side, so a slow destination can come back as a failure rather than a success. Only a record in the `failed` state can be retried; anything else is a conflict. Requires the GEO product and update:content.",
      )
      .argument(
        "<publishRecordId>",
        "publish_record_id, from `senso content verification` (items[].destinations[].publish_record_id) or `senso content citation-details <content_id>`",
      )
      .action(
        runAction(program, async (ctx, rawId: string) => {
          const id = parseId(rawId, PUBLISH_RECORD);
          try {
            await apiRequest({
              method: "POST",
              path: `/org/publish-records/${id}/retry`,
              apiKey: ctx.apiKey,
              baseUrl: ctx.baseUrl,
            });
          } catch (err) {
            throw refine(err, id);
          }
          emitConfirmation(
            ctx,
            `Publish record ${id} is now live.`,
            { action: "retried", resource: "publish_record", id, state: "live" },
            {
              next: [
                {
                  why: "Confirm the state and read the live URL",
                  command: "senso content verification --status published",
                },
              ],
            },
          );
        }),
      ),
    {
      returns: [
        "Nothing: the API answers 204, and a 204 means the destination accepted the content.",
        'Under --output json the CLI reports {"action": "retried", "resource": "publish_record", "id": "<id>", "state": "live"}.',
        "On a failure the record is back in `failed` with last_error set; read it from `senso content verification`.",
      ],
      exitCodes: {
        ...idExits,
        1: "the record is not in the `failed` state (409), or the destination refused the retry again (502) — the record is back in `failed`",
        2: "<publishRecordId> is not a UUID",
        3: "the organization lacks the GEO product, or the key lacks update:content",
        4: "no such publish record, or its publisher or its content no longer exists — the message says which",
      },
      notes: [
        "Only `failed` is retryable. Read `state` before retrying rather than retrying opportunistically: every other state is a 409.",
        "This republishes ONE destination. To republish the whole item, run `senso engine publish` again with the same content_id.",
      ],
      examples: [
        { command: "senso publish-records retry 2b7f0c93-41a8-4d6e-9f52-7c8a1e3b0d45" },
        {
          comment: "Retry every failed destination",
          command:
            "senso content verification --status published --output json | jq -r '.data.items[].destinations[] | select(.state==\"failed\") | .publish_record_id' | xargs -n1 senso publish-records retry",
        },
      ],
      seeAlso: [
        "senso content verification",
        "senso content unpublish",
        "senso content citation-details",
        "senso destinations list",
      ],
    },
  );
}
