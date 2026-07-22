import { describe, expect, it } from "vitest";
import { ConsoleBuffer } from "./consoleBuffer.js";

describe("ConsoleBuffer", () => {
  it("splits lines, classifies output, and keeps a bounded tail", () => {
    const buffer = new ConsoleBuffer(3, 1_000);
    buffer.append("stdout", "first\nwarning: second");
    buffer.append("stderr", "third\nfourth");
    expect(buffer.snapshot().map((line) => line.text)).toEqual(["warning: second", "third", "fourth"]);
    expect(buffer.snapshot().map((line) => line.level)).toEqual(["warning", "error", "error"]);
  });

  it("clears records without reusing record ids", () => {
    const buffer = new ConsoleBuffer();
    const first = buffer.append("tool", "one")[0]!;
    buffer.clear();
    const second = buffer.append("tool", "two")[0]!;
    expect(second.id).toBeGreaterThan(first.id);
  });
});
