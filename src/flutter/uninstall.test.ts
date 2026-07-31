import { describe, expect, it } from "vitest";
import { buildUninstallArguments } from "./uninstall.js";

describe("Flutter uninstall arguments", () => {
  it("targets the selected device and preserves compatible launch selection", () => {
    expect(buildUninstallArguments({
      deviceId: "android-device; echo unsafe",
      mode: "debug",
      extraArgs: ["--dart-define=API=a b", "--flavor", "development", "--device-user=10"],
    })).toEqual([
      "install", "-d", "android-device; echo unsafe", "--uninstall-only", "--debug", "--flavor", "development", "--device-user=10",
    ]);
  });
});
