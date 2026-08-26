import { describe, expect, it, vi } from "vitest";
import type { AndroidRecordingResult } from "./androidRecording.js";
import {
  RecordingCoordinator,
  type CoordinatedRecorder,
} from "./recordingCoordinator.js";

const result: AndroidRecordingResult = {
  filePath: "/managed/recording.mp4",
  remotePath: "/sdcard/.flutter-tools-test.mp4",
  cleanupWarning: null,
  saveWarning: null,
  durationSeconds: 5.25,
};

class FakeRecorder implements CoordinatedRecorder {
  private resolveCompletion!: (value: AndroidRecordingResult) => void;
  private rejectCompletion!: (error: Error) => void;
  readonly completion = new Promise<AndroidRecordingResult>((resolve, reject) => {
    this.resolveCompletion = resolve;
    this.rejectCompletion = reject;
  });
  readonly start = vi.fn(async () => {});
  readonly stop = vi.fn(async () => {
    this.onFinalizing();
    this.resolveCompletion(result);
    return this.completion;
  });

  constructor(private readonly onFinalizing: () => void) {}

  finish(): void { this.onFinalizing(); this.resolveCompletion(result); }
  fail(message: string): void { this.rejectCompletion(new Error(message)); }
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("recording ownership and recovery", () => {
  it("allows only one panel to own a device and exposes recoverable remount state", async () => {
    const recorder = new FakeRecorder(() => {});
    const coordinator = new RecordingCoordinator({ onChange: vi.fn(), onComplete: vi.fn() });
    await coordinator.start({ panelId: "panel-a", deviceId: "pixel", createRecorder: async () => recorder });

    expect(coordinator.getSnapshot("panel-a", "pixel")).toMatchObject({ state: "recording", ownedByPanel: true });
    expect(coordinator.getSnapshot("panel-b", "pixel")).toMatchObject({ state: "recording", ownedByPanel: false });
    await expect(coordinator.start({ panelId: "panel-b", deviceId: "pixel", createRecorder: async () => new FakeRecorder(() => {}) }))
      .rejects.toThrow("another Flutter Tools panel");

    await coordinator.stop("panel-a", "pixel");
  });

  it("moves manual stop through finalization and records completion before returning idle", async () => {
    const snapshots: string[] = [];
    const completed = vi.fn();
    let recorder!: FakeRecorder;
    const coordinator = new RecordingCoordinator({
      onChange: (_panel, _device, snapshot) => { snapshots.push(snapshot.state); },
      onComplete: completed,
    });
    await coordinator.start({ panelId: "panel", deviceId: "pixel", createRecorder: async (onFinalizing) => (recorder = new FakeRecorder(onFinalizing)) });

    await coordinator.stop("panel", "pixel");

    expect(recorder.stop).toHaveBeenCalledOnce();
    expect(snapshots).toEqual(expect.arrayContaining(["starting", "recording", "stopping", "finalizing", "idle"]));
    expect(completed).toHaveBeenCalledWith("panel", "pixel", result, expect.any(String));
    expect(coordinator.getSnapshot("panel", "pixel").state).toBe("idle");
  });

  it("handles automatic duration completion without an explicit stop", async () => {
    const completed = vi.fn();
    let recorder!: FakeRecorder;
    const coordinator = new RecordingCoordinator({ onChange: vi.fn(), onComplete: completed });
    await coordinator.start({ panelId: "panel", deviceId: "pixel", createRecorder: async (onFinalizing) => (recorder = new FakeRecorder(onFinalizing)) });

    recorder.finish();
    await flush();

    expect(completed).toHaveBeenCalledOnce();
    expect(coordinator.getSnapshot("panel", "pixel").state).toBe("idle");
  });

  it("leaves a retryable failed state after an unexpected recorder failure", async () => {
    let first!: FakeRecorder;
    const coordinator = new RecordingCoordinator({ onChange: vi.fn(), onComplete: vi.fn() });
    await coordinator.start({ panelId: "panel", deviceId: "pixel", createRecorder: async (onFinalizing) => (first = new FakeRecorder(onFinalizing)) });

    first.fail("device disconnected");
    await flush();

    expect(coordinator.getSnapshot("panel", "pixel")).toMatchObject({ state: "failed", error: "device disconnected" });
    await expect(coordinator.start({ panelId: "panel", deviceId: "pixel", createRecorder: async (onFinalizing) => new FakeRecorder(onFinalizing) })).resolves.toBeUndefined();
    expect(coordinator.getSnapshot("panel", "pixel").state).toBe("recording");
    await coordinator.stopPanel("panel");
  });

  it("stops every owned process during panel and plugin teardown", async () => {
    const recorders: FakeRecorder[] = [];
    const coordinator = new RecordingCoordinator({ onChange: vi.fn(), onComplete: vi.fn() });
    const start = async (panelId: string, deviceId: string): Promise<void> => coordinator.start({ panelId, deviceId, createRecorder: async (onFinalizing) => {
      const recorder = new FakeRecorder(onFinalizing);
      recorders.push(recorder);
      return recorder;
    } });
    await Promise.all([start("panel-a", "pixel-a"), start("panel-b", "pixel-b")]);

    await coordinator.stopPanel("panel-a");
    expect(recorders[0]!.stop).toHaveBeenCalledOnce();
    expect(recorders[1]!.stop).not.toHaveBeenCalled();

    await coordinator.dispose();
    expect(recorders[1]!.stop).toHaveBeenCalledOnce();
  });

  it("stops and finalizes the matching device when discovery reports a disconnect", async () => {
    let recorder!: FakeRecorder;
    const coordinator = new RecordingCoordinator({ onChange: vi.fn(), onComplete: vi.fn() });
    await coordinator.start({ panelId: "panel", deviceId: "pixel", createRecorder: async (onFinalizing) => (recorder = new FakeRecorder(onFinalizing)) });

    await coordinator.stopDevice("pixel");

    expect(recorder.stop).toHaveBeenCalledOnce();
    expect(coordinator.getSnapshot("panel", "pixel").state).toBe("idle");
  });

  it("bounds panel teardown and aborts a recorder whose stop never settles", async () => {
    const completion = new Promise<AndroidRecordingResult>(() => {});
    const recorder: CoordinatedRecorder = {
      start: vi.fn(async () => {}),
      stop: vi.fn(() => new Promise<AndroidRecordingResult>(() => {})),
      abort: vi.fn(),
      completion,
    };
    const coordinator = new RecordingCoordinator({ onChange: vi.fn(), onComplete: vi.fn(), teardownTimeoutMs: 10 });
    await coordinator.start({ panelId: "panel", deviceId: "pixel", createRecorder: async () => recorder });

    await coordinator.stopPanel("panel");

    expect(recorder.abort).toHaveBeenCalledOnce();
    expect(coordinator.getSnapshot("panel", "pixel")).toMatchObject({ state: "failed", error: expect.stringContaining("timed out") });
  });
});
