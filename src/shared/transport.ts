// Conservatively follows Daintree's accounting for our plain JSON payloads: keys and
// strings use UTF-8 bytes, containers and primitive values cost eight bytes.
export const PUSH_PAYLOAD_BUDGET = 1024 * 1024;
export const CONSOLE_PAYLOAD_BUDGET = 512 * 1024;

export function payloadBytes(value: unknown): number {
  if (typeof value === "string") return Buffer.byteLength(value);
  if (value === null || typeof value !== "object") return 8;
  if (Array.isArray(value)) return 8 + value.reduce((bytes, item) => bytes + payloadBytes(item), 0);
  return 8 + Object.entries(value).reduce((bytes, [key, item]) => bytes + Buffer.byteLength(key) + payloadBytes(item), 0);
}
