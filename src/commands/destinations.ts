import { Command } from "commander";
import { ApiError, apiRequest } from "../lib/api-client.js";
import { requireEnumFlag } from "../lib/enum-arg.js";
import { CliError, EXIT, usageError } from "../lib/errors.js";
import { apiExits, describeCommand, idExits } from "../lib/help.js";
import { parseId, type IdSpec } from "../lib/id-arg.js";
import { emit } from "../lib/output.js";
import { runAction } from "../lib/run-action.js";
import * as log from "../utils/logger.js";

/**
 * The only type POST /org/destinations accepts.
 *
 * The flag used to offer three, because `citeables`, `codeables` and
 * `cucopilot` all appear in `destinations list` — but those two are SLUGS of
 * shared destinations, not publisher types, and the handler rejects anything
 * but `citeables` with a 400. An agent that followed the old help paid a round
 * trip to learn that.
 */
const SUPPORTED_TYPES = ["citeables"] as const;

const REMOVE_ACTIONS = ["leave", "unpublish", "delete"] as const;

/** A bare hostname: no scheme, no path, no port, and at least one dot. */
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

const PUBLISHER_ID: IdSpec = {
  label: "<publisherId>",
  type: "Destination",
  idField: "publisher_id",
  list: "senso destinations list",
};

interface OrgDestinationsListResponse {
  destinations?: { selected_for_generation?: boolean }[];
}

interface RemoveDestinationResponse {
  affected_record_count?: number;
  unpublished_count?: number;
  partial_failures?: string[];
}

