import { Command } from "commander";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { apiRequest } from "../lib/api-client.js";
import {
  readConfig,
  writeConfig,
  clearConfig,
  resolveApiKey,
  getConfigPath,
  API_KEY_SOURCE_LABELS,
  type ApiKeySource,
} from "../lib/config.js";
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

function sourceSuffix(source: ApiKeySource | undefined): string {
  return source ? pc.dim(` (from ${API_KEY_SOURCE_LABELS[source]})`) : "";
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

        // `password`, not `text`: clack redraws the prompt into stdout on every
        // keystroke, so `text` wrote the whole key there one character at a
        // time — `senso login > install.log`, a CI capture or an asciinema
        // recording would persist the credential. `password` masks it.
        const result = await p.password({
          message: "Paste your API key:",
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

        // The key that was just stored is not necessarily the key the next
        // command will use: SENSO_API_KEY outranks the file (see resolveApiKey).
        // Exported in a shell profile, it makes every command talk to a
        // different organization than the one login just confirmed on screen —
        // and nothing else in the CLI would ever mention it. Warn only when the
        // two differ; the same key from both sources changes no behavior.
        // Trimmed on both sides, as `resolveApiKey` does: the pasted key is
        // already trimmed, so an env var carrying a trailing newline would
        // otherwise look like a different key and warn about nothing.
        const envKey = (process.env.SENSO_API_KEY ?? "").trim();
        if (envKey && envKey !== apiKey) {
          log.warn(
            "SENSO_API_KEY is set in this environment and overrides the key just stored, so commands will keep using it and not the key you logged in with. Logging in again will not change that: unset SENSO_API_KEY to use the stored key, or set it to the key you want. Run `senso whoami` to see which organization commands reach.",
          );
        }
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
        // Resolved together so the reported source is the source of the key
        // this command actually used, not a second guess at the same chain.
        const { key: apiKey, source, shadowed } = resolveApiKey({ apiKey: ctx.apiKey });

        if (!apiKey) {
          throw new CliError("Not authenticated: no API key found.", EXIT.AUTH, {
            code: "unauthorized",
            hint: "Run `senso login`, set SENSO_API_KEY, or pass --api-key.",
          });
        }

        const config = readConfig();

        // Whoever runs this may not be whoever set the key up. Someone runs
        // `senso login` in a terminal that already exports SENSO_API_KEY, sees
        // the warning, and then hands the shell to an agent that never saw it —
        // from there, "which key am I using" and "is another one being ignored"
        // are different questions, and only the second explains a surprise.
        // Suppressed under --output json, which implies --quiet; the payload
        // carries `apiKeyShadowedSources` for that caller instead.
        if (shadowed.length > 0 && source && !ctx.quiet) {
          const ignored = shadowed.map((sh) => API_KEY_SOURCE_LABELS[sh]).join(" and ");
          log.warn(
            `More than one API key is available here: ${API_KEY_SOURCE_LABELS[source]} takes precedence, and the key in ${ignored} is being ignored. If this is not the organization you expected, that is why — and running \`senso login\` will not change it while ${API_KEY_SOURCE_LABELS[source]} is set.`,
          );
        }

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
              // Which of the three sources supplied that key. `login` writes
              // the config file but the environment outranks it, so "which
              // organization" is only half an answer without "and why".
              apiKeySource: source,
              // Always present, empty when there is no conflict. A field that
              // is sometimes absent and sometimes an array is a worse contract
              // for the agent doing the parsing than one that is always there.
              apiKeyShadowedSources: shadowed,
              configPath: getConfigPath(),
            },
            {
              plain: [
                "",
                `  ${pc.bold("Organization:")}  ${org.name}`,
                `  ${pc.bold("Org ID:")}        ${org.org_id}`,
                `  ${pc.bold("Slug:")}          ${org.slug}`,
                `  ${pc.bold("Tier:")}          ${org.is_free_tier ? "Free" : "Paid"}`,
                `  ${pc.bold("API Key:")}       ${apiKey.slice(0, 8)}...${sourceSuffix(source)}`,
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
          // The cache was written by `login`, so it describes the STORED key.
          // The test is whether the key in use IS that stored key — not whether
          // a source was shadowed. An environment variable repeating the stored
          // key is not a mismatch and must not warn; a config holding a cached
          // org but no key at all (hand-edited) is one, and shadowing misses it.
          // `typeof` rather than trusting `SensoConfig`: the file is
          // user-editable, so `apiKey` is only a string by convention.
          const storedKey = typeof config.apiKey === "string" ? config.apiKey.trim() : "";
          if (storedKey !== apiKey) {
            log.warn(
              "The organization above was cached by `senso login`, which stored the key that is being ignored, so it may not be the organization the key in use belongs to.",
            );
          }
          emit(
            ctx,
            {
              orgId: config.orgId,
              orgName: config.orgName,
              orgSlug: config.orgSlug,
              isFreeTier: config.isFreeTier,
              apiKeyPrefix: apiKey.slice(0, 8) + "...",
              apiKeySource: source,
              apiKeyShadowedSources: shadowed,
              configPath: getConfigPath(),
              cached: true,
            },
            {
              plain: [
                "",
                `  ${pc.bold("Organization:")}  ${config.orgName} ${pc.dim("(cached)")}`,
                `  ${pc.bold("Org ID:")}        ${config.orgId ?? pc.dim("unknown")}`,
                `  ${pc.bold("API Key:")}       ${apiKey.slice(0, 8)}...${sourceSuffix(source)}`,
                `  ${pc.bold("Config:")}        ${getConfigPath()}`,
                "",
              ],
            },
          );
        }
      }),
    );
}
