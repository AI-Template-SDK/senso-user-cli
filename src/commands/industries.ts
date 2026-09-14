import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";
import { parseEnumFlag, parseIntFlag } from "../lib/enum-arg.js";
import { CliError, EXIT } from "../lib/errors.js";
import { emit } from "../lib/output.js";
import { runAction, type Ctx } from "../lib/run-action.js";
import * as log from "../utils/logger.js";

/**
 * The org-key view of the industry catalog, under the /org/industries
 * prefix.
 *
 * Not to be confused with `senso partner industries`, which reads `/partner/*`
 * and needs a partner key. The two cover similar ground on purpose: this group
 * is the one almost every caller wants, because it works with the key that
 * `senso login` stores. Reads here accept any industry in the public
 * catalog, not only your organization's own.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_RE.test(value.trim());
}

/**
 * Resolve an `<industry>` argument that may be a UUID or a human-typed name.
 * A UUID is used as-is — no extra round trip — and anything else costs one
 * search against the catalog first.
 */
export async function resolveIndustryId(
  industry: string,
  opts: { apiKey?: string; baseUrl?: string },
): Promise<string> {
  if (isUuid(industry)) return industry.trim();

  const data = await apiRequest<{
    industries?: { industry_id?: string; name?: string }[];
  }>({
    path: "/org/industries",
    params: { search: industry },
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
  });

  const match = data.industries?.[0];
  if (!match?.industry_id) {
    throw new CliError(`No industry found matching "${industry}".`, EXIT.NOT_FOUND, {
      hint: "Run `senso industries list` to see the public catalog, or pass an industry UUID.",
    });
  }
  return match.industry_id;
}

/** The date-window and model/location filters every metrics read shares. */
interface WindowFilters {
  from?: string;
  to?: string;
  models?: string;
  location?: string;
}

function windowParams(o: WindowFilters): Record<string, string | undefined> {
  return { from: o.from, to: o.to, models: o.models, location: o.location };
}

/** Attach the four window filters to a command, in one place. */
function withWindowOptions(cmd: Command): Command {
  return cmd
    .option("--from <date>", "Start of the window, YYYY-MM-DD (default: 30 days ago)")
    .option("--to <date>", "End of the window, YYYY-MM-DD (default: today)")
    .option("--models <list>", "Comma-separated model filter")
    .option("--location <code>", "2-letter location code (e.g. US)");
}

const ENTITY_TYPES = [
  "brand",
  "regulator",
  "publisher",
  "government",
  "generic_term",
  "product_model",
  "forum_social",
] as const;

/**
 * `--entity-type` is a comma-separated list, so `parseEnumFlag` cannot check it
 * directly. Validating each member here keeps a typo a usage error: the filter
 * is applied server-side before paging, so `--entity-type brnad` would
 * otherwise come back as a perfectly plausible empty leaderboard.
 */
function parseEntityTypes(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const parts = value
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0);
  if (parts.length === 0) {
    throw new CliError("Invalid --entity-type: no value given.", EXIT.USAGE, { code: "usage" });
  }
  for (const part of parts) {
    if (!ENTITY_TYPES.includes(part as (typeof ENTITY_TYPES)[number])) {
      throw new CliError(`Invalid --entity-type: "${part}".`, EXIT.USAGE, {
        code: "usage",
        hint: `Must be one of: ${ENTITY_TYPES.join(", ")}.`,
      });
    }
  }
  return parts.join(",");
}

const SORTS = ["name_asc", "name_desc", "created_asc", "created_desc"] as const;

