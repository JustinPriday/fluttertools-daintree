import { describe, expect, it } from "vitest";
import { buildRunArguments } from "./runSession.js";

describe("Flutter run arguments", () => {
  it("builds an argv array without shell interpolation", () => {
    expect(buildRunArguments({ deviceId: "ios device; echo unsafe", mode: "profile", entrypoint: "lib/dev main.dart", extraArgs: ["--dart-define=API=a b"] })).toEqual([
      "run", "--machine", "-d", "ios device; echo unsafe", "--profile", "-t", "lib/dev main.dart", "--dart-define=API=a b",
    ]);
  });
});
