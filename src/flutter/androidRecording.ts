import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const DEFAULT_BIT_RATE = 4_000_000;
const DEFAULT_TIME_LIMIT_SECONDS = 180;
const MAX_ERROR_OUTPUT = 64 * 1024;
const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;
const FORCE_KILL_GRACE_MS = 250;

export type AndroidRecordingStage = "start" | "record" | "transfer" | "cleanup";

export class AndroidRecordingError extends Error {
  constructor(
    public readonly stage: AndroidRecordingStage,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AndroidRecordingError";
  }
}

export interface AndroidRecordingResult {
  filePath: string;
  remotePath: string;
  cleanupWarning: string | null;
  saveWarning: string | null;
  durationSeconds: number;
}

interface SpawnedProcess extends ChildProcess {
  stdin: NonNullable<ChildProcess["stdin"]>;
  stdout: NonNullable<ChildProcess["stdout"]>;
  stderr: NonNullable<ChildProcess["stderr"]>;
}

export type AndroidProcessSpawner = (
  executable: string,
  args: readonly string[],
) => SpawnedProcess;

const defaultSpawner: AndroidProcessSpawner = (executable, args) => spawn(executable, [...args], {
  env: process.env,
  shell: false,
  stdio: ["pipe", "pipe", "pipe"],
}) as SpawnedProcess;

function appendBounded(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString();
  return next.length <= MAX_ERROR_OUTPUT ? next : next.slice(-MAX_ERROR_OUTPUT);
}

function processDetail(stderr: string, fallback: string): string {
  return stderr.replace(/\s+/g, " ").trim() || fallback;
}