export function registerDestinationsCommands(program: Command): void {
  const dest = program
    .command("destinations")
    .description(
      "Where published content lands. Three shared destinations exist on the citeables system (citeables, codeables, cucopilot), and an organization can register its own citeables-system domain. `selected_for_generation: true` means generation and publishing use it by default.",
    );

  describeCommand(dest, {
    notes: [
      "Id spaces used here:",
      "  publisher_id  what `destinations remove`, `generate run --publisher-ids` and `engine publish --publisher-ids` take",
      "  slug          the short name `generate sample --destination` takes (citeables, codeables, cucopilot, or your own domain's slug)",
      "",
      "Typical workflow:",
      "  1. senso destinations list    see what exists and what is selected",
      "  2. senso generate update-settings --data '{\"enable_content_generation\":true}'   seeds citeables when nothing is selected",
      "  3. senso destinations add --domain … --name …   register a domain you own",
      "  4. senso destinations remove <publisher_id> --action …   stop publishing there, choosing what happens to live pages",
      "",
      "Permissions: `list` needs the GEO product and read:content; `add` and `remove` need update:org.",
    ],
    seeAlso: ["senso generate settings", "senso generate run", "senso engine publish"],
  });

  describeCommand(
    dest
      .command("list")
      .description(
        "List every destination available to the organization: the shared citeables-system ones and any domain you registered, with how many pages are live on each and whether it is selected for generation.",
      )
      .action(
        runAction(program, async (ctx) => {
          const data = await apiRequest<OrgDestinationsListResponse>({
            path: "/org/destinations",
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });

          const selected = (data.destinations ?? []).filter((d) => d.selected_for_generation);
          // The id column is publisher_id because that is what `remove` takes;
          // slug is beside it because that is what `generate sample` takes, and
          // confusing the two is the commonest mistake in this group.
          emit(ctx, data, {
            columns: [
              "publisher_id",
              "name",
              "slug",
              "display_url",
              "scope",
              "live_count",
              "selected_for_generation",
            ],
            empty: "destinations",
            emptyHint:
              "Not even the shared destinations are linked. Enable generation with `senso generate update-settings --data '{\"enable_content_generation\":true}'`, which seeds citeables.",
            next:
              selected.length === 0
                ? [
                    {
                      why: "Nothing is selected for generation, so a run has nowhere to publish",
                      command:
                        "senso generate update-settings --data '{\"enable_content_generation\":true}'",
                    },
                  ]
                : [],
          });
        }),
      ),
    {
      returns: [
        "destinations[] — not paginated",
        "publisher_id — what `destinations remove`, `generate run --publisher-ids` and `engine publish --publisher-ids` take",
        "slug — what `generate sample --destination` takes",
        "scope — shared (platform-managed: it can be unlinked, never deleted) | org (registered by you)",
        "type — citeables | manual",
        "display_url — the domain pages are served from",
        "live_count and last_publish_at — how many pages are live there, and when the last one went live",
        "selected_for_generation — true means runs and publishes use it by default",
      ],
      exitCodes: {
        ...apiExits,
        0: "success, including when nothing is linked",
        3: "no GEO product, or the key lacks read:content",
      },
      examples: [
        { command: "senso destinations list" },
        {
          comment: "The destinations a run would publish to",
          command:
            "senso destinations list --output json | jq -r '.data.destinations[] | select(.selected_for_generation) | .publisher_id'",
        },
      ],
      seeAlso: ["senso destinations add", "senso destinations remove", "senso generate settings"],
    },
  );

  describeCommand(
    dest
      .command("add")
      .description(
        "Register a domain you own as a publish destination on the citeables system, and select it for generation. The domain is registered with citeables synchronously. Calling it again for the same domain returns the destination that already exists. Needs update:org.",
      )
      .requiredOption(
        "--domain <hostname>",
        'A bare hostname you control, e.g. "content.example.com" — no scheme, no path. Its slug becomes content-example-com.',
      )
      .requiredOption("--name <name>", 'Display name, e.g. "Example Citeables"')
      .option(
        "--type <type>",
        "Only citeables can be registered today. codeables and cucopilot are shared destinations' slugs, not types.",
        "citeables",
      )
      .action(
        runAction(program, async (ctx, cmdOpts: { domain: string; name: string; type: string }) => {
          const type = requireEnumFlag("--type", cmdOpts.type, SUPPORTED_TYPES);
          const domain = parseDomain(cmdOpts.domain);

          const data = await apiRequest({
            method: "POST",
            path: "/org/destinations",
            body: { type, name: cmdOpts.name, domain },
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
            resource: { type: "Destination", list: "senso destinations list" },
          });

          if (!ctx.quiet) log.success(`Registered destination "${cmdOpts.name}" for ${domain}.`);
          emit(ctx, data, {
            warnings: [
              `${domain} is selected for generation immediately, so the next run publishes there as well.`,
            ],
            next: [
              {
                why: "Confirm the destination is listed and selected",
                command: "senso destinations list",
              },
            ],
          });
        }),
      ),
    {
      returns: [
        "publisher_id — use it with `destinations remove`, `generate run --publisher-ids`, `engine publish --publisher-ids`",
        "slug — use it with `generate sample --destination`",
        "scope — always org for a destination you registered",
        "selected_for_generation — true: the next run publishes here as well",
        "live_count — 0 on a new destination",
      ],
      exitCodes: {
        ...apiExits,
        0: "registered, or it already existed",
        2: "--domain is not a bare hostname, or --type is not citeables",
        3: "the key lacks update:org",
        1: "citeables refused the domain (422), or was unreachable (502)",
      },
      examples: [
        {
          command: 'senso destinations add --domain content.example.com --name "Example Citeables"',
        },
        {
          comment: "Keep the new publisher id",
          command:
            'senso destinations add --domain content.example.com --name "Example Citeables" --output json | jq -r .data.publisher_id',
        },
      ],
      seeAlso: ["senso destinations list", "senso destinations remove"],
    },
  );

  describeCommand(
    dest
      .command("remove <publisherId>")
      .description(
        "Stop publishing to a destination, choosing what happens to the pages already live there. Returns counts of what was done. Needs update:org.",
      )
      .requiredOption(
        "--action <action>",
        "Required. leave: pages stay live and the content returns to draft here. unpublish: pages are removed from the destination. delete: unpublish, then hard-delete the content records — irreversible.",
      )
      .option(
        "--also-remove-destination",
        "Also delete the destination itself. Custom (scope: org) destinations only; a shared one can be unlinked but never deleted.",
        false,
      )
      .option(
        "--keep-domain",
        "With --also-remove-destination on a custom citeables domain: keep the domain registered so its URLs keep resolving.",
        false,
      )
      .action(
        runAction(
          program,
          async (
            ctx,
            publisherId: string,
            cmdOpts: { action: string; alsoRemoveDestination?: boolean; keepDomain?: boolean },
          ) => {
            const id = parseId(publisherId, PUBLISHER_ID);
            const action = requireEnumFlag("--action", cmdOpts.action, REMOVE_ACTIONS);
            const alsoRemove = cmdOpts.alsoRemoveDestination ?? false;
            const keepDomain = cmdOpts.keepDomain ?? false;

            // Silently meaningless otherwise: keep_domain is only read when the
            // destination itself is being deleted, so accepting it alone would
            // let a caller believe a domain had been spared that was never at
            // risk.
            if (keepDomain && !alsoRemove) {
              throw usageError("--keep-domain only applies with --also-remove-destination.", {
                field: "--keep-domain",
                hint: "Drop --keep-domain, or add --also-remove-destination to delete the destination while keeping its domain.",
              });
            }

            let data: RemoveDestinationResponse;
            try {
              data = await apiRequest<RemoveDestinationResponse>({
                method: "POST",
                path: `/org/destinations/${id}/remove`,
                body: {
                  action,
                  also_remove_destination: alsoRemove,
                  keep_domain: keepDomain,
                },
                apiKey: ctx.apiKey,
                baseUrl: ctx.baseUrl,
                resource: {
                  type: "Destination",
                  id,
                  idField: "publisher_id",
                  list: "senso destinations list",
                },
              });
            } catch (err) {
              throw explainRemoveFailure(err, id, alsoRemove);
            }

            // The service unlinks the destination even when individual pages
            // could not be retracted, so a bare "removed" tick would tell an
            // agent every page was taken down when some are still live.
            const failures = data.partial_failures ?? [];
            const warnings =
              failures.length > 0
                ? [
                    `${String(failures.length)} of ${String(data.affected_record_count ?? failures.length)} publish records could not be ${action === "delete" ? "deleted" : "unpublished"}: ${failures.join("; ")}`,
                  ]
                : [];

            if (!ctx.quiet) {
              log.success(
                failures.length > 0
                  ? `Unlinked destination ${id} (action: ${action}), with ${String(failures.length)} record(s) left behind.`
                  : `Removed destination ${id} (action: ${action}).`,
              );
            }
            emit(ctx, data, {
              warnings,
              next: [
                { why: "Confirm what is still linked", command: "senso destinations list" },
                ...(failures.length > 0
                  ? [
                      {
                        why: "Retry a publish record that could not be retracted",
                        command: "senso publish-records retry <publish_record_id>",
                      },
                    ]
                  : []),
              ],
            });
          },
        ),
      ),
    {
      returns: [
        "affected_record_count — live or failed publish records found for this destination",
        "unpublished_count — records removed from the destination (unpublish and delete)",
        "deleted_content_count — content rows hard-deleted (delete only)",
        "destination_removed — true when --also-remove-destination applied",
        "domain_deregistered — true when the citeables domain was removed",
        "partial_failures[] — per-record errors; the destination is unlinked anyway, and these are repeated as warnings",
      ],
      exitCodes: {
        ...idExits,
        0: "removed — check partial_failures",
        2: "publisherId is not a UUID, --action is not leave|unpublish|delete, or --keep-domain was given without --also-remove-destination",
        3: "the key lacks update:org",
        4: "the destination is not assigned to this organization",
        1: "--also-remove-destination on a shared destination, or the destination adapter failed (502)",
      },
      notes: [
        "`--action delete` hard-deletes the content records. There is no undo.",
        "publisherId is a publisher_id, not a slug: `citeables` is rejected before any request is made.",
      ],
      examples: [
        {
          comment: "Stop publishing but leave the live pages alone",
          command: "senso destinations remove a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d --action leave",
        },
        {
          comment: "Retract the pages and delete your own destination, keeping the domain",
          command:
            "senso destinations remove c4d5e6f7-a8b9-4c0d-8e1f-2a3b4c5d6e7f --action unpublish --also-remove-destination --keep-domain",
        },
      ],
      seeAlso: ["senso destinations list", "senso content unpublish"],
    },
  );
}

