import pc from "picocolors";

export function success(msg: string): void {
  console.log(`  ${pc.green("✓")} ${msg}`);
}

export function error(msg: string): void {
  console.error(`  ${pc.red("✗")} ${msg}`);
}

export function warn(msg: string): void {
  console.error(`  ${pc.yellow("!")} ${msg}`);
}

export function info(msg: string): void {
  console.log(`  ${pc.cyan("ℹ")} ${msg}`);
}

export function dim(msg: string): void {
  console.log(pc.dim(`  ${msg}`));
}
