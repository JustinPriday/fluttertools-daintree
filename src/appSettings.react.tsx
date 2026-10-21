import React, { useEffect, useState } from "react";
import * as UI from "@daintreehq/plugin-ui";
import { useHostChannel, usePluginPanelEvent } from "@daintreehq/plugin-sdk/react";
import { appSettingSchema, type AppSetting, type AppSettingPreview, type AppSettingsConfig, type AppSettingsState } from "./shared/appSettings.js";

type BaseArgs = { projectPath: string; panelId: string; initialArgs?: Record<string, unknown> };
type Validation = { value: string; line: string; options: { id: string; label: string; after: string }[] };
const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => byte.toString(16).padStart(2, "0")).join("");
const newOption = () => ({ id: newId(), label: "", value: "" });

function DefinitionEditor({ setting, saving, validate, save, onClose, externalError }: {
  setting: AppSetting | null; saving: boolean;
  validate: (setting: AppSetting) => Promise<Validation | undefined>;
  save: (setting: AppSetting) => Promise<void>; onClose: () => void; externalError?: string;
}): React.ReactElement {
  const [settingId] = useState(() => setting?.id ?? newId());
  const [label, setLabel] = useState(setting?.label ?? "");
  const [file, setFile] = useState(setting?.targets[0].file ?? "");
  const [template, setTemplate] = useState(setting?.targets[0].template ?? "");
  const targetId = setting?.targets[0].id ?? "value";
  const [options, setOptions] = useState(() => setting?.options.map((option) => ({ id: option.id, label: option.label, value: option.values[targetId] })) ?? [newOption(), newOption()]);
  const [checked, setChecked] = useState<Validation | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = (): void => { setChecked(null); setError(null); };
  const definition = (): AppSetting | null => {
    const result = appSettingSchema.safeParse({ id: settingId, label, targets: [{ id: targetId, file, template }], options: options.map((option) => ({ id: option.id, label: option.label, values: { [targetId]: option.value } })) });
    if (!result.success) { setError(result.error.issues[0]?.message ?? "Check the setting fields"); return null; }
    return result.data;
  };
  const check = async (): Promise<void> => {
    const candidate = definition(); if (!candidate) return;
    setChecking(true); setError(null); setChecked(null);
    try { const result = await validate(candidate); if (result) setChecked(result); }
    finally { setChecking(false); }
  };
  const example = (): void => {
    changed(); setLabel("Server environment"); setFile("lib/config/app_environment.dart"); setTemplate("static const current = {{setting}};");
    setOptions(["ngrok", "production", "localhost"].map((value) => ({ id: newId(), label: value === "ngrok" ? "Ngrok" : value === "production" ? "Production" : "Localhost", value })));
  };
  return <UI.Dialog open title={setting ? "Edit app setting" : "Add app setting"} icon="sliders-horizontal" size="lg" onClose={onClose} dismissible={!saving && !checking} description="Declare one source line and the choices its dropdown can write." footer={<><UI.Button variant="ghost" disabled={saving || checking} onClick={onClose}>Cancel</UI.Button><UI.Button variant="outline" loading={checking} disabled={saving || checking} onClick={() => void check()}>Check setting</UI.Button><UI.Button variant="contrast" icon="save" loading={saving} disabled={saving || checking || !checked} onClick={() => { const candidate = definition(); if (candidate) void save(candidate); }}>Save definition</UI.Button></>}>
    <div className="ft-app-form">
      {!setting ? <UI.Button size="xs" variant="ghost" icon="wand-sparkles" onClick={example} disabled={checking || saving}>Use server environment example</UI.Button> : null}
      <fieldset disabled={checking || saving} className="ft-app-fields">
        <UI.FormField label="Setting name"><UI.Input value={label} placeholder="Server environment" aria-label="Setting name" onValueChange={(value) => { changed(); setLabel(value); }}/></UI.FormField>
        <UI.FormField label="File" description="Relative to this Flutter app"><UI.Input value={file} placeholder="lib/config/app_environment.dart" aria-label="App setting file" onValueChange={(value) => { changed(); setFile(value); }}/></UI.FormField>
        <UI.FormField label="Line template" description="Put {{setting}} where the selected value belongs. Keep identifying text on the same line."><UI.Input value={template} placeholder="static const current = {{setting}};" aria-label="App setting line template" onValueChange={(value) => { changed(); setTemplate(value); }}/></UI.FormField>
        <UI.Toolbar aria-label="Setting options"><strong>Dropdown options</strong><UI.Button size="xs" variant="secondary" icon="plus" disabled={options.length >= 30} onClick={() => { changed(); setOptions((current) => [...current, newOption()]); }}>Add option</UI.Button></UI.Toolbar>
        {options.map((option, index) => <div className="ft-app-option" key={option.id}>
          <UI.FormField label={`Option ${index + 1} label`}><UI.Input value={option.label} placeholder="Production" aria-label={`Option ${index + 1} label`} onValueChange={(value) => { changed(); setOptions((current) => current.map((item) => item.id === option.id ? { ...item, label: value } : item)); }}/></UI.FormField>
          <UI.FormField label="Source value"><UI.Input value={option.value} placeholder="production" aria-label={`Option ${index + 1} source value`} onValueChange={(value) => { changed(); setOptions((current) => current.map((item) => item.id === option.id ? { ...item, value } : item)); }}/></UI.FormField>
          <UI.IconButton type="button" size="xs" variant="ghost-danger" icon="trash" aria-label={`Remove option ${index + 1}`} disabled={options.length <= 2} onClick={() => { changed(); setOptions((current) => current.filter((item) => item.id !== option.id)); }}/>
        </div>)}
      </fieldset>
      {error || externalError ? <UI.Callout severity="error" role="alert">{error ?? externalError}</UI.Callout> : null}
      {checked ? <div className="ft-app-check"><strong>Current value: {checked.value || "(empty)"}</strong><pre>{checked.line}</pre>{checked.options.map((option) => <div key={option.id}><span>{option.label}</span><pre>{option.after}</pre></div>)}</div> : null}
      <p className="ft-native-params-help">Saving a definition leaves application source unchanged. Values are literal source text.</p>
    </div>
  </UI.Dialog>;
}

