import path from "node:path";
import { spawn } from "node:child_process";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import type { PluginHostApi, PluginPanelBadge, PluginQuickPickItem, PluginWorktreeSnapshot } from "@daintreehq/plugin-sdk";
import { z } from "zod";
import { FlutterDaemon } from "./flutter/daemon.js";
import { discoverFlutterProjects, inspectFlutterVersion, resolveFlutterExecutable } from "./flutter/discovery.js";
import { FlutterRunSession } from "./flutter/runSession.js";
import { ConsoleBuffer } from "./shared/consoleBuffer.js";
import {
  consoleBatchSchema, controlArgsSchema, devicePanelArgsSchema, flutterPanelBindingSchema, operationResultSchema, panelArgsSchema,
  runArgsSchema, screenshotArgsSchema, screenshotResultSchema, selectDeviceArgsSchema, setProjectArgsSchema,
  snapshotSchema, type ConsoleRecord, type FlutterPanelBinding, type FlutterProject, type FlutterWorkspaceSnapshot,
} from "./shared/contracts.js";

const PANEL_KIND = "justinpriday.flutter-tools.workspace";
const BINDINGS_KEY = "panel-bindings-v1";

interface PanelRuntime {
  binding: FlutterPanelBinding;
  projects: FlutterProject[];
  executable: { executable: string; source: "setting" | "fvm" | "path"; version: string | null } | null;
  daemon: FlutterDaemon | null;
  devices: FlutterWorkspaceSnapshot["devices"];
  selectedDeviceId: string | null;
  sessions: Map<string, DeviceRuntime>;
  disconnectTimer: ReturnType<typeof setTimeout> | null;
  connected: boolean;
}

interface DeviceRuntime {
  run: FlutterRunSession | null;
  console: ConsoleBuffer;
  pendingRecords: ConsoleRecord[];
  batchTimer: ReturnType<typeof setTimeout> | null;
  sequence: number;
}

type StoredBindings = Record<string, FlutterPanelBinding>;

function emptyRun(): FlutterWorkspaceSnapshot["run"] { return { state: "idle", appId: null, deviceId: null, vmServiceUri: null, devToolsUri: null, startedAt: null, error: null }; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function screenshotDirectory(pluginId: string): string { return path.resolve(homedir(), ".daintree", "plugin-data", pluginId, "screenshots"); }

export function isOwnedScreenshotPath(pluginId: string, filePath: string): boolean {
  const resolved = path.resolve(filePath);
  return path.dirname(resolved) === screenshotDirectory(pluginId) && path.extname(resolved).toLowerCase() === ".png";
}

interface ScreenshotSystemCommand { command: string; args: string[] }

export function screenshotOpenCommand(platform: NodeJS.Platform, filePath: string): ScreenshotSystemCommand {
  if (platform === "darwin") return { command: "/usr/bin/open", args: [filePath] };
  if (platform === "win32") return { command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", "Start-Process -FilePath $args[0]", filePath] };
  return { command: "xdg-open", args: [filePath] };
}

export const IDLE_PANEL_LEASE_MS = 30 * 60 * 1_000;
export const ACTIVE_PANEL_LEASE_MS = 12 * 60 * 60 * 1_000;

export function panelLeaseMs(state: FlutterWorkspaceSnapshot["run"]["state"]): number {
  return ["starting", "running", "reloading", "restarting", "stopping"].includes(state)
    ? ACTIVE_PANEL_LEASE_MS
    : IDLE_PANEL_LEASE_MS;
}

function isActiveState(state: FlutterWorkspaceSnapshot["run"]["state"]): boolean {
  return ["starting", "running", "reloading", "restarting", "stopping"].includes(state);
}

async function chooseWorktree(host: PluginHostApi): Promise<PluginWorktreeSnapshot | null> {
  const worktrees = await host.getWorktrees();
  if (worktrees.length === 0) return null;
  const current = await host.dispatch("worktree.getCurrent");
  if (current.ok && current.result && typeof current.result === "object" && "worktree" in current.result) {
    const visible = (current.result as { worktree?: { id?: string; path?: string } }).worktree;
    const match = worktrees.find((item) => item.id === visible?.id || item.worktreeId === visible?.id || item.path === visible?.path);
    if (match) return match;
  }
  const candidates = worktrees.filter((item) => item.isCurrent);
  if (candidates.length === 1) return candidates[0] ?? null;
  const pool = candidates.length ? candidates : worktrees;
  const items: PluginQuickPickItem[] = pool.map((item) => ({ id: item.id, label: item.name, description: item.branch, detail: item.path }));
  const selected = await host.showQuickPick(items, { title: "Select a worktree for Flutter Tools", placeholder: "Choose the project context", matchOnDescription: true });
  if (!selected || Array.isArray(selected)) return null;
  return pool.find((item) => item.id === selected.id) ?? null;
}

function bindingFor(worktree: PluginWorktreeSnapshot): FlutterPanelBinding {
  return flutterPanelBindingSchema.parse({ schemaVersion: 1, worktreeId: worktree.id, worktreeName: worktree.name, worktreePath: path.resolve(worktree.path), flutterProjectPath: null });
}

async function storedBindings(host: PluginHostApi): Promise<StoredBindings> {
  const value = await host.storage.get<unknown>(BINDINGS_KEY, "user");
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([id, candidate]) => { const parsed = flutterPanelBindingSchema.safeParse(candidate); return parsed.success ? [[id, parsed.data] as const] : []; }));
}

