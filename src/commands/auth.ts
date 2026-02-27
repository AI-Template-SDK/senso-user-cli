import { Command } from "commander";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { apiRequest, formatApiError } from "../lib/api-client.js";
import {
  readConfig,
  writeConfig,
  clearConfig,
  getApiKey,
  getConfigPath,
} from "../lib/config.js";
import { banner } from "../utils/branding.js";
import * as log from "../utils/logger.js";

interface OrgMeResponse {
  org_id: string;
  name: string;
  slug: string;
  is_free_tier: boolean;
  [key: string]: unknown;
}

async function verifyApiKey(
  apiKey: string,
  baseUrl?: string,
): Promise<OrgMeResponse> {
  return apiRequest<OrgMeResponse>({
    path: "/org/me",
    apiKey,
    baseUrl,
  });
}

export function registerAuthCommands(program: Command): void {
  program
    .command("login")
    .description("Save API key to config (validates via GET /org/me)")
    .action(async () => {
      const opts = program.opts();

      banner();

      console.log(`  ${pc.bold("Welcome to Senso CLI!")}\n`);
      console.log(`  ${pc.dim("1.")} Go to ${pc.cyan("https://docs.senso.ai")} to create an account`);
      console.log(`  ${pc.dim("2.")} Generate an API key from your dashboard\n`);

      const result = await p.text({
        message: "Paste your API key:",
        placeholder: "tgr_...",
        validate: (val) => {
          if (!val || val.trim().length < 4) return "API key is required";
        },
      });

      if (p.isCancel(result)) {
        p.cancel("Login cancelled.");
        process.exit(0);
      }

      const apiKey = (result as string).trim();
      const spin = p.spinner();
      spin.start("Verifying API key...");

      try {
        const org = await verifyApiKey(apiKey, opts.baseUrl);
        spin.stop("API key verified");

        writeConfig({
          apiKey,
          ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
          orgName: org.name,
          orgId: org.org_id,
          orgSlug: org.slug,
          isFreeTier: org.is_free_tier,
        });

        log.success(`Authenticated as ${pc.bold(`"${org.name}"`)} (${pc.dim(org.org_id)})`);
        log.success(`Config saved to ${pc.dim(getConfigPath())}`);
        console.log();
      } catch (err) {
        spin.stop("Verification failed");
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  program
    .command("logout")
    .description("Remove stored credentials")
    .action(() => {
      clearConfig();
      log.success("Credentials removed.");
    });

  program
    .command("whoami")
    .description("Show current auth status and org info")
    .action(async () => {
      const opts = program.opts();
      const apiKey = getApiKey({ apiKey: opts.apiKey });

      if (!apiKey) {
        log.error("Not logged in. Run `senso login` to authenticate.");
        process.exit(1);
      }

      const config = readConfig();

      // Try to refresh org info from API
      try {
        const org = await verifyApiKey(apiKey, opts.baseUrl);
        const format = opts.output || "plain";

        if (format === "json") {
          console.log(
            JSON.stringify({
              orgId: org.org_id,
              orgName: org.name,
              orgSlug: org.slug,
              isFreeTier: org.is_free_tier,
              apiKeyPrefix: apiKey.slice(0, 8) + "...",
            }, null, 2),
          );
        } else {
          console.log();
          console.log(`  ${pc.bold("Organization:")}  ${org.name}`);
          console.log(`  ${pc.bold("Org ID:")}        ${org.org_id}`);
          console.log(`  ${pc.bold("Slug:")}          ${org.slug}`);
          console.log(`  ${pc.bold("Tier:")}          ${org.is_free_tier ? "Free" : "Paid"}`);
          console.log(`  ${pc.bold("API Key:")}       ${apiKey.slice(0, 8)}...`);
          console.log(`  ${pc.bold("Config:")}        ${getConfigPath()}`);
          console.log();
        }
      } catch (err) {
        if (config.orgName) {
          log.warn(`Could not reach API: ${formatApiError(err)}`);
          console.log(`  ${pc.bold("Organization:")}  ${config.orgName} ${pc.dim("(cached)")}`);
          console.log(`  ${pc.bold("Org ID:")}        ${config.orgId}`);
        } else {
          log.error(formatApiError(err));
          process.exit(1);
        }
      }
    });
}
