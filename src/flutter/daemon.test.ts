import { describe, expect, it } from "vitest";
import { FLUTTER_DAEMON_ARGS } from "./daemon.js";

describe("Flutter daemon invocation", () => {
  it("uses the daemon's intrinsic machine protocol without the run-only machine flag", () => {
    expect(FLUTTER_DAEMON_ARGS).toEqual(["daemon"]);
  });
});
