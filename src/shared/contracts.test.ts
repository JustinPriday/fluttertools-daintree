import { describe, expect, it } from "vitest";
import { consoleBatchSchema, runArgsSchema, snapshotSchema } from "./contracts.js";

const idleRun = { state: "idle", appId: null, deviceId: null, vmServiceUri: null, devToolsUri: null, startedAt: null, error: null } as const;

describe("per-device Flutter workspace contracts", () => {
  it("requires every run request to name its target device", () => {
    expect(runArgsSchema.safeParse({ panelId: "panel-1", deviceId: "iphone", mode: "debug", extraArgs: [] }).success).toBe(true);
    expect(runArgsSchema.safeParse({ panelId: "panel-1", mode: "debug", extraArgs: [] }).success).toBe(false);
  });

  it("identifies the device on every console batch", () => {
    expect(consoleBatchSchema.safeParse({ deviceId: "pixel", sequence: 2, records: [] }).success).toBe(true);
    expect(consoleBatchSchema.safeParse({ sequence: 2, records: [] }).success).toBe(false);
  });

  it("carries selected context and independent session summaries", () => {
    const parsed = snapshotSchema.parse({
      binding: { schemaVersion: 1, worktreeId: "wt", worktreeName: "mobile", worktreePath: "/mobile", flutterProjectPath: "/mobile/app" },
      projects: [{ path: "/mobile/app", name: "app", relativePath: "app" }], devices: [], selectedDeviceId: "pixel", sdk: null, toolError: null,
      run: idleRun, sessions: [{ deviceId: "iphone", state: "running", appId: "app-1", startedAt: "2026-07-22T00:00:00.000Z" }], console: [], sequence: 0,
    });
    expect(parsed.selectedDeviceId).toBe("pixel");
    expect(parsed.sessions).toContainEqual(expect.objectContaining({ deviceId: "iphone", state: "running" }));
    expect(parsed.run.state).toBe("idle");
  });
});
