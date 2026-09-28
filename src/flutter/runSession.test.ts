import { describe, expect, it } from "vitest";
import { buildRunArguments, FlutterRunSession } from "./runSession.js";

describe("Flutter run arguments", () => {
  it("builds an argv array without shell interpolation", () => {
    expect(buildRunArguments({ deviceId: "ios device; echo unsafe", mode: "profile", entrypoint: "lib/dev main.dart", extraArgs: ["--dart-define=API=a b"] })).toEqual([
      "run", "--machine", "-d", "ios device; echo unsafe", "--profile", "-t", "lib/dev main.dart", "--dart-define=API=a b",
    ]);
  });

  it("requests a release build explicitly", () => {
    expect(buildRunArguments({ deviceId: "pixel", mode: "release" })).toEqual([
      "run", "--machine", "-d", "pixel", "--release",
    ]);
  });

  it("rejects debug-only reload controls for release sessions", async () => {
    const session = new FlutterRunSession({ executable: "flutter", projectPath: "/project", deviceId: "pixel", mode: "release" });
    await expect(session.reload(false)).rejects.toThrow("Hot reload is unavailable for release builds");
    await expect(session.reload(true)).rejects.toThrow("Hot restart is unavailable for release builds");
  });
});
