import { Command } from "commander";
import { ApiError, apiRequest } from "../lib/api-client.js";
import { CliError, EXIT, toCliError } from "../lib/errors.js";
import { emit } from "../lib/output.js";
import { runAction, type Ctx } from "../lib/run-action.js";

/**
 * Every command in this group calls a /partner/* route. Those routes are gated
 * by partner authentication in senso-api, so the organization API key that
 * `senso login` stores is rejected with a 401/403 — and the generic handler
 * would tell the user to log in again, which never fixes it. Explain the real
 * cause instead, and point at the org-scoped equivalent.
 */
function partnerError(err: unknown): CliError {
  if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
    return new CliError(
      "This request was rejected by the Senso API's partner authentication.",
      EXIT.AUTH,
      {
        code: err.status === 401 ? "unauthorized" : "forbidden",
        status: err.status,
        // One hint rather than four lines: `senso industries` reads
        // partner-scoped endpoints (/partner/*) and needs a PARTNER API key.
        hint: "The organization key stored by `senso login` cannot access /partner/* — logging in again will not help. If you have a partner key, pass it per-command with `--api-key <partner-key>` or export SENSO_API_KEY. For metrics about your own organization, use `senso analytics` — e.g. `senso analytics summary`, `senso analytics domains`, `senso analytics glossary`.",
        cause: err,
      },
    );
  }
  return toCliError(err);
}

/**
 * `runAction`, plus the partner-auth translation above.
 *
 * The whole group needs the same treatment, so the narrow catch lives here once
 * rather than in each of the six actions.
 */