export function AppSettingsDialog({ pluginId, panelId, initialArgs, projectPath, projectName, onClose }: BaseArgs & { pluginId: string; projectName: string; onClose: () => void }): React.ReactElement {
  const baseArgs = { panelId, initialArgs, projectPath };
  const [state, setState] = useState<AppSettingsState | null>(null);
  const [editor, setEditor] = useState<{ setting: AppSetting | null; config: AppSettingsConfig; revision: string | null } | null>(null);
  const [preview, setPreview] = useState<AppSettingPreview | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [errorSource, setErrorSource] = useState<"save" | "validate" | "preview" | "apply" | null>(null);
  const get = useHostChannel<BaseArgs, AppSettingsState>(pluginId, "appSettings.get");
  const save = useHostChannel<BaseArgs & { config: AppSettingsConfig; revision: string | null }, AppSettingsState>(pluginId, "appSettings.save");
  const validate = useHostChannel<BaseArgs & { setting: AppSetting }, Validation>(pluginId, "appSettings.validate");
  const makePreview = useHostChannel<BaseArgs & { settingId: string; optionId: string }, AppSettingPreview>(pluginId, "appSettings.preview");
  const apply = useHostChannel<BaseArgs & { preview: AppSettingPreview }, AppSettingsState>(pluginId, "appSettings.apply");
  const busy = get.loading || save.loading || validate.loading || makePreview.loading || apply.loading;
  const refresh = async (): Promise<void> => { const next = await get.invoke(baseArgs); if (next) setState(next); };
  useEffect(() => { void refresh(); }, [panelId, projectPath]);
  usePluginPanelEvent(pluginId, "appSettings.changed", panelId, () => { setPreview(null); void refresh(); });
  const error = get.error?.message ?? (errorSource === "save" ? save.error?.message : errorSource === "validate" ? validate.error?.message : errorSource === "preview" ? makePreview.error?.message : errorSource === "apply" ? apply.error?.message : undefined);
  const saveDefinition = async (setting: AppSetting): Promise<void> => {
    if (!editor) return;
    const existing = editor.config.appSettings.some((entry) => entry.id === setting.id);
    const config: AppSettingsConfig = { schemaVersion: 1, appSettings: existing ? editor.config.appSettings.map((entry) => entry.id === setting.id ? setting : entry) : [...editor.config.appSettings, setting] };
    setErrorSource("save");
    const result = await save.invoke({ ...baseArgs, config, revision: editor.revision });
    if (result) { setState(result); setEditor(null); setPreview(null); setNotice("Definition saved. Application source unchanged."); }
  };
  const remove = async (setting: AppSetting): Promise<void> => {
    if (!state) return;
    setErrorSource("save");
    const result = await save.invoke({ ...baseArgs, config: { ...state.config, appSettings: state.config.appSettings.filter((entry) => entry.id !== setting.id) }, revision: state.revision });
    if (result) { setState(result); setPreview(null); setNotice("Definition removed. Application source unchanged."); }
  };
  if (editor) return <DefinitionEditor externalError={error} setting={editor.setting} saving={save.loading} validate={(setting) => { setErrorSource("validate"); return validate.invoke({ ...baseArgs, setting }); }} save={saveDefinition} onClose={() => { setEditor(null); setErrorSource(null); }}/>;
  return <UI.Dialog open title="App settings" icon="sliders-horizontal" size="lg" description={`${projectName} · source settings for the next full launch`} onClose={onClose} dismissible={!save.loading && !apply.loading} footer={<UI.Button variant="ghost" disabled={save.loading || apply.loading} onClick={onClose}>Close</UI.Button>}>
    <div className="ft-app-settings">
      <UI.Toolbar aria-label="App setting controls"><UI.Button size="xs" variant="ghost" icon="refresh" loading={get.loading} disabled={busy} onClick={() => { setPreview(null); void refresh(); }}>Refresh</UI.Button><UI.Button size="xs" variant="secondary" icon="plus" disabled={!state || busy || state.config.appSettings.length >= 40} onClick={() => { if (state) { setNotice(null); setErrorSource(null); setEditor({ setting: null, config: state.config, revision: state.revision }); } }}>Add setting</UI.Button></UI.Toolbar>
      {error ? <UI.Callout severity="error" role="alert">{error}</UI.Callout> : null}
      {notice ? <UI.Callout severity="success" role="status">{notice}</UI.Callout> : null}
      {state?.watchWarning ? <UI.Callout severity="warning">{state.watchWarning}</UI.Callout> : null}
      {state?.active ? <UI.Callout severity="info">Stop builds and attached apps for this Flutter project before applying source changes.</UI.Callout> : null}
      {!state && get.loading ? <p role="status">Reading app settings…</p> : null}
      {state && !state.config.appSettings.length ? <UI.EmptyState title="No app settings" description="Add a dropdown that changes one declared line in your Flutter app." icon="sliders-horizontal" scale="popover"/> : null}
      <UI.SettingsGroup>{state?.config.appSettings.map((setting) => {
        const status = state.statuses.find((entry) => entry.id === setting.id);
        const selected = preview?.settingId === setting.id ? preview.optionId : status?.optionId ?? "";
        return <UI.SettingsRow key={setting.id} label={setting.label} layout="stacked" description={setting.targets[0].file} error={status?.error} control={<div className="ft-app-control">
          <UI.Select aria-label={setting.label} density="compact" value={selected} placeholder={status?.value != null ? `Custom value: ${status.value || "(empty)"}` : "Unavailable"} disabled={busy || state.active || Boolean(status?.error)} options={setting.options.map((option) => ({ value: option.id, label: option.label }))} onValueChange={(optionId) => {
            setNotice(null); setPreview(null); setErrorSource("preview");
            if (optionId !== status?.optionId) void makePreview.invoke({ ...baseArgs, settingId: setting.id, optionId }).then((result) => { if (result) setPreview(result); });
          }}/>
          <UI.IconButton size="xs" variant="ghost" icon="pencil" aria-label={`Edit ${setting.label}`} disabled={busy} onClick={() => { setPreview(null); setErrorSource(null); setEditor({ setting, config: state.config, revision: state.revision }); }}/>
          <UI.IconButton size="xs" variant="ghost-danger" icon="trash" aria-label={`Remove ${setting.label} definition; keep source unchanged`} disabled={busy} onClick={() => void remove(setting)}/>
        </div>}/>;
      })}</UI.SettingsGroup>
      {preview ? <div className="ft-app-preview"><strong>{preview.file}</strong><div><span>Current</span><pre>{preview.before}</pre></div><div><span>After Apply</span><pre>{preview.after}</pre></div><UI.Button size="sm" variant="contrast" icon="check" loading={apply.loading} disabled={busy || state?.active} onClick={() => { setErrorSource("apply"); void apply.invoke({ ...baseArgs, preview }).then((result) => { if (result) { setState(result); setPreview(null); setNotice("Saved to source. Use a full Flutter launch to apply."); } else setPreview(null); }); }}>Apply source change</UI.Button></div> : null}
      <p className="ft-native-params-help">Changes are saved to your source files. Running apps keep their compiled settings until a full launch.</p>
    </div>
  </UI.Dialog>;
}
