import { Command } from "commander";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { apiRequest } from "../lib/api-client.js";
import { readConfig, writeConfig, clearConfig, getApiKey, getConfigPath } from "../lib/config.js";
import { CliError, EXIT, toCliError } from "../lib/errors.js";
import { emit, emitConfirmation } from "../lib/output.js";
import { runAction } from "../lib/run-action.js";
import { banner } from "../utils/branding.js";
import * as log from "../utils/logger.js";

interface OrgMeResponse {
  org_id: string;
  name: string;
  slug: string;
  is_free_tier: boolean;
  [key: string]: unknown;
}

async function verifyApiKey(apiKey: string, baseUrl?: string): Promise<OrgMeResponse> {
  return apiRequest<OrgMeResponse>({
    path: "/org/me",
    apiKey,
    baseUrl,
  });
}

export function registerAuthCommands(program: Command): void {
  program
    .command("login")
    .description(
      "Authenticate with Senso. Paste your API key and it will be validated against your organization, then stored locally.",
    )
    .action(
      runAction(program, async (ctx) => {
        // Without a terminal there is nobody to answer the prompt, and clack
        // waits on a keypress that will never arrive — the command used to hang
        // forever in CI and in an agent's shell. Fail immediately instead, and
        // name the two ways to authenticate that do not need a terminal.
        if (!process.stdin.isTTY) {
          throw new CliError("`senso login` needs an interactive terminal.", EXIT.USAGE, {
            code: "usage",
            hint: "Set SENSO_API_KEY in the environment, or pass --api-key, instead of logging in.",
          });
        }

        banner();

        log.raw(`  ${pc.bold("Welcome to Senso CLI!")}\n`);
        log.raw(`  ${pc.dim("1.")} Go to ${pc.cyan("https://docs.senso.ai")} to create an account`);
        log.raw(`  ${pc.dim("2.")} Generate an API key from your dashboard\n`);

        const result = await p.text({
          message: "Paste your API key:",
          placeholder: "tgr_...",
          validate: (val) => {
            if (!val || val.trim().length < 4) return "API key is required";
          },
        });

        // `isCancel` narrows to clack's unique cancel symbol, which does not
        // remove `symbol` from the union — hence the explicit typeof, which both
        // satisfies the compiler and is true rather than an `as string` cast.
        if (p.isCancel(result) || typeof result !== "string") {
          p.cancel("Login canceled.");
          return;
        }

        const apiKey = result.trim();
        const spin = p.spinner();
        spin.start("Verifying API key...");

        let org: OrgMeResponse;
        try {
          org = await verifyApiKey(apiKey, ctx.baseUrl);
        } catch (err) {
          // Stop the spinner before the error surfaces, or the terminal is left
          // with a spinning frame and a hidden cursor.
          spin.stop("Verification failed");
          throw err;
        }
        spin.stop("API key verified");

        // Written only after the key has been proven to work. Storing first and
        // verifying after would leave a bad key on disk for the next command to
        // fail with.
        writeConfig({
          apiKey,
          ...(ctx.baseUrl ? { baseUrl: ctx.baseUrl } : {}),
          orgName: org.name,
          orgId: org.org_id,
          orgSlug: org.slug,
          isFreeTier: org.is_free_tier,
        });

        log.success(`Authenticated as ${pc.bold(`"${org.name}"`)} (${pc.dim(org.org_id)})`);
        log.success(`Config saved to ${pc.dim(getConfigPath())}`);
      }),
    );

  program
    .command("logout")
    .description("Remove stored API key and organization info from local config.")
    .action(
      runAction(program, (ctx) => {
        clearConfig();
        emitConfirmation(ctx, "Credentials removed.");
      }),
    );

  program
    .command("whoami")
    .description(
      "Show which organization you are authenticated as, including org ID, slug, tier, and API key prefix.",
    )
    .action(
      runAction(program, async (ctx) => {
        const apiKey = getApiKey({ apiKey: ctx.apiKey });

        if (!apiKey) {
          throw new CliError("Not authenticated: no API key found.", EXIT.AUTH, {
            code: "unauthorized",
            hint: "Run `senso login`, set SENSO_API_KEY, or pass --api-key.",
          });
        }

        const config = readConfig();

        try {
          const org = await verifyApiKey(apiKey, ctx.baseUrl);
          emit(
            ctx,
            {
              orgId: org.org_id,
              orgName: org.name,
              orgSlug: org.slug,
              isFreeTier: org.is_free_tier,
              // A prefix, never the key. `whoami` is the command people paste
              // into a support thread.
              apiKeyPrefix: apiKey.slice(0, 8) + "...",
              configPath: getConfigPath(),
            },
            {
              plain: [
                "",
                `  ${pc.bold("Organization:")}  ${org.name}`,
                `  ${pc.bold("Org ID:")}        ${org.org_id}`,
                `  ${pc.bold("Slug:")}          ${org.slug}`,
                `  ${pc.bold("Tier:")}          ${org.is_free_tier ? "Free" : "Paid"}`,
                `  ${pc.bold("API Key:")}       ${apiKey.slice(0, 8)}...`,
                `  ${pc.bold("Config:")}        ${getConfigPath()}`,
                "",
              ],
            },
          );
        } catch (err) {
          // Offline, or the API is down. If a previous login cached the org
          // there is still something true to say, and saying it beats failing —
          // "which org am I pointed at" is answerable without the network.
          //
          // But NOT when the key itself was rejected. Falling back on a 401
          // meant a revoked key printed a cached organization and exited 0, from
          // the one command whose entire job is to say whether you are
          // authenticated.
          const mapped = toCliError(err);
          if (mapped.exitCode === EXIT.AUTH) throw mapped;
          if (!config.orgName) throw err;

          log.warn("Could not reach the Senso API. Showing the last known values.");
          emit(
            ctx,
            {
              orgId: config.orgId,
              orgName: config.orgName,
              orgSlug: config.orgSlug,
              isFreeTier: config.isFreeTier,
              apiKeyPrefix: apiKey.slice(0, 8) + "...",
              configPath: getConfigPath(),
              cached: true,
            },
            {
              plain: [
                "",
                `  ${pc.bold("Organization:")}  ${config.orgName} ${pc.dim("(cached)")}`,
                `  ${pc.bold("Org ID:")}        ${config.orgId ?? pc.dim("unknown")}`,
                `  ${pc.bold("Config:")}        ${getConfigPath()}`,
                "",
              ],
            },
          );
        }
      }),
    );
}
