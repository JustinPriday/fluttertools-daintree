import React, { useEffect, useMemo, useRef, useState } from "react";
import type { PanelViewProps } from "@daintreehq/plugin-sdk";
import { useHostChannel, useNow, usePluginPanelEvent } from "@daintreehq/plugin-sdk/react";
import * as UI from "@daintreehq/plugin-ui";
import { supportsAppReinstall } from "./flutter/device.js";
import { LaunchParametersEditor } from "./launchParameters.react.js";
import { formatDuration, recordingControl } from "./media/presentation.js";
import { consoleBatchSchema, snapshotSchema, type ConsoleBatch, type ConsoleRecord, type FlutterWorkspaceSnapshot, type LaunchParameters, type MediaItem, type RunMode } from "./shared/contracts.js";
import { panelStyles } from "./panelStyles.js";

type Tab = "console" | "media";
type IconName = "camera" | "close" | "copy" | "detach" | "devtools" | "folder" | "play" | "record" | "refresh" | "reload" | "restart" | "settings" | "stop" | "video";
interface ScreenshotPreview { dataUrl: string; copied: boolean }
interface OperationResponse { ok: boolean; message: string }
const MAX_RENDERED_LINES = 1_200;

const ICON_NAMES: Record<IconName, UI.IconProps["name"]> = {
  camera: "camera",
  close: "x",
  copy: "copy",
  detach: "unlink",
  devtools: "external-link",
  folder: "folder-open",
  play: "play",
  record: "circle",
  refresh: "refresh",
  reload: "zap",
  restart: "rotate-ccw",
  settings: "settings",
  stop: "square",
  video: "video",
};

function Icon({ name }: { name: IconName }): React.ReactElement {
  return <UI.Icon className="ft-svg" name={ICON_NAMES[name]}/>;
}

function IconButton({ icon, label, onClick, disabled, tone, active }: { icon: IconName; label: string; onClick: () => void; disabled?: boolean; tone?: "primary" | "danger"; active?: boolean }): React.ReactElement {
  return <UI.IconButton type="button" size="xs" icon={ICON_NAMES[icon]} className={["ft-btn", "ft-icon", tone ?? "", active ? "active" : ""].filter(Boolean).join(" ")} aria-label={label} pressed={active} disabled={disabled} onClick={onClick}/>;
}

function useStyles(): void {
  useEffect(() => { const node = document.createElement("style"); node.dataset.flutterTools = "true"; node.textContent = panelStyles; document.head.appendChild(node); return () => node.remove(); }, []);
}

