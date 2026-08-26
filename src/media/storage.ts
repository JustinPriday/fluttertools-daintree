import { mkdir, open, realpath, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export type MediaKind = "screenshot" | "recording";

const MEDIA_LAYOUT: Record<MediaKind, { directory: string; extension: ".png" | ".mp4" }> = {
  screenshot: { directory: "screenshots", extension: ".png" },
  recording: { directory: "recordings", extension: ".mp4" },
};

export interface MediaDestination {
  filePath: string;
  warning: string | null;
  storage: "configured" | "managed";
}

async function unlinkIfPresent(filePath: string): Promise<void> {
  try { await unlink(path.resolve(filePath)); }
  catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error; }
}

export async function deleteMediaFile(filePath: string): Promise<void> {
  await unlinkIfPresent(filePath);
}

export function managedMediaDirectory(pluginId: string, kind: MediaKind): string {
  return path.resolve(homedir(), ".daintree", "plugin-data", pluginId, MEDIA_LAYOUT[kind].directory);
}

export function isOwnedMediaPath(pluginId: string, filePath: string, expectedKind?: MediaKind): boolean {
  const resolved = path.resolve(filePath);
  const kinds: MediaKind[] = expectedKind ? [expectedKind] : ["screenshot", "recording"];
  return kinds.some((kind) => {
    const layout = MEDIA_LAYOUT[kind];
    return path.dirname(resolved) === managedMediaDirectory(pluginId, kind)
      && path.extname(resolved).toLowerCase() === layout.extension;
  });
}

function safeDeviceId(deviceId: string): string {
  return deviceId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "device";
}

export function createManagedMediaPath(
  pluginId: string,
  kind: MediaKind,
  deviceId: string,
  now = new Date(),
): string {
  const layout = MEDIA_LAYOUT[kind];
  const timestamp = now.toISOString().replaceAll(":", "-");
  return path.join(managedMediaDirectory(pluginId, kind), `${timestamp}-${safeDeviceId(deviceId)}${layout.extension}`);
}

export function createRemoteRecordingPath(token: string): string {
  const safeToken = token.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
  if (!safeToken) throw new Error("Recording token must contain a safe filename character");
  return `/sdcard/.flutter-tools-${safeToken}.mp4`;
}

async function reserveUniqueSavePath(directory: string, filename: string): Promise<string> {
  const extension = path.extname(filename);
  const stem = path.basename(filename, extension);
  for (let suffix = 0; suffix < 10_000; suffix += 1) {
    const candidate = path.join(directory, suffix === 0 ? filename : `${stem}-${suffix}${extension}`);
    try {
      const handle = await open(candidate, "wx", 0o600);
      await handle.close();
      return candidate;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error("Could not choose an unused capture filename");
}

export async function reserveManagedMediaDestination(
  pluginId: string,
  kind: MediaKind,
  deviceId: string,
  warning: string | null,
  now = new Date(),
  managedDirectory = managedMediaDirectory(pluginId, kind),
): Promise<MediaDestination> {
  await mkdir(managedDirectory, { recursive: true });
  const filename = path.basename(createManagedMediaPath(pluginId, kind, deviceId, now));
  return { filePath: await reserveUniqueSavePath(managedDirectory, filename), warning, storage: "managed" };
}

export async function resolveMediaDestination(
  pluginId: string,
  kind: MediaKind,
  deviceId: string,
  configuredDirectory: unknown,
  now = new Date(),
  managedDirectory = managedMediaDirectory(pluginId, kind),
): Promise<MediaDestination> {
  if (typeof configuredDirectory !== "string" || configuredDirectory.trim() === "") {
    return reserveManagedMediaDestination(pluginId, kind, deviceId, null, now, managedDirectory);
  }
  if (!path.isAbsolute(configuredDirectory)) {
    return reserveManagedMediaDestination(pluginId, kind, deviceId, "Capture save folder must be an absolute path. The capture was saved in Flutter Tools storage.", now, managedDirectory);
  }
  try {
    const directory = await realpath(configuredDirectory);
    const details = await stat(directory);
    if (!details.isDirectory()) throw new Error("the configured path is not a directory");
    const filename = path.basename(createManagedMediaPath(pluginId, kind, deviceId, now));
    return { filePath: await reserveUniqueSavePath(directory, filename), warning: null, storage: "configured" };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return reserveManagedMediaDestination(pluginId, kind, deviceId, `Could not use the capture save folder (${detail}). The capture was saved in Flutter Tools storage.`, now, managedDirectory);
  }
}

export async function ensureManagedMediaDirectory(pluginId: string, kind: MediaKind): Promise<string> {
  const directory = managedMediaDirectory(pluginId, kind);
  await mkdir(directory, { recursive: true });
  return directory;
}