/**
 * A hostname, not a URL.
 *
 * `--domain https://content.example.com/` was forwarded as typed and refused by
 * citeables several seconds later, with a message about the registration rather
 * than about the flag.
 */
function parseDomain(value: string): string {
  const domain = value.trim();
  if (!HOSTNAME_RE.test(domain)) {
    throw usageError(`Invalid --domain: "${value}" is not a bare hostname.`, {
      field: "--domain",
      received: value,
      hint: "Pass the host only, e.g. --domain content.example.com (no scheme, no path, no port).",
    });
  }
  return domain;
}

/**
 * Explains the one 404 that does not mean what it says.
 *
 * Asking to delete a SHARED destination is refused deep in the service with
 * "cannot delete shared publisher", and that reason is wrapped in the same
 * not-assigned error the API returns for an id that belongs to another
 * organization. Reported as a bare 404 it sends the caller looking for a
 * missing id that is in fact right there in `destinations list`.
 */
function explainRemoveFailure(err: unknown, id: string, alsoRemove: boolean): unknown {
  if (!(err instanceof ApiError) || err.status !== 404 || !alsoRemove) return err;
  return new CliError(
    `Could not remove destination ${id}: shared destinations (citeables, codeables, cucopilot) can be unlinked but not deleted — the API reported "${err.message}".`,
    EXIT.ERROR,
    {
      code: "error",
      status: 404,
      field: "--also-remove-destination",
      hint: "Run again without --also-remove-destination, or check the id with `senso destinations list`.",
      request: err.request,
      cause: err,
    },
  );
}
