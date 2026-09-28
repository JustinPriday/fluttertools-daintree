import { describe, expect, it } from "vitest";
import type { FlutterPanelBinding } from "../shared/contracts.js";
import { applyLaunchParameters, dartDefineArguments, launchParameterIdentity, LaunchParameterStore } from "./launchParameters.js";

function binding(worktreeId: string, project = "app"): FlutterPanelBinding {
  return { schemaVersion: 1, worktreeId, worktreeName: worktreeId, worktreePath: `/repo/${worktreeId}`, flutterProjectPath: `/repo/${worktreeId}/${project}` };
}

class MemoryStorage {
  readonly values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> { return this.values.get(key) as T | undefined; }
  async set<T>(key: string, value: T): Promise<void> { this.values.set(key, value); }
}

describe("Flutter launch parameters", () => {
  it("emits only set Dart defines as single argv tokens", () => {
    expect(dartDefineArguments({ dartDefines: [
      { key: "ANALYTICS_LOCAL_TEST", value: "true", enabled: true },
      { key: "API_LABEL", value: "local build = one", enabled: true },
      { key: "DISABLED_FLAG", value: "false", enabled: false },
    ] })).toEqual([
      "--dart-define=ANALYTICS_LOCAL_TEST=true",
      "--dart-define=API_LABEL=local build = one",
    ]);
  });

  it("replaces earlier Dart defines while preserving unrelated arguments", () => {
    expect(applyLaunchParameters(
      ["--flavor", "development", "--dart-define=OLD=true", "--dart-define", "PAIR=false", "--verbose"],
      { dartDefines: [{ key: "CURRENT", value: "yes", enabled: true }] },
    )).toEqual(["--flavor", "development", "--verbose", "--dart-define=CURRENT=yes"]);
  });

  it("uses worktree and relative project identity", () => {
    expect(launchParameterIdentity(binding("wt-1", "packages/mobile"))).toBe("wt-1:packages/mobile");
    expect(launchParameterIdentity({ ...binding("wt-1"), flutterProjectPath: null })).toBeNull();
  });

  it("persists separate values per project and removes empty entries", async () => {
    const storage = new MemoryStorage();
    const store = new LaunchParameterStore(storage);
    await store.save(binding("wt-1", "app"), { dartDefines: [{ key: "ONE", value: "1", enabled: true }] });
    await store.save(binding("wt-1", "admin"), { dartDefines: [{ key: "TWO", value: "2", enabled: false }] });
    expect(await store.load(binding("wt-1", "app"))).toEqual({ dartDefines: [{ key: "ONE", value: "1", enabled: true }] });
    expect(await store.load(binding("wt-1", "admin"))).toEqual({ dartDefines: [{ key: "TWO", value: "2", enabled: false }] });
    await store.save(binding("wt-1", "app"), { dartDefines: [] });
    expect(await store.load(binding("wt-1", "app"))).toEqual({ dartDefines: [] });
  });
});
