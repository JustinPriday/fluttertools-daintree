import { access, readFile, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type { FlutterProject } from "../shared/contracts.js";
import type { FlutterDevice } from "../shared/contracts.js";
import { parseFlutterDeviceList } from "./device.js";

const IGNORED = new Set([".git", ".dart_tool", ".idea", ".vscode", "build", "dist", "node_modules", "Pods", "DerivedData"]);
const execFileAsync = promisify(execFile);

async function isFlutterProject(directory: string): Promise<boolean> {
  try {
    const pubspec = await readFile(path.join(directory, "pubspec.yaml"), "utf8");
    return /^\s*flutter\s*:\s*$/m.test(pubspec) || /^\s*sdk\s*:\s*flutter\s*$/m.test(pubspec);
  } catch {
    return false;
  }
}

function projectName(pubspec: string, fallback: string): string {
  return pubspec.match(/^name\s*:\s*([^#\r\n]+)/m)?.[1]?.trim().replace(/^['"]|['"]$/g, "") || fallback;
}

export async function discoverFlutterProjects(root: string, maxDepth = 5): Promise<FlutterProject[]> {
  const results: FlutterProject[] = [];
  async function walk(directory: string, depth: number): Promise<void> {
    if (await isFlutterProject(directory)) {
      const pubspec = await readFile(path.join(directory, "pubspec.yaml"), "utf8");
      results.push({ path: directory, name: projectName(pubspec, path.basename(directory)), relativePath: path.relative(root, directory) || "." });
    }
    if (depth >= maxDepth) return;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    await Promise.all(entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !IGNORED.has(entry.name) && !entry.name.startsWith(".")).map((entry) => walk(path.join(directory, entry.name), depth + 1)));
  }
  await walk(path.resolve(root), 0);
  return results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export async function resolveFlutterExecutable(worktreePath: string, configuredSdkPath?: string): Promise<{ executable: string; source: "setting" | "fvm" | "path" }> {
  const candidates: Array<{ executable: string; source: "setting" | "fvm" }> = [];
  if (configuredSdkPath?.trim()) candidates.push({ executable: path.join(configuredSdkPath.trim(), "bin", process.platform === "win32" ? "flutter.bat" : "flutter"), source: "setting" });
  candidates.push({ executable: path.join(worktreePath, ".fvm", "flutter_sdk", "bin", process.platform === "win32" ? "flutter.bat" : "flutter"), source: "fvm" });
  for (const candidate of candidates) {
    try { await access(candidate.executable); return candidate; } catch { /* continue */ }
  }
  return { executable: process.platform === "win32" ? "flutter.bat" : "flutter", source: "path" };
}

export async function inspectFlutterVersion(executable: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(executable, ["--version", "--machine"], { timeout: 20_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 });
    const value = JSON.parse(stdout) as { frameworkVersion?: unknown; dartSdkVersion?: unknown; channel?: unknown };
    if (typeof value.frameworkVersion !== "string") return null;
    const channel = typeof value.channel === "string" ? ` ${value.channel}` : "";
    const dart = typeof value.dartSdkVersion === "string" ? ` · Dart ${value.dartSdkVersion}` : "";
    return `Flutter ${value.frameworkVersion}${channel}${dart}`;
  } catch { return null; }
}

export async function discoverFlutterDevices(executable: string): Promise<FlutterDevice[]> {
  const { stdout } = await execFileAsync(executable, ["devices", "--machine"], {
    timeout: 30_000,
    killSignal: "SIGKILL",
    maxBuffer: 4 * 1024 * 1024,
  });
  return parseFlutterDeviceList(JSON.parse(stdout));
}