export default function FlutterToolsPanel({ panelId, pluginId, initialArgs }: PanelViewProps): React.ReactElement {
  useStyles();
  const [snapshot, setSnapshot] = useState<FlutterWorkspaceSnapshot | null>(null);
  const [tab, setTab] = useState<Tab>("console");
  const [query, setQuery] = useState("");
  const [previews, setPreviews] = useState<Record<string, ScreenshotPreview>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [showLaunchParameters, setShowLaunchParameters] = useState(false);
  const [deletingPath, setDeletingPath] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<MediaItem | null>(null);
  const [runMenuOpen, setRunMenuOpen] = useState(false);
  const [restartConfirmationOpen, setRestartConfirmationOpen] = useState(false);
  const consoleRef = useRef<HTMLDivElement>(null);
  const runActionRef = useRef<HTMLDivElement>(null);
  const restartActionRef = useRef<HTMLDivElement>(null);
  const runHoldTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restartHoldTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressRunClick = useRef(false);
  const suppressRestartClick = useRef(false);
  const expectedSequence = useRef(0);
  const promptedForProject = useRef(false);
  const baseArgs = useMemo(() => ({ panelId, initialArgs }), [panelId, initialArgs]);
  const connect = useHostChannel<typeof baseArgs, FlutterWorkspaceSnapshot>(pluginId, "workspace.connect");
  const refresh = useHostChannel<typeof baseArgs, FlutterWorkspaceSnapshot>(pluginId, "workspace.refresh");
  const openSettings = useHostChannel<typeof baseArgs, OperationResponse>(pluginId, "settings.open");
  const selectProject = useHostChannel<{ panelId: string; initialArgs?: Record<string, unknown>; projectPath: string }, unknown>(pluginId, "project.select");
  const saveLaunchParameters = useHostChannel<{ panelId: string; initialArgs?: Record<string, unknown>; launchParameters: LaunchParameters }, LaunchParameters>(pluginId, "launchParameters.set");
  const selectDevice = useHostChannel<{ panelId: string; initialArgs?: Record<string, unknown>; deviceId: string }, FlutterWorkspaceSnapshot>(pluginId, "device.select");
  const startRun = useHostChannel<{ panelId: string; initialArgs?: Record<string, unknown>; deviceId: string; mode: RunMode; extraArgs: string[] }, OperationResponse>(pluginId, "run.start");
  const reinstallRun = useHostChannel<{ panelId: string; initialArgs?: Record<string, unknown>; deviceId: string }, unknown>(pluginId, "run.reinstall");
  const controlRun = useHostChannel<{ panelId: string; initialArgs?: Record<string, unknown>; deviceId: string; operation: "hotReload" | "hotRestart" | "stop" | "detach" }, unknown>(pluginId, "run.control");
  const screenshot = useHostChannel<{ panelId: string; initialArgs?: Record<string, unknown>; deviceId: string; copyToClipboard: boolean }, { deviceId: string; filePath: string | null; dataUrl: string | null; copied: boolean; message: string; saveWarning: string | null }>(pluginId, "screenshot.capture");
  const copyScreenshot = useHostChannel<{ panelId: string; initialArgs?: Record<string, unknown>; deviceId: string; filePath: string }, unknown>(pluginId, "screenshot.copy");
  const startRecording = useHostChannel<{ panelId: string; initialArgs?: Record<string, unknown>; deviceId: string }, OperationResponse>(pluginId, "recording.start");
  const stopRecording = useHostChannel<{ panelId: string; initialArgs?: Record<string, unknown>; deviceId: string }, OperationResponse>(pluginId, "recording.stop");
  const openMedia = useHostChannel<{ panelId: string; initialArgs?: Record<string, unknown>; deviceId: string; filePath: string }, OperationResponse>(pluginId, "media.open");
  const revealMedia = useHostChannel<{ panelId: string; initialArgs?: Record<string, unknown>; deviceId: string; filePath: string }, OperationResponse>(pluginId, "media.reveal");
  const deleteMedia = useHostChannel<{ panelId: string; initialArgs?: Record<string, unknown>; deviceId: string; filePath: string; deleteFile: boolean }, OperationResponse>(pluginId, "media.delete");
  const clearConsole = useHostChannel<{ panelId: string; initialArgs?: Record<string, unknown>; deviceId: string }, unknown>(pluginId, "console.clear");
  const copyConsole = useHostChannel<{ text: string }, unknown>(pluginId, "console.copy");
  const openDevTools = useHostChannel<{ panelId: string; initialArgs?: Record<string, unknown>; deviceId: string }, unknown>(pluginId, "devtools.open");

  usePluginPanelEvent<unknown>(pluginId, "workspace.snapshot", panelId, (payload) => { const parsed = snapshotSchema.safeParse(payload); if (parsed.success) { expectedSequence.current = parsed.data.sequence; setSnapshot(parsed.data); } });
  usePluginPanelEvent<ConsoleBatch>(pluginId, "console.batch", panelId, (payload) => {
    const parsed = consoleBatchSchema.safeParse(payload); if (!parsed.success) return;
    if (parsed.data.deviceId !== snapshot?.selectedDeviceId) return;
    if (parsed.data.sequence !== expectedSequence.current) void connect.invoke(baseArgs).then((next) => next && setSnapshot(next));
    expectedSequence.current = parsed.data.sequence + 1;
    setSnapshot((current) => current ? { ...current, console: [...current.console, ...parsed.data.records].slice(-5000), sequence: expectedSequence.current } : current);
  });

  useEffect(() => { void connect.invoke(baseArgs).then((next) => next && setSnapshot(next)); }, [panelId]);
  useEffect(() => { if (!follow) return; requestAnimationFrame(() => { const node = consoleRef.current; if (node) node.scrollTop = node.scrollHeight; }); }, [snapshot?.console.length, follow]);
  useEffect(() => { if (snapshot && !snapshot.binding.flutterProjectPath && !promptedForProject.current) { promptedForProject.current = true; setShowSettings(true); } }, [snapshot]);
  useEffect(() => {
    if (!runMenuOpen) return;
    const closeOutside = (event: PointerEvent): void => { if (!runActionRef.current?.contains(event.target as Node)) setRunMenuOpen(false); };
    const closeOnEscape = (event: KeyboardEvent): void => { if (event.key === "Escape") setRunMenuOpen(false); };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => { document.removeEventListener("pointerdown", closeOutside); document.removeEventListener("keydown", closeOnEscape); };
  }, [runMenuOpen]);
  useEffect(() => {
    if (!restartConfirmationOpen) return;
    const closeOutside = (event: PointerEvent): void => { if (!restartActionRef.current?.contains(event.target as Node)) setRestartConfirmationOpen(false); };
    const closeOnEscape = (event: KeyboardEvent): void => { if (event.key === "Escape") setRestartConfirmationOpen(false); };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => { document.removeEventListener("pointerdown", closeOutside); document.removeEventListener("keydown", closeOnEscape); };
  }, [restartConfirmationOpen]);
  useEffect(() => () => { if (runHoldTimer.current) clearTimeout(runHoldTimer.current); if (restartHoldTimer.current) clearTimeout(restartHoldTimer.current); }, []);
  useEffect(() => { setRunMenuOpen(false); setRestartConfirmationOpen(false); }, [snapshot?.selectedDeviceId]);
  useEffect(() => {
    if (!pendingDelete) return;
    const closeOnEscape = (event: KeyboardEvent): void => { if (event.key === "Escape") setPendingDelete(null); };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [pendingDelete]);
  useEffect(() => {
    if (!showLaunchParameters) return;
    const closeOnEscape = (event: KeyboardEvent): void => { if (event.key === "Escape" && !saveLaunchParameters.loading) setShowLaunchParameters(false); };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [showLaunchParameters, saveLaunchParameters.loading]);
  const records = useMemo(() => { const all = snapshot?.console ?? []; const filtered = query ? all.filter((line) => `${line.stream} ${line.text}`.toLowerCase().includes(query.toLowerCase())) : all; return filtered.slice(-MAX_RENDERED_LINES); }, [snapshot?.console, query]);
  const run = snapshot?.run;
  const running = run?.state === "running";
  const active = Boolean(run && ["starting", "running", "reloading", "restarting", "stopping"].includes(run.state));
  const anyActive = Boolean(snapshot?.sessions.some((session) => ["starting", "running", "reloading", "restarting", "stopping"].includes(session.state)));
  const selectedDevice = snapshot?.devices.find((item) => item.id === snapshot.selectedDeviceId);
  const selectedProject = snapshot?.projects.find((item) => item.path === snapshot.binding.flutterProjectPath);
  const busy = !snapshot || connect.loading || refresh.loading || selectProject.loading || selectDevice.loading || saveLaunchParameters.loading || startRun.loading || reinstallRun.loading || controlRun.loading;
  const canStart = Boolean(snapshot?.binding.flutterProjectPath && selectedDevice && (!run || ["idle", "stopped", "detached", "failed"].includes(run.state)));
  const debugSession = run?.mode === "debug";
  const canHotRestart = Boolean(running && debugSession && selectedDevice?.capabilities.hotRestart);
  const canReinstall = Boolean(canHotRestart && snapshot?.binding.flutterProjectPath && selectedDevice && supportsAppReinstall(selectedDevice));
  const visibleMedia = (snapshot?.media ?? []).filter((item) => item.deviceId === snapshot?.selectedDeviceId);
  const recording = snapshot?.recording;
  const clock = useNow({ intervalMs: recording?.startedAt && ["recording", "stopping"].includes(recording.state) ? 1_000 : 0 });
  const recordingBusy = startRecording.loading || stopRecording.loading;
  const recordingLive = Boolean(recording && ["starting", "recording", "stopping", "finalizing"].includes(recording.state));
  const ownsRecording = recording?.ownedByPanel !== false;
  const androidTarget = selectedDevice?.platform.toLowerCase().includes("android") ?? false;
  const recordingElapsed = recording?.startedAt ? Math.max(0, Math.floor((clock - Date.parse(recording.startedAt)) / 1_000)) : 0;
  const recordControl = recordingControl({ deviceName: selectedDevice?.name, platform: selectedDevice?.platform, state: recording?.state, ownedByPanel: ownsRecording, elapsedSeconds: recordingElapsed, busy: recordingBusy || busy });
  const runningCount = snapshot?.sessions.filter((session) => session.state === "running").length ?? 0;
  const savedParameterCount = snapshot?.launchParameters.dartDefines.length ?? 0;
  const enabledParameterCount = snapshot?.launchParameters.dartDefines.filter((define) => define.enabled).length ?? 0;
  const currentError = message ?? recording?.error ?? snapshot?.toolError ?? connect.error?.message ?? refresh.error?.message ?? openSettings.error?.message ?? selectProject.error?.message ?? saveLaunchParameters.error?.message ?? selectDevice.error?.message ?? startRun.error?.message ?? reinstallRun.error?.message ?? controlRun.error?.message ?? screenshot.error?.message ?? copyScreenshot.error?.message ?? startRecording.error?.message ?? stopRecording.error?.message ?? openMedia.error?.message ?? revealMedia.error?.message ?? deleteMedia.error?.message ?? null;
  const error = currentError === dismissedError ? null : currentError;

  const refreshWorkspace = async (): Promise<void> => { setMessage(null); setDismissedError(null); const next = await refresh.invoke(baseArgs); if (next) setSnapshot(next); };
  const changeDevice = async (deviceId: string): Promise<void> => { setMessage(null); setFollow(true); const next = await selectDevice.invoke({ ...baseArgs, deviceId }); if (next) { expectedSequence.current = next.sequence; setSnapshot(next); } };
  const changeProject = async (projectPath: string): Promise<void> => { if (!projectPath) return; setMessage(null); const result = await selectProject.invoke({ ...baseArgs, projectPath }); if (result) { const next = await connect.invoke(baseArgs); if (next) setSnapshot(next); setShowLaunchParameters(false); setShowSettings(false); } };
  const persistLaunchParameters = async (launchParameters: LaunchParameters): Promise<boolean> => {
    setMessage(null); setDismissedError(null);
    const saved = await saveLaunchParameters.invoke({ ...baseArgs, launchParameters });
    if (!saved) return false;
    setSnapshot((current) => current ? { ...current, launchParameters: saved } : current);
    setNotice(saved.dartDefines.some((define) => define.enabled) ? "Launch parameters saved for the next full run" : "Launch parameters saved; the next run uses Flutter defaults");
    return true;
  };
  const capture = async (): Promise<void> => {
    if (!selectedDevice) return;
    setMessage(null); setNotice(null); const result = await screenshot.invoke({ ...baseArgs, deviceId: selectedDevice.id, copyToClipboard: false });
    if (!result?.filePath || !result.dataUrl) return;
    setPreviews((current) => ({ ...current, [result.filePath!]: { dataUrl: result.dataUrl!, copied: result.copied } })); setNotice(result.message); setTab("media");
  };
  const removeMedia = async (item: MediaItem, deleteFile: boolean): Promise<void> => {
    if (!selectedDevice) return;
    setMessage(null); setDeletingPath(item.filePath);
    const result = await deleteMedia.invoke({ ...baseArgs, deviceId: selectedDevice.id, filePath: item.filePath, deleteFile });
    if (result) {
      setPreviews((current) => { const next = { ...current }; delete next[item.filePath]; return next; });
      setNotice(result.message);
      const next = await connect.invoke(baseArgs); if (next) setSnapshot(next);
    }
    setDeletingPath(null); setPendingDelete(null);
  };
  const copyShot = async (item: MediaItem): Promise<void> => {
    if (!selectedDevice) return;
    setMessage(null); const copied = await copyScreenshot.invoke({ ...baseArgs, deviceId: selectedDevice.id, filePath: item.filePath });
    if (copied) { setPreviews((current) => ({ ...current, [item.filePath]: { dataUrl: current[item.filePath]?.dataUrl ?? "", copied: true } })); setNotice("Screenshot copied"); }
  };
  const toggleRecording = async (): Promise<void> => {
    if (!selectedDevice || !androidTarget || recordingBusy || (recordingLive && !ownsRecording)) return;
    setMessage(null); setDismissedError(null);
    const result = recordingLive ? await stopRecording.invoke({ ...baseArgs, deviceId: selectedDevice.id }) : await startRecording.invoke({ ...baseArgs, deviceId: selectedDevice.id });
    if (result) { setNotice(result.message); if (recordingLive) setTab("media"); }
    const next = await connect.invoke(baseArgs); if (next) setSnapshot(next);
  };
  const cancelRunHold = (): void => { if (runHoldTimer.current) clearTimeout(runHoldTimer.current); runHoldTimer.current = null; };
  const openRunMenu = (): void => {
    if (!canStart || busy || !selectedDevice) return;
    setRunMenuOpen(true);
  };
  const beginRunHold = (): void => {
    if (!canStart || busy || !selectedDevice) return;
    suppressRunClick.current = false;
    cancelRunHold();
    runHoldTimer.current = setTimeout(() => { suppressRunClick.current = true; openRunMenu(); }, 600);
  };
  const launch = (mode: RunMode): void => {
    cancelRunHold();
    if (!selectedDevice || !canStart || busy) { setRunMenuOpen(false); return; }
    setMessage(null);
    setDismissedError(null);
    setRunMenuOpen(false);
    void startRun.invoke({ ...baseArgs, deviceId: selectedDevice.id, mode, extraArgs: [] });
  };
  const runDebug = (): void => {
    cancelRunHold();
    if (suppressRunClick.current) { suppressRunClick.current = false; return; }
    launch("debug");
  };
  const cancelRestartHold = (): void => { if (restartHoldTimer.current) clearTimeout(restartHoldTimer.current); restartHoldTimer.current = null; };
  const beginRestartHold = (): void => {
    if (!canReinstall || busy) return;
    suppressRestartClick.current = false;
    cancelRestartHold();
    restartHoldTimer.current = setTimeout(() => { suppressRestartClick.current = true; setRestartConfirmationOpen(true); }, 600);
  };
  const hotRestart = (): void => {
    cancelRestartHold();
    if (suppressRestartClick.current) { suppressRestartClick.current = false; return; }
    if (selectedDevice) void controlRun.invoke({ ...baseArgs, deviceId: selectedDevice.id, operation: "hotRestart" });
  };
  const confirmReinstall = (): void => {
    if (!selectedDevice) return;
    setMessage(null);
    setDismissedError(null);
    setRestartConfirmationOpen(false);
    void reinstallRun.invoke({ ...baseArgs, deviceId: selectedDevice.id });
  };

  return <div className="ft-root">
    <header className="ft-repo-bar">
      <div className="ft-mark">F</div>
      <div className="ft-context"><strong>{snapshot?.binding.worktreeName ?? "Flutter Tools"}</strong><span title={snapshot?.binding.worktreePath}>{snapshot?.binding.worktreePath ?? "Binding to visible worktree…"}</span></div>
      <div className="ft-project-chip" title={snapshot?.binding.flutterProjectPath ?? "No Flutter project selected"}><span>PROJECT</span>{selectedProject?.relativePath ?? (snapshot?.binding.flutterProjectPath ? "Flutter app" : "Not set")}</div>
      <IconButton icon="settings" label="Flutter Tools settings" active={showSettings} onClick={() => setShowSettings((value) => !value)}/>
    </header>
    {showSettings ? <section className="ft-settings" aria-label="Flutter project settings">
      <div className="ft-settings-copy"><strong>Flutter project</strong><span>Set once for this panel. Nested apps remain bound to the current Daintree worktree.</span></div>
      <select className="ft-select ft-project-select" aria-label="Flutter project" value={snapshot?.binding.flutterProjectPath ?? ""} disabled={!snapshot || anyActive || selectProject.loading} onChange={(event) => void changeProject(event.target.value)}>
        <option value="">Select project…</option>{snapshot?.projects.map((project) => <option key={project.path} value={project.path}>{project.relativePath === "." ? project.name : `${project.name} · ${project.relativePath}`}</option>)}
      </select>
      {anyActive ? <span className="ft-settings-note">Stop all apps to change project.</span> : null}
      <button type="button" className={`ft-params-summary-btn ${enabledParameterCount ? "active" : ""}`} disabled={!snapshot?.binding.flutterProjectPath} onClick={() => setShowLaunchParameters(true)}>
        <span className="ft-param-mark" aria-hidden="true">&#123; &#125;</span><span><strong>Launch parameters</strong><small>{savedParameterCount ? `${enabledParameterCount} set · ${savedParameterCount} saved` : "Default Flutter launch"}</small></span><b>Edit</b>
      </button>
      <button type="button" className="ft-btn ft-text-btn ft-plugin-settings-btn" title="Open Plugin Settings" aria-label="Open Plugin Settings" disabled={openSettings.loading} onClick={() => void openSettings.invoke(baseArgs)}>{openSettings.loading ? "Opening…" : "Plugin Settings"}</button>
    </section> : null}
    <div className="ft-launch-bar">
      <label className="ft-device-picker"><span>Target</span><select className="ft-select" aria-label="Flutter target device" value={snapshot?.selectedDeviceId ?? ""} disabled={!snapshot || !snapshot.devices.length || busy} onChange={(event) => void changeDevice(event.target.value)}>
        {!snapshot?.devices.length ? <option value="">No devices detected</option> : null}
        {snapshot?.devices.map((device) => { const session = snapshot.sessions.find((item) => item.deviceId === device.id); const state = session?.state ?? "idle"; const mode = session?.mode; const live = ["starting", "running", "reloading", "restarting", "stopping"].includes(state); return <option key={device.id} value={device.id}>{live ? "● " : ""}{device.name} · {device.platform}{device.emulator ? " · emulator" : ""}{state !== "idle" ? ` · ${state}` : ""}{live && mode && mode !== "debug" ? ` · ${mode}` : ""}</option>; })}
      </select></label>
      <span className="ft-device-count">{snapshot?.devices.length ?? 0} available</span>
      {savedParameterCount ? <button type="button" className={`ft-param-chip ${enabledParameterCount ? "active" : ""}`} title={`${enabledParameterCount} set · ${savedParameterCount} saved launch ${savedParameterCount === 1 ? "parameter" : "parameters"}`} aria-label={`Edit launch parameters. ${enabledParameterCount} set, ${savedParameterCount} saved.`} onClick={() => setShowLaunchParameters(true)}><i/><span>PARAMS</span><strong>{enabledParameterCount}</strong></button> : null}<span className="ft-spacer"/>
      <IconButton icon="refresh" label="Refresh projects and devices" disabled={busy} onClick={() => void refreshWorkspace()}/>
      {active && selectedDevice ? <IconButton icon="stop" label={`Stop Flutter application on ${selectedDevice.name}`} tone="danger" disabled={busy || run?.state === "stopping"} onClick={() => void controlRun.invoke({ ...baseArgs, deviceId: selectedDevice.id, operation: "stop" })}/>
      : <div ref={runActionRef} className="ft-run-action">
        <button type="button" className="ft-btn ft-icon primary" title={selectedDevice ? `Run debug build on ${selectedDevice.name}. Hold or right-click for release.` : "Select a target to run"} aria-label={selectedDevice ? `Run debug build on ${selectedDevice.name}. Hold or right-click for release options.` : "Select a target to run"} aria-haspopup="menu" aria-expanded={runMenuOpen} disabled={!canStart || busy || !selectedDevice} onPointerDown={beginRunHold} onPointerUp={cancelRunHold} onPointerCancel={cancelRunHold} onPointerLeave={cancelRunHold} onContextMenu={(event) => { event.preventDefault(); openRunMenu(); }} onKeyDown={(event) => { if (event.key === "ArrowDown") { event.preventDefault(); openRunMenu(); } }} onClick={runDebug}><Icon name="play"/></button>
        {runMenuOpen ? <div className="ft-run-popover" role="menu" aria-label="Flutter launch modes">
          <span>ALTERNATE LAUNCH</span>
          <button type="button" className="ft-run-option" role="menuitem" autoFocus onClick={() => launch("release")}>
            <span className="ft-release-mark">R</span><span><strong>Install &amp; run release</strong><small>Optimized build · debugging and hot reload unavailable</small></span>
          </button>
        </div> : null}
      </div>}
    </div>
    <div className={`ft-session-bar ${restartConfirmationOpen ? "popover-open" : ""}`}>
      <span className={`ft-state ${run?.state ?? "idle"}`}><i/>{run?.state ?? "idle"}{active && run?.mode === "release" ? <b className="ft-mode-badge">release</b> : null}</span>
      <span className="ft-session-target" title={selectedDevice?.id}>{selectedDevice?.name ?? "No device selected"}</span>
      {run?.appId ? <span className="ft-app-id" title={run.appId}>{run.appId}</span> : null}<span className="ft-spacer"/>
      <IconButton icon="reload" label={run?.mode === "release" ? "Hot reload is unavailable for release builds" : "Hot reload"} disabled={!running || !debugSession || !selectedDevice?.capabilities.hotReload || busy} onClick={() => selectedDevice && void controlRun.invoke({ ...baseArgs, deviceId: selectedDevice.id, operation: "hotReload" })}/>
      <div ref={restartActionRef} className="ft-restart-action">
        <button type="button" className="ft-btn ft-icon" title="Hot restart" aria-label="Hot restart" disabled={!canHotRestart || busy} onPointerDown={beginRestartHold} onPointerUp={cancelRestartHold} onPointerCancel={cancelRestartHold} onPointerLeave={cancelRestartHold} onClick={hotRestart}><Icon name="restart"/></button>
        {restartConfirmationOpen ? <div className="ft-restart-popover ft-restart-confirm" role="dialog" aria-modal="true" aria-label="Confirm reinstall and restart">
          <strong>Reinstall the app on {selectedDevice?.name} from scratch?</strong>
          <p><strong>All app data stored on this device will be permanently lost.</strong> Preferences, databases, caches, and signed-in state will be removed. Project source files and remote data are not affected.</p>
          <p>The app will then be reinstalled and launched using the same Flutter run configuration.</p>
          <div><button type="button" className="ft-btn ft-text-btn" onClick={() => setRestartConfirmationOpen(false)}>Cancel</button><button type="button" className="ft-btn danger ft-text-btn" onClick={confirmReinstall}>Delete &amp; Reinstall</button></div>
        </div> : null}
      </div>
      <IconButton icon="devtools" label={run?.mode === "release" ? "DevTools is unavailable for release builds" : "Open Flutter DevTools"} disabled={!debugSession || !(run?.devToolsUri || run?.vmServiceUri) || busy} onClick={() => selectedDevice && void openDevTools.invoke({ ...baseArgs, deviceId: selectedDevice.id })}/>
      <div className="ft-capture-cluster" aria-label="Device media controls">
        <IconButton icon="camera" label="Capture device screenshot" disabled={!selectedDevice?.capabilities.screenshot || busy || screenshot.loading} onClick={() => void capture()}/>
        <button type="button" className={`ft-btn ft-record-btn ${recordControl.active ? "active" : ""}`} title={recordControl.title} aria-label={recordControl.title} aria-pressed={recordControl.active} disabled={recordControl.disabled} onClick={() => void toggleRecording()}>
          {recordControl.active ? <Icon name="stop"/> : <Icon name="record"/>}{recordControl.active ? <span>{recordControl.label}</span> : null}
        </button>
      </div>
      <IconButton icon="detach" label="Detach debugger and leave application running" disabled={!running || busy} onClick={() => selectedDevice && void controlRun.invoke({ ...baseArgs, deviceId: selectedDevice.id, operation: "detach" })}/>
    </div>
    {error ? <div className="ft-error" role="alert"><span>{error}</span><button className="ft-alert-close" type="button" aria-label="Dismiss error" onClick={() => setDismissedError(error)}><Icon name="close"/></button></div> : null}
    {notice ? <div className="ft-notice" role="status"><span>{notice}</span><button className="ft-alert-close" type="button" aria-label="Dismiss success message" onClick={() => setNotice(null)}><Icon name="close"/></button></div> : null}
    {pendingDelete ? <div className="ft-dialog-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) setPendingDelete(null); }}><div className="ft-delete-dialog" role="dialog" aria-modal="true" aria-label={`Delete ${pendingDelete.kind}`}>
      <strong>Remove this {pendingDelete.kind === "recording" ? "recording" : "screenshot"}?</strong>
      <p><strong>Remove Reference</strong> keeps the single saved file at the path below. <strong>Delete File</strong> removes the reference and permanently deletes that file.</p><code title={pendingDelete.filePath}>{pendingDelete.filePath}</code>
      <div><button type="button" className="ft-btn ft-text-btn" autoFocus onClick={() => setPendingDelete(null)}>Cancel</button><button type="button" className="ft-btn ft-text-btn" disabled={deleteMedia.loading} onClick={() => void removeMedia(pendingDelete, false)}>Remove Reference</button><button type="button" className="ft-btn danger ft-text-btn" disabled={deleteMedia.loading} onClick={() => void removeMedia(pendingDelete, true)}>Delete File</button></div>
    </div></div> : null}
    {showLaunchParameters && snapshot ? <LaunchParametersEditor key={`${snapshot.binding.flutterProjectPath}:${snapshot.launchParameters.dartDefines.map((define) => `${define.key}:${define.value}:${define.enabled}`).join("|")}`} parameters={snapshot.launchParameters} projectName={selectedProject?.name ?? "Flutter project"} running={anyActive} saving={saveLaunchParameters.loading} onCancel={() => setShowLaunchParameters(false)} onSave={persistLaunchParameters}/> : null}
    <main className="ft-main">
      <div className="ft-tabs"><button className={`ft-tab ${tab === "console" ? "active" : ""}`} onClick={() => setTab("console")}>Console <span className="ft-count">{snapshot?.console.length ?? 0}</span></button><button className={`ft-tab ${tab === "media" ? "active" : ""}`} onClick={() => setTab("media")}>Media <span className="ft-count">{visibleMedia.length}</span></button></div>
      {tab === "console" ? <section className="ft-pane"><div className="ft-console-tools"><input className="ft-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Filter ${selectedDevice?.name ?? "target"} console…`} aria-label="Filter console output"/><button className="ft-btn ft-text-btn" disabled={!records.length} onClick={() => void copyConsole.invoke({ text: records.map((line) => `${line.at} [${line.stream}] ${line.text}`).join("\n") })}>Copy</button><button className="ft-btn ft-text-btn" disabled={!selectedDevice} onClick={() => selectedDevice && void clearConsole.invoke({ ...baseArgs, deviceId: selectedDevice.id })}>Clear</button></div><div className="ft-console-wrap"><div ref={consoleRef} className="ft-console" onWheel={() => { const node = consoleRef.current; if (node && node.scrollHeight-node.scrollTop-node.clientHeight > 24) setFollow(false); }} onScroll={() => { const node = consoleRef.current; if (node && node.scrollHeight-node.scrollTop-node.clientHeight < 8) setFollow(true); }}>
        {!records.length ? <div className="ft-empty"><div><strong>{snapshot?.binding.flutterProjectPath ? "Console standing by" : "Choose a Flutter project"}</strong>{snapshot?.binding.flutterProjectPath ? "Run the app to stream structured Flutter output." : "Open project settings to bind one of the discovered Flutter apps."}</div></div> : records.map((line: ConsoleRecord) => <div key={line.id} className={`ft-line ${line.level}`}><span className="ft-time">{line.at.slice(11,19)}</span><span className="ft-stream">{line.stream}</span><span className="ft-text">{line.text}</span></div>)}
      </div>{!follow ? <button className="ft-btn ft-resume" onClick={() => setFollow(true)}>↓ Resume live tail</button> : null}</div></section>
      : <section className="ft-pane ft-media">{!visibleMedia.length ? <div className="ft-empty"><div><strong>No media for {selectedDevice?.name ?? "this target"}</strong>Capture a PNG or record an Android device to collect media here.<small>Video recording is Android-only. Files use the configured save folder, or Flutter Tools storage when no folder is set.</small></div></div> : visibleMedia.map((item) => {
        const preview = previews[item.filePath]; const created = new Date(item.createdAt); const timestamp = Number.isNaN(created.valueOf()) ? item.createdAt : created.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
        return <article className={`ft-media-card ${item.kind}`} key={item.id}>
          <button className="ft-shot-delete" type="button" title={`Remove ${item.kind}`} aria-label={`Remove ${item.kind} captured at ${timestamp}`} disabled={deletingPath === item.filePath || deleteMedia.loading} onClick={() => setPendingDelete(item)}><Icon name="close"/></button>
          {item.kind === "screenshot" && preview?.dataUrl ? <img src={preview.dataUrl} alt={`Device screenshot captured at ${timestamp}`}/> : <div className="ft-media-placeholder" aria-label={item.kind === "recording" ? "MP4 screen recording" : "PNG screenshot"}><Icon name={item.kind === "recording" ? "video" : "camera"}/><strong>{item.kind === "recording" ? "MP4 RECORDING" : "PNG CAPTURE"}</strong>{item.durationSeconds != null ? <span>{formatDuration(item.durationSeconds)}</span> : null}</div>}
          <div className="ft-media-info"><div><strong>{item.kind === "recording" ? "Screen recording" : "Screenshot"}</strong><span title={item.filePath}>{timestamp}</span>{item.saveWarning ? <span className="warning" title={item.saveWarning}>Save-folder warning</span> : null}</div>
            <div className="ft-media-actions">{item.kind === "screenshot" ? <IconButton icon="copy" label={preview?.copied ? "Copy screenshot again" : "Copy screenshot"} disabled={copyScreenshot.loading} onClick={() => void copyShot(item)}/> : null}<button className="ft-btn ft-text-btn" disabled={openMedia.loading} onClick={() => selectedDevice && void openMedia.invoke({ ...baseArgs, deviceId: selectedDevice.id, filePath: item.filePath })}>Open</button><IconButton icon="folder" label="Reveal media in folder" disabled={revealMedia.loading} onClick={() => selectedDevice && void revealMedia.invoke({ ...baseArgs, deviceId: selectedDevice.id, filePath: item.filePath })}/></div>
          </div>
        </article>;
      })}</section>}
    </main>
    <footer className="ft-toolchain"><span className={`ft-tool-dot ${snapshot?.sdk ? "ready" : ""}`}/><strong>Flutter</strong><span>{snapshot?.sdk?.version ?? "SDK unavailable"}</span><span className="ft-divider"/> <span>{snapshot?.sdk?.source ? snapshot.sdk.source.toUpperCase() : "UNRESOLVED"}</span><span className="ft-tool-path" title={snapshot?.sdk?.executable}>{snapshot?.sdk?.executable ?? "Flutter executable not resolved"}</span><span className="ft-spacer"/><span>{runningCount} running · {snapshot?.devices.length ?? 0} device{snapshot?.devices.length === 1 ? "" : "s"}</span></footer>
  </div>;
}
