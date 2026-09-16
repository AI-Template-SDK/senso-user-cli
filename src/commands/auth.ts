import { Command } from "commander";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { apiRequest } from "../lib/api-client.js";
import { readConfig, writeConfig, clearConfig, getApiKey, getConfigPath } from "../lib/config.js";
import { CliError, EXIT, toCliError } from "../lib/errors.js";
import { apiExits, describeCommand, localExits } from "../lib/help.js";
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

/**
 * Which of the three credential sources is in effect.
 *
 * An agent that cannot tell `--api-key` from `SENSO_API_KEY` from the stored
 * config cannot debug "why am I in the wrong organization" — and the answer is
 * almost always that one of the three is shadowing the one it edited.
 *
 * The env branch checks for a non-empty value on purpose: `getApiKey` uses `||`,
 * so `SENSO_API_KEY=` falls through to the config rather than authenticating
 * with an empty string, and this has to agree with it.
 */
function credentialSource(flagKey: string | undefined): "flag" | "env" | "config" {
  if (flagKey) return "flag";
  return process.env.SENSO_API_KEY ? "env" : "config";
}

export function registerAuthCommands(program: Command): void {
  describeCommand(
    program
      .command("login")
      .description(
        "Authenticate with Senso. Paste your API key and it will be validated against your organization, then stored locally. Interactive only: without a terminal it exits 2 and names the two alternatives.",
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
          log.raw(`  ${pc.dim("1.")} Create an account at ${pc.cyan("https://app.senso.ai")}`);
          log.raw(
            `  ${pc.dim("2.")} Generate an API key: ${pc.cyan("Settings → API keys")} in the app\n`,
          );

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

          // stdout stays empty in plain — the two ticks above are the human
          // rendering — but a caller that drove this through a pty with
          // --output json now gets a record of which organization it logged into.
          emit(
            ctx,
            {
              org_id: org.org_id,
              name: org.name,
              slug: org.slug,
              is_free_tier: org.is_free_tier,
              config_path: getConfigPath(),
            },
            { plain: [] },
          );
        }),
      ),
    {
      returns: [
        "org_id, name, slug, is_free_tier — the organization the key belongs to (--output json only)",
        "config_path — the file the key was written to",
      ],
      exitCodes: {
        ...apiExits,
        2: "there is no terminal to prompt on — use SENSO_API_KEY or --api-key instead",
        3: "the pasted key was rejected; nothing is written",
      },
      notes: [
        "Interactive only. In CI or an agent's shell use SENSO_API_KEY=... or --api-key ...; both work without logging in.",
        "Precedence: --api-key beats SENSO_API_KEY, which beats the stored config.",
        "The key is verified with GET /org/me BEFORE it is stored, so a bad key never lands on disk.",
        `Stores apiKey, orgName, orgId, orgSlug and isFreeTier in ${getConfigPath()}; --base-url is stored alongside when given.`,
        "Canceling the prompt is exit 0 and changes nothing.",
      ],
      examples: [
        { comment: "Interactive login", command: "senso login" },
        {
          comment: "No terminal: authenticate per command instead",
          command: "SENSO_API_KEY=tgr_... senso whoami",
        },
      ],
      seeAlso: ["senso whoami", "senso logout"],
    },
  );

  describeCommand(
    program
      .command("logout")
      .description(
        "Remove stored API key and organization info from local config. Does not affect SENSO_API_KEY or --api-key.",
      )
      .action(
        runAction(program, (ctx) => {
          // Read before clearing: "removed" and "there was nothing to remove"
          // are different facts, and a caller could not tell them apart when
          // both printed the same sentence and exited 0.
          const stored = readConfig();
          const hadCredentials = Boolean(stored.apiKey);
          clearConfig();
          const path = getConfigPath();

          emitConfirmation(
            ctx,
            hadCredentials
              ? `Removed stored credentials from ${path}.`
              : `Nothing was stored at ${path}.`,
            {
              action: hadCredentials ? "deleted" : "unchanged",
              resource: "credentials",
              path,
              had_credentials: hadCredentials,
            },
            {
              warnings: process.env.SENSO_API_KEY
                ? [
                    "SENSO_API_KEY is still set in this shell; commands will keep authenticating with it.",
                  ]
                : [],
            },
          );
        }),
      ),
    {
      returns: [
        "action — deleted when something was stored, unchanged when nothing was",
        "path — the config file that was cleared",
        "had_credentials — whether there was a key to remove",
      ],
      exitCodes: localExits,
      notes: [
        `Touches only ${getConfigPath()}. Nothing is revoked server-side: the key still works.`,
        "SENSO_API_KEY and --api-key still authenticate afterwards.",
      ],
      examples: [{ command: "senso logout" }],
      seeAlso: ["senso login", "senso whoami"],
    },
  );

  describeCommand(
    program
      .command("whoami")
      .description(
        "Show which organization you are authenticated as, including org ID, slug, tier, API key prefix and which credential source is in effect. Makes one request to GET /org/me.",
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
          const source = credentialSource(ctx.apiKey);
          // A prefix, never the key. `whoami` is the command people paste into a
          // support thread.
          const prefix = apiKey.slice(0, 8) + "...";

          try {
            const org = await verifyApiKey(apiKey, ctx.baseUrl);
            // snake_case, like every other payload in this CLI. These keys used to
            // be camelCase, so a jq expression written from the /org/me DTO —
            // `.org_id`, `.is_free_tier` — silently yielded null on the one
            // command whose job is to say who you are.
            emit(
              ctx,
              {
                org_id: org.org_id,
                name: org.name,
                slug: org.slug,
                is_free_tier: org.is_free_tier,
                api_key_prefix: prefix,
                credential_source: source,
                config_path: getConfigPath(),
                cached: false,
              },
              {
                plain: [
                  "",
                  `  ${pc.bold("Organization:")}  ${org.name}`,
                  `  ${pc.bold("Org ID:")}        ${org.org_id}`,
                  `  ${pc.bold("Slug:")}          ${org.slug}`,
                  `  ${pc.bold("Tier:")}          ${org.is_free_tier ? "Free" : "Paid"}`,
                  `  ${pc.bold("API Key:")}       ${prefix}`,
                  `  ${pc.bold("Key from:")}      ${source}`,
                  `  ${pc.bold("Config:")}        ${getConfigPath()}`,
                  "",
                ],
                next: [
                  {
                    why: "See products, websites and limits for this organization",
                    command: "senso org get",
                  },
                ],
              },
            );
          } catch (err) {
            // Offline. If a previous login cached the org there is still something
            // true to say, and saying it beats failing — "which org am I pointed
            // at" is answerable without the network.
            //
            // ONLY offline. Falling back on anything that was not a network
            // failure meant a revoked key (401) or a deleted organization (404)
            // printed cached values and exited 0, from the one command whose whole
            // job is to say whether you are authenticated.
            const mapped = toCliError(err);
            if (mapped.exitCode !== EXIT.NETWORK) throw mapped;
            if (!config.orgName) throw mapped;

            emit(
              ctx,
              {
                org_id: config.orgId,
                name: config.orgName,
                slug: config.orgSlug,
                is_free_tier: config.isFreeTier,
                api_key_prefix: prefix,
                credential_source: source,
                config_path: getConfigPath(),
                cached: true,
              },
              {
                plain: [
                  "",
                  `  ${pc.bold("Organization:")}  ${config.orgName} ${pc.dim("(cached)")}`,
                  `  ${pc.bold("Org ID:")}        ${config.orgId ?? pc.dim("unknown")}`,
                  `  ${pc.bold("Key from:")}      ${source}`,
                  `  ${pc.bold("Config:")}        ${getConfigPath()}`,
                  "",
                ],
                warnings: [
                  "Could not reach the Senso API. These values are from the last login, not from the server.",
                ],
              },
            );
          }
        }),
      ),
    {
      returns: [
        "org_id, name, slug — the organization this key belongs to",
        "is_free_tier — true on the free tier",
        "api_key_prefix — the first 8 characters; never the whole key",
        "credential_source — flag | env | config: which of --api-key, SENSO_API_KEY and the stored config is in effect",
        "config_path — where the stored credential lives",
        "cached — true when the API could not be reached and these are the last known values",
      ],
      exitCodes: {
        ...apiExits,
        3: "no API key anywhere, or the key was rejected — a rejected key is never masked by the cache",
        4: "the organization behind this key no longer exists",
      },
      notes: [
        "Makes one request to GET /org/me.",
        "Falls back to the last login's values ONLY on a network failure, and says so with cached: true and a warning.",
        "Shows the organization, not the key's products or permissions — use `senso org get` for those.",
      ],
      examples: [
        { comment: "Which organization am I in?", command: "senso whoami" },
        {
          comment: "Just the id",
          command: "senso whoami --output json | jq -r '.data.org_id'",
        },
        {
          comment: "Which credential is in effect?",
          command: "senso whoami --output json | jq -r '.data.credential_source'",
        },
      ],
      seeAlso: ["senso org get", "senso login", "senso logout"],
    },
  );
}
