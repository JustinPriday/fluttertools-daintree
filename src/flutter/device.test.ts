import { describe, expect, it } from "vitest";
import { parseFlutterDeviceList, supportsAppReinstall } from "./device.js";

describe("Flutter device payloads", () => {
  it("limits app reinstall to mobile device platforms", () => {
    expect(supportsAppReinstall({ platform: "android-arm64" })).toBe(true);
    expect(supportsAppReinstall({ platform: "ios" })).toBe(true);
    expect(supportsAppReinstall({ platform: "darwin-arm64" })).toBe(false);
    expect(supportsAppReinstall({ platform: "web-javascript" })).toBe(false);
  });
  it("accepts daemon and one-shot platform field names", () => {
    const devices = parseFlutterDeviceList([
      { id: "daemon", name: "Daemon", platform: "darwin", emulator: false, capabilities: {} },
      { id: "cli", name: "CLI", targetPlatform: "web-javascript", emulator: false, capabilities: {} },
    ]);
    expect(devices.map(({ id, platform }) => ({ id, platform }))).toEqual([
      { id: "cli", platform: "web-javascript" },
      { id: "daemon", platform: "darwin" },
    ]);
  });

  it("drops malformed device entries", () => {
    expect(parseFlutterDeviceList([{ name: "missing id" }, null])).toEqual([]);
  });
});
