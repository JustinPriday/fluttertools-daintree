import { createMockHost } from "@daintreehq/plugin-sdk/testing";
import type { PluginWorktreeSnapshot } from "@daintreehq/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { homedir } from "node:os";
import path from "node:path";
import { activate, isOwnedScreenshotPath } from "./index.js";
import * as discovery from "./flutter/discovery.js";
import { AppSettingsService } from "./flutter/appSettings.js";
import { FlutterMachineProcess } from "./flutter/machine.js";
import { FlutterDaemon } from "./flutter/daemon.js";
import { payloadBytes, PUSH_PAYLOAD_BUDGET } from "./shared/transport.js";
import { snapshotSchema } from "./shared/contracts.js";

afterEach(() => vi.restoreAllMocks());

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(async () => Buffer.from([137, 80, 78, 71])) };
});

function worktree(): PluginWorktreeSnapshot { return { id: "wt-1", worktreeId: "wt-1", name: "mobile-suite", path: "/repo/mobile-suite", isCurrent: true, linked: null, status: null }; }

describe("Flutter Tools activation", () => {
  it("connects without relying on pushes and uses invalidation for oversized snapshots", async () => {
    const current = worktree();
    const projects = Array.from({ length: 6000 }, (_, index) => ({ path: `/repo/mobile-suite/${index}`, name: "x".repeat(180), relativePath: String(index) }));
    vi.spyOn(discovery, "discoverFlutterProjects").mockResolvedValue(projects);
    vi.spyOn(discovery, "resolveFlutterExecutable").mockResolvedValue({ executable: "flutter", source: "path" });
    vi.spyOn(discovery, "inspectFlutterVersion").mockResolvedValue("Flutter fixture");
    vi.spyOn(discovery, "discoverFlutterDevices").mockResolvedValue([]);
    vi.spyOn(FlutterDaemon.prototype, "start").mockResolvedValue();
    vi.spyOn(FlutterDaemon.prototype, "listDevices").mockReturnValue([]);
    const host = createMockHost({ capabilities: ["shell:exec", "fs:project-read"], activeWorktree: current, worktrees: [current] });
    const post = vi.spyOn(host, "postToPanel").mockRejectedValue(new Error("Push unavailable"));
    const dispose = await activate(host);
    const context = { projectId: null, worktreeId: current.id, webContentsId: 1, pluginId: "justinpriday.flutter-tools" };
    const args = { panelId: "panel-overflow", initialArgs: { schemaVersion: 1, worktreeId: current.id, worktreeName: current.name, worktreePath: current.path, flutterProjectPath: null } };
    try {
      const result = snapshotSchema.parse(await host.registeredHandlers.find((item) => item.channel === "workspace.connect")!.handler(context, args));
      expect(result.projects).toHaveLength(6000);
      expect(result.sdk?.version).toBe("Flutter fixture");
      expect(payloadBytes(result)).toBeGreaterThan(PUSH_PAYLOAD_BUDGET);
      expect(post).not.toHaveBeenCalled();
      post.mockImplementation(async (_channel, payload) => { expect(payloadBytes(payload)).toBeLessThanOrEqual(PUSH_PAYLOAD_BUDGET); });
      await host.registeredHandlers.find((item) => item.channel === "project.select")!.handler(context, { ...args, projectPath: projects[0]!.path });
      expect(post).toHaveBeenCalledWith("workspace.changed", {}, args.panelId);
      // Pulling the invalidation returns state directly, without another push.
      post.mockClear();
      await host.registeredHandlers.find((item) => item.channel === "workspace.connect")!.handler(context, args);
      expect(post).not.toHaveBeenCalled();
    } finally { dispose(); }
  });

  it("retains a failed target and its console through discovery loss and reconnection", async () => {
    const current = worktree();
    const iphone = { id: "iphone", name: "Jay’s iPhone", platform: "ios", category: null, emulator: false, ephemeral: false, sdk: null, capabilities: { hotReload: true, hotRestart: true, screenshot: false, fastStart: false } };
    const other = { ...iphone, id: "other", name: "Other device" };
    vi.spyOn(discovery, "discoverFlutterProjects").mockResolvedValue([{ path: current.path, name: "app", relativePath: "." }]);
    vi.spyOn(discovery, "resolveFlutterExecutable").mockResolvedValue({ executable: "flutter", source: "path" });
    vi.spyOn(discovery, "inspectFlutterVersion").mockResolvedValue("Flutter fixture");
    vi.spyOn(discovery, "discoverFlutterDevices").mockResolvedValue([iphone, other]);
    let daemon: FlutterDaemon;
    vi.spyOn(FlutterDaemon.prototype, "start").mockImplementation(async function (this: FlutterDaemon) { daemon = this; });
    vi.spyOn(FlutterDaemon.prototype, "listDevices").mockReturnValue([iphone, other]);
    vi.spyOn(FlutterMachineProcess.prototype, "start").mockImplementation(function (this: FlutterMachineProcess) {
      this.emit("stdout", "Command PhaseScriptExecution failed with a nonzero exit code");
      this.emit("exit", 2);
    });
    const host = createMockHost({ capabilities: ["shell:exec", "fs:project-read"], activeWorktree: current, worktrees: [current] });
    const dispose = await activate(host);
    const context = { projectId: null, worktreeId: current.id, webContentsId: 1, pluginId: "justinpriday.flutter-tools" };
    const args = { panelId: "panel-failure", initialArgs: { schemaVersion: 1, worktreeId: current.id, worktreeName: current.name, worktreePath: current.path, flutterProjectPath: current.path } };
    const invoke = (channel: string, extra = {}) => host.registeredHandlers.find((item) => item.channel === channel)!.handler(context, { ...args, ...extra });
    try {
      await invoke("workspace.connect");
      await invoke("run.start", { deviceId: iphone.id, mode: "release", extraArgs: [] });
      daemon!.emit("devices", [other]);
      const lost = snapshotSchema.parse(await invoke("workspace.connect"));
      expect(lost.devices).toEqual([other]);
      expect(lost.selectedDeviceId).toBe(iphone.id);
      expect(lost.selectedDevice?.name).toBe(iphone.name);
      expect(lost.run).toMatchObject({ state: "failed", error: "Flutter run exited with code 2" });
      expect(lost.console.some((line) => line.text.includes("PhaseScriptExecution"))).toBe(true);
      daemon!.emit("devices", [{ ...iphone, name: "Reconnected iPhone" }, other]);
      const restored = snapshotSchema.parse(await invoke("workspace.connect"));
      expect(restored.selectedDeviceId).toBe(iphone.id);
      expect(restored.selectedDevice?.name).toBe("Reconnected iPhone");
      await invoke("device.select", { deviceId: other.id });
      expect(snapshotSchema.parse(await invoke("workspace.connect")).selectedDeviceId).toBe(other.id);
    } finally { dispose(); }
  });

  it("coordinates app setting writes, runs, watchers and panels by their bound Flutter app", async () => {
    const current = worktree();
    const otherRoot = current.path + "/other";
    vi.spyOn(FlutterDaemon.prototype, "running", "get").mockReturnValue(false);
    vi.spyOn(discovery, "discoverFlutterProjects").mockResolvedValue([current.path, otherRoot].map((root) => ({ path: root, name: "app", relativePath: root === current.path ? "." : "other" })));
    vi.spyOn(discovery, "resolveFlutterExecutable").mockResolvedValue({ executable: "flutter", source: "path" });
    vi.spyOn(discovery, "inspectFlutterVersion").mockResolvedValue("Flutter fixture");
    const device = { id: "pixel", name: "Pixel", platform: "android", category: null, emulator: false, ephemeral: false, sdk: null, capabilities: { hotReload: true, hotRestart: true, screenshot: false, fastStart: false } };
    vi.spyOn(discovery, "discoverFlutterDevices").mockResolvedValue([device]);
    vi.spyOn(FlutterDaemon.prototype, "start").mockResolvedValue();
    vi.spyOn(FlutterDaemon.prototype, "listDevices").mockReturnValue([device]);
    vi.spyOn(AppSettingsService.prototype, "load").mockResolvedValue({ config: { schemaVersion: 1, appSettings: [] }, revision: null });
    vi.spyOn(AppSettingsService.prototype, "statuses").mockResolvedValue([]);
    vi.spyOn(AppSettingsService.prototype, "containedPath").mockImplementation(async (root, file) => path.resolve(root, file));
    const apply = vi.spyOn(AppSettingsService.prototype, "apply").mockResolvedValue();
    vi.spyOn(FlutterMachineProcess.prototype, "running", "get").mockReturnValue(true);
    const start = vi.spyOn(FlutterMachineProcess.prototype, "start").mockImplementation(function (this: FlutterMachineProcess) { this.emit("message", { event: "app.started" }); });
    vi.spyOn(FlutterMachineProcess.prototype, "close").mockImplementation(async function (this: FlutterMachineProcess) { this.emit("exit", 0); });
    const host = createMockHost({ capabilities: ["shell:exec", "fs:project-read", "fs:project-write"], activeWorktree: current, worktrees: [current] });
    const watchers: { change: (file: string) => void; dispose: ReturnType<typeof vi.fn> }[] = [];
    vi.spyOn(host.fs, "watch").mockImplementation(async (_paths, change) => { const dispose = vi.fn(); watchers.push({ change, dispose }); return dispose; });
    const post = vi.spyOn(host, "postToPanel");
    const dispose = await activate(host);
    const context = { projectId: null, worktreeId: current.id, webContentsId: 1, pluginId: "justinpriday.flutter-tools" };
    const argsFor = (panelId: string) => ({ panelId, projectPath: panelId === "other" ? otherRoot : current.path, initialArgs: { schemaVersion: 1, worktreeId: current.id, worktreeName: current.name, worktreePath: current.path, flutterProjectPath: panelId === "other" ? otherRoot : current.path } });
    const invoke = (panel: string, channel: string, extra = {}) => host.registeredHandlers.find((item) => item.channel === channel)!.handler(context, { ...argsFor(panel), ...extra });
    const preview = { projectPath: current.path, settingId: "server", optionId: "production", file: "lib/config.dart", before: "old", after: "new", sourceRevision: "source", definitionRevision: null };
    try {
      for (const panel of ["a", "b", "other"]) await invoke(panel, "appSettings.get");
      expect(watchers).toHaveLength(3);
      await invoke("a", "run.start", { deviceId: "pixel", mode: "release", extraArgs: [] });
      await expect(invoke("b", "appSettings.apply", { preview })).rejects.toThrow("Stop all Flutter builds");
      expect(apply).not.toHaveBeenCalled();
      await invoke("other", "appSettings.apply", { preview });
      expect(apply).toHaveBeenCalledWith(otherRoot, preview);
      await invoke("a", "run.control", { deviceId: "pixel", operation: "stop" });
      await invoke("b", "appSettings.apply", { preview });
      expect(apply).toHaveBeenCalledWith(current.path, preview);
      post.mockClear();
      watchers[0].change("/file-changed");
      await vi.waitFor(() => expect(post).toHaveBeenCalledWith("appSettings.changed", {}, "b"));
      expect(post).toHaveBeenCalledWith("appSettings.changed", {}, "a");
      expect(post).not.toHaveBeenCalledWith("appSettings.changed", {}, "other");
      // A source write that already owns the application lock finishes before a queued run starts.
      start.mockClear();
      let finishWrite!: () => void;
      apply.mockImplementationOnce(async () => { await new Promise<void>((resolve) => { finishWrite = resolve; }); });
      const write = invoke("b", "appSettings.apply", { preview });
      await vi.waitFor(() => expect(finishWrite).toBeTypeOf("function"));
      const run = invoke("a", "run.start", { deviceId: "pixel", mode: "release", extraArgs: [] });
      await Promise.resolve(); expect(start).not.toHaveBeenCalled();
      finishWrite(); await Promise.all([write, run]); expect(start).toHaveBeenCalledOnce();
    } finally { await dispose(); }
    expect(watchers.every((watcher) => watcher.dispose.mock.calls.length === 1)).toBe(true);
  });

  it("only permits deletion inside the plugin-owned screenshots directory", () => {
    const owned = path.join(homedir(), ".daintree", "plugin-data", "justinpriday.flutter-tools", "screenshots", "capture.png");
    expect(isOwnedScreenshotPath("justinpriday.flutter-tools", owned)).toBe(true);
    expect(isOwnedScreenshotPath("justinpriday.flutter-tools", path.join(owned, "..", "..", "settings.json"))).toBe(false);
    expect(isOwnedScreenshotPath("justinpriday.flutter-tools", path.join(homedir(), "capture.png"))).toBe(false);
    expect(isOwnedScreenshotPath("justinpriday.flutter-tools", owned.replace(/\.png$/, ".txt"))).toBe(false);
  });
  it("registers the public actions and typed panel channels without starting Flutter", async () => {
    const host = createMockHost({ capabilities: ["shell:exec", "fs:project-read", "fs:user-data-write", "clipboard:write"], activeWorktree: worktree(), worktrees: [worktree()] });
    await activate(host);
    expect(host.registeredActions.map((item) => item.descriptor)).toEqual(expect.arrayContaining([expect.objectContaining({ id: "open", requires: [] }), expect.objectContaining({ id: "open-another", requires: [] })]));
    expect(host.registeredHandlers.map((item) => item.channel)).toEqual(expect.arrayContaining(["workspace.connect", "settings.open", "launchParameters.set", "run.start", "run.reinstall", "run.control", "recording.start", "recording.stop", "screenshot.capture", "screenshot.copy", "media.open", "media.reveal", "media.delete"]));
    expect(host.registeredHandlers.map((item) => item.channel)).not.toEqual(expect.arrayContaining(["screenshot.open", "screenshot.delete"]));
    expect(host.registeredHandlers.map((item) => item.channel)).not.toContain("workspace.disconnect");
  });

  it("opens a restore-safe panel bound to the visible worktree", async () => {
    const current = worktree();
    const host = createMockHost({ capabilities: ["shell:exec", "fs:project-read", "fs:user-data-write", "clipboard:write"], activeWorktree: current, worktrees: [current] });
    host.setDispatchResult("worktree.getCurrent", { ok: true, result: { worktree: { id: current.id, path: current.path } } });
    host.setDispatchResult("panel.openPluginPanel", { ok: true, result: { panelId: "flutter-panel-1" } });
    await activate(host);
    await host.registeredActions.find((item) => item.descriptor.id === "open")?.handler(undefined);
    expect(host.dispatchedActions).toContainEqual({ actionId: "panel.openPluginPanel", args: { kind: "justinpriday.flutter-tools.workspace", worktreeId: "wt-1", initialArgs: { schemaVersion: 1, worktreeId: "wt-1", worktreeName: "mobile-suite", worktreePath: "/repo/mobile-suite", flutterProjectPath: null }, reuseExisting: true } });
  });
});
