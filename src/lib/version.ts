import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

let _version = "0.0.0";

try {
  // Works in bundled ESM context
  const __dirname = dirname(fileURLToPath(import.meta.url));
  // Try walking up to find package.json (works both in src/ and dist/)
  for (const dir of [__dirname, join(__dirname, ".."), join(__dirname, "../..")]) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
      if (pkg.version) {
        _version = pkg.version;
        break;
      }
    } catch {
      // keep trying
    }
  }
} catch {
  // fallback
}

export const version = _version;