export function registerIndustriesCommands(program: Command): void {
  const industries = program
    .command("industries")
    .description(
      'Browse the public industry catalog and the competitive intelligence Senso collects for it — brand leaderboards, domain citations and the prompts each industry runs. Works with the organization key stored by `senso login`. The <industry> argument accepts a UUID or a name (e.g. "Airlines (Canada)"). Reads accept any industry in the catalog; only `import-prompts` is restricted to your own.',
    );

  industries
    .command("list")
    .description(
      "List the public industry catalog — the industries any organization can browse, with the prompt, model and location counts that show how much coverage each one has.",
    )
    .option("--search <q>", "Case-insensitive substring match against name or slug")
    .option("--limit <n>", "Page size, 1-100 (default 50)")
    .option("--offset <n>", "Number of industries to skip (default 0)")
    .option("--sort <order>", `Sort order: ${SORTS.join(", ")} (default name_asc)`)
    .option(
      "--live",
      "Only industries actively running — at least one model enabled and one active prompt",
    )
    .action(
      runAction(
        program,
        async (
          ctx: Ctx,
          cmdOpts: {
            search?: string;
            limit?: string;
            offset?: string;
            sort?: string;
            live?: boolean;
          },
        ) => {
          const limit = parseIntFlag("--limit", cmdOpts.limit, { min: 1, max: 100 });
          const offset = parseIntFlag("--offset", cmdOpts.offset, { min: 0 });
          const sort = parseEnumFlag("--sort", cmdOpts.sort, SORTS);

          const data = await apiRequest({
            path: "/org/industries",
            params: {
              search: cmdOpts.search,
              limit: limit?.toString(),
              offset: offset?.toString(),
              sort,
              live: cmdOpts.live ? "true" : undefined,
            },
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });
          emit(ctx, data, {
            columns: [
              "industry_id",
              "name",
              "slug",
              "active_prompt_count",
              "model_count",
              "location_count",
            ],
          });
        },
      ),
    );

  industries
    .command("prompts <industry>")
    .description(
      "List the prompts an industry runs. These are the industry's own prompts, not your organization's (`senso prompts list`) — their ids are what `industries import-prompts` and `senso generate industry-draft` accept.",
    )
    .option("--limit <n>", "Page size, 1-100 (default 50)")
    .option("--offset <n>", "Number of prompts to skip (default 0)")
    .action(
      runAction(
        program,
        async (ctx: Ctx, industry: string, cmdOpts: { limit?: string; offset?: string }) => {
          const limit = parseIntFlag("--limit", cmdOpts.limit, { min: 1, max: 100 });
          const offset = parseIntFlag("--offset", cmdOpts.offset, { min: 0 });
          const industryId = await resolveIndustryId(industry, ctx);

          const data = await apiRequest({
            path: `/org/industries/${industryId}/prompts`,
            params: { limit: limit?.toString(), offset: offset?.toString() },
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });
          emit(ctx, data, { columns: ["id", "text", "funnel_stage"] });
        },
      ),
    );

  withWindowOptions(
    industries
      .command("brands <industry>")
      .description(
        "Brand leaderboard for an industry — who the AI answers named over the window, ranked by mentions, with average position, sentiment, most-cited domain and trends. Figures are counts, not rates: divide by the `totals` block to get shares. Ranks are global, so a later page still shows real ranks.",
      ),
  )
    .option("--limit <n>", "Page size, 1-100 (default 100)")
    .option("--offset <n>", "Number of brands to skip (default 0)")
    .option("--no-canonicalize", "Do not merge spelling variants — raw per-spelling rows")
    .option("--rollup <mode>", "Set to `parent` to fold sub-brands into their parent company")
    .option("--entity-type <list>", `Comma-separated types to keep: ${ENTITY_TYPES.join(", ")}`)
    .action(
      runAction(
        program,
        async (
          ctx: Ctx,
          industry: string,
          cmdOpts: WindowFilters & {
            limit?: string;
            offset?: string;
            canonicalize?: boolean;
            rollup?: string;
            entityType?: string;
          },
        ) => {
          const limit = parseIntFlag("--limit", cmdOpts.limit, { min: 1, max: 100 });
          const offset = parseIntFlag("--offset", cmdOpts.offset, { min: 0 });
          const rollup = parseEnumFlag("--rollup", cmdOpts.rollup, ["parent"] as const);
          const entityType = parseEntityTypes(cmdOpts.entityType);
          const industryId = await resolveIndustryId(industry, ctx);

          const data = await apiRequest({
            path: `/org/industries/${industryId}/brands`,
            params: {
              ...windowParams(cmdOpts),
              limit: limit?.toString(),
              offset: offset?.toString(),
              // Commander gives `canonicalize: false` only when --no-canonicalize
              // is passed; the server default is true, so say nothing otherwise.
              canonicalize: cmdOpts.canonicalize === false ? "false" : undefined,
              rollup,
              entity_type: entityType,
            },
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });
          emit(ctx, data, {
            columns: [
              "mentions_rank",
              "brand_name",
              "mentions_count",
              "mention_total",
              "average_position",
              "top_cited_domain",
              "entity_type",
            ],
          });
        },
      ),
    );

  withWindowOptions(
    industries
      .command("brand <industry> <brandName>")
      .description(
        "Everything about one brand in an industry, merged across its spelling variants. Matching is fuzzy, so a brand that was never named comes back as `mentioned: false` rather than a 404. For repeat calls, take the `brand_id` from the result and use `brand-by-id`, which skips the fuzzy match.",
      ),
  ).action(
    runAction(
      program,
      async (ctx: Ctx, industry: string, brandName: string, cmdOpts: WindowFilters) => {
        const industryId = await resolveIndustryId(industry, ctx);
        const data = await apiRequest({
          path: `/org/industries/${industryId}/brands/${encodeURIComponent(brandName)}`,
          params: windowParams(cmdOpts),
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data);
      },
    ),
  );

  withWindowOptions(
    industries
      .command("brand-by-id <industry> <brandId>")
      .description(
        "Look up a brand in an industry by its stable `brand_id`, as returned by `industries brands` or `industries brand`. Same payload as `brand`, without the fuzzy name match.",
      ),
  ).action(
    runAction(
      program,
      async (ctx: Ctx, industry: string, brandId: string, cmdOpts: WindowFilters) => {
        const industryId = await resolveIndustryId(industry, ctx);
        const data = await apiRequest({
          path: `/org/industries/${industryId}/brands-by-id/${encodeURIComponent(brandId)}`,
          params: windowParams(cmdOpts),
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data);
      },
    ),
  );

  withWindowOptions(
    industries
      .command("domain <industry> <domain>")
      .description(
        "How often a domain was cited in an industry's answers over the window. A domain that was never cited comes back as `cited: false` rather than a 404. Pass `--url` to look up a full URL instead; the <domain> argument is still required, because the API needs it in the path.",
      ),
  )
    .option("--url <url>", "Look up this full URL instead of the bare domain")
    .action(
      runAction(
        program,
        async (
          ctx: Ctx,
          industry: string,
          domain: string,
          cmdOpts: WindowFilters & { url?: string },
        ) => {
          const industryId = await resolveIndustryId(industry, ctx);
          const data = await apiRequest({
            path: `/org/industries/${industryId}/domains/${encodeURIComponent(domain)}`,
            params: { ...windowParams(cmdOpts), url: cmdOpts.url },
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });
          emit(ctx, data);
        },
      ),
    );

  industries
    .command("import-prompts <industry>")
    .description(
      "Copy prompts from your organization's own industry into your organization, and start importing the run history already collected for them so their analytics open with data rather than an empty chart. Only your own industry is accepted — any other is a 403. Prompts you already hold are skipped, so re-running is safe. This ACTIVATES the organization and starts its scheduled runs, including for prompts already saved but not yet running. Follow the returned history_import.import_id with `senso history-imports get`. Requires the GEO product.",
    )
    .requiredOption(
      "--prompt-ids <ids>",
      "Comma-separated industry prompt ids, 1-100, no duplicates (from `senso industries prompts`)",
    )
    .action(
      runAction(program, async (ctx: Ctx, industry: string, cmdOpts: { promptIds: string }) => {
        const ids = cmdOpts.promptIds
          .split(",")
          .map((p) => p.trim())
          .filter((p) => p.length > 0);

        // Checked here because the API rejects the whole request on any bad id
        // and changes nothing — a round trip to learn about a typo, and for a
        // duplicate, a 400 that names ids the caller has to go match up by hand.
        if (ids.length === 0) {
          throw new CliError("Invalid --prompt-ids: no ids given.", EXIT.USAGE, { code: "usage" });
        }
        if (ids.length > 100) {
          throw new CliError(
            `Invalid --prompt-ids: ${ids.length.toString()} ids given, the maximum is 100.`,
            EXIT.USAGE,
            { code: "usage" },
          );
        }
        const seen = new Set<string>();
        for (const id of ids) {
          if (!isUuid(id)) {
            throw new CliError(`Invalid --prompt-ids: "${id}" is not a UUID.`, EXIT.USAGE, {
              code: "usage",
              hint: "Run `senso industries prompts <industry>` to list the ids this accepts.",
            });
          }
          if (seen.has(id.toLowerCase())) {
            throw new CliError(
              `Invalid --prompt-ids: "${id}" appears more than once.`,
              EXIT.USAGE,
              {
                code: "usage",
              },
            );
          }
          seen.add(id.toLowerCase());
        }

        const industryId = await resolveIndustryId(industry, ctx);
        const data = await apiRequest({
          method: "POST",
          path: `/org/industries/${industryId}/prompts/import`,
          body: { prompt_ids: ids },
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        if (!ctx.quiet) log.success("Industry prompts imported.");
        emit(ctx, data, { columns: ["industry_prompt_id", "status", "geo_question_id", "reason"] });
      }),
    );
}
