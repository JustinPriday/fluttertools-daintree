import type { ConsoleRecord } from "./contracts.js";
import { CONSOLE_PAYLOAD_BUDGET, payloadBytes } from "./transport.js";

const MAX_LINE_BYTES = 16 * 1024;
function boundedLine(line: string): string {
  if (Buffer.byteLength(line) <= MAX_LINE_BYTES) return line;
  const suffix = "… [line truncated]";
  return Buffer.from(line).subarray(0, MAX_LINE_BYTES - Buffer.byteLength(suffix) - 3).toString("utf8") + suffix;
}

export function consoleBatches(records: ConsoleRecord[]): ConsoleRecord[][] {
  const batches: ConsoleRecord[][] = [];
  let batch: ConsoleRecord[] = [];
  let bytes = 8;
  for (const record of records) {
    const size = payloadBytes(record);
    if (batch.length && bytes + size > CONSOLE_PAYLOAD_BUDGET) { batches.push(batch); batch = []; bytes = 8; }
    batch.push(record); bytes += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export class ConsoleBuffer {
  private records: ConsoleRecord[] = [];
  private bytes = 0;
  private nextId = 0;
  constructor(private readonly maxRecords = 5_000, private readonly maxBytes = CONSOLE_PAYLOAD_BUDGET) {}

  append(stream: ConsoleRecord["stream"], text: string): ConsoleRecord[] {
    const level = stream === "stderr" ? "error" : /\b(?:warning|warn)\b/i.test(text) ? "warning" : "info";
    const created = text.replace(/\r/g, "").split("\n").filter(Boolean).map((line) => ({ id: this.nextId++, at: new Date().toISOString(), stream, level, text: boundedLine(line) } satisfies ConsoleRecord));
    for (const record of created) { this.records.push(record); this.bytes += payloadBytes(record); }
    while (this.records.length > this.maxRecords || this.bytes + 8 > this.maxBytes) { const removed = this.records.shift(); if (removed) this.bytes -= payloadBytes(removed); else break; }
    return created;
  }
  snapshot(): ConsoleRecord[] { return [...this.records]; }
  clear(): void { this.records = []; this.bytes = 0; }
}
