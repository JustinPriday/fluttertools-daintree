import { describe, expect, it } from "vitest";
import { ConsoleBuffer, consoleBatches } from "./consoleBuffer.js";
import { CONSOLE_PAYLOAD_BUDGET, payloadBytes, PUSH_PAYLOAD_BUDGET } from "./transport.js";

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

  it("keeps verbose history under the transport budget including record metadata", () => {
    const buffer = new ConsoleBuffer();
    for (let index = 0; index < 5000; index++) buffer.append("stdout", "x".repeat(150));
    const records = buffer.snapshot();
    expect(payloadBytes(records)).toBeLessThanOrEqual(CONSOLE_PAYLOAD_BUDGET);
    expect(records.at(-1)?.id).toBe(4999);
    expect(records.length).toBeLessThan(5000);
  });

  it("bounds individual Unicode lines and partitions a large output burst into ordered batches", () => {
    const buffer = new ConsoleBuffer();
    const created = buffer.append("stderr", Array.from({ length: 120 }, () => "🔥".repeat(12000)).join("\n"));
    expect(created.every((record) => Buffer.byteLength(record.text) <= 16 * 1024)).toBe(true);
    expect(created[0]?.text).toContain("[line truncated]");
    const batches = consoleBatches(created);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat()).toEqual(created);
    for (const records of batches) {
      expect(payloadBytes({ deviceId: "pixel", sequence: 0, records })).toBeLessThan(PUSH_PAYLOAD_BUDGET);
    }
    expect(payloadBytes(buffer.snapshot())).toBeLessThanOrEqual(CONSOLE_PAYLOAD_BUDGET);
  });
});
