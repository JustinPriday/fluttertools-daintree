import { createMockHost } from "@daintreehq/plugin-testing";
import type { PluginWorktreeSnapshot } from "@daintreehq/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { homedir } from "node:os";
import path from "node:path";
import { activate, isOwnedScreenshotPath } from "./index.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(async () => Buffer.from([137, 80, 78, 71])) };
});

function worktree(): PluginWorktreeSnapshot { return { id: "wt-1", worktreeId: "wt-1", name: "mobile-suite", path: "/repo/mobile-suite", isCurrent: true, linked: null, status: null }; }

describe("Flutter Tools activation", () => {
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
    expect(host.registeredHandlers.map((item) => item.channel)).toEqual(expect.arrayContaining(["workspace.connect", "settings.open", "run.start", "run.reinstall", "run.control", "recording.start", "recording.stop", "screenshot.capture", "screenshot.copy", "media.open", "media.reveal", "media.delete"]));
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