async function unlinkIfPresent(filePath: string): Promise<void> {
  try { await unlink(filePath); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

function terminateChild(child: SpawnedProcess): void {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const forceTimer = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, FORCE_KILL_GRACE_MS);
  forceTimer.unref();
  child.once("exit", () => clearTimeout(forceTimer));
}

function readRemotePid(child: SpawnedProcess, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let stdout = "";
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const finish = (error: Error | null, pid?: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error); else resolve(pid!);
    };
    const onData = (chunk: Buffer | string): void => {
      stdout = appendBounded(stdout, chunk);
      const firstLine = stdout.split(/\r?\n/, 1)[0]?.trim();
      if (/^[1-9]\d*$/.test(firstLine)) finish(null, firstLine);
    };
    const onError = (error: Error): void => finish(new AndroidRecordingError("start", `ADB screen recording could not start: ${error.message}`, { cause: error }));
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => finish(new AndroidRecordingError("start", `Android screen recorder exited before reporting its process ID (${signal ?? code ?? "unknown"})`));
    const timer = setTimeout(() => {
      terminateChild(child);
      finish(new AndroidRecordingError("start", `Android screen recorder did not report its process ID within ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();
    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

interface Mp4Box { type: string; start: number; size: number; headerSize: number }

function readMp4Boxes(bytes: Buffer, start = 0, end = bytes.length): Mp4Box[] | null {
  const boxes: Mp4Box[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > end) return null;
      const extended = bytes.readBigUInt64BE(offset + 8);
      if (extended > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      size = Number(extended);
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < headerSize || offset + size > end) return null;
    boxes.push({ type, start: offset, size, headerSize });
    offset += size;
  }
  return offset === end ? boxes : null;
}

export function finalizedMp4DurationSeconds(bytes: Buffer): number | null {
  const topLevel = readMp4Boxes(bytes);
  if (!topLevel || !topLevel.some((box) => box.type === "ftyp") || !topLevel.some((box) => box.type === "mdat")) return null;
  const moov = topLevel.find((box) => box.type === "moov");
  if (!moov) return null;
  const children = readMp4Boxes(bytes, moov.start + moov.headerSize, moov.start + moov.size);
  const mvhd = children?.find((box) => box.type === "mvhd");
  if (!mvhd) return null;
  const payload = mvhd.start + mvhd.headerSize;
  if (payload + 20 > mvhd.start + mvhd.size) return null;
  const version = bytes[payload];
  let timescale: number;
  let duration: number;
  if (version === 0) {
    timescale = bytes.readUInt32BE(payload + 12);
    duration = bytes.readUInt32BE(payload + 16);
  } else if (version === 1) {
    if (payload + 32 > mvhd.start + mvhd.size) return null;
    timescale = bytes.readUInt32BE(payload + 20);
    const extendedDuration = bytes.readBigUInt64BE(payload + 24);
    if (extendedDuration > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    duration = Number(extendedDuration);
  } else return null;
  if (!timescale || duration <= 0) return null;
  const seconds = duration / timescale;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

export function isFinalizedMp4(bytes: Buffer): boolean {
  return finalizedMp4DurationSeconds(bytes) !== null;
}

async function runAdbCommand(
  spawner: AndroidProcessSpawner,
  executable: string,
  args: readonly string[],
  stage: AndroidRecordingStage,
  timeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawner(executable, args);
    let stderr = "";
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    child.stderr.on("data", (chunk) => { stderr = appendBounded(stderr, chunk); });
    child.once("error", (error) => {
      finish(new AndroidRecordingError(stage, `ADB could not start: ${error.message}`, { cause: error }));
    });
    child.once("exit", (code, signal) => {
      if (code === 0) finish();
      else finish(new AndroidRecordingError(stage, processDetail(stderr, `ADB exited (${signal ?? code ?? "unknown"})`)));
    });
    const timer = setTimeout(() => {
      terminateChild(child);
      finish(new AndroidRecordingError(stage, `ADB operation timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();
  });
}

export async function cleanupAndroidRecordingFile(
  adbExecutable: string,
  deviceId: string,
  remotePath: string,
  spawner: AndroidProcessSpawner = defaultSpawner,
  timeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
): Promise<void> {
  if (!/^\/sdcard\/\.flutter-tools-[a-zA-Z0-9._-]+\.mp4$/.test(remotePath)) {
    throw new AndroidRecordingError("cleanup", "Refusing to clean an unowned Android recording path");
  }
  await runAdbCommand(spawner, adbExecutable, ["-s", deviceId, "shell", "rm", "-f", remotePath], "cleanup", timeoutMs);
}

function pathCandidates(env: NodeJS.ProcessEnv, userHome: string, platform: NodeJS.Platform): string[] {
  const executableName = platform === "win32" ? "adb.exe" : "adb";
  const sdkRoots = [env.ANDROID_SDK_ROOT, env.ANDROID_HOME].filter((value): value is string => Boolean(value));
  if (platform === "darwin") sdkRoots.push(path.join(userHome, "Library", "Android", "sdk"));
  else if (platform === "win32" && env.LOCALAPPDATA) sdkRoots.push(path.join(env.LOCALAPPDATA, "Android", "Sdk"));
  else sdkRoots.push(path.join(userHome, "Android", "Sdk"));

  const candidates = sdkRoots.map((root) => path.join(root, "platform-tools", executableName));
  for (const directory of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    candidates.push(path.join(directory, executableName));
  }
  return [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
}

export async function resolveAdbExecutable(options: {
  env?: NodeJS.ProcessEnv;
  userHome?: string;
  platform?: NodeJS.Platform;
  canExecute?: (candidate: string) => Promise<void>;
} = {}): Promise<string> {
  const env = options.env ?? process.env;
  const userHome = options.userHome ?? homedir();
  const platform = options.platform ?? process.platform;
  const canExecute = options.canExecute ?? ((candidate: string) => access(candidate, constants.X_OK));
  const candidates = pathCandidates(env, userHome, platform);
  for (const candidate of candidates) {
    try {
      await canExecute(candidate);
      return candidate;
    } catch {
      // Continue through explicit SDK locations, standard locations, then PATH.
    }
  }
  throw new AndroidRecordingError(
    "start",
    "Android platform tools were not found. Install Android SDK Platform-Tools or set ANDROID_SDK_ROOT/ANDROID_HOME, then retry.",
  );
}

export function supportsAndroidRecording(platform: string): boolean {
  return platform.toLowerCase().startsWith("android");
}

export interface AndroidScreenRecorderOptions {
  adbExecutable: string;
  deviceId: string;
  destinationPath: string;
  remotePath: string;
  bitRate?: number;
  timeLimitSeconds?: number;
  spawner?: AndroidProcessSpawner;
  onFinalizing?: () => void;
  operationTimeoutMs?: number;
  fallbackDestination?: () => Promise<{ filePath: string; warning: string | null }>;
}

export class AndroidScreenRecorder {
  private readonly spawner: AndroidProcessSpawner;
  private process: SpawnedProcess | null = null;
  private completionPromise: Promise<AndroidRecordingResult> | null = null;
  private remotePidPromise: Promise<string> | null = null;
  private controlProcess: SpawnedProcess | null = null;
  private stopRequested = false;
  private aborted = false;

  constructor(private readonly options: AndroidScreenRecorderOptions) {
    if (!options.deviceId.trim()) throw new AndroidRecordingError("start", "Android device ID is required");
    if (!path.isAbsolute(options.destinationPath)) throw new AndroidRecordingError("start", "Recording destination must be absolute");
    if (!/^\/sdcard\/\.flutter-tools-[a-zA-Z0-9._-]+\.mp4$/.test(options.remotePath)) {
      throw new AndroidRecordingError("start", "Recording device path is not a valid Flutter Tools temporary path");
    }
    const bitRate = options.bitRate ?? DEFAULT_BIT_RATE;
    const timeLimit = options.timeLimitSeconds ?? DEFAULT_TIME_LIMIT_SECONDS;
    if (!Number.isInteger(bitRate) || bitRate < 100_000) throw new AndroidRecordingError("start", "Recording bit rate is invalid");
    if (!Number.isInteger(timeLimit) || timeLimit < 1 || timeLimit > DEFAULT_TIME_LIMIT_SECONDS) {
      throw new AndroidRecordingError("start", "Recording time limit must be between 1 and 180 seconds");
    }
    this.spawner = options.spawner ?? defaultSpawner;
  }

  get running(): boolean { return this.process !== null && this.process.exitCode === null; }
  get completion(): Promise<AndroidRecordingResult> {
    if (!this.completionPromise) return Promise.reject(new AndroidRecordingError("start", "Recording has not started"));
    return this.completionPromise;
  }

  async start(): Promise<void> {
    if (this.completionPromise) throw new AndroidRecordingError("start", "Recording has already started");
    await mkdir(path.dirname(this.options.destinationPath), { recursive: true });
    const remoteCommand = `screenrecord --bit-rate ${this.options.bitRate ?? DEFAULT_BIT_RATE} --time-limit ${this.options.timeLimitSeconds ?? DEFAULT_TIME_LIMIT_SECONDS} ${this.options.remotePath} & recorder_pid=$!; echo "$recorder_pid"; wait "$recorder_pid"`;
    const args = ["-s", this.options.deviceId, "shell", remoteCommand];
    const child = this.spawner(this.options.adbExecutable, args);
    this.process = child;
    this.remotePidPromise = readRemotePid(child, this.options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS);
    void this.remotePidPromise.catch(() => {});
    const control = this.spawner(this.options.adbExecutable, ["-s", this.options.deviceId, "shell"]);
    this.controlProcess = control;
    control.stdout.on("data", () => {});
    control.stderr.on("data", () => {});
    control.once("error", () => { if (this.controlProcess === control) this.controlProcess = null; });
    control.once("exit", () => { if (this.controlProcess === control) this.controlProcess = null; });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr = appendBounded(stderr, chunk); });
    this.completionPromise = new Promise<AndroidRecordingResult>((resolve, reject) => {
      let settled = false;
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        if (this.process === child) this.process = null;
        this.closeControlProcess();
        void this.cleanupLocal().then(() => this.cleanupRemote()).finally(() => reject(new AndroidRecordingError("start", `ADB screen recording could not start: ${error.message}`, { cause: error })));
      });
      child.once("exit", (code, signal) => {
        if (settled) return;
        settled = true;
        if (this.process === child) this.process = null;
        this.closeControlProcess();
        if (this.aborted) {
          void this.cleanupLocal().then(() => this.cleanupRemote()).finally(() => reject(new AndroidRecordingError("record", "Android screen recording was aborted after its teardown deadline")));
          return;
        }
        if (code !== 0 && !this.stopRequested) {
          const detail = processDetail(stderr, `screenrecord exited (${signal ?? code ?? "unknown"})`);
          void this.cleanupLocal().then(() => this.cleanupRemote()).finally(() => reject(new AndroidRecordingError("record", `Android screen recording failed: ${detail}`)));
          return;
        }
        this.options.onFinalizing?.();
        void this.transferAndCleanup().then(resolve, reject);
      });
    });

    // `spawn()` returns only after Node has created the child handle. Startup
    // errors arrive asynchronously through `completion`, which lets callers
    // publish a starting state without racing a very fast child exit.
  }

  async stop(): Promise<AndroidRecordingResult> {
    if (!this.completionPromise) throw new AndroidRecordingError("start", "Recording has not started");
    this.stopRequested = true;
    const process = this.process;
    if (process && process.exitCode === null) {
      if (!this.remotePidPromise) throw new AndroidRecordingError("start", "Android recorder process ID is unavailable");
      const remotePid = await this.remotePidPromise;
      if (process.exitCode === null) {
        await this.signalRemoteProcess(remotePid);
      }
    }
    return this.completionPromise;
  }

  abort(): void {
    this.aborted = true;
    this.stopRequested = true;
    const remotePid = this.remotePidPromise;
    if (remotePid) {
      void remotePid.then((pid) => runAdbCommand(
        this.spawner,
        this.options.adbExecutable,
        ["-s", this.options.deviceId, "shell", "kill", "-9", pid],
        "cleanup",
        this.options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
      )).catch(() => {}).finally(() => { void this.cleanupRemote(); });
    }
    if (this.process && this.process.exitCode === null) this.process.kill("SIGKILL");
    if (this.controlProcess && this.controlProcess.exitCode === null) this.controlProcess.kill("SIGKILL");
    this.controlProcess = null;
  }

  private async signalRemoteProcess(remotePid: string): Promise<void> {
    const control = this.controlProcess;
    if (!control || control.exitCode !== null || control.stdin.destroyed || !control.stdin.writable) {
      await runAdbCommand(this.spawner, this.options.adbExecutable, ["-s", this.options.deviceId, "shell", "kill", "-2", remotePid], "record", this.options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS);
      return;
    }
    this.controlProcess = null;
    const timeoutMs = this.options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          terminateChild(control);
          reject(new AndroidRecordingError("record", `ADB control channel timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref();
        control.stdin.end(`kill -2 ${remotePid}\nexit\n`, (error?: Error | null) => {
          clearTimeout(timer);
          if (error) reject(new AndroidRecordingError("record", `ADB control channel failed: ${error.message}`, { cause: error }));
          else resolve();
        });
      });
    } catch {
      await runAdbCommand(this.spawner, this.options.adbExecutable, ["-s", this.options.deviceId, "shell", "kill", "-2", remotePid], "record", timeoutMs);
    }
  }

  private closeControlProcess(): void {
    const control = this.controlProcess;
    if (!control) return;
    this.controlProcess = null;
    if (control.exitCode === null && !control.stdin.destroyed && control.stdin.writable) control.stdin.end("exit\n");
    const timer = setTimeout(() => terminateChild(control), FORCE_KILL_GRACE_MS);
    timer.unref();
    control.once("exit", () => clearTimeout(timer));
  }

  private async transferAndCleanup(): Promise<AndroidRecordingResult> {
    let transferError: unknown = null;
    let durationSeconds = 0;
    let destinationPath = this.options.destinationPath;
    let saveWarning: string | null = null;
    try {
      try {
        await runAdbCommand(this.spawner, this.options.adbExecutable, ["-s", this.options.deviceId, "pull", this.options.remotePath, destinationPath], "transfer", this.options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS);
      } catch (error) {
        if (!this.options.fallbackDestination) throw error;
        await unlinkIfPresent(destinationPath);
        const fallback = await this.options.fallbackDestination();
        destinationPath = fallback.filePath;
        saveWarning = fallback.warning;
        await runAdbCommand(this.spawner, this.options.adbExecutable, ["-s", this.options.deviceId, "pull", this.options.remotePath, destinationPath], "transfer", this.options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS);
      }
      const details = await stat(destinationPath);
      if (!details.isFile() || details.size === 0) throw new AndroidRecordingError("transfer", "ADB transferred an empty recording");
      const parsedDuration = finalizedMp4DurationSeconds(await readFile(destinationPath));
      if (parsedDuration === null) {
        throw new AndroidRecordingError("transfer", "Android produced an incomplete MP4; the recording was not added to Media");
      }
      durationSeconds = parsedDuration;
    } catch (error) {
      transferError = error;
      await unlink(destinationPath).catch(() => {});
    }
    const cleanupWarning = await this.cleanupRemote();
    if (transferError) {
      const message = transferError instanceof Error ? transferError.message : String(transferError);
      throw new AndroidRecordingError("transfer", cleanupWarning ? `${message}. ${cleanupWarning}` : message, { cause: transferError });
    }
    return { filePath: destinationPath, remotePath: this.options.remotePath, cleanupWarning, saveWarning, durationSeconds };
  }

  private async cleanupLocal(): Promise<void> {
    await unlink(this.options.destinationPath).catch(() => {});
  }

  private async cleanupRemote(): Promise<string | null> {
    try {
      await cleanupAndroidRecordingFile(this.options.adbExecutable, this.options.deviceId, this.options.remotePath, this.spawner, this.options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS);
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `The recording was retained, but its temporary device file could not be removed: ${message}`;
    }
  }
}
