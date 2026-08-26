import { describe, expect, it } from "vitest";
import { formatDuration, recordingControl } from "./presentation.js";

describe("formatDuration", () => {
  it("formats elapsed recording time without negative or fractional output", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(65.9)).toBe("1:05");
    expect(formatDuration(-4)).toBe("0:00");
    expect(formatDuration(3_605)).toBe("60:05");
  });
});

describe("recordingControl", () => {
  it("keeps recording unavailable on unsupported targets without affecting other controls", () => {
    expect(recordingControl({ deviceName: "macOS", platform: "darwin" })).toEqual({
      disabled: true, active: false, label: "Record", title: "Screen recording is available on Android devices",
    });
  });

  it("presents an elapsed Stop action only to the panel that owns the recording", () => {
    expect(recordingControl({ deviceName: "Pixel", platform: "android-arm64", state: "recording", ownedByPanel: true, elapsedSeconds: 65 })).toMatchObject({ disabled: false, active: true, label: "Stop 1:05" });
    expect(recordingControl({ deviceName: "Pixel", platform: "android-arm64", state: "recording", ownedByPanel: false })).toMatchObject({ disabled: true, active: false, title: "Recording is controlled by another Flutter Tools panel" });
  });

  it("disables transitional recording actions with clear status labels", () => {
    expect(recordingControl({ deviceName: "Pixel", platform: "android", state: "finalizing" })).toMatchObject({ disabled: true, active: true, label: "Saving…" });
  });
});
