import { z } from "zod";

const id = z.string().regex(/^[a-zA-Z0-9_-]+$/).max(80);
const singleLine = z.string().min(1).max(1000).regex(/^[^\r\n\0]+$/, "Use a single line");
export const appSettingSchema = z.object({
  id,
  label: z.string().trim().min(1).max(100),
  targets: z.array(z.object({ id, file: z.string().min(1).max(500).refine((value) => !value.startsWith("/") && !value.includes("\\") && !value.split("/").some((part) => part === ".." || part === "." || !part) && !/^[A-Za-z]:/.test(value) && !/[\r\n\0]/.test(value), "Use a path relative to the Flutter project"), template: singleLine.refine((value) => value.split("{{setting}}").length === 2 && value.replace("{{setting}}", "").trim().length > 0, "Include exactly one {{setting}} marker and identifying text") })).length(1, "MVP settings change one target"),
  options: z.array(z.object({ id, label: z.string().trim().min(1).max(100), values: z.record(z.string(), singleLine) })).min(2).max(30),
}).superRefine((setting, ctx) => {
  const targetId = setting.targets[0]?.id;
  const ids = new Set<string>(), labels = new Set<string>(), values = new Set<string>();
  for (const option of setting.options) {
    if (ids.has(option.id) || labels.has(option.label)) ctx.addIssue({ code: "custom", message: "Option IDs and labels must be unique" });
    ids.add(option.id); labels.add(option.label);
    if (Object.keys(option.values).length !== 1 || !targetId || !(targetId in option.values)) ctx.addIssue({ code: "custom", message: "Each option must provide the target value" });
    const value = option.values[targetId ?? ""];
    if (values.has(value)) ctx.addIssue({ code: "custom", message: "Option values must be distinct" });
    values.add(value);
  }
});
export const appSettingsConfigSchema = z.object({ schemaVersion: z.literal(1), appSettings: z.array(appSettingSchema).max(40) }).superRefine((config, ctx) => {
  if (new Set(config.appSettings.map((setting) => setting.id)).size !== config.appSettings.length) ctx.addIssue({ code: "custom", message: "Setting IDs must be unique" });
});
export type AppSetting = z.infer<typeof appSettingSchema>;
export type AppSettingsConfig = z.infer<typeof appSettingsConfigSchema>;
export const appSettingStatusSchema = z.object({ id: z.string(), value: z.string().nullable(), optionId: z.string().nullable(), error: z.string().nullable() });
export const appSettingsStateSchema = z.object({ config: appSettingsConfigSchema, revision: z.string().nullable(), statuses: z.array(appSettingStatusSchema), active: z.boolean(), watchWarning: z.string().nullable().default(null) });
export type AppSettingsState = z.infer<typeof appSettingsStateSchema>;
export const appSettingPreviewSchema = z.object({ projectPath: z.string().min(1), settingId: z.string(), optionId: z.string(), file: z.string(), before: z.string(), after: z.string(), sourceRevision: z.string(), definitionRevision: z.string().nullable() });
export type AppSettingPreview = z.infer<typeof appSettingPreviewSchema>;
