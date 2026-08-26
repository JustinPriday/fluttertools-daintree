import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AndroidRecordingError,
  AndroidScreenRecorder,
  cleanupAndroidRecordingFile,
  resolveAdbExecutable,
  supportsAndroidRecording,
  type AndroidProcessSpawner,
} from "./androidRecording.js";

class FakeProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  killedWith: NodeJS.Signals | null = null;

  constructor(private readonly exitOnKill = true) {
    super();
    queueMicrotask(() => this.emit("spawn"));
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killedWith = signal;
    if (this.exitOnKill) this.finish(null, signal);
    return true;
  }

  finish(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    queueMicrotask(() => this.emit("exit", code, signal));
  }
}

const temporaryRoots: string[] = [];

function destination(): string {
  const root = mkdtempSync(path.join(tmpdir(), "flutter-tools-recording-"));
  temporaryRoots.push(root);
  return path.join(root, "recording.mp4");
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function successfulSpawner(calls: string[][], destinationPath: string): { spawner: AndroidProcessSpawner; recording: FakeProcess } {
  const recording = new FakeProcess();
  const spawner = vi.fn<AndroidProcessSpawner>((_executable, args) => {
    calls.push([...args]);
    if (args.some((arg) => arg.includes("screenrecord"))) {
      queueMicrotask(() => recording.stdout.write("4321\n"));
      return recording as never;
    }
    if (args.length === 3 && args[2] === "shell") {
      const control = new FakeProcess(false);
      control.stdin.on("data", (chunk) => {
        const command = chunk.toString();
        if (command.includes("kill -2 4321")) recording.finish(0);
        if (command.includes("exit")) control.finish(0);
      });
      return control as never;
    }
    const process = new FakeProcess();
    if (args.includes("kill")) recording.finish(130);
    if (args.includes("pull")) {
      mkdirSync(path.dirname(destinationPath), { recursive: true });
      writeFileSync(destinationPath, finalizedMp4());
    }
    queueMicrotask(() => process.finish(0));
    return process as never;
  });
  return { spawner, recording };
}

function mp4Box(type: string, payload: Uint8Array = new Uint8Array()): Buffer {
  const box = Buffer.alloc(8 + payload.length);
  box.writeUInt32BE(box.length, 0);
  box.write(type, 4, 4, "ascii");
  box.set(payload, 8);
  return box;
}

function finalizedMp4(): Buffer {
  const movieHeader = Buffer.alloc(20);
  movieHeader.writeUInt32BE(1_000, 12);
  movieHeader.writeUInt32BE(5_250, 16);
  return Buffer.concat([mp4Box("ftyp"), mp4Box("mdat"), mp4Box("moov", mp4Box("mvhd", movieHeader))]);
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} did not settle`)), 250); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe("Android screen recording", () => {
  it("resolves explicit and standard Android SDK locations before PATH", async () => {
    const checked: string[] = [];
    const executable = await resolveAdbExecutable({
      env: { ANDROID_SDK_ROOT: "/configured/sdk", PATH: "/path/bin" },
      userHome: "/Users/test",
      platform: "darwin",
      canExecute: async (candidate) => {
        checked.push(candidate);
        if (candidate !== "/Users/test/Library/Android/sdk/platform-tools/adb") throw new Error("missing");
      },
    });
    expect(executable).toBe("/Users/test/Library/Android/sdk/platform-tools/adb");
    expect(checked).toEqual([
      "/configured/sdk/platform-tools/adb",
      "/Users/test/Library/Android/sdk/platform-tools/adb",
    ]);
  });

  it("reports an actionable error when Android platform tools are unavailable", async () => {
    await expect(resolveAdbExecutable({ env: {}, userHome: "/Users/test", platform: "darwin", canExecute: async () => { throw new Error("missing"); } }))
      .rejects.toMatchObject({ name: "AndroidRecordingError", stage: "start", message: expect.stringContaining("ANDROID_SDK_ROOT") });
  });

  it("targets the selected serial with fixed arguments and finalizes on manual stop", async () => {
    const filePath = destination();
    const calls: string[][] = [];
    const { spawner, recording } = successfulSpawner(calls, filePath);
    const recorder = new AndroidScreenRecorder({
      adbExecutable: "/sdk/platform-tools/adb",
      deviceId: "pixel; echo unsafe",
      destinationPath: filePath,
      remotePath: "/sdcard/.flutter-tools-token.mp4",
      spawner,
    });

    await within(recorder.start(), "start");
    const result = await within(recorder.stop(), "stop");

    expect(recording.killedWith).toBeNull();
    expect(calls).toEqual([
      ["-s", "pixel; echo unsafe", "shell", 'screenrecord --bit-rate 4000000 --time-limit 180 /sdcard/.flutter-tools-token.mp4 & recorder_pid=$!; echo "$recorder_pid"; wait "$recorder_pid"'],
      ["-s", "pixel; echo unsafe", "shell"],
      ["-s", "pixel; echo unsafe", "pull", "/sdcard/.flutter-tools-token.mp4", filePath],
      ["-s", "pixel; echo unsafe", "shell", "rm", "-f", "/sdcard/.flutter-tools-token.mp4"],
    ]);
    expect(result).toEqual({ filePath, remotePath: "/sdcard/.flutter-tools-token.mp4", cleanupWarning: null, saveWarning: null, durationSeconds: 5.25 });
  });

  it("automatically transfers a recording when screenrecord reaches its duration limit", async () => {
    const filePath = destination();
    const calls: string[][] = [];
    const { spawner, recording } = successfulSpawner(calls, filePath);
    const recorder = new AndroidScreenRecorder({ adbExecutable: "/adb", deviceId: "pixel", destinationPath: filePath, remotePath: "/sdcard/.flutter-tools-auto.mp4", spawner });
    await recorder.start();

    recording.finish(0);

    await expect(recorder.completion).resolves.toMatchObject({ filePath });
    expect(calls.some((args) => args.includes("pull"))).toBe(true);
    expect(calls.some((args) => args.includes("rm"))).toBe(true);
  });

  it("retries transfer into one private reserved file when the configured destination becomes unusable", async () => {
    const configuredPath = destination();
    const fallbackPath = destination();
    writeFileSync(configuredPath, "");
    writeFileSync(fallbackPath, "");
    const recording = new FakeProcess();
    let pullCount = 0;
    const spawner = vi.fn<AndroidProcessSpawner>((_executable, args) => {
      if (args.some((arg) => arg.includes("screenrecord"))) {
        queueMicrotask(() => recording.stdout.write("4321\n"));
        return recording as never;
      }
      if (args.length === 3 && args[2] === "shell") {
        const control = new FakeProcess(false);
        control.stdin.on("data", (chunk) => {
          if (chunk.toString().includes("kill -2 4321")) recording.finish(0);
          if (chunk.toString().includes("exit")) control.finish(0);
        });
        return control as never;
      }
      const child = new FakeProcess();
      if (args.includes("pull")) {
        pullCount += 1;
        if (pullCount === 1) queueMicrotask(() => child.finish(1));
        else {
          writeFileSync(args.at(-1)!, finalizedMp4());
          queueMicrotask(() => child.finish(0));
        }
      } else queueMicrotask(() => child.finish(0));
      return child as never;
    });
    const recorder = new AndroidScreenRecorder({
      adbExecutable: "/adb",
      deviceId: "pixel",
      destinationPath: configuredPath,
      remotePath: "/sdcard/.flutter-tools-fallback.mp4",
      spawner,
      fallbackDestination: async () => ({ filePath: fallbackPath, warning: "Saved in Flutter Tools storage instead." }),
    });
    await recorder.start();

    const result = await recorder.stop();

    expect(result).toMatchObject({ filePath: fallbackPath, saveWarning: "Saved in Flutter Tools storage instead." });
    expect(() => statSync(configuredPath)).toThrow();
    expect(statSync(fallbackPath).size).toBeGreaterThan(0);
    expect(pullCount).toBe(2);
  });

  it("rejects and removes a non-empty MP4 that was pulled before Android finalized it", async () => {
    const filePath = destination();
    const calls: string[][] = [];
    const recording = new FakeProcess();
    const spawner = vi.fn<AndroidProcessSpawner>((_executable, args) => {
      calls.push([...args]);
      if (args.some((arg) => arg.includes("screenrecord"))) {
        queueMicrotask(() => recording.stdout.write("4321\n"));
        return recording as never;
      }
      if (args.length === 3 && args[2] === "shell") {
        const control = new FakeProcess(false);
        control.stdin.on("data", (chunk) => {
          const command = chunk.toString();
          if (command.includes("kill -2 4321")) recording.finish(0);
          if (command.includes("exit")) control.finish(0);
        });
        return control as never;
      }
      const process = new FakeProcess();
      if (args.includes("kill")) recording.finish(130);
      if (args.includes("pull")) writeFileSync(filePath, Buffer.concat([mp4Box("ftyp"), mp4Box("mdat")]));
      queueMicrotask(() => process.finish(0));
      return process as never;
    });
    const recorder = new AndroidScreenRecorder({ adbExecutable: "/adb", deviceId: "pixel", destinationPath: filePath, remotePath: "/sdcard/.flutter-tools-incomplete.mp4", spawner });
    await recorder.start();

    await expect(recorder.stop()).rejects.toMatchObject({ stage: "transfer", message: expect.stringContaining("incomplete MP4") });
    expect(() => statSync(filePath)).toThrow();
    expect(calls.some((args) => args.includes("rm"))).toBe(true);
  });

  it("differentiates recording failure and still attempts device cleanup", async () => {
    const filePath = destination();
    const calls: string[][] = [];
    const { spawner, recording } = successfulSpawner(calls, filePath);
    const recorder = new AndroidScreenRecorder({ adbExecutable: "/adb", deviceId: "pixel", destinationPath: filePath, remotePath: "/sdcard/.flutter-tools-fail.mp4", spawner });
    await recorder.start();
    recording.stderr.write("encoder unavailable");

    recording.finish(1);

    await expect(recorder.completion).rejects.toMatchObject({ name: "AndroidRecordingError", stage: "record", message: expect.stringContaining("encoder unavailable") });
    expect(calls.some((args) => args.includes("pull"))).toBe(false);
    expect(calls.some((args) => args.includes("rm"))).toBe(true);
  });

  it("validates Android support and generated device paths before spawning", () => {
    expect(supportsAndroidRecording("android-arm64")).toBe(true);
    expect(supportsAndroidRecording("ios")).toBe(false);
    expect(() => new AndroidScreenRecorder({ adbExecutable: "/adb", deviceId: "pixel", destinationPath: destination(), remotePath: "/sdcard/unowned.mp4" }))
      .toThrow(AndroidRecordingError);
  });

  it("refuses broad or non-plugin device cleanup paths before spawning ADB", async () => {
    const spawner = vi.fn<AndroidProcessSpawner>();
    await expect(cleanupAndroidRecordingFile("/adb", "pixel", "/sdcard/*.mp4", spawner))
      .rejects.toMatchObject({ stage: "cleanup", message: expect.stringContaining("Refusing") });
    expect(spawner).not.toHaveBeenCalled();
  });

  it("times out and terminates a hung ADB cleanup command", async () => {
    const hung = new FakeProcess(false);
    const spawner = vi.fn<AndroidProcessSpawner>(() => hung as never);

    await expect(cleanupAndroidRecordingFile("/adb", "pixel", "/sdcard/.flutter-tools-timeout.mp4", spawner, 10))
      .rejects.toMatchObject({ stage: "cleanup", message: expect.stringContaining("timed out") });
    expect(hung.killedWith).toBe("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 275));
    expect(hung.killedWith).toBe("SIGKILL");
  });

  it("bounds remote PID acquisition and terminates the stalled recording shell", async () => {
    const recording = new FakeProcess(false);
    const control = new FakeProcess(false);
    const spawner = vi.fn<AndroidProcessSpawner>((_executable, args) => args.some((arg) => arg.includes("screenrecord")) ? recording as never : control as never);
    const recorder = new AndroidScreenRecorder({ adbExecutable: "/adb", deviceId: "pixel", destinationPath: destination(), remotePath: "/sdcard/.flutter-tools-pid-timeout.mp4", spawner, operationTimeoutMs: 10 });
    await recorder.start();

    await expect(recorder.stop()).rejects.toMatchObject({ stage: "start", message: expect.stringContaining("process ID") });
    expect(recording.killedWith).toBe("SIGTERM");
    recorder.abort();
    expect(recording.killedWith).toBe("SIGKILL");
  });

  it("force-abort kills the known remote recorder with a bounded exact-PID command", async () => {
    const filePath = destination();
    writeFileSync(filePath, "");
    const calls: string[][] = [];
    const { spawner, recording } = successfulSpawner(calls, filePath);
    const recorder = new AndroidScreenRecorder({ adbExecutable: "/adb", deviceId: "pixel", destinationPath: filePath, remotePath: "/sdcard/.flutter-tools-abort.mp4", spawner, operationTimeoutMs: 50 });
    await recorder.start();
    await Promise.resolve();

    recorder.abort();
    await expect(recorder.completion).rejects.toMatchObject({ stage: "record", message: expect.stringContaining("aborted") });
    await Promise.resolve();

    expect(recording.killedWith).toBe("SIGKILL");
    expect(calls).toContainEqual(["-s", "pixel", "shell", "kill", "-9", "4321"]);
  });
});
