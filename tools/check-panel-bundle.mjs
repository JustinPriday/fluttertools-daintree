import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(new URL("../plugin.json", import.meta.url), "utf8"));
const panel = await readFile(new URL(`../${manifest.contributes.views[0].componentPath}`, import.meta.url), "utf8");
if (!/\bfrom\s*["']react(?:\/jsx-(?:dev-)?runtime)?["']/.test(panel)) throw new Error("Panel must retain host React imports.");
if (!/\bfrom\s*["']@daintreehq\/plugin-ui["']/.test(panel)) throw new Error("Panel must retain the host UI Kit import.");
for (const pattern of [/node_modules\/react\//, /process\.env\.NODE_ENV/]) {
  if (pattern.test(panel)) throw new Error("Panel contains a bundled React runtime.");
}
console.log("Verified panel uses Daintree's host React and UI Kit facades.");
