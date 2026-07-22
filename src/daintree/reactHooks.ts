import { useCallback, useEffect, useRef, useState } from "react";

interface PluginBridge {
  invoke(pluginId: string, channel: string, ...args: unknown[]): Promise<unknown>;
  onPanel(pluginId: string, channel: string, panelId: string, callback: (payload: unknown) => void): () => void;
}
interface BridgeGlobal { electron?: { plugin?: PluginBridge } }
interface ChannelResult<TArgs, TResult> { invoke(args: TArgs): Promise<TResult | undefined>; loading: boolean; error: Error | null }

function bridge(): PluginBridge {
  const value = (globalThis as unknown as BridgeGlobal).electron?.plugin;
  if (!value) throw new Error("Daintree's plugin renderer bridge is unavailable.");
  return value;
}

/** Compatibility adapter for the public renderer bridge; remove once the
 * shipped SDK/react entry no longer embeds a second React runtime. */
export function useHostChannel<TArgs = unknown, TResult = unknown>(pluginId: string, channel: string): ChannelResult<TArgs, TResult> {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const callId = useRef(0);
  useEffect(() => { setLoading(false); setError(null); }, [pluginId, channel]);
  const invoke = useCallback(async (args: TArgs) => {
    const id = ++callId.current; setLoading(true); setError(null);
    try { const result = await bridge().invoke(pluginId, channel, args) as TResult; return id === callId.current ? result : undefined; }
    catch (cause) { if (id === callId.current) setError(cause instanceof Error ? cause : new Error(String(cause))); return undefined; }
    finally { if (id === callId.current) setLoading(false); }
  }, [pluginId, channel]);
  return { invoke, loading, error };
}

export function usePluginPanelEvent<TPayload = unknown>(pluginId: string, channel: string, panelId: string, handler: (payload: TPayload) => void): void {
  const latest = useRef(handler); useEffect(() => { latest.current = handler; });
  useEffect(() => bridge().onPanel(pluginId, channel, panelId, (payload) => latest.current(payload as TPayload)), [pluginId, channel, panelId]);
}
