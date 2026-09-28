import React, { useMemo, useRef, useState } from "react";
import { launchParametersSchema, type LaunchParameters } from "./shared/contracts.js";

interface DraftDefine {
  id: number;
  key: string;
  value: string;
  enabled: boolean;
}

interface LaunchParametersEditorProps {
  parameters: LaunchParameters;
  projectName: string;
  running: boolean;
  saving: boolean;
  onCancel: () => void;
  onSave: (parameters: LaunchParameters) => Promise<boolean>;
}

let nextDraftId = 1;

function draftDefine(key = "", value = "", enabled = true): DraftDefine {
  return { id: nextDraftId++, key, value, enabled };
}

function parsePastedDefine(value: string): { key: string; value: string } | null {
  const argument = value.trim();
  const prefix = "--dart-define=";
  if (!argument.startsWith(prefix)) return null;
  const definition = argument.slice(prefix.length);
  const separator = definition.indexOf("=");
  if (separator <= 0) return null;
  return { key: definition.slice(0, separator), value: definition.slice(separator + 1) };
}

export function LaunchParametersEditor({ parameters, projectName, running, saving, onCancel, onSave }: LaunchParametersEditorProps): React.ReactElement {
  const dialogRef = useRef<HTMLElement>(null);
  const [draft, setDraft] = useState<DraftDefine[]>(() => parameters.dartDefines.map((define) => draftDefine(define.key, define.value, define.enabled)));
  const [query, setQuery] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const normalizedQuery = query.trim().toLowerCase();
  const visible = useMemo(() => normalizedQuery ? draft.filter((define) => `${define.key} ${define.value}`.toLowerCase().includes(normalizedQuery)) : draft, [draft, normalizedQuery]);
  const enabledCount = draft.filter((define) => define.enabled).length;

  const update = (id: number, values: Partial<Omit<DraftDefine, "id">>): void => {
    setValidationError(null);
    setDraft((current) => current.map((define) => define.id === id ? { ...define, ...values } : define));
  };

  const addDefine = (): void => {
    setQuery("");
    setValidationError(null);
    setDraft((current) => [...current, draftDefine()]);
  };

  const save = async (): Promise<void> => {
    const parsed = launchParametersSchema.safeParse({ dartDefines: draft.map(({ key, value, enabled }) => ({ key, value, enabled })) });
    if (!parsed.success) {
      setValidationError(parsed.error.issues[0]?.message ?? "Review the launch parameters");
      return;
    }
    if (await onSave(parsed.data)) onCancel();
  };

  const trapFocus = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); if (!saving) void save(); return; }
    if (event.key !== "Tab") return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)') ?? [])];
    if (!focusable.length) return;
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  return <div className="ft-dialog-backdrop ft-params-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget && !saving) onCancel(); }}>
    <section ref={dialogRef} className="ft-params-dialog" role="dialog" aria-modal="true" aria-labelledby="ft-params-title" onKeyDown={trapFocus}>
      <header className="ft-params-header">
        <div><span>RUN CONFIGURATION</span><h2 id="ft-params-title">Launch parameters</h2><p>{projectName}</p></div>
        <button type="button" className="ft-param-close" aria-label="Close launch parameters" disabled={saving} onClick={onCancel}>×</button>
      </header>
      <div className="ft-params-summary">
        <div><strong>{enabledCount}</strong><span>{enabledCount === 1 ? "define set" : "defines set"}</span></div>
        <p>Compile-time values applied to the next full Flutter launch.{running ? " The running app will not change." : ""}</p>
      </div>
      <div className="ft-params-tools">
        <input className="ft-search ft-param-search" type="search" value={query} autoFocus placeholder="Find a name or value…" aria-label="Find launch parameters" onChange={(event) => setQuery(event.target.value)}/>
        <button type="button" className="ft-btn ft-param-add" disabled={draft.length >= 40} onClick={addDefine}><span aria-hidden="true">＋</span> Add define</button>
      </div>
      <div className="ft-param-columns" aria-hidden="true"><span>STATE</span><span>NAME</span><span>VALUE</span><span/></div>
      <div className="ft-param-list">
        {!draft.length ? <div className="ft-param-empty"><strong>No launch parameters</strong><span>Add a Dart define when this project needs a non-default build.</span></div> : null}
        {draft.length > 0 && !visible.length ? <div className="ft-param-empty"><strong>No matches</strong><span>Nothing contains “{query.trim()}”.</span></div> : null}
        {visible.map((define) => <div className={`ft-param-row ${define.enabled ? "set" : "unset"}`} key={define.id}>
          <button type="button" className="ft-param-toggle" aria-pressed={define.enabled} aria-label={`${define.enabled ? "Unset" : "Set"} ${define.key || "new define"}`} onClick={() => update(define.id, { enabled: !define.enabled })}><i/><span>{define.enabled ? "Set" : "Unset"}</span></button>
          <input className="ft-param-input ft-param-key" value={define.key} placeholder="ANALYTICS_LOCAL_TEST" aria-label="Dart define name" onPaste={(event) => { const parsed = parsePastedDefine(event.clipboardData.getData("text")); if (parsed) { event.preventDefault(); update(define.id, parsed); } }} onChange={(event) => update(define.id, { key: event.target.value })}/>
          <input className="ft-param-input" value={define.value} placeholder="true" aria-label={`${define.key || "Dart define"} value`} onChange={(event) => update(define.id, { value: event.target.value })}/>
          <button type="button" className="ft-param-remove" aria-label={`Remove ${define.key || "new define"}`} onClick={() => setDraft((current) => current.filter((candidate) => candidate.id !== define.id))}>×</button>
        </div>)}
      </div>
      <footer className="ft-params-footer">
        <div>{validationError ? <span className="ft-param-validation" role="alert">{validationError}</span> : <span>Paste a complete <code>--dart-define=NAME=value</code> into the name field. Defines are not secret storage.</span>}</div>
        <button type="button" className="ft-btn ft-text-btn" disabled={saving} onClick={onCancel}>Cancel</button>
        <button type="button" className="ft-btn primary ft-param-save" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save parameters"}</button>
      </footer>
    </section>
  </div>;
}
