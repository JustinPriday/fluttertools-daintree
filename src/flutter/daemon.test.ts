import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FLUTTER_DAEMON_ARGS, FlutterDaemon } from "./daemon.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((entry) => rm(entry, { recursive: true, force: true }))); });

describe("Flutter daemon invocation", () => {
  it("uses the daemon's intrinsic machine protocol without the run-only machine flag", () => {
    expect(FLUTTER_DAEMON_ARGS).toEqual(["daemon"]);
  });

  it.skipIf(process.platform === "win32")("terminates a daemon that stops answering requests", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "flutter-daemon-timeout-")); temporary.push(root);
    const executable = path.join(root, "flutter-fixture");
    await writeFile(executable, `#!/usr/bin/env node\nprocess.stdout.write('[{"event":"daemon.connected","params":{"version":"test"}}]\\n');process.on('SIGTERM',()=>{});setInterval(()=>{},1000);\n`);
    await chmod(executable, 0o755);
    const daemon = new FlutterDaemon(executable, 25);
    await expect(daemon.start()).rejects.toThrow("device.enable timed out");
    expect(daemon.running).toBe(false);
  }, 10_000);
});
