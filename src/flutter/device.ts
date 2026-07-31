import { deviceSchema, type FlutterDevice } from "../shared/contracts.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function parseFlutterDevice(value: unknown): FlutterDevice | null {
  const raw = asRecord(value);
  const caps = asRecord(raw?.capabilities);
  const parsed = deviceSchema.safeParse({
    id: raw?.id,
    name: raw?.name,
    platform: raw?.platform ?? raw?.targetPlatform,
    category: typeof raw?.category === "string" ? raw.category : null,
    emulator: raw?.emulator === true,
    ephemeral: raw?.ephemeral === true,
    sdk: typeof raw?.sdk === "string" ? raw.sdk : null,
    capabilities: {
      hotReload: caps?.hotReload === true,
      hotRestart: caps?.hotRestart === true,
      screenshot: caps?.screenshot === true,
      fastStart: caps?.fastStart === true,
    },
  });
  return parsed.success ? parsed.data : null;
}

export function parseFlutterDeviceList(value: unknown): FlutterDevice[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const device = parseFlutterDevice(candidate);
    return device ? [device] : [];
  }).sort((a, b) => a.name.localeCompare(b.name));
}

export function supportsAppReinstall(device: Pick<FlutterDevice, "platform">): boolean {
  const platform = device.platform.toLowerCase();
  return platform.startsWith("android") || platform === "ios";
}