async function saveBinding(host: PluginHostApi, panelId: string, binding: FlutterPanelBinding): Promise<void> {
  const all = await storedBindings(host); all[panelId] = binding; await host.storage.set(BINDINGS_KEY, all, "user");
}

async function resolveBinding(host: PluginHostApi, panelId: string, initialArgs?: Record<string, unknown>): Promise<FlutterPanelBinding> {
  const all = await storedBindings(host);
  const candidate = all[panelId] ?? flutterPanelBindingSchema.safeParse(initialArgs).data;
  if (!candidate) throw new Error("This panel has no valid Flutter worktree binding. Close it and open Flutter Tools again.");
  const valid = (await host.getWorktrees()).some((item) => (item.id === candidate.worktreeId || item.worktreeId === candidate.worktreeId) && path.resolve(item.path) === path.resolve(candidate.worktreePath));
  if (!valid) throw new Error("The worktree bound to this Flutter panel is no longer loaded.");
  return candidate;
}

function badge(runtime: PanelRuntime): PluginPanelBadge {
  const snapshots = [...runtime.sessions.values()].map((session) => session.run?.getSnapshot() ?? emptyRun());
  const running = snapshots.filter((snapshot) => snapshot.state === "running").length;
  if (running > 0) return { kind: "label", text: String(running), color: "success", tooltip: `${running} Flutter ${running === 1 ? "app" : "apps"} running` };
  const changing = snapshots.find((snapshot) => isActiveState(snapshot.state));
  if (changing) return { kind: "dot", color: "warning", tooltip: `Flutter ${changing.state}` };
  const failed = snapshots.find((snapshot) => snapshot.state === "failed");
  if (failed) return { kind: "label", text: "ERR", color: "error", tooltip: failed.error ?? "Flutter run failed" };
  return { kind: "label", text: runtime.devices.length.toString(), color: "default", tooltip: `${runtime.devices.length} Flutter devices` };
}

