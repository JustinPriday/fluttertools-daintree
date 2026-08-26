import type { AndroidRecordingResult } from "./androidRecording.js";
import type { RecordingSnapshot } from "../shared/contracts.js";

export interface CoordinatedRecorder {
  start(): Promise<void>;
  stop(): Promise<AndroidRecordingResult>;
  abort?(): void;
  readonly completion: Promise<AndroidRecordingResult>;
}

interface RecordingEntry {
  panelId: string;
  deviceId: string;
  recorder: CoordinatedRecorder | null;
  snapshot: RecordingSnapshot;
  ready: Promise<void>;
  settlement: Promise<void> | null;
  stopRequested: boolean;
}

export interface StartCoordinatedRecordingOptions {
  panelId: string;
  deviceId: string;
  createRecorder: (onFinalizing: () => void) => Promise<CoordinatedRecorder>;
}

export interface RecordingCoordinatorOptions {
  onChange: (panelId: string, deviceId: string, snapshot: RecordingSnapshot) => void | Promise<void>;
  onComplete: (panelId: string, deviceId: string, result: AndroidRecordingResult, startedAt: string) => void | Promise<void>;
  teardownTimeoutMs?: number;
}

const DEFAULT_TEARDOWN_TIMEOUT_MS = 45_000;

function idleSnapshot(deviceId: string | null): RecordingSnapshot {
  return { state: "idle", deviceId, startedAt: null, error: null, ownedByPanel: true };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class RecordingCoordinator {
  private readonly active = new Map<string, RecordingEntry>();
  private readonly lastByOwner = new Map<string, RecordingSnapshot>();

  constructor(private readonly options: RecordingCoordinatorOptions) {}

  getSnapshot(panelId: string, deviceId: string | null): RecordingSnapshot {
    if (!deviceId) return idleSnapshot(null);
    const active = this.active.get(deviceId);
    if (active) return { ...active.snapshot, ownedByPanel: active.panelId === panelId };
    return this.lastByOwner.get(this.ownerKey(panelId, deviceId)) ?? idleSnapshot(deviceId);
  }

  async start(options: StartCoordinatedRecordingOptions): Promise<void> {
    const conflict = this.active.get(options.deviceId);
    if (conflict) {
      throw new Error(conflict.panelId === options.panelId
        ? "This device is already being recorded"
        : "This device is already being recorded by another Flutter Tools panel");
    }

    const entry: RecordingEntry = {
      panelId: options.panelId,
      deviceId: options.deviceId,
      recorder: null,
      snapshot: { state: "starting", deviceId: options.deviceId, startedAt: null, error: null, ownedByPanel: true },
      ready: Promise.resolve(),
      settlement: null,
      stopRequested: false,
    };
    this.active.set(options.deviceId, entry);
    this.lastByOwner.set(this.ownerKey(options.panelId, options.deviceId), entry.snapshot);
    this.changed(entry);

    const launch = this.launch(entry, options.createRecorder);
    entry.ready = launch;
    await launch;
  }

  async stop(panelId: string, deviceId: string): Promise<void> {
    const entry = this.active.get(deviceId);
    if (!entry) throw new Error("No active screen recording exists for this device");
    if (entry.panelId !== panelId) throw new Error("This recording belongs to another Flutter Tools panel");
    await this.stopEntry(entry);
  }

  async stopDevice(deviceId: string): Promise<void> {
    const entry = this.active.get(deviceId);
    if (entry) await this.stopEntry(entry);
  }

  async stopPanel(panelId: string): Promise<void> {
    await Promise.all([...this.active.values()].filter((entry) => entry.panelId === panelId).map((entry) => this.stopEntry(entry)));
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.active.values()].map((entry) => this.stopEntry(entry)));
  }

  private async launch(entry: RecordingEntry, createRecorder: StartCoordinatedRecordingOptions["createRecorder"]): Promise<void> {
    try {
      const recorder = await createRecorder(() => {
        if (this.active.get(entry.deviceId) !== entry) return;
        this.setSnapshot(entry, { ...entry.snapshot, state: "finalizing" });
      });
      entry.recorder = recorder;
      await recorder.start();
      if (this.active.get(entry.deviceId) !== entry) return;
      const startedAt = new Date().toISOString();
      this.setSnapshot(entry, { state: "recording", deviceId: entry.deviceId, startedAt, error: null, ownedByPanel: true });
      entry.settlement = recorder.completion.then(
        (result) => this.complete(entry, result),
        (error) => this.fail(entry, error),
      );
      if (entry.stopRequested) await this.stopEntry(entry);
    } catch (error) {
      await this.fail(entry, error);
      throw error;
    }
  }

  private async stopEntry(entry: RecordingEntry): Promise<void> {
    if (this.active.get(entry.deviceId) !== entry) return;
    entry.stopRequested = true;
    if (!entry.recorder) {
      await entry.ready.catch(() => {});
      if (this.active.get(entry.deviceId) !== entry || !entry.recorder) return;
    }
    this.setSnapshot(entry, { ...entry.snapshot, state: "stopping" });
    const timeoutMs = this.options.teardownTimeoutMs ?? DEFAULT_TEARDOWN_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        entry.recorder.stop().catch(() => {}).then(() => entry.settlement),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Recording teardown timed out after ${timeoutMs}ms`)), timeoutMs);
          timer.unref();
        }),
      ]);
    } catch (error) {
      entry.recorder.abort?.();
      await this.fail(entry, error);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async complete(entry: RecordingEntry, result: AndroidRecordingResult): Promise<void> {
    if (this.active.get(entry.deviceId) !== entry) return;
    this.setSnapshot(entry, { ...entry.snapshot, state: "finalizing" });
    try {
      await this.options.onComplete(entry.panelId, entry.deviceId, result, entry.snapshot.startedAt ?? new Date().toISOString());
      this.active.delete(entry.deviceId);
      this.setSnapshot(entry, idleSnapshot(entry.deviceId));
    } catch (error) {
      await this.fail(entry, error);
    }
  }

  private async fail(entry: RecordingEntry, error: unknown): Promise<void> {
    if (this.active.get(entry.deviceId) === entry) this.active.delete(entry.deviceId);
    this.setSnapshot(entry, { state: "failed", deviceId: entry.deviceId, startedAt: entry.snapshot.startedAt, error: errorMessage(error), ownedByPanel: true });
  }

  private setSnapshot(entry: RecordingEntry, snapshot: RecordingSnapshot): void {
    entry.snapshot = snapshot;
    this.lastByOwner.set(this.ownerKey(entry.panelId, entry.deviceId), snapshot);
    this.changed(entry);
  }

  private changed(entry: RecordingEntry): void {
    void Promise.resolve(this.options.onChange(entry.panelId, entry.deviceId, entry.snapshot)).catch(() => {});
  }

  private ownerKey(panelId: string, deviceId: string): string {
    return `${panelId}\0${deviceId}`;
  }
}
