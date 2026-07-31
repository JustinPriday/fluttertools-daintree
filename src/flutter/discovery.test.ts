import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverFlutterDevices, discoverFlutterProjects, resolveFlutterExecutable } from "./discovery.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((entry) => rm(entry, { recursive: true, force: true }))); });

describe("Flutter discovery", () => {
  it("finds root and nested Flutter apps while ignoring generated trees", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "flutter-tools-discovery-")); temporary.push(root);
    await writeFile(path.join(root, "pubspec.yaml"), "name: root_app\ndependencies:\n  flutter:\n    sdk: flutter\n");
    await mkdir(path.join(root, "packages", "mobile"), { recursive: true });
    await writeFile(path.join(root, "packages", "mobile", "pubspec.yaml"), "name: mobile\nenvironment:\n  sdk: ^3.0.0\ndependencies:\n  flutter:\n    sdk: flutter\n");
    await mkdir(path.join(root, "build", "fake"), { recursive: true });
    await writeFile(path.join(root, "build", "fake", "pubspec.yaml"), "name: ignored\nflutter:\n");
    const projects = await discoverFlutterProjects(root, 5);
    expect(projects.map((project) => project.relativePath)).toEqual([".", path.join("packages", "mobile")]);
    expect(projects.map((project) => project.name)).toEqual(["root_app", "mobile"]);
  });

  it("prefers the configured SDK over FVM and PATH", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "flutter-tools-sdk-")); temporary.push(root);
    const sdk = path.join(root, "sdk"); await mkdir(path.join(sdk, "bin"), { recursive: true });
    await writeFile(path.join(sdk, "bin", "flutter"), "");
    await expect(resolveFlutterExecutable(root, sdk)).resolves.toEqual({ executable: path.join(sdk, "bin", "flutter"), source: "setting" });
  });

  it.skipIf(process.platform === "win32")("discovers devices through the one-shot machine command", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "flutter-tools-devices-")); temporary.push(root);
    const executable = path.join(root, "flutter-fixture");
    const payload = [{ name: "Pixel", id: "pixel", isSupported: true, targetPlatform: "android-arm64", emulator: false, sdk: "Android 16", capabilities: { hotReload: true, hotRestart: true, screenshot: true } }];
    await writeFile(executable, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(payload))});\n`);
    await chmod(executable, 0o755);
    await expect(discoverFlutterDevices(executable)).resolves.toEqual([
      expect.objectContaining({ id: "pixel", name: "Pixel", platform: "android-arm64", sdk: "Android 16" }),
    ]);
  });
});
