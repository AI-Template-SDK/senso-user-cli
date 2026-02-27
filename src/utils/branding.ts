import figlet from "figlet";
import gradient from "gradient-string";
import boxen from "boxen";
import pc from "picocolors";
import { version } from "../lib/version.js";

const sensoGradient = gradient(["#0D9373", "#07C983"]);

export function banner(): void {
  const ascii = figlet.textSync("SENSO", {
    font: "ANSI Shadow",
    horizontalLayout: "fitted",
  });

  const branded = sensoGradient.multiline(ascii);
  const tagline = pc.dim("        Infrastructure for the Agentic Web");

  console.log(
    boxen(`${branded}\n${tagline}`, {
      padding: 1,
      margin: { top: 1, bottom: 1, left: 2, right: 2 },
      borderStyle: "round",
      borderColor: "green",
    }),
  );
}

export function miniBanner(): void {
  const title = sensoGradient("Senso CLI");
  console.log(`\n  ${title} ${pc.dim(`v${version}`)}\n`);
}

export function updateBox(current: string, latest: string): void {
  const msg = [
    `${pc.yellow("Update available!")} ${pc.dim(current)} → ${pc.green(latest)}`,
    "",
    `Run ${pc.cyan("senso update")} to update`,
  ].join("\n");

  console.error(
    boxen(msg, {
      padding: 1,
      margin: { top: 1, bottom: 0, left: 2, right: 2 },
      borderStyle: "round",
      borderColor: "yellow",
    }),
  );
}
