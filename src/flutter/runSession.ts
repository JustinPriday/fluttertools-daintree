import { EventEmitter } from "node:events";
import { FlutterMachineProcess, type MachineMessage } from "./machine.js";
import type { RunMode, RunState } from "../shared/contracts.js";

function record(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }

export interface RunSessionSnapshot {
  state: RunState;
  mode: RunMode;
  appId: string | null;
  deviceId: string;
  vmServiceUri: string | null;
  devToolsUri: string | null;
  startedAt: string | null;
  error: string | null;
}

export function buildRunArguments(options: { deviceId: string; mode: RunMode; entrypoint?: string; extraArgs?: string[] }): string[] {
  const args = ["run", "--machine", "-d", options.deviceId];
  if (options.mode !== "debug") args.push(`--${options.mode}`);
  if (options.entrypoint?.trim()) args.push("-t", options.entrypoint.trim());
  args.push(...(options.extraArgs ?? []));
  return args;
}

export class FlutterRunSession extends EventEmitter {
  private readonly machine: FlutterMachineProcess;
  private snapshot: RunSessionSnapshot;

  constructor(options: { executable: string; projectPath: string; deviceId: string; mode: RunMode; entrypoint?: string; extraArgs?: string[] }) {
    super();
    const args = buildRunArguments(options);
    this.machine = new FlutterMachineProcess({ executable: options.executable, args, cwd: options.projectPath });
    this.snapshot = { state: "idle", mode: options.mode, appId: null, deviceId: options.deviceId, vmServiceUri: null, devToolsUri: null, startedAt: null, error: null };
    this.machine.on("message", (message: MachineMessage) => this.onMessage(message));
    this.machine.on("stdout", (text: string) => this.emit("output", "stdout", text));
    this.machine.on("stderr", (text: string) => this.emit("output", "stderr", text));
    this.machine.on("processError", (error: Error) => this.fail(error));
    this.machine.on("exit", (code: number | null) => {
      if (this.snapshot.state === "detached") return;
      if (this.snapshot.state !== "stopping" && this.snapshot.state !== "stopped" && code !== 0) this.fail(new Error(`Flutter run exited with code ${code ?? "unknown"}`));
      else this.update({ state: "stopped" });
    });
  }

  getSnapshot(): RunSessionSnapshot { return { ...this.snapshot }; }
  start(): void { this.update({ state: "starting", startedAt: new Date().toISOString(), error: null }); this.machine.start(); }

  async reload(fullRestart: boolean): Promise<void> {
    if (this.snapshot.mode !== "debug") throw new Error(`Hot ${fullRestart ? "restart" : "reload"} is unavailable for ${this.snapshot.mode} builds`);
    if (!this.snapshot.appId || this.snapshot.state !== "running") throw new Error("No running Flutter application is ready");
    this.update({ state: fullRestart ? "restarting" : "reloading" });
    try {
      await this.machine.request("app.restart", { appId: this.snapshot.appId, fullRestart, pause: false, reason: "Daintree Flutter Tools", debounce: true }, 120_000);
      this.update({ state: "running" });
    } catch (error) { this.update({ state: "running" }); throw error; }
  }

  async stop(): Promise<void> {
    if (!this.machine.running) { this.update({ state: "stopped" }); return; }
    this.update({ state: "stopping" });
    await this.machine.close(this.snapshot.appId ? "app.stop" : undefined, this.snapshot.appId ? { appId: this.snapshot.appId } : {});
    this.update({ state: "stopped" });
  }

  async detach(): Promise<void> {
    if (!this.snapshot.appId || !this.machine.running) throw new Error("No running Flutter application can be detached");
    await this.machine.close("app.detach", { appId: this.snapshot.appId });
    this.update({ state: "detached" });
  }

  private onMessage(message: MachineMessage): void {
    const params = record(message.params);
    if (message.event === "app.start" && typeof params?.appId === "string") this.update({ appId: params.appId });
    else if (message.event === "app.started") this.update({ state: "running" });
    else if (message.event === "app.debugPort") {
      const uri = typeof params?.wsUri === "string" ? params.wsUri : typeof params?.baseUri === "string" ? params.baseUri : null;
      if (uri) this.update({ vmServiceUri: uri });
    } else if (message.event === "app.devTools") {
      if (typeof params?.uri === "string") this.update({ devToolsUri: params.uri });
    } else if (message.event === "app.stop") this.update({ state: "stopped" });
    else if (message.event === "app.log") {
      const text = typeof params?.log === "string" ? params.log : JSON.stringify(params ?? message.params);
      this.emit("output", params?.error === true ? "stderr" : "tool", text);
    } else if (message.event) this.emit("toolEvent", message.event, message.params);
  }

  private update(patch: Partial<RunSessionSnapshot>): void { this.snapshot = { ...this.snapshot, ...patch }; this.emit("state", this.getSnapshot()); }
  private fail(error: Error): void { this.update({ state: "failed", error: error.message }); this.emit("output", "system", error.message); }
}
