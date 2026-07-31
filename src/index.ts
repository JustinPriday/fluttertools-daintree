import path from "node:path";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import type { PluginHostApi, PluginPanelBadge, PluginQuickPickItem, PluginWorktreeSnapshot } from "@daintreehq/plugin-sdk";
import { z } from "zod";
import { FlutterDaemon } from "./flutter/daemon.js";
import { supportsAppReinstall } from "./flutter/device.js";
import { discoverFlutterDevices, discoverFlutterProjects, inspectFlutterVersion, resolveFlutterExecutable } from "./flutter/discovery.js";
import { FlutterRunSession } from "./flutter/runSession.js";
import { uninstallFlutterApp } from "./flutter/uninstall.js";
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
  toolError: string | null;
  refreshPromise: Promise<void> | null;
  sessions: Map<string, DeviceRuntime>;
}

interface DeviceRuntime {
  run: FlutterRunSession | null;
  launchConfig: { mode: "debug" | "profile" | "release"; entrypoint?: string; extraArgs: string[] } | null;
  launchPromise: Promise<void> | null;
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

  const getDeviceRuntime = (runtime: PanelRuntime, deviceId: string): DeviceRuntime => {
    const existing = runtime.sessions.get(deviceId); if (existing) return existing;
    const created: DeviceRuntime = { run: null, launchConfig: null, launchPromise: null, console: new ConsoleBuffer(), pendingRecords: [], batchTimer: null, sequence: 0 };
    runtime.sessions.set(deviceId, created); return created;
  };

