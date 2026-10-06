import React, { useMemo, useState } from "react";
import * as UI from "@daintreehq/plugin-ui";
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

  return <UI.Dialog open onClose={onCancel} title="Launch parameters" icon="braces" description={`${projectName} · compile-time Dart defines`} size="lg" dismissible={!saving} footer={<><UI.Button type="button" variant="ghost" disabled={saving} onClick={onCancel}>Cancel</UI.Button><UI.Button type="button" variant="contrast" icon="save" loading={saving} disabled={saving} onClick={() => void save()}>Save parameters</UI.Button></>} hint={validationError ? <span role="alert">{validationError}</span> : "Applied on the next full Flutter launch"}>
    <div className="ft-native-params">
      <div className="ft-native-params-summary"><UI.Badge tone={enabledCount ? "info" : "neutral"} shape="pill">{enabledCount} {enabledCount === 1 ? "define" : "defines"} set</UI.Badge><span>Compile-time values applied to the next full launch.{running ? " The running app will not change." : ""}</span></div>
      <UI.Toolbar aria-label="Launch parameter controls" variant="bar" className="ft-native-params-tools"><UI.SearchField className="ft-native-param-search" value={query} onValueChange={setQuery} onClear={() => setQuery("")} autoFocus placeholder="Find a name or value…" aria-label="Find launch parameters"/><UI.Button type="button" size="xs" variant="secondary" icon="plus" disabled={draft.length >= 40} onClick={addDefine}>Add define</UI.Button></UI.Toolbar>
      <div className="ft-param-columns" aria-hidden="true"><span>USE</span><span>NAME</span><span>VALUE</span><span/></div>
      <div className="ft-param-list">
        {!draft.length ? <UI.EmptyState title="No launch parameters" description="Add a Dart define when this project needs a non-default build." icon="braces" scale="popover" action={<UI.Button type="button" size="sm" variant="secondary" icon="plus" onClick={addDefine}>Add define</UI.Button>}/> : null}
        {draft.length > 0 && !visible.length ? <UI.EmptyState title="No matches" description={`Nothing contains “${query.trim()}”.`} variant="filtered-empty" scale="popover"/> : null}
        {visible.map((define) => <div className={`ft-param-row ${define.enabled ? "set" : "unset"}`} key={define.id}>
          <UI.Switch checked={define.enabled} aria-label={`${define.enabled ? "Unset" : "Set"} ${define.key || "new define"}`} onCheckedChange={(enabled) => update(define.id, { enabled })}/>
          <UI.Input density="compact" className="ft-param-key" value={define.key} placeholder="ANALYTICS_LOCAL_TEST" aria-label="Dart define name" onPaste={(event) => { const parsed = parsePastedDefine(event.clipboardData.getData("text")); if (parsed) { event.preventDefault(); update(define.id, parsed); } }} onValueChange={(key) => update(define.id, { key })}/>
          <UI.Input density="compact" value={define.value} placeholder="true" aria-label={`${define.key || "Dart define"} value`} onValueChange={(value) => update(define.id, { value })}/>
          <UI.IconButton type="button" size="xs" variant="ghost-danger" icon="trash" aria-label={`Remove ${define.key || "new define"}`} onClick={() => setDraft((current) => current.filter((candidate) => candidate.id !== define.id))}/>
        </div>)}
      </div>
      <p className="ft-native-params-help">Paste a complete <code>--dart-define=NAME=value</code> into the name field. Defines are not secret storage.</p>
    </div>
  </UI.Dialog>;
}
