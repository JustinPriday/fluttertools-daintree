import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";

export interface MachineMessage { id?: number; method?: string; event?: string; params?: unknown; result?: unknown; error?: unknown }
export interface MachineProcessOptions { executable: string; args: string[]; cwd?: string; terminationGraceMs?: number }

export const DEFAULT_TERMINATION_GRACE_MS = 2_000;
const FORCE_KILL_WAIT_MS = 2_000;

export class FlutterMachineProcess extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private stdoutBuffer = "";
  private childExit: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly options: MachineProcessOptions) { super(); }

  get running(): boolean { return this.child !== null && this.child.exitCode === null; }

  start(): void {
    if (this.running) return;
    const child = spawn(this.options.executable, this.options.args, { cwd: this.options.cwd, env: process.env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.stdoutBuffer = "";
    let settled = false;
    this.childExit = new Promise((resolve) => {
      const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (settled) return;
        settled = true;
        if (this.child === child) this.child = null;
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error(`Flutter process exited (${signal ?? code ?? "unknown"})`));
        }
        this.pending.clear();
        this.emit("exit", code, signal);
        resolve();
      };
      child.once("error", (error) => {
        this.emit("processError", error);
        finish(null, null);
      });
      child.once("exit", finish);
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consume(chunk));
    child.stderr.on("data", (chunk: string) => this.emit("stderr", chunk));
  }

  request(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<unknown> {
    if (!this.child?.stdin.writable) return Promise.reject(new Error("Flutter process is not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child?.stdin.write(`${JSON.stringify([{ id, method, params }])}\n`);
    });
  }

  async close(method?: string, params: Record<string, unknown> = {}): Promise<void> {
    if (this.closePromise) return this.closePromise;
    const child = this.child;
    const childExit = this.childExit;
    if (!child || !childExit) return;

    const closing = this.closeChild(child, childExit, method, params);
    this.closePromise = closing;
    try {
      await closing;
    } finally {
      if (this.closePromise === closing) this.closePromise = null;
    }
  }

  private async closeChild(
    child: ChildProcessWithoutNullStreams,
    childExit: Promise<void>,
    method?: string,
    params: Record<string, unknown> = {},
  ): Promise<void> {
    if (method) {
      try { await this.request(method, params, 4_000); }
      catch { /* Continue with process termination. */ }
    }
    if (child.exitCode !== null || this.child !== child) {
      await childExit;
      return;
    }

    child.kill("SIGTERM");
    const exitedGracefully = await this.waitForExit(
      childExit,
      this.options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS,
    );
    if (exitedGracefully) return;

    child.kill("SIGKILL");
    if (!(await this.waitForExit(childExit, FORCE_KILL_WAIT_MS))) {
      throw new Error("Flutter process did not exit after SIGKILL");
    }
  }

  private async waitForExit(childExit: Promise<void>, timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        childExit.then(() => true),
        new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private consume(chunk: string): void {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) this.consumeLine(line);
  }

  private consumeLine(line: string): void {
    if (!line.trim()) return;
    let decoded: unknown;
    try { decoded = JSON.parse(line); } catch { this.emit("stdout", line); return; }
    const messages = Array.isArray(decoded) ? decoded : [decoded];
    for (const candidate of messages) {
      if (!candidate || typeof candidate !== "object") continue;
      const message = candidate as MachineMessage;
      if (typeof message.id === "number" && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id)!;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(typeof message.error === "string" ? message.error : JSON.stringify(message.error)));
        else pending.resolve(message.result);
      } else {
        this.emit("message", message);
      }
    }
  }
}
