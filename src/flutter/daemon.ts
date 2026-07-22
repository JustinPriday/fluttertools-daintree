import { EventEmitter } from "node:events";
import { FlutterMachineProcess, type MachineMessage } from "./machine.js";
import { deviceSchema, type FlutterDevice } from "../shared/contracts.js";

export const FLUTTER_DAEMON_ARGS = ["daemon"] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseDevice(value: unknown): FlutterDevice | null {
  const raw = asRecord(value);
  const caps = asRecord(raw?.capabilities);
  const parsed = deviceSchema.safeParse({
    id: raw?.id,
    name: raw?.name,
    platform: raw?.platform,
    category: typeof raw?.category === "string" ? raw.category : null,
    emulator: raw?.emulator === true,
    ephemeral: raw?.ephemeral === true,
    sdk: typeof raw?.sdk === "string" ? raw.sdk : null,
    capabilities: { hotReload: caps?.hotReload === true, hotRestart: caps?.hotRestart === true, screenshot: caps?.screenshot === true, fastStart: caps?.fastStart === true },
  });
  return parsed.success ? parsed.data : null;
}

export class FlutterDaemon extends EventEmitter {
  private readonly machine: FlutterMachineProcess;
  private devices = new Map<string, FlutterDevice>();
  private readyPromise: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;
  private rejectReady: ((error: Error) => void) | null = null;

  constructor(executable: string) {
    super();
    this.machine = new FlutterMachineProcess({ executable, args: [...FLUTTER_DAEMON_ARGS] });
    this.machine.on("message", (message: MachineMessage) => this.onMessage(message));
    this.machine.on("stderr", (text: string) => this.emit("log", text));
    this.machine.on("processError", (error: Error) => this.rejectReady?.(error));
    this.machine.on("exit", (code) => { this.rejectReady?.(new Error(`Flutter daemon exited with code ${code ?? "unknown"}`)); this.devices.clear(); this.emit("devices", []); });
  }

  async start(): Promise<void> {
    if (this.machine.running) return;
    this.readyPromise = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.machine.start();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([this.readyPromise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Flutter daemon did not become ready")), 20_000); })]); }
    finally { if (timer) clearTimeout(timer); this.resolveReady = null; this.rejectReady = null; }
    await this.machine.request("device.enable");
    await this.refreshDevices();
  }

  listDevices(): FlutterDevice[] { return [...this.devices.values()].sort((a, b) => a.name.localeCompare(b.name)); }

  async refreshDevices(): Promise<FlutterDevice[]> {
    const response = await this.machine.request("device.getDevices");
    const next = new Map<string, FlutterDevice>();
    if (Array.isArray(response)) for (const item of response) { const device = parseDevice(item); if (device) next.set(device.id, device); }
    this.devices = next;
    const devices = this.listDevices();
    this.emit("devices", devices);
    return devices;
  }

  async takeScreenshot(deviceId: string): Promise<Buffer> {
    const result = await this.machine.request("device.takeScreenshot", { deviceId }, 60_000);
    if (typeof result !== "string" || result.length === 0) throw new Error("Flutter returned no screenshot data");
    return Buffer.from(result, "base64");
  }

  async dispose(): Promise<void> { await this.machine.close("daemon.shutdown"); }

  private onMessage(message: MachineMessage): void {
    if (message.event === "daemon.connected") this.resolveReady?.();
    if (message.event === "device.added") { const device = parseDevice(message.params); if (device) this.devices.set(device.id, device); }
    if (message.event === "device.removed") { const raw = asRecord(message.params); if (typeof raw?.id === "string") this.devices.delete(raw.id); }
    if (message.event?.startsWith("device.")) this.emit("devices", this.listDevices());
    if (message.event === "daemon.logMessage") this.emit("log", JSON.stringify(message.params));
  }
}
