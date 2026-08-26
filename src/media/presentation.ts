export function formatDuration(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  return `${minutes}:${String(safe % 60).padStart(2, "0")}`;
}

export interface RecordingControl {
  disabled: boolean;
  active: boolean;
  label: string;
  title: string;
}

export function recordingControl(input: { deviceName?: string; platform?: string; state?: string; ownedByPanel?: boolean; elapsedSeconds?: number; busy?: boolean }): RecordingControl {
  if (!input.deviceName) return { disabled: true, active: false, label: "Record", title: "Select a device to record" };
  if (!input.platform?.toLowerCase().includes("android")) return { disabled: true, active: false, label: "Record", title: "Screen recording is available on Android devices" };
  const active = ["starting", "recording", "stopping", "finalizing"].includes(input.state ?? "idle");
  if (active && input.ownedByPanel === false) return { disabled: true, active: false, label: "Record", title: "Recording is controlled by another Flutter Tools panel" };
  const transitional = ["starting", "stopping", "finalizing"].includes(input.state ?? "");
  const label = input.state === "starting" ? "Starting…" : input.state === "stopping" ? "Stopping…" : input.state === "finalizing" ? "Saving…" : input.state === "recording" ? `Stop ${formatDuration(input.elapsedSeconds ?? 0)}` : "Record";
  return { disabled: Boolean(input.busy || transitional), active, label, title: label };
}
