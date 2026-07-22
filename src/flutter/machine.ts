import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";

export interface MachineMessage { id?: number; method?: string; event?: string; params?: unknown; result?: unknown; error?: unknown }
export interface MachineProcessOptions { executable: string; args: string[]; cwd?: string }

export class FlutterMachineProcess extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private stdoutBuffer = "";
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly options: MachineProcessOptions) { super(); }

  get running(): boolean { return this.child !== null && this.child.exitCode === null; }

  start(): void {
    if (this.running) return;
    const child = spawn(this.options.executable, this.options.args, { cwd: this.options.cwd, env: process.env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consume(chunk));
    child.stderr.on("data", (chunk: string) => this.emit("stderr", chunk));
    child.on("error", (error) => this.emit("processError", error));
    child.on("exit", (code, signal) => {
      this.child = null;
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(`Flutter process exited (${signal ?? code ?? "unknown"})`)); }
      this.pending.clear();
      this.emit("exit", code, signal);
    });
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
    const child = this.child;
    if (!child) return;
    if (method) { try { await this.request(method, params, 4_000); } catch { /* terminate below */ } }
    if (child.exitCode === null) child.kill("SIGTERM");
    this.child = null;
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