export async function activate(host: PluginHostApi): Promise<() => void> {
  const runtimes = new Map<string, PanelRuntime>();

  const launchSystemCommand = async ({ command, args }: ScreenshotSystemCommand): Promise<void> => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", shell: false });
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
  };

  const getDeviceRuntime = (runtime: PanelRuntime, deviceId: string): DeviceRuntime => {
    const existing = runtime.sessions.get(deviceId); if (existing) return existing;
    const created: DeviceRuntime = { run: null, console: new ConsoleBuffer(), pendingRecords: [], batchTimer: null, sequence: 0 };
    runtime.sessions.set(deviceId, created); return created;
  };

  const snapshotFor = (runtime: PanelRuntime): FlutterWorkspaceSnapshot => {
    const selected = runtime.selectedDeviceId ? getDeviceRuntime(runtime, runtime.selectedDeviceId) : null;
    return snapshotSchema.parse({
      binding: runtime.binding, projects: runtime.projects, devices: runtime.devices,
      selectedDeviceId: runtime.selectedDeviceId, sdk: runtime.executable,
      run: selected?.run?.getSnapshot() ?? emptyRun(),
      sessions: [...runtime.sessions.entries()].map(([deviceId, session]) => { const run = session.run?.getSnapshot() ?? emptyRun(); return { deviceId, state: run.state, appId: run.appId, startedAt: run.startedAt }; }),
      console: selected?.console.snapshot() ?? [], sequence: selected?.sequence ?? 0,
    });
  };

  const flush = (panelId: string, deviceId: string, session: DeviceRuntime): void => {
    if (session.batchTimer) clearTimeout(session.batchTimer);
    session.batchTimer = null;
    if (!session.pendingRecords.length) return;
    const payload = consoleBatchSchema.parse({ deviceId, sequence: session.sequence++, records: session.pendingRecords.splice(0) });
    void host.postToPanel("console.batch", payload, panelId).catch(() => {});
  };

  const append = (panelId: string, runtime: PanelRuntime, deviceId: string, stream: ConsoleRecord["stream"], text: string): void => {
    const session = getDeviceRuntime(runtime, deviceId);
    session.pendingRecords.push(...session.console.append(stream, text));
    if (session.pendingRecords.length >= 100) flush(panelId, deviceId, session);
    else if (!session.batchTimer) session.batchTimer = setTimeout(() => flush(panelId, deviceId, session), 50);
  };

  const publish = async (panelId: string, runtime: PanelRuntime): Promise<void> => {
    await Promise.all([
      host.setPanelBadge(panelId, badge(runtime)),
      host.postToPanel("workspace.snapshot", snapshotFor(runtime), panelId),
    ]);
  };

  const disposeRuntime = async (panelId: string): Promise<boolean> => {
    const runtime = runtimes.get(panelId); if (!runtime) return false;
    runtimes.delete(panelId);
    for (const [deviceId, session] of runtime.sessions) flush(panelId, deviceId, session);
    if (runtime.disconnectTimer) clearTimeout(runtime.disconnectTimer);
    await Promise.all([...runtime.sessions.values()].map((session) => session.run?.stop().catch(() => {})));
    await runtime.daemon?.dispose().catch(() => {});
    return true;
  };

  const scheduleDisconnect = (panelId: string, runtime: PanelRuntime): void => {
    runtime.connected = false;
    if (runtime.disconnectTimer) clearTimeout(runtime.disconnectTimer);
    const active = [...runtime.sessions.values()].some((session) => isActiveState(session.run?.getSnapshot().state ?? "idle"));
    runtime.disconnectTimer = setTimeout(() => { void disposeRuntime(panelId); }, active ? ACTIVE_PANEL_LEASE_MS : IDLE_PANEL_LEASE_MS);
    runtime.disconnectTimer.unref?.();
  };

  const getRuntime = async (panelId: string, initialArgs?: Record<string, unknown>): Promise<PanelRuntime> => {
    const existing = runtimes.get(panelId); if (existing) { existing.connected = true; if (existing.disconnectTimer) clearTimeout(existing.disconnectTimer); existing.disconnectTimer = null; return existing; }
    const binding = await resolveBinding(host, panelId, initialArgs);
    const depthSetting = await host.settings.get<unknown>("projectSearchDepth");
    const projects = await discoverFlutterProjects(binding.worktreePath, typeof depthSetting === "number" ? depthSetting : 5);
    if (!binding.flutterProjectPath && projects.length === 1) binding.flutterProjectPath = projects[0]!.path;
    if (binding.flutterProjectPath && !projects.some((project) => path.resolve(project.path) === path.resolve(binding.flutterProjectPath!))) binding.flutterProjectPath = null;
    const sdkSetting = await host.settings.get<unknown>("flutterSdkPath");
    const resolvedExecutable = await resolveFlutterExecutable(binding.worktreePath, typeof sdkSetting === "string" ? sdkSetting : undefined);
    const executable = { ...resolvedExecutable, version: await inspectFlutterVersion(resolvedExecutable.executable) };
    const runtime: PanelRuntime = { binding, projects, executable, daemon: null, devices: [], selectedDeviceId: null, sessions: new Map(), disconnectTimer: null, connected: true };
    runtimes.set(panelId, runtime);
    await saveBinding(host, panelId, binding);
    const daemon = new FlutterDaemon(executable.executable); runtime.daemon = daemon;
    daemon.on("devices", (devices: FlutterWorkspaceSnapshot["devices"]) => { runtime.devices = devices; if (!runtime.selectedDeviceId || !devices.some((item) => item.id === runtime.selectedDeviceId)) runtime.selectedDeviceId = devices[0]?.id ?? null; void publish(panelId, runtime).catch(() => {}); });
    daemon.on("log", (text: string) => { if (runtime.selectedDeviceId) append(panelId, runtime, runtime.selectedDeviceId, "tool", text); });
    try { await daemon.start(); } catch (error) { if (runtime.selectedDeviceId) append(panelId, runtime, runtime.selectedDeviceId, "system", `Flutter daemon: ${errorMessage(error)}`); }
    return runtime;
  };

  const open = async (reuseExisting: boolean): Promise<{ opened: boolean }> => {
    const worktree = await chooseWorktree(host); if (!worktree) { await host.showToast({ message: "No worktree was selected for Flutter Tools", type: "warning" }); return { opened: false }; }
    const binding = bindingFor(worktree);
    const result = await host.dispatch("panel.openPluginPanel", { kind: PANEL_KIND, worktreeId: worktree.id, initialArgs: binding, reuseExisting });
    if (!result.ok) throw new Error(result.error.message);
    const panelId = result.result && typeof result.result === "object" && "panelId" in result.result && typeof result.result.panelId === "string" ? result.result.panelId : null;
    if (panelId) await saveBinding(host, panelId, binding);
    return { opened: true };
  };

  await Promise.all([
    host.registerAction({ id: "open", title: "Flutter: Open Tools", description: "Open Flutter Tools bound to the visible worktree.", category: "Flutter", kind: "command", danger: "safe" }, () => open(true)),
    host.registerAction({ id: "open-another", title: "Flutter: Open Another Tools Panel", description: "Open another independent Flutter Tools panel.", category: "Flutter", kind: "command", danger: "safe" }, () => open(false)),
    host.registerHandler("workspace.connect", { args: panelArgsSchema, result: snapshotSchema, requires: ["shell:exec"] }, async (_ctx, args) => { const runtime = await getRuntime(args.panelId, args.initialArgs); await publish(args.panelId, runtime); return snapshotFor(runtime); }),
    host.registerHandler("workspace.refresh", { args: panelArgsSchema, result: snapshotSchema, requires: ["shell:exec"] }, async (_ctx, args) => { const runtime = await getRuntime(args.panelId, args.initialArgs); const depth = await host.settings.get<unknown>("projectSearchDepth"); runtime.projects = await discoverFlutterProjects(runtime.binding.worktreePath, typeof depth === "number" ? depth : 5); if (!runtime.daemon) throw new Error("Flutter daemon unavailable"); await runtime.daemon.refreshDevices(); await publish(args.panelId, runtime); return snapshotFor(runtime); }),
    host.registerHandler("project.select", { args: setProjectArgsSchema, result: flutterPanelBindingSchema }, async (_ctx, args) => { const runtime = await getRuntime(args.panelId, args.initialArgs); const project = runtime.projects.find((item) => path.resolve(item.path) === path.resolve(args.projectPath)); if (!project) throw new Error("Selected Flutter project is outside the discovered worktree projects"); if ([...runtime.sessions.values()].some((session) => isActiveState(session.run?.getSnapshot().state ?? "idle"))) throw new Error("Stop all running applications before changing Flutter project"); for (const [deviceId, session] of runtime.sessions) { flush(args.panelId, deviceId, session); if (session.batchTimer) clearTimeout(session.batchTimer); } runtime.sessions.clear(); runtime.binding = { ...runtime.binding, flutterProjectPath: project.path }; await saveBinding(host, args.panelId, runtime.binding); await publish(args.panelId, runtime); return runtime.binding; }),
    host.registerHandler("device.select", { args: selectDeviceArgsSchema, result: snapshotSchema }, async (_ctx, args) => { const runtime = await getRuntime(args.panelId, args.initialArgs); if (!runtime.devices.some((item) => item.id === args.deviceId)) throw new Error("Selected Flutter device is no longer available"); runtime.selectedDeviceId = args.deviceId; getDeviceRuntime(runtime, args.deviceId); await publish(args.panelId, runtime); return snapshotFor(runtime); }),
    host.registerHandler("run.start", { args: runArgsSchema, result: operationResultSchema, requires: ["shell:exec"] }, async (_ctx, args) => { const runtime = await getRuntime(args.panelId, args.initialArgs); if (!runtime.binding.flutterProjectPath) throw new Error("Select a Flutter project first"); if (!runtime.devices.some((device) => device.id === args.deviceId)) throw new Error("Selected Flutter device is no longer available"); if (!runtime.executable) throw new Error("Flutter SDK unavailable"); const deviceRuntime = getDeviceRuntime(runtime, args.deviceId); await deviceRuntime.run?.stop(); deviceRuntime.console.clear(); deviceRuntime.pendingRecords = []; deviceRuntime.sequence = 0; const session = new FlutterRunSession({ executable: runtime.executable.executable, projectPath: runtime.binding.flutterProjectPath, deviceId: args.deviceId, mode: args.mode, entrypoint: args.entrypoint, extraArgs: args.extraArgs }); deviceRuntime.run = session; session.on("output", (stream: ConsoleRecord["stream"], text: string) => append(args.panelId, runtime, args.deviceId, stream, text)); session.on("state", () => { if (!runtime.connected) scheduleDisconnect(args.panelId, runtime); void publish(args.panelId, runtime).catch(() => {}); }); session.start(); await publish(args.panelId, runtime); return { ok: true, message: `Starting on ${args.deviceId}` }; }),
    host.registerHandler("run.control", { args: controlArgsSchema, result: operationResultSchema, requires: ["shell:exec"] }, async (_ctx, args) => { const runtime = await getRuntime(args.panelId, args.initialArgs); const session = runtime.sessions.get(args.deviceId)?.run; if (!session) throw new Error("No Flutter run session exists for the selected device"); if (args.operation === "stop") await session.stop(); else if (args.operation === "detach") await session.detach(); else await session.reload(args.operation === "hotRestart"); await publish(args.panelId, runtime); return { ok: true, message: args.operation === "hotReload" ? "Hot reload complete" : args.operation === "hotRestart" ? "Hot restart complete" : args.operation === "detach" ? "Debugger detached; application left running" : "Application stopped" }; }),
    host.registerHandler("screenshot.capture", { args: screenshotArgsSchema, result: screenshotResultSchema, requires: ["shell:exec", "fs:user-data-write"] }, async (_ctx, args) => { const runtime = await getRuntime(args.panelId, args.initialArgs); if (!runtime.daemon) throw new Error("Flutter daemon unavailable"); const device = runtime.devices.find((item) => item.id === args.deviceId); if (!device?.capabilities.screenshot) throw new Error(`${device?.name ?? args.deviceId} does not advertise screenshot support`); const bytes = await runtime.daemon.takeScreenshot(args.deviceId); const directory = screenshotDirectory(host.pluginId); await mkdir(directory, { recursive: true }); const filePath = path.join(directory, `${new Date().toISOString().replaceAll(":", "-")}-${args.deviceId.replace(/[^a-zA-Z0-9._-]/g, "_")}.png`); await writeFile(filePath, bytes); return { ok: true, message: "Screenshot captured", deviceId: args.deviceId, filePath, dataUrl: `data:image/png;base64,${bytes.toString("base64")}`, copied: false }; }),
    host.registerHandler("devtools.open", { args: devicePanelArgsSchema, result: operationResultSchema }, async (_ctx, args) => { const runtime = await getRuntime(args.panelId, args.initialArgs); const run = runtime.sessions.get(args.deviceId)?.run?.getSnapshot(); const url = run?.devToolsUri ?? (run?.vmServiceUri ? `https://devtools.flutter.dev/?uri=${encodeURIComponent(run.vmServiceUri)}` : null); if (!url) throw new Error("DevTools becomes available after the selected device's VM service connects"); const result = await host.dispatch("browser.openUrl", { url }); if (!result.ok) throw new Error(result.error.message); return { ok: true, message: "DevTools opened" }; }),
    host.registerHandler("screenshot.open", { args: z.object({ filePath: z.string().min(1) }), result: operationResultSchema, requires: ["shell:exec"] }, async (_ctx, args) => { if (!isOwnedScreenshotPath(host.pluginId, args.filePath)) throw new Error("Only screenshots created by Flutter Tools can be opened"); const filePath = path.resolve(args.filePath); await launchSystemCommand(screenshotOpenCommand(process.platform, filePath)); return { ok: true, message: "Screenshot opened" }; }),
    host.registerHandler("screenshot.delete", { args: z.object({ filePath: z.string().min(1) }), result: operationResultSchema, requires: ["fs:user-data-write"] }, async (_ctx, args) => { if (!isOwnedScreenshotPath(host.pluginId, args.filePath)) throw new Error("Only screenshots created by Flutter Tools can be deleted"); try { await unlink(path.resolve(args.filePath)); } catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error; } return { ok: true, message: "Screenshot deleted" }; }),
    host.registerHandler("console.clear", { args: devicePanelArgsSchema, result: operationResultSchema }, async (_ctx, args) => { const runtime = await getRuntime(args.panelId, args.initialArgs); const session = getDeviceRuntime(runtime, args.deviceId); session.console.clear(); session.pendingRecords = []; session.sequence = 0; await publish(args.panelId, runtime); return { ok: true, message: "Console cleared" }; }),
    host.registerHandler("console.copy", { args: z.object({ text: z.string().max(8 * 1024 * 1024) }), result: operationResultSchema, requires: ["clipboard:write"] }, async (_ctx, args) => { await host.clipboard.writeText(args.text); return { ok: true, message: "Console copied" }; }),
    host.registerHandler("workspace.disconnect", { args: z.object({ panelId: z.string().min(1) }), result: operationResultSchema }, async (_ctx, args) => { const runtime = runtimes.get(args.panelId); if (!runtime) return { ok: false, message: "Panel was already disconnected" }; for (const [deviceId, session] of runtime.sessions) flush(args.panelId, deviceId, session); scheduleDisconnect(args.panelId, runtime); return { ok: true, message: "Panel hidden; Flutter sessions retained for reconnect" }; }),
  ]);

  return async () => {
    await Promise.all([...runtimes.keys()].map((panelId) => disposeRuntime(panelId)));
  };
}
