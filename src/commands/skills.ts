import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Command } from "commander";
import * as log from "../utils/logger.js";
import { getApiKey } from "../lib/config.js";

const execFileAsync = promisify(execFile);

const SENSO_SKILLS = [
  "senso-ai/senso-search",
  "senso-ai/senso-ingest",
  "senso-ai/senso-content-gen",
  "senso-ai/senso-brand-setup",
  "senso-ai/senso-kb-organize",
  "senso-ai/senso-review-publish",
];

const AGENT_FLAGS: Record<string, string> = {
  claude: "--claude",
  cursor: "--cursor",
  codex: "--codex",
  copilot: "--copilot",
  gemini: "--gemini",
  cline: "--cline",
};

async function resolveShipables(): Promise<string> {
  // Check if shipables is available globally
  try {
    await execFileAsync("shipables", ["--version"]);
    return "shipables";
  } catch {
    // Fall back to npx
    return "npx";
  }
}

async function runShipables(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const bin = await resolveShipables();
  if (bin === "npx") {
    return execFileAsync("npx", ["--yes", "@senso-ai/shipables", ...args], { timeout: 120_000 });
  }
  return execFileAsync(bin, args, { timeout: 120_000 });
}

function buildAgentFlags(agent?: string): string[] {
  if (!agent) return ["--all"];
  const flag = AGENT_FLAGS[agent.toLowerCase()];
  if (!flag) {
    const valid = Object.keys(AGENT_FLAGS).join(", ");
    throw new Error(`Unknown agent "${agent}". Valid agents: ${valid}`);
  }
  return [flag];
}

export function registerSkillsCommands(program: Command): void {
  const skills = program
    .command("skills")
    .description("Install and manage Senso agent skills. Skills teach AI coding agents (Claude Code, Cursor, Codex, etc.) how to use Senso automatically.");

  skills
    .command("install [names...]")
    .description("Install Senso agent skills. Use --all for all six official skills, or pass individual short names (search, ingest, content-gen, brand-setup, kb-organize, review-publish).")
    .option("--all", "Install all six official Senso skills")
    .option("--agent <name>", "Target a specific agent: claude, cursor, codex, copilot, gemini, cline")
    .option("--global", "Install globally instead of project-level")
    .action(async (names: string[], cmdOpts: { all?: boolean; agent?: string; global?: boolean }) => {
      const opts = program.opts();

      // Determine which skills to install
      let skillPackages: string[];
      if (cmdOpts.all || names.length === 0) {
        skillPackages = [...SENSO_SKILLS];
      } else {
        skillPackages = names.map((n) => {
          // Allow short names like "search" -> "senso-ai/senso-search"
          if (n.startsWith("@")) return n;
          return `senso-ai/senso-${n}`;
        });
      }

      // Build agent flags
      let agentFlags: string[];
      try {
        agentFlags = buildAgentFlags(cmdOpts.agent);
      } catch (err) {
        log.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }

      // Build env flags for API key
      const envFlags: string[] = [];
      const apiKey = getApiKey({ apiKey: opts.apiKey });
      if (apiKey) {
        envFlags.push("--env", `SENSO_API_KEY=${apiKey}`);
      }

      const globalFlag = cmdOpts.global ? ["--global"] : [];

      log.info(`Installing ${skillPackages.length} skill(s)...`);

      for (const pkg of skillPackages) {
        try {
          const args = ["install", pkg, ...agentFlags, ...globalFlag, ...envFlags, "--yes"];
          const { stdout, stderr } = await runShipables(args);

          if (!opts.quiet) {
            if (stdout.trim()) console.log(stdout.trim());
            if (stderr.trim()) console.error(stderr.trim());
          }

          const shortName = pkg.replace("senso-ai/senso-", "");
          log.success(`Installed ${shortName}`);
        } catch (err) {
          const shortName = pkg.replace("senso-ai/senso-", "");
          const msg = err instanceof Error ? err.message : String(err);
          log.error(`Failed to install ${shortName}: ${msg}`);
        }
      }

      log.success("Done. Your agent can now use Senso — just talk to it naturally.");
    });

  skills
    .command("list")
    .description("List installed Senso skills.")
    .option("--global", "List globally installed skills")
    .action(async (cmdOpts: { global?: boolean }) => {
      const opts = program.opts();
      try {
        const globalFlag = cmdOpts.global ? ["--global"] : [];
        const { stdout } = await runShipables(["list", ...globalFlag, "--json"]);
        const data = JSON.parse(stdout);
        if (opts.output === "json") {
          console.log(JSON.stringify(data, null, 2));
        } else {
          if (!data || (Array.isArray(data) && data.length === 0)) {
            log.info("No skills installed. Run `senso skills install --all` to get started.");
          } else {
            console.log(JSON.stringify(data, null, 2));
          }
        }
      } catch (err) {
        log.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  skills
    .command("list-available")
    .description("Show all six official Senso skills available for install.")
    .action(async () => {
      const opts = program.opts();
      const available = SENSO_SKILLS.map((pkg) => ({
        package: pkg,
        shortName: pkg.replace("senso-ai/senso-", ""),
      }));

      if (opts.output === "json") {
        console.log(JSON.stringify(available, null, 2));
      } else {
        console.log();
        for (const s of available) {
          console.log(`  ${s.shortName.padEnd(18)} ${s.package}`);
        }
        console.log();
        log.info("Install all: senso skills install --all");
      }
    });

  skills
    .command("remove <name>")
    .description("Remove an installed Senso skill. Use the short name (e.g., search, ingest, content-gen).")
    .option("--global", "Remove from global install")
    .action(async (name: string, cmdOpts: { global?: boolean }) => {
      const opts = program.opts();
      const pkg = name.startsWith("@") ? name : `senso-ai/senso-${name}`;
      const globalFlag = cmdOpts.global ? ["--global"] : [];

      try {
        const { stdout, stderr } = await runShipables(["uninstall", pkg, ...globalFlag, "--yes"]);

        if (!opts.quiet) {
          if (stdout.trim()) console.log(stdout.trim());
          if (stderr.trim()) console.error(stderr.trim());
        }

        const shortName = pkg.replace("senso-ai/senso-", "");
        log.success(`Removed ${shortName}`);
      } catch (err) {
        log.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
