// Optimises every raw GLB in tools/blender/out into public/models (what the browser loads).
// The "false" flags keep moving parts, sockets and named materials: the default optimize
// merges parts and drops empty socket nodes (starter-kit lesson), and its palette step
// bakes every flat colour into "PaletteMaterial" textures, which loses the livery, shell,
// beacon, signal_, glass, wrap and tint materials the runtime restyles per instance.
// Meshopt-compressed files are decoded by drei's useGLTF in the browser.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const OUT = "tools/blender/out";
const ITEMS = "tools/blender/items";
const PUBLIC = "public/models";
mkdirSync(PUBLIC, { recursive: true });
const files = readdirSync(OUT).filter((name) => name.endsWith(".glb"));
if (!files.length) {
  console.error(`No GLB files in ${OUT}. Run npm run models:build first.`);
  process.exit(1);
}
// Blender cannot read meshopt files, so check_items.py checks the raw build. This checks
// what the browser actually loads: the GLB's JSON chunk must still name every runtime
// part, socket and per-instance material from the item contract.
function contractProblems(file, target) {
  const contractPath = join(ITEMS, file.replace(/\.glb$/, ".json"));
  if (!existsSync(contractPath)) return [];
  const contract = JSON.parse(readFileSync(contractPath, "utf8"));
  const glb = readFileSync(target);
  const gltf = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString("utf8"));
  const nodes = new Set((gltf.nodes ?? []).map((node) => node.name));
  const materials = (gltf.materials ?? []).map((material) => material.name ?? "");
  return [
    ...[...contract.parts, ...contract.sockets, ...(contract.options ?? [])].filter((name) => !nodes.has(name)).map((name) => `missing node '${name}'`),
    ...contract.perInstanceMaterials.filter((prefix) => !materials.some((name) => name.startsWith(prefix))).map((prefix) => `no material starting with '${prefix}'`),
  ];
}

let failures = 0;
let before = 0;
let after = 0;
for (const file of files) {
  const source = join(OUT, file);
  const target = join(PUBLIC, file);
  const result = spawnSync("npx", ["--yes", "@gltf-transform/cli@4", "optimize", source, target, "--compress", "meshopt", "--flatten", "false", "--join", "false", "--simplify", "false", "--prune", "false", "--instance", "false", "--palette", "false"], { stdio: ["ignore", "ignore", "inherit"], shell: process.platform === "win32" });
  if (result.status !== 0) process.exit(result.status ?? 1);
  before += statSync(source).size;
  after += statSync(target).size;
  const problems = contractProblems(file, target);
  failures += problems.length ? 1 : 0;
  console.log(`${file.padEnd(18)} ${(statSync(source).size / 1024).toFixed(1).padStart(7)} KB → ${(statSync(target).size / 1024).toFixed(1).padStart(7)} KB ${problems.length ? `FAIL ${problems.join("; ")}` : ""}`);
}
console.log(`total ${(before / 1024).toFixed(0)} KB → ${(after / 1024).toFixed(0)} KB`);
if (failures) {
  console.error(`${failures} optimised model(s) lost contract parts or materials`);
  process.exit(1);
}
