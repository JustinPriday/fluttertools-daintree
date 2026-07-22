import React, { useEffect, useMemo, useRef, useState } from "react";
import type { PanelViewProps } from "@daintreehq/plugin-sdk";
import { useHostChannel, usePluginPanelEvent } from "./daintree/reactHooks.js";
import { consoleBatchSchema, snapshotSchema, type ConsoleBatch, type ConsoleRecord, type FlutterWorkspaceSnapshot } from "./shared/contracts.js";
import { panelStyles } from "./panelStyles.js";

type Tab = "console" | "screenshots";
type IconName = "camera" | "close" | "copy" | "detach" | "devtools" | "play" | "refresh" | "reload" | "restart" | "settings" | "stop";
interface Shot { deviceId: string; dataUrl: string; filePath: string; copied: boolean; at: string }
const MAX_RENDERED_LINES = 1_200;

const ICON_PATHS: Record<IconName, React.ReactNode> = {
  camera: <><path d="M4 8h3l1.5-2h7L17 8h3v11H4Z"/><circle cx="12" cy="13" r="3.5"/></>,
  close: <><path d="m7 7 10 10"/><path d="M17 7 7 17"/></>,
  copy: <><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></>,
  detach: <><path d="M9 7H6a3 3 0 0 0 0 6h3"/><path d="M15 7h3a3 3 0 0 1 0 6h-3"/><path d="m8 18 8-12"/></>,
  devtools: <><path d="M14 5h5v5"/><path d="m19 5-8 8"/><path d="M18 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></>,
  play: <path d="m8 5 10 7-10 7Z"/>,
  refresh: <><path d="M20 11a8 8 0 0 0-14.9-4"/><path d="M4 4v5h5"/><path d="M4 13a8 8 0 0 0 14.9 4"/><path d="M20 20v-5h-5"/></>,
  reload: <><path d="m13 3-5 9h4l-1 9 5-10h-4Z"/></>,
  restart: <><path d="M20 11a8 8 0 1 0-2.34 5.66"/><path d="M20 4v7h-7"/></>,
  settings: <><circle cx="12" cy="12" r="3"/><path d="M19 13.5v-3l-2-.7-.7-1.7.9-1.9-2.2-2.1-1.8.9-1.7-.7-.7-2H8l-.7 2-1.7.7-1.8-.9-2.1 2.1.9 1.9-.7 1.7-2 .7v3l2 .7.7 1.7-.9 1.9 2.1 2.1 1.8-.9 1.7.7.7 2h3l.7-2 1.7-.7 1.8.9 2.2-2.1-.9-1.9.7-1.7Z"/></>,
  stop: <rect x="6" y="6" width="12" height="12" rx="1.5"/>,
};

function Icon({ name }: { name: IconName }): React.ReactElement {
  return <svg className="ft-svg" viewBox="0 0 24 24" aria-hidden="true">{ICON_PATHS[name]}</svg>;
}

function IconButton({ icon, label, onClick, disabled, tone, active }: { icon: IconName; label: string; onClick: () => void; disabled?: boolean; tone?: "primary" | "danger"; active?: boolean }): React.ReactElement {
  return <button type="button" className={["ft-btn", "ft-icon", tone ?? "", active ? "active" : ""].filter(Boolean).join(" ")} title={label} aria-label={label} aria-pressed={active} disabled={disabled} onClick={onClick}><Icon name={icon}/></button>;
}

function useStyles(): void {
  useEffect(() => { const node = document.createElement("style"); node.dataset.flutterTools = "true"; node.textContent = panelStyles; document.head.appendChild(node); return () => node.remove(); }, []);
}

async function copyPng(dataUrl: string): Promise<boolean> {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") return false;
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    return true;
  } catch { return false; }
}

