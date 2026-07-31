import { spawn, type ChildProcess } from "node:child_process";

interface UninstallOptions {
  executable: string;
  projectPath: string;
  deviceId: string;
  mode: "debug" | "profile" | "release";
  extraArgs?: string[];
  timeoutMs?: number;
  onOutput?: (stream: "stdout" | "stderr", text: string) => void;
}

const FORWARDED_OPTIONS = new Set(["--flavor", "--device-user"]);

export function buildUninstallArguments(options: Pick<UninstallOptions, "deviceId" | "mode" | "extraArgs">): string[] {
  const args = ["install", "-d", options.deviceId, "--uninstall-only", `--${options.mode}`];
  const extra = options.extraArgs ?? [];
  for (let index = 0; index < extra.length; index += 1) {
    const argument = extra[index]!;
    const name = argument.split("=", 1)[0]!;
    if (!FORWARDED_OPTIONS.has(name)) continue;
    args.push(argument);
    if (!argument.includes("=") && extra[index + 1] && !extra[index + 1]!.startsWith("-")) args.push(extra[++index]!);
  }
  return args;
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch { child.kill(signal); }
}

export async function uninstallFlutterApp(options: UninstallOptions): Promise<void> {
  const args = buildUninstallArguments(options);
  const child = spawn(options.executable, args, {
    cwd: options.projectPath,
    env: process.env,
    detached: process.platform !== "win32",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (text: string) => options.onOutput?.("stdout", text));
  child.stderr?.on("data", (text: string) => options.onOutput?.("stderr", text));

  await new Promise<void>((resolve, reject) => {
    let timedOut = false;
    let forceTimer: ReturnType<typeof setTimeout> | null = null;
    const timeout = setTimeout(() => {
      timedOut = true;
      signalProcessTree(child, "SIGTERM");
      forceTimer = setTimeout(() => signalProcessTree(child, "SIGKILL"), 2_000);
    }, options.timeoutMs ?? 120_000);
    const finish = (): void => { clearTimeout(timeout); if (forceTimer) clearTimeout(forceTimer); };
    child.once("error", (error) => { finish(); reject(error); });
    child.once("exit", (code, signal) => {
      finish();
      if (timedOut) reject(new Error("Flutter uninstall timed out"));
      else if (code === 0) resolve();
      else reject(new Error(`Flutter uninstall exited with ${signal ?? code ?? "an unknown error"}`));
    });
  });
}
