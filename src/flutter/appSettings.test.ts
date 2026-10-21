import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { PluginHostApi } from "@daintreehq/plugin-sdk";
import { appSettingSchema, appSettingsConfigSchema, type AppSetting } from "../shared/appSettings.js";
import { AppSettingsService, inspectSetting, replaceSetting, APP_SETTINGS_FILE } from "./appSettings.js";

const setting: AppSetting = { id: "server", label: "Server environment", targets: [{ id: "value", file: "lib/config/app_environment.dart", template: "static const current = {{setting}};" }], options: ["ngrok", "production", "localhost"].map((id) => ({ id, label: id, values: { value: id } })) };
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const folders: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "flutter-app-settings-")); folders.push(root);
  const file = path.join(root, setting.targets[0].file);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "class AppEnvironment {\r\n  static const current = ngrok;\r\n  static const another = ngrok;\r\n}\r\n");
  const fs = {
    readFileBytes: vi.fn(async (filePath: string) => new Uint8Array(await readFile(filePath))),
    mkdir: vi.fn(async (directory: string) => { await mkdir(directory, { recursive: true }); }),
    writeFile: vi.fn(async (filePath: string, content: string, options: { expectedRevision?: string | null }) => {
      let revision: string | null = null;
      try { revision = hash(await readFile(filePath)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (revision !== options.expectedRevision) throw Object.assign(new Error("REVISION_MISMATCH: file changed"), { code: "REVISION_MISMATCH" });
      await writeFile(filePath, content); return { revision: hash(content) };
    }),
  };
  const service = new AppSettingsService({ fs: fs as unknown as PluginHostApi["fs"] });
  const config = { schemaVersion: 1 as const, appSettings: [setting] };
  return { root, file, fs, service, config };
}

describe("App settings matching", () => {
  it("changes only the declared value, preserving BOM, indentation and CRLF", () => {
    const text = "\uFEFFclass Test {\r\n\tstatic const current = ngrok;\r\n  final other = ngrok;\r\n}\r\n";
    const change = replaceSetting(text, setting, "production");
    expect(change.text).toBe(text.replace("current = ngrok", "current = production"));
    expect(change.before).toBe("\tstatic const current = ngrok;");
    expect(change.after).toBe("\tstatic const current = production;");
  });
  it("supports a single line with BOM and no final newline", () => {
    expect(replaceSetting("\uFEFFstatic const current = ngrok;", setting, "localhost").after).toBe("\uFEFFstatic const current = localhost;");
  });
  it("detects unknown current values without choosing a default", () => {
    expect(inspectSetting("  static const current = staging;", setting).value).toBe("staging");
  });
  it("rejects missing, ambiguous and regex-like templates without guessing", () => {
    expect(() => inspectSetting("static const unrelated = ngrok;", setting)).toThrow("does not match");
    expect(() => inspectSetting("static const current = ngrok;\nstatic const current = production;", setting)).toThrow("more than one");
    expect(() => inspectSetting("static const current = ngrok;", { ...setting, targets: [{ ...setting.targets[0], template: "static .* current = {{setting}};" }] })).toThrow("does not match");
  });
  it.each(["../outside.dart", "/outside.dart", "lib/../../outside.dart", "C:/outside.dart", "lib\\outside.dart"])("rejects escaping file paths: %s", (file) => {
    expect(appSettingSchema.safeParse({ ...setting, targets: [{ ...setting.targets[0], file }] }).success).toBe(false);
  });
  it("rejects malformed markers, duplicate choices and incomplete mappings", () => {
    for (const template of ["{{setting}}", "static const current = ngrok;", "{{setting}} + {{setting}}", "foo\n{{setting}}"])
      expect(appSettingSchema.safeParse({ ...setting, targets: [{ ...setting.targets[0], template }] }).success).toBe(false);
    expect(appSettingSchema.safeParse({ ...setting, options: [setting.options[0], setting.options[0]] }).success).toBe(false);
    expect(appSettingSchema.safeParse({ ...setting, options: [setting.options[0], { id: "other", label: "Other", values: {} }] }).success).toBe(false);
    expect(appSettingsConfigSchema.safeParse({ schemaVersion: 1, appSettings: [setting, setting] }).success).toBe(false);
  });
});

describe("App settings source editing", () => {
  it("adds a portable definition without editing source, then previews and applies each option", async () => {
    const { root, file, fs, service, config } = await fixture();
    const original = await readFile(file, "utf8");
    expect(await service.load(root)).toEqual({ config: { schemaVersion: 1, appSettings: [] }, revision: null });
    await service.save(root, config, null);
    expect(await readFile(file, "utf8")).toBe(original);
    expect(JSON.parse(await readFile(path.join(root, APP_SETTINGS_FILE), "utf8"))).toEqual(config);
    for (const option of setting.options) {
      const preview = await service.preview(root, setting.id, option.id);
      const before = await readFile(file, "utf8");
      expect(await readFile(file, "utf8")).toBe(before);
      await service.apply(root, preview);
      const source = await readFile(file, "utf8");
      expect(source).toBe(before.replace(/current = [^;]+;/, `current = ${option.id};`));
      expect(source).toContain("another = ngrok;");
      expect(await service.statuses(root, config)).toEqual([{ id: setting.id, optionId: option.id, value: option.id, error: null }]);
    }
    expect(fs.writeFile).toHaveBeenCalled();
  });
  it("reads external edits as custom or invalid states", async () => {
    const { root, file, service, config } = await fixture();
    await writeFile(file, "static const current = staging;");
    expect((await service.statuses(root, config))[0]).toMatchObject({ value: "staging", optionId: null, error: null });
    await writeFile(file, "unrelated");
    expect((await service.statuses(root, config))[0].error).toContain("does not match");
  });
  it("refuses stale source and definition previews, preserving external edits", async () => {
    const { root, file, service, config } = await fixture();
    await service.save(root, config, null);
    const preview = await service.preview(root, setting.id, "production");
    await writeFile(file, (await readFile(file, "utf8")) + "// user edit\n");
    await expect(service.apply(root, preview)).rejects.toThrow("changed");
    expect(await readFile(file, "utf8")).toContain("// user edit");
    const next = await service.preview(root, setting.id, "production");
    await writeFile(path.join(root, APP_SETTINGS_FILE), JSON.stringify({ ...config, appSettings: [{ ...setting, label: "Updated by editor" }] }));
    await expect(service.apply(root, next)).rejects.toThrow("changed");
    await expect(service.save(root, config, preview.definitionRevision)).rejects.toThrow("changed");
  });
  it("rejects a preview from another app even when definitions and source match", async () => {
    const first = await fixture(), second = await fixture();
    await first.service.save(first.root, first.config, null);
    await second.service.save(second.root, second.config, null);
    const preview = await first.service.preview(first.root, setting.id, "production");
    await expect(second.service.apply(second.root, preview)).rejects.toThrow("another Flutter project");
    expect(await readFile(second.file, "utf8")).toContain("current = ngrok;");
  });
  it("preserves edits made between the final read and write", async () => {
    const { root, file, fs, service, config } = await fixture();
    await service.save(root, config, null);
    const preview = await service.preview(root, setting.id, "production");
    const write = fs.writeFile.getMockImplementation()!;
    fs.writeFile.mockImplementationOnce(async (...args) => { await writeFile(file, "// replaced by editor\n"); return write(...args); });
    await expect(service.apply(root, preview)).rejects.toThrow("REVISION_MISMATCH");
    expect(await readFile(file, "utf8")).toBe("// replaced by editor\n");
  });
  it("removes broken definitions without changing source", async () => {
    const { root, file, service, config } = await fixture();
    await service.save(root, config, null);
    const { revision } = await service.load(root);
    await writeFile(file, "// target removed");
    await service.save(root, { schemaVersion: 1, appSettings: [] }, revision);
    expect(await readFile(file, "utf8")).toBe("// target removed");
  });
  it("rejects source and definition symlinks outside the bound app", async () => {
    const { root, service, config } = await fixture();
    const outside = await mkdtemp(path.join(tmpdir(), "flutter-app-settings-outside-")); folders.push(outside);
    await writeFile(path.join(outside, "config.dart"), "static const current = ngrok;");
    await symlink(outside, path.join(root, "escape"));
    await expect(service.save(root, { ...config, appSettings: [{ ...setting, targets: [{ ...setting.targets[0], file: "escape/config.dart" }] }] }, null)).rejects.toThrow("outside");
    await symlink(outside, path.join(root, ".daintree"));
    await expect(service.load(root)).rejects.toThrow("outside");
  });
  it("does not bypass a denied host write", async () => {
    const { root, file, fs, service, config } = await fixture();
    await service.save(root, config, null);
    const preview = await service.preview(root, setting.id, "production");
    fs.writeFile.mockRejectedValueOnce(new Error("Permission denied"));
    await expect(service.apply(root, preview)).rejects.toThrow("Permission denied");
    expect(await readFile(file, "utf8")).toContain("current = ngrok;");
  });
  it("serializes operations on the same app and allows other apps independently", async () => {
    const { root, service } = await fixture();
    const order: string[] = [];
    let release!: () => void;
    const first = service.exclusive(root, async () => { order.push("first"); await new Promise<void>((resolve) => { release = resolve; }); });
    await vi.waitFor(() => expect(order).toEqual(["first"]));
    const second = service.exclusive(root, async () => { order.push("second"); });
    await service.exclusive(root + "-other", async () => { order.push("other"); });
    expect(order).toEqual(["first", "other"]);
    release(); await Promise.all([first, second]);
    expect(order).toEqual(["first", "other", "second"]);
  });
});