export default function FlutterToolsPanel({ panelId, pluginId, initialArgs, disposeSignal }: PanelViewProps): React.ReactElement {
  useStyles();
  const [snapshot, setSnapshot] = useState<FlutterWorkspaceSnapshot | null>(null);
  const [tab, setTab] = useState<Tab>("console");
  const [query, setQuery] = useState("");
  const [shots, setShots] = useState<Shot[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [deletingPath, setDeletingPath] = useState<string | null>(null);
  const consoleRef = useRef<HTMLDivElement>(null);
  const expectedSequence = useRef(0);
  const promptedForProject = useRef(false);
  const baseArgs = useMemo(() => ({ panelId, initialArgs }), [panelId, initialArgs]);
  const connect = useHostChannel<typeof baseArgs, FlutterWorkspaceSnapshot>(pluginId, "workspace.connect");
  const refresh = useHostChannel<typeof baseArgs, FlutterWorkspaceSnapshot>(pluginId, "workspace.refresh");
  const selectProject = useHostChannel<{ panelId: string; initialArgs?: Record<string, unknown>; projectPath: string }, unknown>(pluginId, "project.select");
  const selectDevice = useHostChannel<{ panelId: string; initialArgs?: Record<string, unknown>; deviceId: string }, FlutterWorkspaceSnapshot>(pluginId, "device.select");
  const startRun = useHostChannel<{ panelId: string; initialArgs?: Record<string, unknown>; deviceId: string; mode: "debug"; extraArgs: string[] }, unknown>(pluginId, "run.start");
  const controlRun = useHostChannel<{ panelId: string; initialArgs?: Record<string, unknown>; deviceId: string; operation: "hotReload" | "hotRestart" | "stop" | "detach" }, unknown>(pluginId, "run.control");
  const screenshot = useHostChannel<{ panelId: string; initialArgs?: Record<string, unknown>; deviceId: string; copyToClipboard: boolean }, { deviceId: string; filePath: string | null; dataUrl: string | null; message: string }>(pluginId, "screenshot.capture");
  const deleteScreenshot = useHostChannel<{ filePath: string }, unknown>(pluginId, "screenshot.delete");
  const openScreenshot = useHostChannel<{ filePath: string }, unknown>(pluginId, "screenshot.open");
  const clearConsole = useHostChannel<{ panelId: string; initialArgs?: Record<string, unknown>; deviceId: string }, unknown>(pluginId, "console.clear");
  const copyConsole = useHostChannel<{ text: string }, unknown>(pluginId, "console.copy");
  const openDevTools = useHostChannel<{ panelId: string; initialArgs?: Record<string, unknown>; deviceId: string }, unknown>(pluginId, "devtools.open");
  const disconnect = useHostChannel<{ panelId: string }, unknown>(pluginId, "workspace.disconnect");

  usePluginPanelEvent<unknown>(pluginId, "workspace.snapshot", panelId, (payload) => { const parsed = snapshotSchema.safeParse(payload); if (parsed.success) { expectedSequence.current = parsed.data.sequence; setSnapshot(parsed.data); } });
  usePluginPanelEvent<ConsoleBatch>(pluginId, "console.batch", panelId, (payload) => {
    const parsed = consoleBatchSchema.safeParse(payload); if (!parsed.success) return;
    if (parsed.data.deviceId !== snapshot?.selectedDeviceId) return;
    if (parsed.data.sequence !== expectedSequence.current) void connect.invoke(baseArgs).then((next) => next && setSnapshot(next));
    expectedSequence.current = parsed.data.sequence + 1;
    setSnapshot((current) => current ? { ...current, console: [...current.console, ...parsed.data.records].slice(-5000), sequence: expectedSequence.current } : current);
  });

  useEffect(() => { void connect.invoke(baseArgs).then((next) => next && setSnapshot(next)); }, [panelId]);
  useEffect(() => { const stop = () => { void disconnect.invoke({ panelId }); }; disposeSignal.addEventListener("abort", stop, { once: true }); return () => disposeSignal.removeEventListener("abort", stop); }, [panelId, disposeSignal]);
  useEffect(() => { if (!follow) return; requestAnimationFrame(() => { const node = consoleRef.current; if (node) node.scrollTop = node.scrollHeight; }); }, [snapshot?.console.length, follow]);
  useEffect(() => { if (snapshot && !snapshot.binding.flutterProjectPath && !promptedForProject.current) { promptedForProject.current = true; setShowSettings(true); } }, [snapshot]);

  const records = useMemo(() => { const all = snapshot?.console ?? []; const filtered = query ? all.filter((line) => `${line.stream} ${line.text}`.toLowerCase().includes(query.toLowerCase())) : all; return filtered.slice(-MAX_RENDERED_LINES); }, [snapshot?.console, query]);
  const run = snapshot?.run;
  const running = run?.state === "running";
  const active = Boolean(run && ["starting", "running", "reloading", "restarting", "stopping"].includes(run.state));
  const anyActive = Boolean(snapshot?.sessions.some((session) => ["starting", "running", "reloading", "restarting", "stopping"].includes(session.state)));
  const selectedDevice = snapshot?.devices.find((item) => item.id === snapshot.selectedDeviceId);
  const selectedProject = snapshot?.projects.find((item) => item.path === snapshot.binding.flutterProjectPath);
  const busy = !snapshot || connect.loading || refresh.loading || selectProject.loading || selectDevice.loading || startRun.loading || controlRun.loading || screenshot.loading || deleteScreenshot.loading;
  const canStart = Boolean(snapshot?.binding.flutterProjectPath && selectedDevice && (!run || ["idle", "stopped", "detached", "failed"].includes(run.state)));
  const visibleShots = shots.filter((shot) => shot.deviceId === snapshot?.selectedDeviceId);
  const runningCount = snapshot?.sessions.filter((session) => session.state === "running").length ?? 0;
  const error = message ?? connect.error?.message ?? refresh.error?.message ?? selectProject.error?.message ?? selectDevice.error?.message ?? startRun.error?.message ?? controlRun.error?.message ?? screenshot.error?.message ?? deleteScreenshot.error?.message ?? openScreenshot.error?.message ?? null;

  const refreshWorkspace = async (): Promise<void> => { setMessage(null); const next = await refresh.invoke(baseArgs); if (next) setSnapshot(next); };
  const changeDevice = async (deviceId: string): Promise<void> => { setMessage(null); setFollow(true); const next = await selectDevice.invoke({ ...baseArgs, deviceId }); if (next) { expectedSequence.current = next.sequence; setSnapshot(next); } };
  const changeProject = async (projectPath: string): Promise<void> => { if (!projectPath) return; setMessage(null); const result = await selectProject.invoke({ ...baseArgs, projectPath }); if (result) { const next = await connect.invoke(baseArgs); if (next) setSnapshot(next); setShowSettings(false); } };
  const capture = async (): Promise<void> => {
    if (!selectedDevice) return;
    setMessage(null); const result = await screenshot.invoke({ ...baseArgs, deviceId: selectedDevice.id, copyToClipboard: false });
    if (!result?.filePath || !result.dataUrl) return;
    setShots((current) => [{ deviceId: result.deviceId, dataUrl: result.dataUrl!, filePath: result.filePath!, copied: false, at: new Date().toISOString() }, ...current].slice(0, 30)); setTab("screenshots");
  };
  const removeShot = async (shot: Shot): Promise<void> => {
    setMessage(null); setDeletingPath(shot.filePath);
    const result = await deleteScreenshot.invoke({ filePath: shot.filePath });
    if (result) setShots((current) => current.filter((candidate) => candidate.filePath !== shot.filePath));
    setDeletingPath(null);
  };
  const copyShot = async (shot: Shot): Promise<void> => {
    setMessage(null); const copied = await copyPng(shot.dataUrl);
    if (!copied) { setMessage("Daintree could not write this PNG to the image clipboard."); return; }
    setShots((current) => current.map((candidate) => candidate.filePath === shot.filePath ? { ...candidate, copied: true } : candidate));
  };

  return <div className="ft-root">
    <header className="ft-repo-bar">
      <div className="ft-mark">F</div>
      <div className="ft-context"><strong>{snapshot?.binding.worktreeName ?? "Flutter Tools"}</strong><span title={snapshot?.binding.worktreePath}>{snapshot?.binding.worktreePath ?? "Binding to visible worktree…"}</span></div>
      <div className="ft-project-chip" title={snapshot?.binding.flutterProjectPath ?? "No Flutter project selected"}><span>PROJECT</span>{selectedProject?.relativePath ?? (snapshot?.binding.flutterProjectPath ? "Flutter app" : "Not set")}</div>
      <IconButton icon="settings" label="Change Flutter project binding" active={showSettings} onClick={() => setShowSettings((value) => !value)}/>
    </header>
    {showSettings ? <section className="ft-settings" aria-label="Flutter project settings">
      <div><strong>Flutter project</strong><span>Set once for this panel. Nested apps remain bound to the current Daintree worktree.</span></div>
      <select className="ft-select ft-project-select" aria-label="Flutter project" value={snapshot?.binding.flutterProjectPath ?? ""} disabled={!snapshot || anyActive || selectProject.loading} onChange={(event) => void changeProject(event.target.value)}>
        <option value="">Select project…</option>{snapshot?.projects.map((project) => <option key={project.path} value={project.path}>{project.relativePath === "." ? project.name : `${project.name} · ${project.relativePath}`}</option>)}
      </select>
      {anyActive ? <span className="ft-settings-note">Stop all apps to change project.</span> : null}
    </section> : null}
    <div className="ft-launch-bar">
      <label className="ft-device-picker"><span>Target</span><select className="ft-select" aria-label="Flutter target device" value={snapshot?.selectedDeviceId ?? ""} disabled={!snapshot || !snapshot.devices.length || busy} onChange={(event) => void changeDevice(event.target.value)}>
        {!snapshot?.devices.length ? <option value="">No devices detected</option> : null}
        {snapshot?.devices.map((device) => { const session = snapshot.sessions.find((item) => item.deviceId === device.id); const state = session?.state ?? "idle"; const live = ["starting", "running", "reloading", "restarting", "stopping"].includes(state); return <option key={device.id} value={device.id}>{live ? "● " : ""}{device.name} · {device.platform}{device.emulator ? " · emulator" : ""}{state !== "idle" ? ` · ${state}` : ""}</option>; })}
      </select></label>
      <span className="ft-device-count">{snapshot?.devices.length ?? 0} available</span><span className="ft-spacer"/>
      <IconButton icon="refresh" label="Refresh projects and devices" disabled={busy} onClick={() => void refreshWorkspace()}/>
      {active && selectedDevice ? <IconButton icon="stop" label={`Stop Flutter application on ${selectedDevice.name}`} tone="danger" disabled={busy || run?.state === "stopping"} onClick={() => void controlRun.invoke({ ...baseArgs, deviceId: selectedDevice.id, operation: "stop" })}/>
      : <IconButton icon="play" label={selectedDevice ? `Run Flutter application on ${selectedDevice.name}` : "Select a target to run"} tone="primary" disabled={!canStart || busy || !selectedDevice} onClick={() => selectedDevice && void startRun.invoke({ ...baseArgs, deviceId: selectedDevice.id, mode: "debug", extraArgs: [] })}/>}
    </div>
    <div className="ft-session-bar">
      <span className={`ft-state ${run?.state ?? "idle"}`}><i/>{run?.state ?? "idle"}</span>
      <span className="ft-session-target" title={selectedDevice?.id}>{selectedDevice?.name ?? "No device selected"}</span>
      {run?.appId ? <span className="ft-app-id" title={run.appId}>{run.appId}</span> : null}<span className="ft-spacer"/>
      <IconButton icon="reload" label="Hot reload" disabled={!running || !selectedDevice?.capabilities.hotReload || busy} onClick={() => selectedDevice && void controlRun.invoke({ ...baseArgs, deviceId: selectedDevice.id, operation: "hotReload" })}/>
      <IconButton icon="restart" label="Hot restart" disabled={!running || !selectedDevice?.capabilities.hotRestart || busy} onClick={() => selectedDevice && void controlRun.invoke({ ...baseArgs, deviceId: selectedDevice.id, operation: "hotRestart" })}/>
      <IconButton icon="devtools" label="Open Flutter DevTools" disabled={!(run?.devToolsUri || run?.vmServiceUri) || busy} onClick={() => selectedDevice && void openDevTools.invoke({ ...baseArgs, deviceId: selectedDevice.id })}/>
      <IconButton icon="camera" label="Capture device screenshot" disabled={!selectedDevice?.capabilities.screenshot || busy} onClick={() => void capture()}/>
      <IconButton icon="detach" label="Detach debugger and leave application running" disabled={!running || busy} onClick={() => selectedDevice && void controlRun.invoke({ ...baseArgs, deviceId: selectedDevice.id, operation: "detach" })}/>
    </div>
    {error ? <div className="ft-error" role="alert"><span>{error}</span><button className="ft-alert-close" type="button" aria-label="Dismiss error" onClick={() => setMessage(null)}><Icon name="close"/></button></div> : null}
    <main className="ft-main">
      <div className="ft-tabs"><button className={`ft-tab ${tab === "console" ? "active" : ""}`} onClick={() => setTab("console")}>Console <span className="ft-count">{snapshot?.console.length ?? 0}</span></button><button className={`ft-tab ${tab === "screenshots" ? "active" : ""}`} onClick={() => setTab("screenshots")}>Screenshots <span className="ft-count">{visibleShots.length}</span></button></div>
      {tab === "console" ? <section className="ft-pane"><div className="ft-console-tools"><input className="ft-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Filter ${selectedDevice?.name ?? "target"} console…`} aria-label="Filter console output"/><button className="ft-btn ft-text-btn" disabled={!records.length} onClick={() => void copyConsole.invoke({ text: records.map((line) => `${line.at} [${line.stream}] ${line.text}`).join("\n") })}>Copy</button><button className="ft-btn ft-text-btn" disabled={!selectedDevice} onClick={() => selectedDevice && void clearConsole.invoke({ ...baseArgs, deviceId: selectedDevice.id })}>Clear</button></div><div className="ft-console-wrap"><div ref={consoleRef} className="ft-console" onWheel={() => { const node = consoleRef.current; if (node && node.scrollHeight-node.scrollTop-node.clientHeight > 24) setFollow(false); }} onScroll={() => { const node = consoleRef.current; if (node && node.scrollHeight-node.scrollTop-node.clientHeight < 8) setFollow(true); }}>
        {!records.length ? <div className="ft-empty"><div><strong>{snapshot?.binding.flutterProjectPath ? "Console standing by" : "Choose a Flutter project"}</strong>{snapshot?.binding.flutterProjectPath ? "Run the app to stream structured Flutter output." : "Open project settings to bind one of the discovered Flutter apps."}</div></div> : records.map((line: ConsoleRecord) => <div key={line.id} className={`ft-line ${line.level}`}><span className="ft-time">{line.at.slice(11,19)}</span><span className="ft-stream">{line.stream}</span><span className="ft-text">{line.text}</span></div>)}
      </div>{!follow ? <button className="ft-btn ft-resume" onClick={() => setFollow(true)}>↓ Resume live tail</button> : null}</div></section>
      : <section className="ft-pane ft-shots">{!visibleShots.length ? <div className="ft-empty"><div><strong>No captures for {selectedDevice?.name ?? "this target"}</strong>Capture the selected device to save a PNG and preview it here.</div></div> : visibleShots.map((shot) => <article className="ft-shot" key={shot.filePath}>
        <button className="ft-shot-delete" type="button" title="Delete screenshot" aria-label={`Delete screenshot captured at ${shot.at}`} disabled={deletingPath === shot.filePath} onClick={() => void removeShot(shot)}><Icon name="close"/></button>
        <img src={shot.dataUrl} alt={`Device screenshot captured at ${shot.at}`}/><div className="ft-shot-meta"><span title={shot.filePath}>{shot.copied ? "Copied · " : ""}{shot.at.slice(11,19)}</span><IconButton icon="copy" label={shot.copied ? "Copy screenshot again" : "Copy screenshot"} onClick={() => void copyShot(shot)}/><button className="ft-btn ft-text-btn" disabled={openScreenshot.loading} onClick={() => void openScreenshot.invoke({filePath:shot.filePath})}>{openScreenshot.loading ? "Opening…" : "Open"}</button></div>
      </article>)}</section>}
    </main>
    <footer className="ft-toolchain"><span className={`ft-tool-dot ${snapshot?.sdk ? "ready" : ""}`}/><strong>Flutter</strong><span>{snapshot?.sdk?.version ?? "SDK unavailable"}</span><span className="ft-divider"/> <span>{snapshot?.sdk?.source ? snapshot.sdk.source.toUpperCase() : "UNRESOLVED"}</span><span className="ft-tool-path" title={snapshot?.sdk?.executable}>{snapshot?.sdk?.executable ?? "Flutter executable not resolved"}</span><span className="ft-spacer"/><span>{runningCount} running · {snapshot?.devices.length ?? 0} device{snapshot?.devices.length === 1 ? "" : "s"}</span></footer>
  </div>;
}