function runPartnerAction<Args extends unknown[]>(
  program: Command,
  handler: (ctx: Ctx, ...args: Args) => Promise<void>,
): (...args: Args) => Promise<void> {
  return runAction(program, async (ctx: Ctx, ...args: Args) => {
    try {
      await handler(ctx, ...args);
    } catch (err) {
      throw partnerError(err);
    }
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_RE.test(value.trim());
}

// Common competitive-intelligence filters shared across the read endpoints.
interface CIFilters {
  from?: string;
  to?: string;
  location?: string;
  models?: string;
}

function ciParams(cmdOpts: CIFilters): Record<string, string | undefined> {
  return {
    from: cmdOpts.from,
    to: cmdOpts.to,
    location: cmdOpts.location,
    models: cmdOpts.models,
  };
}

// Resolve an <industry> argument that may be either a UUID or a human-typed
// name (e.g. "Automotive"). Non-UUID values are looked up via the partner
// industries search and resolved to the first match's industry_id.
async function resolveIndustryId(
  industry: string,
  opts: { apiKey?: string; baseUrl?: string },
): Promise<string> {
  if (isUuid(industry)) return industry.trim();

  const data = await apiRequest<{
    industries?: { industry_id?: string; name?: string }[];
  }>({
    path: "/partner/industries",
    params: { search: industry },
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
  });

  const match = data.industries?.[0];
  if (!match?.industry_id) {
    throw new CliError(`No industry found matching "${industry}".`, EXIT.NOT_FOUND, {
      hint: "Run `senso industries list` to see the industries this key can read, or pass an industry UUID.",
    });
  }
  return match.industry_id;
}

export function registerIndustriesCommands(program: Command): void {
  const industries = program
    .command("industries")
    .description(
      'Explore industry-level competitive intelligence across a partner network — brand share-of-voice, domain citations, and per-prompt metrics. The <industry> argument accepts either a UUID or a name (e.g. "Automotive"). REQUIRES A PARTNER API KEY: these commands read /partner/* endpoints, which reject the organization key stored by `senso login`. For metrics about your own organization, use `senso analytics`.',
    );

  industries
    .command("list")
    .description("List industries visible to the partner. Use --search to filter by name.")
    .option("--search <q>", "Filter industries by name")
    .action(
      runPartnerAction(program, async (ctx, cmdOpts: { search?: string }) => {
        const data = await apiRequest({
          path: "/partner/industries",
          params: { search: cmdOpts.search },
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data, {
          columns: ["industry_id", "name", "slug", "active_prompt_count"],
        });
      }),
    );

  industries
    .command("summary <industry>")
    .description(
      "One-call, slide-ready overview of an industry: brand counts, share-of-voice, and citation totals over a time window.",
    )
    .option("--from <date>", "Start date (YYYY-MM-DD)")
    .option("--to <date>", "End date (YYYY-MM-DD)")
    .option("--location <code>", "2-letter location code (e.g. US)")
    .option("--models <list>", "Comma-separated model filter")
    .action(
      runPartnerAction(program, async (ctx, industry: string, cmdOpts: CIFilters) => {
        const industryId = await resolveIndustryId(industry, ctx);
        const data = await apiRequest({
          path: `/partner/industries/${industryId}/summary`,
          params: ciParams(cmdOpts),
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data);
      }),
    );

  industries
    .command("brand <industry> <brandName>")
    .description(
      "Everything about one brand within an industry, merged across surface-form spellings. Returns mentioned=false when the brand is never named.",
    )
    .option("--from <date>", "Start date (YYYY-MM-DD)")
    .option("--to <date>", "End date (YYYY-MM-DD)")
    .option("--location <code>", "2-letter location code (e.g. US)")
    .option("--models <list>", "Comma-separated model filter")
    .action(
      runPartnerAction(
        program,
        async (ctx, industry: string, brandName: string, cmdOpts: CIFilters) => {
          const industryId = await resolveIndustryId(industry, ctx);
          const data = await apiRequest({
            path: `/partner/industries/${industryId}/brands/${encodeURIComponent(brandName)}`,
            params: ciParams(cmdOpts),
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });
          emit(ctx, data);
        },
      ),
    );

  industries
    .command("domain <industry> <domainOrUrl>")
    .description(
      "Direct domain/URL citation lookup within an industry. Returns cited=false when the domain is never cited.",
    )
    .option("--from <date>", "Start date (YYYY-MM-DD)")
    .option("--to <date>", "End date (YYYY-MM-DD)")
    .option("--location <code>", "2-letter location code (e.g. US)")
    .option("--models <list>", "Comma-separated model filter")
    .action(
      runPartnerAction(
        program,
        async (ctx, industry: string, domainOrUrl: string, cmdOpts: CIFilters) => {
          const industryId = await resolveIndustryId(industry, ctx);
          const data = await apiRequest({
            path: `/partner/industries/${industryId}/domains/${encodeURIComponent(domainOrUrl)}`,
            params: ciParams(cmdOpts),
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });
          emit(ctx, data);
        },
      ),
    );

  industries
    .command("prompt-metrics <industry>")
    .description(
      "Pure-industry per-prompt metrics (no single-org overlay) — how each tracked prompt performs across the industry.",
    )
    .option("--from <date>", "Start date (YYYY-MM-DD)")
    .option("--to <date>", "End date (YYYY-MM-DD)")
    .option("--location <code>", "2-letter location code (e.g. US)")
    .option("--models <list>", "Comma-separated model filter")
    .option("--limit <n>", "Maximum prompts to return")
    .option("--offset <n>", "Number of prompts to skip (for pagination)")
    .action(
      runPartnerAction(
        program,
        async (ctx, industry: string, cmdOpts: CIFilters & { limit?: string; offset?: string }) => {
          const industryId = await resolveIndustryId(industry, ctx);
          const data = await apiRequest({
            path: `/partner/industries/${industryId}/prompt-metrics`,
            params: { ...ciParams(cmdOpts), limit: cmdOpts.limit, offset: cmdOpts.offset },
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });
          emit(ctx, data, {
            columns: [
              "industry_prompt_id",
              "industry_prompt",
              "funnel_stage",
              "persona",
              "category",
            ],
          });
        },
      ),
    );

  industries
    .command("glossary")
    .description(
      "Canonical metric glossary — the citable definition of every competitive-intelligence metric returned by these endpoints.",
    )
    .action(
      runPartnerAction(program, async (ctx) => {
        const data = await apiRequest({
          path: "/partner/glossary",
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data, { columns: ["metric", "denominator", "definition"] });
      }),
    );
}
