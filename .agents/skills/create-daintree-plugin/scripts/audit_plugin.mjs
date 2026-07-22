#!/usr/bin/env node

import { access, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = path.resolve(process.argv[2] ?? process.cwd());
const failures = [];
const warnings = [];
const passes = [];

function fail(message) {
  failures.push(message);
}

function warn(message) {
  warnings.push(message);
}

function pass(message) {
  passes.push(message);
}

async function readJson(relativePath) {
  try {
    return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
  } catch (error) {
    fail(`Cannot read valid ${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function safeRelativePath(candidate) {
  return (
    typeof candidate === "string" &&
    candidate.length > 0 &&
    !path.isAbsolute(candidate) &&
    !candidate.includes("://") &&
    !candidate.split(/[\\/]/).includes("..")
  );
}

async function assertFile(label, relativePath) {
  if (!safeRelativePath(relativePath)) {
    fail(`${label} must be a safe plugin-relative path: ${String(relativePath)}`);
    return false;
  }
  const absolute = path.join(root, relativePath);
  try {
    const metadata = await stat(absolute);
    if (!metadata.isFile()) {
      fail(`${label} is not a file: ${relativePath}`);
      return false;
    }
    pass(`${label} exists: ${relativePath}`);
    return true;
  } catch {
    fail(`${label} does not exist after build: ${relativePath}`);
    return false;
  }
}

function duplicateIds(entries, label) {
  if (!Array.isArray(entries)) return;
  const seen = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry.id !== "string") continue;
    if (seen.has(entry.id)) fail(`Duplicate ${label} id: ${entry.id}`);
    seen.add(entry.id);
  }
}

async function walk(directory) {
  const output = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return output;
  }
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await walk(absolute)));
    else if (entry.isFile()) output.push(absolute);
  }
  return output;
}

const manifest = await readJson("plugin.json");
const packageJson = await readJson("package.json");

if (manifest) {
  if (!/^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/.test(manifest.name ?? "")) {
    fail(`plugin.json name is not a publisher.plugin-name id: ${String(manifest.name)}`);
  } else {
    pass(`Plugin id is scoped: ${manifest.name}`);
  }

  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    fail("plugin.json must contain a version");
  }

  if (!manifest.engines || typeof manifest.engines.daintree !== "string") {
    fail("plugin.json must declare engines.daintree");
  } else {
    pass(`Daintree compatibility is declared: ${manifest.engines.daintree}`);
  }

  if (packageJson?.version !== manifest.version) {
    fail(
      `Version mismatch: package.json=${String(packageJson?.version)} plugin.json=${String(manifest.version)}`
    );
  } else {
    pass(`Package and manifest versions match: ${manifest.version}`);
  }

  if (packageJson?.name !== manifest.name) {
    warn(
      `package.json name (${String(packageJson?.name)}) differs from plugin id (${String(manifest.name)})`
    );
  }

  const contributes = manifest.contributes ?? {};
  for (const [key, entries] of Object.entries(contributes)) duplicateIds(entries, key);

  const panels = Array.isArray(contributes.panels) ? contributes.panels : [];
  const views = Array.isArray(contributes.views) ? contributes.views : [];
  const panelIds = new Set(panels.map((panel) => panel?.id).filter(Boolean));
  const viewIds = new Set(views.map((view) => view?.id).filter(Boolean));

  for (const id of viewIds) {
    if (!panelIds.has(id)) fail(`View '${id}' has no matching panel contribution`);
  }
  for (const id of panelIds) {
    if (!viewIds.has(id) && !panels.find((panel) => panel?.id === id)?.hasPty) {
      warn(`Panel '${id}' has no matching view contribution`);
    }
  }

  if (typeof manifest.main === "string") await assertFile("Worker main", manifest.main);
  else if (views.length > 0) warn("Panel plugin has no worker main; confirm it is intentionally renderer-only");

  const viewFiles = [];
  for (const view of views) {
    if (view?.location !== "panel") fail(`View '${String(view?.id)}' must use location 'panel'`);
    if (await assertFile(`View '${String(view?.id)}'`, view?.componentPath)) {
      viewFiles.push({ id: view.id, relativePath: view.componentPath });
    }
    if (
      typeof view?.componentPath === "string" &&
      typeof manifest.version === "string" &&
      !view.componentPath.includes(manifest.version)
    ) {
      warn(
        `View '${String(view.id)}' path is not versioned with ${manifest.version}; production ESM updates may reuse cached code`
      );
    }
  }

  const commands = new Set(
    (Array.isArray(contributes.commands) ? contributes.commands : [])
      .map((command) => command?.id)
      .filter(Boolean)
      .map((id) => `${manifest.name}.${id}`)
  );
  for (const collection of [contributes.toolbarButtons, contributes.menuItems, contributes.contextMenus]) {
    if (!Array.isArray(collection)) continue;
    for (const entry of collection) {
      const actionId = entry?.actionId;
      if (typeof actionId !== "string" || actionId.length === 0) {
        fail(`Contribution '${String(entry?.id ?? entry?.label ?? "unknown")}' has no actionId`);
      } else if (actionId.startsWith(`${manifest.name}.`) && !commands.has(actionId)) {
        warn(`Plugin action reference is not manifest-declared as a command: ${actionId}`);
      }
    }
  }

  const forbiddenReact = [
    { pattern: /node_modules\/react\//, label: "bundled React implementation" },
    { pattern: /process\.env\.NODE_ENV/, label: "React Node/CommonJS environment branch" },
  ];
  const externalReact = /\bfrom\s*["']react(?:\/jsx-(?:dev-)?runtime)?["']/;

  for (const viewFile of viewFiles) {
    const source = await readFile(path.join(root, viewFile.relativePath), "utf8");
    if (!externalReact.test(source)) {
      warn(`View '${viewFile.id}' has no visible external React import; inspect bundler output`);
    } else {
      pass(`View '${viewFile.id}' retains a host-resolved React import`);
    }
    for (const forbidden of forbiddenReact) {
      if (forbidden.pattern.test(source)) fail(`View '${viewFile.id}' contains ${forbidden.label}`);
    }
  }
}

try {
  await access(path.join(root, "dist"));
  const distFiles = await walk(path.join(root, "dist"));
  if (distFiles.some((file) => file.endsWith(".map"))) {
    warn("dist contains source maps; exclude them from release staging unless intentionally distributed");
  }
} catch {
  warn("No dist directory found; run this audit after the production build");
}

for (const message of passes) console.log(`PASS  ${message}`);
for (const message of warnings) console.warn(`WARN  ${message}`);
for (const message of failures) console.error(`FAIL  ${message}`);

console.log(`\nAudit summary: ${passes.length} passed, ${warnings.length} warning(s), ${failures.length} failure(s)`);
process.exitCode = failures.length === 0 ? 0 : 1;
