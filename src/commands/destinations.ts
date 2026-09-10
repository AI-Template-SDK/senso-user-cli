import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";
import { CliError, EXIT } from "../lib/errors.js";
import { emit } from "../lib/output.js";
import { runAction } from "../lib/run-action.js";
import * as log from "../utils/logger.js";

const SUPPORTED_TYPES = ["citeables", "codeables", "cucopilot"] as const;
const REMOVE_ACTIONS = ["leave", "unpublish", "delete"] as const;

type SupportedType = (typeof SUPPORTED_TYPES)[number];
type RemoveAction = (typeof REMOVE_ACTIONS)[number];

export function registerDestinationsCommands(program: Command): void {
  const dest = program
    .command("destinations")
    .description(
      "Manage publish destinations. Destinations are where generated content gets published — shared domains (citeables, codeables, cucopilot) plus any custom citeables domains registered for your org. Most orgs publish to 'citeables' by default; additional destinations are opt-in.",
    );

  dest
    .command("list")
    .description(
      "List all destinations available to the organization. Includes shared destinations (citeables, codeables, cucopilot) and any custom domains you've added, with per-destination live article counts and last publish timestamps. 'selected_for_generation: true' means a destination is active in your generation pipeline.",
    )
    .action(
      runAction(program, async (ctx) => {
        const data = await apiRequest({
          path: "/org/destinations",
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        // The id column is publisher_id because that is what `remove` takes.
        emit(ctx, data, {
          columns: ["publisher_id", "name", "domain", "type", "selected_for_generation"],
        });
      }),
    );

  dest
    .command("add")
    .description(
      "Register a custom publish destination (a citeables-system domain owned by your org). The domain is registered synchronously with the citeables service and linked to the org. Today only citeables-type destinations (slugs: citeables, codeables, cucopilot) are supported — pass --type if you need to target one of the non-default systems; new destination types may be added in future releases.",
    )
    .requiredOption("--domain <domain>", 'Custom domain to register (e.g. "content.example.com")')
    .requiredOption("--name <name>", 'Display name for the destination (e.g. "Example Citeables")')
    .option(
      "--type <type>",
      "Destination type. One of: citeables, codeables, cucopilot. Defaults to citeables.",
      "citeables",
    )
    .action(
      runAction(program, async (ctx, cmdOpts: { domain: string; name: string; type: string }) => {
        const type = cmdOpts.type.toLowerCase();
        if (!(SUPPORTED_TYPES as readonly string[]).includes(type)) {
          throw new CliError(`Invalid --type "${cmdOpts.type}".`, EXIT.USAGE, {
            code: "usage",
            hint: `Must be one of: ${SUPPORTED_TYPES.join(", ")}.`,
          });
        }
        const data = await apiRequest({
          method: "POST",
          path: "/org/destinations",
          body: {
            type: type as SupportedType,
            name: cmdOpts.name,
            domain: cmdOpts.domain,
          },
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        if (!ctx.quiet)
          log.success(`Destination "${cmdOpts.name}" registered for ${cmdOpts.domain}.`);
        emit(ctx, data);
      }),
    );

  dest
    .command("remove <publisherId>")
    .description(
      "Remove a destination from the org. --action controls what happens to live content: 'leave' keeps the articles live at the destination (org stops publishing to it but published records remain), 'unpublish' removes live articles from the destination and returns content to draft, 'delete' unpublishes AND hard-deletes the local content records. Shared destinations (citeables/codeables/cucopilot) can be removed from the org without affecting the underlying domain. --keep-domain preserves the custom domain registration on the citeables side (useful for SEO) when removing a custom destination.",
    )
    .requiredOption(
      "--action <action>",
      "One of: leave, unpublish, delete. See command description.",
    )
    .option(
      "--also-remove-destination",
      "Also delete the publisher row (not just the org link). Only valid for custom destinations you own.",
      false,
    )
    .option(
      "--keep-domain",
      "Keep the custom domain registered on citeables after removing (custom destinations only).",
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
          const action = cmdOpts.action.toLowerCase();
          if (!(REMOVE_ACTIONS as readonly string[]).includes(action)) {
            throw new CliError(`Invalid --action "${cmdOpts.action}".`, EXIT.USAGE, {
              code: "usage",
              hint: `Must be one of: ${REMOVE_ACTIONS.join(", ")}.`,
            });
          }
          const data = await apiRequest({
            method: "POST",
            path: `/org/destinations/${publisherId}/remove`,
            body: {
              action: action as RemoveAction,
              also_remove_destination: cmdOpts.alsoRemoveDestination ?? false,
              keep_domain: cmdOpts.keepDomain ?? false,
            },
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });
          if (!ctx.quiet) log.success(`Destination ${publisherId} removed (action: ${action}).`);
          emit(ctx, data);
        },
      ),
    );
}
