import path from "node:path";
import { launchParametersSchema, type FlutterPanelBinding, type LaunchParameters } from "../shared/contracts.js";

export const EMPTY_LAUNCH_PARAMETERS: LaunchParameters = { dartDefines: [] };
export const LAUNCH_PARAMETERS_STORAGE_KEY = "launch-parameters-v1";

interface LaunchParameterStorage {
  get<T = unknown>(key: string, scope?: "user"): Promise<T | undefined>;
  set<T = unknown>(key: string, value: T, scope?: "user"): Promise<void>;
}

type StoredLaunchParameterEntry = { identity: string; parameters: LaunchParameters };

function parseRegistry(value: unknown): StoredLaunchParameterEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const entry = candidate as Record<string, unknown>;
    const parameters = launchParametersSchema.safeParse(entry.parameters);
    return typeof entry.identity === "string" && parameters.success ? [{ identity: entry.identity, parameters: parameters.data }] : [];
  });
}

export function launchParameterIdentity(binding: FlutterPanelBinding): string | null {
  if (!binding.flutterProjectPath) return null;
  const relativeProject = path.relative(path.resolve(binding.worktreePath), path.resolve(binding.flutterProjectPath)) || ".";
  return `${binding.worktreeId}:${relativeProject.split(path.sep).join("/")}`;
}

export function dartDefineArguments(parameters: LaunchParameters): string[] {
  return parameters.dartDefines.filter((define) => define.enabled).map((define) => `--dart-define=${define.key}=${define.value}`);
}

export function applyLaunchParameters(extraArgs: readonly string[], parameters: LaunchParameters): string[] {
  const retained: string[] = [];
  for (let index = 0; index < extraArgs.length; index += 1) {
    const argument = extraArgs[index]!;
    if (argument === "--dart-define") { index += 1; continue; }
    if (argument.startsWith("--dart-define=")) continue;
    retained.push(argument);
  }
  return [...retained, ...dartDefineArguments(parameters)];
}

export class LaunchParameterStore {
  private writeQueue = Promise.resolve();

  constructor(private readonly storage: LaunchParameterStorage) {}

  async load(binding: FlutterPanelBinding): Promise<LaunchParameters> {
    const identity = launchParameterIdentity(binding);
    if (!identity) return { ...EMPTY_LAUNCH_PARAMETERS, dartDefines: [] };
    const registry = parseRegistry(await this.storage.get<unknown>(LAUNCH_PARAMETERS_STORAGE_KEY, "user"));
    const stored = registry.find((entry) => entry.identity === identity)?.parameters;
    return stored ? { dartDefines: stored.dartDefines.map((define) => ({ ...define })) } : { dartDefines: [] };
  }

  async save(binding: FlutterPanelBinding, parameters: LaunchParameters): Promise<LaunchParameters> {
    const identity = launchParameterIdentity(binding);
    if (!identity) throw new Error("Select a Flutter project before editing launch parameters");
    const validated = launchParametersSchema.parse(parameters);
    const work = this.writeQueue.then(async () => {
      const registry = parseRegistry(await this.storage.get<unknown>(LAUNCH_PARAMETERS_STORAGE_KEY, "user"));
      const next = registry.filter((entry) => entry.identity !== identity);
      if (validated.dartDefines.length) next.push({ identity, parameters: validated });
      await this.storage.set(LAUNCH_PARAMETERS_STORAGE_KEY, next, "user");
    });
    this.writeQueue = work.catch(() => {});
    await work;
    return { dartDefines: validated.dartDefines.map((define) => ({ ...define })) };
  }
}