  const snapshotFor = (runtime: PanelRuntime): FlutterWorkspaceSnapshot => {
    const selected = runtime.selectedDeviceId ? getDeviceRuntime(runtime, runtime.selectedDeviceId) : null;
    return snapshotSchema.parse({
      binding: runtime.binding, projects: runtime.projects, devices: runtime.devices,
      selectedDeviceId: runtime.selectedDeviceId, sdk: runtime.executable,
      toolError: runtime.toolError,
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

  const startDeviceRun = async (
    panelId: string,
    runtime: PanelRuntime,
    deviceId: string,
    config: NonNullable<DeviceRuntime["launchConfig"]>,
    reinstall = false,
  ): Promise<void> => {
    const deviceRuntime = getDeviceRuntime(runtime, deviceId);
    if (deviceRuntime.launchPromise) throw new Error("A launch operation is already in progress for this device");
    const launch = (async () => {
      if (!runtime.binding.flutterProjectPath) throw new Error("Select a Flutter project first");
      const device = runtime.devices.find((candidate) => candidate.id === deviceId);
      if (!device) throw new Error("Selected Flutter device is no longer available");
      if (reinstall && !supportsAppReinstall(device)) throw new Error("Reinstall & Restart is supported for Android and iOS devices only");
      if (!runtime.executable) throw new Error("Flutter SDK unavailable");
      await deviceRuntime.run?.stop();
      deviceRuntime.console.clear();
      deviceRuntime.pendingRecords = [];
      deviceRuntime.sequence = 0;
      deviceRuntime.launchConfig = { ...config, extraArgs: [...config.extraArgs] };
      append(panelId, runtime, deviceId, "system", reinstall ? "Reinstall & Restart: removing the installed app and its local data." : "Starting Flutter application.");
      await publish(panelId, runtime);
      if (reinstall) {
        await uninstallFlutterApp({
          executable: runtime.executable.executable,
          projectPath: runtime.binding.flutterProjectPath,
          deviceId,
          mode: config.mode,
          extraArgs: config.extraArgs,
          onOutput: (stream, text) => append(panelId, runtime, deviceId, stream, text),
        });
        append(panelId, runtime, deviceId, "system", "Uninstall complete. Launching the Flutter application.");
      }
      const session = new FlutterRunSession({
        executable: runtime.executable.executable,
        projectPath: runtime.binding.flutterProjectPath,
        deviceId,
        mode: config.mode,
        entrypoint: config.entrypoint,
        extraArgs: config.extraArgs,
      });
      deviceRuntime.run = session;
      session.on("output", (stream: ConsoleRecord["stream"], text: string) => append(panelId, runtime, deviceId, stream, text));
      session.on("state", () => { void publish(panelId, runtime).catch(() => {}); });
      session.start();
      await publish(panelId, runtime);
    })();
    deviceRuntime.launchPromise = launch;
    try { await launch; } finally { if (deviceRuntime.launchPromise === launch) deviceRuntime.launchPromise = null; }
  };

  const applyDevices = (runtime: PanelRuntime, devices: FlutterWorkspaceSnapshot["devices"]): void => {
    runtime.devices = devices;
    if (!runtime.selectedDeviceId || !devices.some((item) => item.id === runtime.selectedDeviceId)) {
      runtime.selectedDeviceId = devices[0]?.id ?? null;
    }
  };

  const attachDaemon = (panelId: string, runtime: PanelRuntime): FlutterDaemon => {
    const daemon = new FlutterDaemon(runtime.executable!.executable);
    runtime.daemon = daemon;
    daemon.on("devices", (devices: FlutterWorkspaceSnapshot["devices"]) => {
      applyDevices(runtime, devices);
      void publish(panelId, runtime).catch(() => {});
    });
    daemon.on("log", (text: string) => {
      if (runtime.selectedDeviceId) append(panelId, runtime, runtime.selectedDeviceId, "tool", text);
    });
    return daemon;
  };

  const discoveryFailureMessage = (daemonError: unknown, fallbackError: unknown): string => {
    const detail = `Flutter daemon: ${errorMessage(daemonError)}. One-shot discovery: ${errorMessage(fallbackError)}.`.replace(/\s+/g, " ").trim();
    if (process.platform !== "darwin") return detail;
    const timedOut = /timed out|sigkill|command failed/i.test(detail);
    return timedOut
      ? "Flutter device discovery did not respond before the timeout. Run `mdutil -s /`. If it says “Spotlight server is disabled,” open System Settings → Spotlight → Search Privacy, remove Macintosh HD, then press Refresh."
      : `${detail} On macOS, also check \`mdutil -s /\`; disabled Spotlight can block Flutter startup.`;
  };

  const performDeviceRefresh = async (panelId: string, runtime: PanelRuntime): Promise<void> => {
    if (!runtime.executable) throw new Error("Flutter SDK unavailable");
    let daemon = runtime.daemon;
    if (!daemon?.running) {
      await daemon?.dispose().catch(() => {});
      daemon = attachDaemon(panelId, runtime);
    }

    const daemonAttempt = daemon.running ? daemon.refreshDevices() : daemon.start().then(() => daemon.listDevices());
    const fallbackAttempt = discoverFlutterDevices(runtime.executable.executable);
    const [daemonResult, fallbackResult] = await Promise.allSettled([daemonAttempt, fallbackAttempt]);

    if (fallbackResult.status === "fulfilled") applyDevices(runtime, fallbackResult.value);
    if (daemonResult.status === "rejected") {
      await daemon.dispose().catch(() => {});
      if (runtime.daemon === daemon) runtime.daemon = null;
    }

    if (daemonResult.status === "rejected" && fallbackResult.status === "rejected") {
      runtime.toolError = discoveryFailureMessage(daemonResult.reason, fallbackResult.reason);
    } else if (daemonResult.status === "rejected") {
      runtime.toolError = `Live Flutter device monitoring is unavailable (${errorMessage(daemonResult.reason)}). Using one-shot device discovery; Refresh retries the daemon.`;
    } else {
      runtime.toolError = null;
    }
  };

  const refreshDeviceSources = (panelId: string, runtime: PanelRuntime): Promise<void> => {
    if (runtime.refreshPromise) return runtime.refreshPromise;
    const refresh = performDeviceRefresh(panelId, runtime);
    runtime.refreshPromise = refresh;
    const clear = (): void => { if (runtime.refreshPromise === refresh) runtime.refreshPromise = null; };
    void refresh.then(clear, clear);
    return refresh;
  };

  const disposeRuntime = async (panelId: string): Promise<boolean> => {
    const runtime = runtimes.get(panelId); if (!runtime) return false;
    runtimes.delete(panelId);
    for (const [deviceId, session] of runtime.sessions) flush(panelId, deviceId, session);
    await Promise.all([...runtime.sessions.values()].map((session) => session.run?.stop().catch(() => {})));
    await runtime.daemon?.dispose().catch(() => {});
    return true;
  };

  const getRuntime = async (panelId: string, initialArgs?: Record<string, unknown>): Promise<PanelRuntime> => {
    const existing = runtimes.get(panelId); if (existing) return existing;
    const binding = await resolveBinding(host, panelId, initialArgs);
    const depthSetting = await host.settings.get<unknown>("projectSearchDepth");
    const projects = await discoverFlutterProjects(binding.worktreePath, typeof depthSetting === "number" ? depthSetting : 5);
    if (!binding.flutterProjectPath && projects.length === 1) binding.flutterProjectPath = projects[0]!.path;
    if (binding.flutterProjectPath && !projects.some((project) => path.resolve(project.path) === path.resolve(binding.flutterProjectPath!))) binding.flutterProjectPath = null;
    const sdkSetting = await host.settings.get<unknown>("flutterSdkPath");
    const resolvedExecutable = await resolveFlutterExecutable(binding.worktreePath, typeof sdkSetting === "string" ? sdkSetting : undefined);
    const executable = { ...resolvedExecutable, version: await inspectFlutterVersion(resolvedExecutable.executable) };
    const runtime: PanelRuntime = { binding, projects, executable, daemon: null, devices: [], selectedDeviceId: null, toolError: null, refreshPromise: null, sessions: new Map() };
    runtimes.set(panelId, runtime);
    await saveBinding(host, panelId, binding);
    await refreshDeviceSources(panelId, runtime);
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
    host.onDidChangePanelLifecycle((event) => { if (event.phase === "removed") void disposeRuntime(event.panelId); }),
    host.registerAction({ id: "open", title: "Flutter: Open Tools", description: "Open Flutter Tools bound to the visible worktree.", category: "Flutter", kind: "command", danger: "safe", requires: [] }, () => open(true)),
    host.registerAction({ id: "open-another", title: "Flutter: Open Another Tools Panel", description: "Open another independent Flutter Tools panel.", category: "Flutter", kind: "command", danger: "safe", requires: [] }, () => open(false)),
    host.registerHandler("workspace.connect", { args: panelArgsSchema, result: snapshotSchema, requires: ["shell:exec"] }, async (_ctx, args) => { const runtime = await getRuntime(args.panelId, args.initialArgs); await publish(args.panelId, runtime); return snapshotFor(runtime); }),
    host.registerHandler("workspace.refresh", { args: panelArgsSchema, result: snapshotSchema, requires: ["shell:exec"] }, async (_ctx, args) => { const runtime = await getRuntime(args.panelId, args.initialArgs); const depth = await host.settings.get<unknown>("projectSearchDepth"); runtime.projects = await discoverFlutterProjects(runtime.binding.worktreePath, typeof depth === "number" ? depth : 5); await refreshDeviceSources(args.panelId, runtime); await publish(args.panelId, runtime); return snapshotFor(runtime); }),
    host.registerHandler("project.select", { args: setProjectArgsSchema, result: flutterPanelBindingSchema }, async (_ctx, args) => { const runtime = await getRuntime(args.panelId, args.initialArgs); const project = runtime.projects.find((item) => path.resolve(item.path) === path.resolve(args.projectPath)); if (!project) throw new Error("Selected Flutter project is outside the discovered worktree projects"); if ([...runtime.sessions.values()].some((session) => isActiveState(session.run?.getSnapshot().state ?? "idle"))) throw new Error("Stop all running applications before changing Flutter project"); for (const [deviceId, session] of runtime.sessions) { flush(args.panelId, deviceId, session); if (session.batchTimer) clearTimeout(session.batchTimer); } runtime.sessions.clear(); runtime.binding = { ...runtime.binding, flutterProjectPath: project.path }; await saveBinding(host, args.panelId, runtime.binding); await publish(args.panelId, runtime); return runtime.binding; }),
    host.registerHandler("device.select", { args: selectDeviceArgsSchema, result: snapshotSchema }, async (_ctx, args) => { const runtime = await getRuntime(args.panelId, args.initialArgs); if (!runtime.devices.some((item) => item.id === args.deviceId)) throw new Error("Selected Flutter device is no longer available"); runtime.selectedDeviceId = args.deviceId; getDeviceRuntime(runtime, args.deviceId); await publish(args.panelId, runtime); return snapshotFor(runtime); }),
    host.registerHandler("run.start", { args: runArgsSchema, result: operationResultSchema, requires: ["shell:exec"] }, async (_ctx, args) => { const runtime = await getRuntime(args.panelId, args.initialArgs); await startDeviceRun(args.panelId, runtime, args.deviceId, { mode: args.mode, entrypoint: args.entrypoint, extraArgs: args.extraArgs }); return { ok: true, message: `Starting on ${args.deviceId}` }; }),
    host.registerHandler("run.reinstall", { args: devicePanelArgsSchema, result: operationResultSchema, requires: ["shell:exec"] }, async (_ctx, args) => { const runtime = await getRuntime(args.panelId, args.initialArgs); const deviceRuntime = getDeviceRuntime(runtime, args.deviceId); const config = deviceRuntime.launchConfig ?? { mode: "debug" as const, extraArgs: [] }; await startDeviceRun(args.panelId, runtime, args.deviceId, config, true); return { ok: true, message: `Reinstalling and restarting on ${args.deviceId}` }; }),
    host.registerHandler("run.control", { args: controlArgsSchema, result: operationResultSchema, requires: ["shell:exec"] }, async (_ctx, args) => { const runtime = await getRuntime(args.panelId, args.initialArgs); const session = runtime.sessions.get(args.deviceId)?.run; if (!session) throw new Error("No Flutter run session exists for the selected device"); if (args.operation === "stop") await session.stop(); else if (args.operation === "detach") await session.detach(); else await session.reload(args.operation === "hotRestart"); await publish(args.panelId, runtime); return { ok: true, message: args.operation === "hotReload" ? "Hot reload complete" : args.operation === "hotRestart" ? "Hot restart complete" : args.operation === "detach" ? "Debugger detached; application left running" : "Application stopped" }; }),
    host.registerHandler("screenshot.capture", { args: screenshotArgsSchema, result: screenshotResultSchema, requires: ["shell:exec", "fs:user-data-write", "clipboard:write"] }, async (_ctx, args) => { const runtime = await getRuntime(args.panelId, args.initialArgs); if (!runtime.daemon) throw new Error("Flutter daemon unavailable"); const device = runtime.devices.find((item) => item.id === args.deviceId); if (!device?.capabilities.screenshot) throw new Error(`${device?.name ?? args.deviceId} does not advertise screenshot support`); const bytes = await runtime.daemon.takeScreenshot(args.deviceId); const directory = screenshotDirectory(host.pluginId); await mkdir(directory, { recursive: true }); const filePath = path.join(directory, `${new Date().toISOString().replaceAll(":", "-")}-${args.deviceId.replace(/[^a-zA-Z0-9._-]/g, "_")}.png`); await writeFile(filePath, bytes); if (args.copyToClipboard) await host.clipboard.writeImage(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)); return { ok: true, message: args.copyToClipboard ? "Screenshot captured and copied" : "Screenshot captured", deviceId: args.deviceId, filePath, dataUrl: `data:image/png;base64,${bytes.toString("base64")}`, copied: args.copyToClipboard }; }),
    host.registerHandler("devtools.open", { args: devicePanelArgsSchema, result: operationResultSchema }, async (_ctx, args) => { const runtime = await getRuntime(args.panelId, args.initialArgs); const run = runtime.sessions.get(args.deviceId)?.run?.getSnapshot(); const url = run?.devToolsUri ?? (run?.vmServiceUri ? `https://devtools.flutter.dev/?uri=${encodeURIComponent(run.vmServiceUri)}` : null); if (!url) throw new Error("DevTools becomes available after the selected device's VM service connects"); const result = await host.dispatch("browser.openUrl", { url }); if (!result.ok) throw new Error(result.error.message); return { ok: true, message: "DevTools opened" }; }),
    host.registerHandler("screenshot.copy", { args: z.object({ filePath: z.string().min(1) }), result: operationResultSchema, requires: ["fs:user-data-write", "clipboard:write"] }, async (_ctx, args) => { if (!isOwnedScreenshotPath(host.pluginId, args.filePath)) throw new Error("Only screenshots created by Flutter Tools can be copied"); const bytes = await readFile(path.resolve(args.filePath)); await host.clipboard.writeImage(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)); return { ok: true, message: "Screenshot copied" }; }),
    host.registerHandler("screenshot.open", { args: z.object({ filePath: z.string().min(1) }), result: operationResultSchema, requires: ["fs:user-data-write"] }, async (_ctx, args) => { if (!isOwnedScreenshotPath(host.pluginId, args.filePath)) throw new Error("Only screenshots created by Flutter Tools can be opened"); await host.system.openPath(path.resolve(args.filePath)); return { ok: true, message: "Screenshot opened" }; }),
    host.registerHandler("screenshot.delete", { args: z.object({ filePath: z.string().min(1) }), result: operationResultSchema, requires: ["fs:user-data-write"] }, async (_ctx, args) => { if (!isOwnedScreenshotPath(host.pluginId, args.filePath)) throw new Error("Only screenshots created by Flutter Tools can be deleted"); try { await unlink(path.resolve(args.filePath)); } catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error; } return { ok: true, message: "Screenshot deleted" }; }),
    host.registerHandler("console.clear", { args: devicePanelArgsSchema, result: operationResultSchema }, async (_ctx, args) => { const runtime = await getRuntime(args.panelId, args.initialArgs); const session = getDeviceRuntime(runtime, args.deviceId); session.console.clear(); session.pendingRecords = []; session.sequence = 0; await publish(args.panelId, runtime); return { ok: true, message: "Console cleared" }; }),
    host.registerHandler("console.copy", { args: z.object({ text: z.string().max(8 * 1024 * 1024) }), result: operationResultSchema, requires: ["clipboard:write"] }, async (_ctx, args) => { await host.clipboard.writeText(args.text); return { ok: true, message: "Console copied" }; }),
  ]);

  return async () => {
    await Promise.all([...runtimes.keys()].map((panelId) => disposeRuntime(panelId)));
  };
}
