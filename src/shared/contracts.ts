import { z } from "zod";

export const flutterPanelBindingSchema = z.object({
  schemaVersion: z.literal(1),
  worktreeId: z.string().min(1),
  worktreeName: z.string().min(1),
  worktreePath: z.string().min(1),
  flutterProjectPath: z.string().min(1).nullable(),
});
export type FlutterPanelBinding = z.infer<typeof flutterPanelBindingSchema>;

export const deviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  platform: z.string(),
  category: z.string().nullable(),
  emulator: z.boolean(),
  ephemeral: z.boolean(),
  sdk: z.string().nullable(),
  capabilities: z.object({ hotReload: z.boolean(), hotRestart: z.boolean(), screenshot: z.boolean(), fastStart: z.boolean() }),
});
export type FlutterDevice = z.infer<typeof deviceSchema>;

export const projectSchema = z.object({ path: z.string(), name: z.string(), relativePath: z.string() });
export type FlutterProject = z.infer<typeof projectSchema>;

export const consoleRecordSchema = z.object({
  id: z.number().int().nonnegative(),
  at: z.string(),
  stream: z.enum(["stdout", "stderr", "tool", "system"]),
  level: z.enum(["info", "warning", "error"]),
  text: z.string(),
});
export type ConsoleRecord = z.infer<typeof consoleRecordSchema>;

export const runStateSchema = z.enum(["idle", "starting", "running", "reloading", "restarting", "stopping", "stopped", "detached", "failed"]);
export type RunState = z.infer<typeof runStateSchema>;

export const runSnapshotSchema = z.object({ state: runStateSchema, appId: z.string().nullable(), deviceId: z.string().nullable(), vmServiceUri: z.string().nullable(), devToolsUri: z.string().nullable(), startedAt: z.string().nullable(), error: z.string().nullable() });
export const deviceSessionSchema = z.object({ deviceId: z.string().min(1), state: runStateSchema, appId: z.string().nullable(), startedAt: z.string().nullable() });

export const snapshotSchema = z.object({
  binding: flutterPanelBindingSchema,
  projects: z.array(projectSchema),
  devices: z.array(deviceSchema),
  selectedDeviceId: z.string().nullable(),
  sdk: z.object({ executable: z.string(), source: z.enum(["setting", "fvm", "path"]), version: z.string().nullable() }).nullable(),
  run: runSnapshotSchema,
  sessions: z.array(deviceSessionSchema),
  console: z.array(consoleRecordSchema),
  sequence: z.number().int().nonnegative(),
});
export type FlutterWorkspaceSnapshot = z.infer<typeof snapshotSchema>;

export const panelArgsSchema = z.object({ panelId: z.string().min(1), initialArgs: z.record(z.string(), z.unknown()).optional() });
export const setProjectArgsSchema = panelArgsSchema.extend({ projectPath: z.string().min(1) });
export const selectDeviceArgsSchema = panelArgsSchema.extend({ deviceId: z.string().min(1) });
export const devicePanelArgsSchema = panelArgsSchema.extend({ deviceId: z.string().min(1) });
export const runArgsSchema = devicePanelArgsSchema.extend({ mode: z.enum(["debug", "profile", "release"]).default("debug"), entrypoint: z.string().optional(), extraArgs: z.array(z.string()).max(40).default([]) });
export const controlArgsSchema = devicePanelArgsSchema.extend({ operation: z.enum(["hotReload", "hotRestart", "stop", "detach"]) });
export const screenshotArgsSchema = devicePanelArgsSchema.extend({ copyToClipboard: z.boolean().default(false) });

export const operationResultSchema = z.object({ ok: z.boolean(), message: z.string() });
export const screenshotResultSchema = z.object({ ok: z.boolean(), message: z.string(), deviceId: z.string(), filePath: z.string().nullable(), dataUrl: z.string().nullable(), copied: z.boolean() });
export const consoleBatchSchema = z.object({ deviceId: z.string().min(1), sequence: z.number().int().nonnegative(), records: z.array(consoleRecordSchema) });
export type ConsoleBatch = z.infer<typeof consoleBatchSchema>;
