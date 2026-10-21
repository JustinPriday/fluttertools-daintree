import path from "node:path";
import { realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { PluginHostApi } from "@daintreehq/plugin-sdk";
import { appSettingsConfigSchema, type AppSetting, type AppSettingPreview, type AppSettingsConfig } from "../shared/appSettings.js";

export const APP_SETTINGS_FILE = ".daintree/flutter-tools.json";
const emptyConfig = (): AppSettingsConfig => ({ schemaVersion: 1, appSettings: [] });
const missing = (error: unknown): boolean => error instanceof Error && ((error as NodeJS.ErrnoException).code === "ENOENT" || /^ENOENT\b/.test(error.message));
const inside = (root: string, file: string): boolean => { const relative = path.relative(root, file); return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };

/** Literal single-line matching. Only the captured value is changed. */
export function inspectSetting(text: string, setting: AppSetting): { value: string; start: number; end: number; lineStart: number; line: string } {
  const [prefix, suffix] = setting.targets[0].template.trimStart().split("{{setting}}");
  const matches: { value: string; start: number; end: number; lineStart: number; line: string }[] = [];
  let offset = 0;
  for (const line of text.split(/\r\n|\n|\r/)) {
    const indentation = /^[\uFEFF \t]*/.exec(line)![0].length;
    const body = line.slice(indentation);
    if (body.startsWith(prefix) && body.endsWith(suffix) && body.length >= prefix.length + suffix.length) {
      if (line.length > 8192) throw new Error("Matched source line is too long (maximum 8192 characters)");
      const start = offset + indentation + prefix.length;
      const end = offset + line.length - suffix.length;
      if (end - start > 1000) throw new Error("Matched source value is too long (maximum 1000 characters)");
      matches.push({ value: text.slice(start, end), start, end, lineStart: offset, line });
    }
    offset += line.length;
    if (text.slice(offset, offset + 2) === "\r\n") offset += 2;
    else if (/[\r\n]/.test(text[offset] ?? "")) offset++;
  }
  if (matches.length !== 1) throw new Error(matches.length ? "Template matches more than one line. Make it more specific." : "Template does not match a line in this file. Check the file and template.");
  return matches[0];
}

export function replaceSetting(text: string, setting: AppSetting, optionId: string): { text: string; before: string; after: string } {
  const match = inspectSetting(text, setting);
  const option = setting.options.find((candidate) => candidate.id === optionId);
  if (!option) throw new Error("This option no longer exists. Refresh App settings.");
  const value = option.values[setting.targets[0].id];
  const updated = text.slice(0, match.start) + value + text.slice(match.end);
  return { text: updated, before: match.line, after: updated.slice(match.lineStart, match.lineStart + match.line.length + value.length - match.value.length) };
}

export class AppSettingsService {
  private queues = new Map<string, Promise<unknown>>();
  constructor(private readonly host: Pick<PluginHostApi, "fs">) {}

  async exclusive<T>(root: string, operation: () => Promise<T>): Promise<T> {
    const key = path.resolve(root);
    const previous = this.queues.get(key) ?? Promise.resolve();
    const work = previous.catch(() => {}).then(operation);
    this.queues.set(key, work);
    try { return await work; } finally { if (this.queues.get(key) === work) this.queues.delete(key); }
  }

  async containedPath(root: string, relative: string): Promise<string> {
    const resolvedRoot = await realpath(root);
    const file = path.resolve(root, relative);
    if (!inside(path.resolve(root), file) || file === path.resolve(root)) throw new Error("App setting path must be inside the selected Flutter project");
    let existing = file;
    for (;;) {
      try { if (!inside(resolvedRoot, await realpath(existing))) throw new Error("App setting path resolves outside the selected Flutter project"); break; }
      catch (error) { if (!missing(error)) throw error; const parent = path.dirname(existing); if (parent === existing) throw error; existing = parent; }
    }
    return file;
  }

  async read(root: string, relative: string): Promise<{ text: string; revision: string }> {
    const file = await this.containedPath(root, relative);
    const bytes = await this.host.fs.readFileBytes(file);
    if (bytes.byteLength > 2 * 1024 * 1024) throw new Error("App setting files must be smaller than 2 MiB");
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return { text, revision: createHash("sha256").update(bytes).digest("hex") };
  }

  async load(root: string): Promise<{ config: AppSettingsConfig; revision: string | null }> {
    try {
      const source = await this.read(root, APP_SETTINGS_FILE);
      let config: unknown;
      try { config = JSON.parse(source.text.replace(/^\uFEFF/, "")); }
      catch { throw new Error(`${APP_SETTINGS_FILE} contains invalid JSON. Correct it in your editor, then Refresh.`); }
      const parsed = appSettingsConfigSchema.safeParse(config);
      if (!parsed.success) throw new Error(`${APP_SETTINGS_FILE}: ${parsed.error.issues[0]?.message ?? "Invalid definition"}. Correct it in your editor, then Refresh.`);
      return { config: parsed.data, revision: source.revision };
    } catch (error) { if (missing(error)) return { config: emptyConfig(), revision: null }; throw error; }
  }

  async statuses(root: string, config: AppSettingsConfig) {
    return Promise.all(config.appSettings.map(async (setting) => {
      try {
        const source = await this.read(root, setting.targets[0].file);
        const { value } = inspectSetting(source.text, setting);
        return { id: setting.id, value, optionId: setting.options.find((option) => option.values[setting.targets[0].id] === value)?.id ?? null, error: null };
      } catch (error) { return { id: setting.id, value: null, optionId: null, error: error instanceof Error ? error.message : String(error) }; }
    }));
  }

  async validate(root: string, setting: AppSetting) {
    if (setting.targets[0].file === APP_SETTINGS_FILE) throw new Error("An app setting cannot edit its own definition file");
    const source = await this.read(root, setting.targets[0].file);
    const { value, line } = inspectSetting(source.text, setting);
    return { value, line, options: setting.options.map((option) => ({ id: option.id, label: option.label, after: replaceSetting(source.text, setting, option.id).after })) };
  }

  async save(root: string, config: AppSettingsConfig, expectedRevision: string | null): Promise<void> {
    const parsed = appSettingsConfigSchema.parse(config);
    const current = await this.load(root);
    if (current.revision !== expectedRevision) throw new Error("App settings definitions changed. Refresh before saving.");
    // Only new or edited definitions require a valid target. Broken entries can still be removed.
    for (const setting of parsed.appSettings) if (JSON.stringify(setting) !== JSON.stringify(current.config.appSettings.find((entry) => entry.id === setting.id))) await this.validate(root, setting);
    const file = await this.containedPath(root, APP_SETTINGS_FILE);
    await this.host.fs.mkdir(path.dirname(file));
    await this.containedPath(root, APP_SETTINGS_FILE);
    await this.host.fs.writeFile(file, JSON.stringify(parsed, null, 2) + "\n", { expectedRevision });
  }

  async preview(root: string, settingId: string, optionId: string): Promise<AppSettingPreview> {
    const definitions = await this.load(root);
    const setting = definitions.config.appSettings.find((candidate) => candidate.id === settingId);
    if (!setting) throw new Error("This setting no longer exists. Refresh App settings.");
    if (setting.targets[0].file === APP_SETTINGS_FILE) throw new Error("An app setting cannot edit its own definition file");
    const source = await this.read(root, setting.targets[0].file);
    const change = replaceSetting(source.text, setting, optionId);
    return { projectPath: path.resolve(root), settingId, optionId, file: setting.targets[0].file, before: change.before, after: change.after, sourceRevision: source.revision, definitionRevision: definitions.revision };
  }

  async apply(root: string, preview: AppSettingPreview): Promise<void> {
    if (path.resolve(root) !== preview.projectPath) throw new Error("Preview belongs to another Flutter project. Preview again before applying.");
    const fresh = await this.preview(root, preview.settingId, preview.optionId);
    if (fresh.definitionRevision !== preview.definitionRevision || fresh.sourceRevision !== preview.sourceRevision) throw new Error("The source or definition changed. Preview again before applying.");
    const { config, revision } = await this.load(root);
    if (revision !== fresh.definitionRevision) throw new Error("Definition changed. Preview again before applying.");
    const setting = config.appSettings.find((candidate) => candidate.id === preview.settingId)!;
    const source = await this.read(root, setting.targets[0].file);
    if (source.revision !== fresh.sourceRevision) throw new Error("Source changed. Preview again before applying.");
    const change = replaceSetting(source.text, setting, preview.optionId);
    if (change.text !== source.text) await this.host.fs.writeFile(await this.containedPath(root, setting.targets[0].file), change.text, { expectedRevision: fresh.sourceRevision });
  }
}
