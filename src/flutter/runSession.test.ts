import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRunArguments, FlutterRunSession } from "./runSession.js";
import { FlutterMachineProcess } from "./machine.js";

afterEach(() => vi.restoreAllMocks());

describe("Flutter run arguments", () => {
  it("builds an argv array without shell interpolation", () => {
    expect(buildRunArguments({ deviceId: "ios device; echo unsafe", mode: "profile", entrypoint: "lib/dev main.dart", extraArgs: ["--dart-define=API=a b"] })).toEqual([
      "run", "--machine", "-d", "ios device; echo unsafe", "--profile", "-t", "lib/dev main.dart", "--dart-define=API=a b",
    ]);
  });

  it("builds and launches release without a resident machine connection", () => {
    expect(buildRunArguments({ deviceId: "pixel", mode: "release" })).toEqual([
      "run", "--no-resident", "-d", "pixel", "--release",
    ]);
  });

  it("leaves a successful release launch detached without exposing a running session", () => {
    vi.spyOn(FlutterMachineProcess.prototype, "start").mockImplementation(function (this: FlutterMachineProcess) { this.emit("exit", 0); });
    const session = new FlutterRunSession({ executable: "flutter", projectPath: "/project", deviceId: "pixel", mode: "release" });
    const states: string[] = [];
    session.on("state", (snapshot) => states.push(snapshot.state));
    session.start();
    expect(states).toEqual(["starting", "detached"]);
    expect(session.getSnapshot()).toMatchObject({ state: "detached", mode: "release", appId: null, vmServiceUri: null, devToolsUri: null, error: null });
  });

  it("reports release build failures instead of marking them detached", () => {
    vi.spyOn(FlutterMachineProcess.prototype, "start").mockImplementation(function (this: FlutterMachineProcess) { this.emit("exit", 1); });
    const session = new FlutterRunSession({ executable: "flutter", projectPath: "/project", deviceId: "pixel", mode: "release" });
    session.start();
    expect(session.getSnapshot()).toMatchObject({ state: "failed", error: "Flutter run exited with code 1" });
  });

  it.each([0, null])("cancels a release build without detaching or reporting failure (exit %s)", async (code) => {
    let machine: FlutterMachineProcess;
    vi.spyOn(FlutterMachineProcess.prototype, "start").mockImplementation(function (this: FlutterMachineProcess) { machine = this; });
    vi.spyOn(FlutterMachineProcess.prototype, "running", "get").mockReturnValue(true);
    const close = vi.spyOn(FlutterMachineProcess.prototype, "close").mockImplementation(async () => { machine.emit("exit", code); });
    const session = new FlutterRunSession({ executable: "flutter", projectPath: "/project", deviceId: "iphone", mode: "release" });
    const states: string[] = [];
    const output: string[] = [];
    session.on("state", (snapshot) => states.push(snapshot.state));
    session.on("output", (_stream, text) => output.push(text));
    session.start();
    await session.stop();
    expect(close).toHaveBeenCalledWith(undefined, {});
    expect(states).toContain("stopping");
    expect(states).not.toContain("detached");
    expect(states).not.toContain("failed");
    expect(session.getSnapshot()).toMatchObject({ state: "stopped", error: null });
    expect(output).toContain("Flutter build and deployment cancelled.");
  });

  it("preserves attached development sessions", () => {
    expect(buildRunArguments({ deviceId: "pixel", mode: "debug" })).toEqual(["run", "--machine", "-d", "pixel"]);
    vi.spyOn(FlutterMachineProcess.prototype, "start").mockImplementation(function (this: FlutterMachineProcess) {
      this.emit("message", { event: "app.start", params: { appId: "debug-app" } });
      this.emit("message", { event: "app.started" });
    });
    const session = new FlutterRunSession({ executable: "flutter", projectPath: "/project", deviceId: "pixel", mode: "debug" });
    session.start();
    expect(session.getSnapshot()).toMatchObject({ state: "running", appId: "debug-app" });
  });

  it("rejects debug-only reload controls for release sessions", async () => {
    const session = new FlutterRunSession({ executable: "flutter", projectPath: "/project", deviceId: "pixel", mode: "release" });
    await expect(session.reload(false)).rejects.toThrow("Hot reload is unavailable for release builds");
    await expect(session.reload(true)).rejects.toThrow("Hot restart is unavailable for release builds");
  });
});
