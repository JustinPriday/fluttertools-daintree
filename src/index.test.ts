import { createMockHost } from "@daintreehq/plugin-testing";
import type { PluginWorktreeSnapshot } from "@daintreehq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import path from "node:path";
import { ACTIVE_PANEL_LEASE_MS, IDLE_PANEL_LEASE_MS, activate, isOwnedScreenshotPath, panelLeaseMs, screenshotOpenCommand } from "./index.js";

function worktree(): PluginWorktreeSnapshot { return { id: "wt-1", worktreeId: "wt-1", name: "mobile-suite", path: "/repo/mobile-suite", isCurrent: true, linked: null, status: null }; }

describe("Flutter Tools activation", () => {
  it("retains active sessions much longer than idle hidden panels", () => {
    expect(panelLeaseMs("running")).toBe(ACTIVE_PANEL_LEASE_MS);
    expect(panelLeaseMs("reloading")).toBe(ACTIVE_PANEL_LEASE_MS);
    expect(panelLeaseMs("idle")).toBe(IDLE_PANEL_LEASE_MS);
    expect(panelLeaseMs("stopped")).toBe(IDLE_PANEL_LEASE_MS);
  });
  it("only permits deletion inside the plugin-owned screenshots directory", () => {
    const owned = path.join(homedir(), ".daintree", "plugin-data", "justinpriday.flutter-tools", "screenshots", "capture.png");
    expect(isOwnedScreenshotPath("justinpriday.flutter-tools", owned)).toBe(true);
    expect(isOwnedScreenshotPath("justinpriday.flutter-tools", path.join(owned, "..", "..", "settings.json"))).toBe(false);
    expect(isOwnedScreenshotPath("justinpriday.flutter-tools", path.join(homedir(), "capture.png"))).toBe(false);
    expect(isOwnedScreenshotPath("justinpriday.flutter-tools", owned.replace(/\.png$/, ".txt"))).toBe(false);
  });
  it("uses non-shell platform commands for screenshot operations", () => {
    expect(screenshotOpenCommand("darwin", "/tmp/capture.png")).toEqual({ command: "/usr/bin/open", args: ["/tmp/capture.png"] });
    expect(screenshotOpenCommand("linux", "/tmp/capture.png")).toEqual({ command: "xdg-open", args: ["/tmp/capture.png"] });
  });
  it("registers the public actions and typed panel channels without starting Flutter", async () => {
    const host = createMockHost({ capabilities: ["shell:exec", "fs:project-read", "fs:user-data-write", "clipboard:write"], activeWorktree: worktree(), worktrees: [worktree()] });
    await activate(host);
    expect(host.registeredActions.map((item) => item.descriptor.id)).toEqual(["open", "open-another"]);
    expect(host.registeredHandlers.map((item) => item.channel)).toEqual(expect.arrayContaining(["workspace.connect", "run.start", "run.control", "screenshot.capture", "screenshot.open", "screenshot.delete", "workspace.disconnect"]));
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
