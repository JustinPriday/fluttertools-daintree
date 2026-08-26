import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createManagedMediaPath,
  createRemoteRecordingPath,
  deleteMediaFile,
  isOwnedMediaPath,
  managedMediaDirectory,
  resolveMediaDestination,
} from "./storage.js";

const temporaryRoots: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "flutter-tools-media-"));
  temporaryRoots.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("managed media storage", () => {
  it("recognizes only direct PNG and MP4 children of the plugin-owned media directories", () => {
    const pluginId = "justinpriday.flutter-tools";
    const screenshot = path.join(managedMediaDirectory(pluginId, "screenshot"), "capture.png");
    const recording = path.join(managedMediaDirectory(pluginId, "recording"), "capture.mp4");
    expect(isOwnedMediaPath(pluginId, screenshot)).toBe(true);
    expect(isOwnedMediaPath(pluginId, recording)).toBe(true);
    expect(isOwnedMediaPath(pluginId, screenshot, "recording")).toBe(false);
    expect(isOwnedMediaPath(pluginId, path.join(path.dirname(screenshot), "nested", "capture.png"))).toBe(false);
    expect(isOwnedMediaPath(pluginId, recording.replace(/\.mp4$/, ".sh"))).toBe(false);
  });

  it("builds bounded safe host and device filenames from an untrusted device id", () => {
    const filePath = createManagedMediaPath("justinpriday.flutter-tools", "recording", "pixel; rm -rf /", new Date("2026-08-26T07:00:00.000Z"));
    expect(filePath).toContain(`${path.sep}recordings${path.sep}2026-08-26T07-00-00.000Z-pixel__rm_-rf__.mp4`);
    expect(createRemoteRecordingPath("id; unsafe/../token")).toBe("/sdcard/.flutter-tools-idunsafetoken.mp4");
  });

  it("chooses one collision-safe file in the selected save folder", async () => {
    const root = await temporaryDirectory();
    const saveDirectory = path.join(root, "captures");
    await mkdir(saveDirectory);
    const now = new Date("2026-08-26T07:00:00.000Z");
    const expectedName = "2026-08-26T07-00-00.000Z-pixel.mp4";
    await writeFile(path.join(saveDirectory, expectedName), "existing recording");

    const result = await resolveMediaDestination("justinpriday.flutter-tools", "recording", "pixel", saveDirectory, now);

    expect(result).toEqual({ filePath: path.join(await realpath(saveDirectory), "2026-08-26T07-00-00.000Z-pixel-1.mp4"), warning: null, storage: "configured" });
    expect(await readFile(path.join(saveDirectory, expectedName), "utf8")).toBe("existing recording");
    expect(await readFile(result.filePath)).toHaveLength(0);
  });

  it("atomically reserves distinct paths for concurrent same-timestamp captures", async () => {
    const root = await temporaryDirectory();
    const saveDirectory = path.join(root, "captures");
    await mkdir(saveDirectory);
    const now = new Date("2026-08-26T07:00:00.000Z");

    const destinations = await Promise.all(Array.from({ length: 8 }, () => resolveMediaDestination("justinpriday.flutter-tools", "screenshot", "pixel", saveDirectory, now)));

    expect(new Set(destinations.map((item) => item.filePath)).size).toBe(8);
    await Promise.all(destinations.map(async (item) => expect(await readFile(item.filePath)).toHaveLength(0)));
  });

  it("atomically reserves distinct private-storage paths for concurrent captures", async () => {
    const root = await temporaryDirectory();
    const managedDirectory = path.join(root, "managed");
    const now = new Date("2026-08-26T07:00:00.000Z");

    const destinations = await Promise.all(Array.from({ length: 8 }, () => resolveMediaDestination("justinpriday.flutter-tools", "screenshot", "pixel", "", now, managedDirectory)));

    expect(new Set(destinations.map((item) => item.filePath)).size).toBe(8);
    expect(destinations.every((item) => item.storage === "managed")).toBe(true);
  });

  it("falls back to one managed path with a warning when the save folder is unavailable", async () => {
    const root = await temporaryDirectory();
    const managedDirectory = path.join(root, "managed");
    const result = await resolveMediaDestination("justinpriday.flutter-tools", "screenshot", "pixel", path.join(root, "missing"), new Date("2026-08-26T07:00:00.000Z"), managedDirectory);

    expect(result.filePath).toBe(path.join(managedDirectory, path.basename(createManagedMediaPath("justinpriday.flutter-tools", "screenshot", "pixel", new Date("2026-08-26T07:00:00.000Z")))));
    expect(result.warning).toContain("saved in Flutter Tools storage");
    expect(result.storage).toBe("managed");
    expect(await readFile(result.filePath)).toHaveLength(0);
  });

  it.skipIf(process.platform === "win32")("falls back before capture when an existing save folder cannot create a file", async () => {
    const root = await temporaryDirectory();
    const saveDirectory = path.join(root, "read-only");
    const managedDirectory = path.join(root, "managed");
    await mkdir(saveDirectory);
    await chmod(saveDirectory, 0o500);
    try {
      const result = await resolveMediaDestination("justinpriday.flutter-tools", "screenshot", "pixel", saveDirectory, new Date("2026-08-26T07:00:00.000Z"), managedDirectory);
      expect(result.storage).toBe("managed");
      expect(result.warning).toContain("saved in Flutter Tools storage");
      expect(await readFile(result.filePath)).toHaveLength(0);
    } finally {
      await chmod(saveDirectory, 0o700);
    }
  });

  it("uses one managed path when no save folder is configured", async () => {
    const root = await temporaryDirectory();
    const managedDirectory = path.join(root, "managed");
    const now = new Date("2026-08-26T07:00:00.000Z");
    await expect(resolveMediaDestination("justinpriday.flutter-tools", "screenshot", "pixel", "", now, managedDirectory)).resolves.toEqual({ filePath: path.join(managedDirectory, path.basename(createManagedMediaPath("justinpriday.flutter-tools", "screenshot", "pixel", now))), warning: null, storage: "managed" });
  });

  it("deletes the selected single media file when requested", async () => {
    const root = await temporaryDirectory();
    const media = path.join(root, "capture.mp4");
    await writeFile(media, "recording");
    await deleteMediaFile(media);
    await expect(readFile(media)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
