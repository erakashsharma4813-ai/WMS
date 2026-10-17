// Bundles check.ts (it imports the scene code, which is TypeScript) and runs it.
// node tools/showcase/check.mjs <command> <config.json> <result.json> <docks> [extra]
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(mkdtempSync(join(tmpdir(), "showcase-")), "check.cjs");
await build({ entryPoints: [join(here, "check.ts")], bundle: true, platform: "node", outfile: out, logLevel: "warning" });
const run = spawnSync(process.execPath, [out, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(run.status ?? 1);
