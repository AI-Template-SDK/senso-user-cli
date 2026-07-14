import { Command } from "commander";
import { apiRequest, formatApiError } from "../lib/api-client.js";
import * as log from "../utils/logger.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    industries?: Array<{ industry_id?: string; name?: string }>;
  }>({
    path: "/partner/industries",
    params: { search: industry },
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
  });

  const match = data.industries?.[0];
  if (!match?.industry_id) {
    throw new Error(`No industry found matching "${industry}".`);
  }
  return match.industry_id;
}

export function registerIndustriesCommands(program: Command): void {
  const industries = program
    .command("industries")
    .description("Explore industry-level competitive intelligence across a partner network — brand share-of-voice, domain citations, and per-prompt metrics. The <industry> argument accepts either a UUID or a name (e.g. \"Automotive\").");

  industries
    .command("list")
    .description("List industries visible to the partner. Use --search to filter by name.")
    .option("--search <q>", "Filter industries by name")
    .action(async (cmdOpts: { search?: string }) => {
      const opts = program.opts();
      try {
        const data = await apiRequest({
          path: "/partner/industries",
          params: { search: cmdOpts.search },
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  industries
    .command("summary <industry>")
    .description("One-call, slide-ready overview of an industry: brand counts, share-of-voice, and citation totals over a time window.")
    .option("--from <date>", "Start date (YYYY-MM-DD)")
    .option("--to <date>", "End date (YYYY-MM-DD)")
    .option("--location <code>", "2-letter location code (e.g. US)")
    .option("--models <list>", "Comma-separated model filter")
    .action(async (industry: string, cmdOpts: CIFilters) => {
      const opts = program.opts();
      try {
        const industryId = await resolveIndustryId(industry, opts);
        const data = await apiRequest({
          path: `/partner/industries/${industryId}/summary`,
          params: ciParams(cmdOpts),
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  industries
    .command("brand <industry> <brandName>")
    .description("Everything about one brand within an industry, merged across surface-form spellings. Returns mentioned=false when the brand is never named.")
    .option("--from <date>", "Start date (YYYY-MM-DD)")
    .option("--to <date>", "End date (YYYY-MM-DD)")
    .option("--location <code>", "2-letter location code (e.g. US)")
    .option("--models <list>", "Comma-separated model filter")
    .action(async (industry: string, brandName: string, cmdOpts: CIFilters) => {
      const opts = program.opts();
      try {
        const industryId = await resolveIndustryId(industry, opts);
        const data = await apiRequest({
          path: `/partner/industries/${industryId}/brands/${encodeURIComponent(brandName)}`,
          params: ciParams(cmdOpts),
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  industries
    .command("domain <industry> <domainOrUrl>")
    .description("Direct domain/URL citation lookup within an industry. Returns cited=false when the domain is never cited.")
    .option("--from <date>", "Start date (YYYY-MM-DD)")
    .option("--to <date>", "End date (YYYY-MM-DD)")
    .option("--location <code>", "2-letter location code (e.g. US)")
    .option("--models <list>", "Comma-separated model filter")
    .action(async (industry: string, domainOrUrl: string, cmdOpts: CIFilters) => {
      const opts = program.opts();
      try {
        const industryId = await resolveIndustryId(industry, opts);
        const data = await apiRequest({
          path: `/partner/industries/${industryId}/domains/${encodeURIComponent(domainOrUrl)}`,
          params: ciParams(cmdOpts),
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  industries
    .command("prompt-metrics <industry>")
    .description("Pure-industry per-prompt metrics (no single-org overlay) — how each tracked prompt performs across the industry.")
    .option("--from <date>", "Start date (YYYY-MM-DD)")
    .option("--to <date>", "End date (YYYY-MM-DD)")
    .option("--location <code>", "2-letter location code (e.g. US)")
    .option("--models <list>", "Comma-separated model filter")
    .option("--limit <n>", "Maximum prompts to return")
    .option("--offset <n>", "Number of prompts to skip (for pagination)")
    .action(async (industry: string, cmdOpts: CIFilters & { limit?: string; offset?: string }) => {
      const opts = program.opts();
      try {
        const industryId = await resolveIndustryId(industry, opts);
        const data = await apiRequest({
          path: `/partner/industries/${industryId}/prompt-metrics`,
          params: { ...ciParams(cmdOpts), limit: cmdOpts.limit, offset: cmdOpts.offset },
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  industries
    .command("glossary")
    .description("Canonical metric glossary — the citable definition of every competitive-intelligence metric returned by these endpoints.")
    .action(async () => {
      const opts = program.opts();
      try {
        const data = await apiRequest({
          path: "/partner/glossary",
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });
}
