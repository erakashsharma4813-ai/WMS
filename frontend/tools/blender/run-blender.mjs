// Runs a Blender Python script headless: node tools/blender/run-blender.mjs <script.py> [-- args]
// Blender is found from $BLENDER, then the default Windows install, then PATH.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

function findBlender() {
  if (process.env.BLENDER) return process.env.BLENDER;
  const root = "C:/Program Files/Blender Foundation";
  if (existsSync(root)) {
    const versions = readdirSync(root).filter((name) => name.startsWith("Blender")).sort().reverse();
    for (const version of versions) {
      const exe = join(root, version, "blender.exe");
      if (existsSync(exe)) return exe;
    }
  }
  return "blender";
}

const [script, ...rest] = process.argv.slice(2);
if (!script) {
  console.error("usage: node tools/blender/run-blender.mjs <script.py> [-- args]");
  process.exit(2);
}
const blender = findBlender();
const result = spawnSync(blender, ["--background", "--factory-startup", "--python", script, ...rest], { stdio: "inherit" });
if (result.error) {
  console.error(`Could not start Blender (${blender}). Set BLENDER to the blender executable.`);
  process.exit(1);
}
process.exit(result.status ?? 1);
