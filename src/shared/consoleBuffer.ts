import type { ConsoleRecord } from "./contracts.js";

export class ConsoleBuffer {
  private records: ConsoleRecord[] = [];
  private bytes = 0;
  private nextId = 0;
  constructor(private readonly maxRecords = 5_000, private readonly maxBytes = 2 * 1024 * 1024) {}

  append(stream: ConsoleRecord["stream"], text: string): ConsoleRecord[] {
    const level = stream === "stderr" ? "error" : /\b(?:warning|warn)\b/i.test(text) ? "warning" : "info";
    const created = text.replace(/\r/g, "").split("\n").filter(Boolean).map((line) => ({ id: this.nextId++, at: new Date().toISOString(), stream, level, text: line } satisfies ConsoleRecord));
    for (const record of created) { this.records.push(record); this.bytes += Buffer.byteLength(record.text); }
    while (this.records.length > this.maxRecords || this.bytes > this.maxBytes) { const removed = this.records.shift(); if (removed) this.bytes -= Buffer.byteLength(removed.text); }
    return created;
  }
  snapshot(): ConsoleRecord[] { return [...this.records]; }
  clear(): void { this.records = []; this.bytes = 0; }
}
