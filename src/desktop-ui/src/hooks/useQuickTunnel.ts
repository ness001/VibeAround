import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type QuickTunnelStatus = {
  state: "stopped" | "starting" | "running" | "error";
  url: string | null;
  error: string | null;
};

type NativeQuickTunnelStatus = {
  status: "stopped" | "starting" | "running" | "failed";
  publicUrl: string | null;
  error: string | null;
};

function normalizeStatus(result: NativeQuickTunnelStatus): QuickTunnelStatus {
  return { state: result.status === "failed" ? "error" : result.status, url: result.publicUrl, error: result.error };
}

export function useQuickTunnel() {
  const [status, setStatus] = useState<QuickTunnelStatus>({ state: "stopped", url: null, error: null });
  const [busy, setBusy] = useState(false);
  const [available, setAvailable] = useState(false);
  const mounted = useRef(false);
  const changing = useRef(false);
  const generation = useRef(0);

  useEffect(() => {
    mounted.current = true;
    let timer: ReturnType<typeof setTimeout>;
    let disposed = false;
    async function refresh() {
      const current = generation.current;
      try {
        if (!changing.current) {
          const next = normalizeStatus(await invoke<NativeQuickTunnelStatus>("quick_tunnel_status"));
          if (!disposed && current === generation.current) {
            setStatus(next);
            setAvailable(true);
          }
        }
      } catch {
        if (!disposed && current === generation.current) setAvailable(false);
      } finally {
        if (!disposed) timer = setTimeout(() => void refresh(), 2000);
      }
    }
    void refresh();
    return () => {
      disposed = true;
      mounted.current = false;
      clearTimeout(timer);
    };
  }, []);

  const change = useCallback(async (command: "quick_tunnel_start" | "quick_tunnel_stop", cloudflaredPath?: string) => {
    if (changing.current) return false;
    changing.current = true;
    generation.current += 1;
    setBusy(true);
    try {
      const next = normalizeStatus(await invoke<NativeQuickTunnelStatus>(command, command === "quick_tunnel_start"
        ? { cloudflaredPath: cloudflaredPath?.trim() || null } : undefined));
      if (mounted.current) {
        setStatus(next);
        setAvailable(true);
      }
      return next.state !== "error";
    } catch (error) {
      if (mounted.current) setStatus({ state: "error", url: null, error: typeof error === "string" ? error : "Quick Tunnel command failed." });
      return false;
    } finally {
      changing.current = false;
      if (mounted.current) setBusy(false);
    }
  }, []);

  return { status, busy, available, start: (path?: string) => change("quick_tunnel_start", path), stop: () => change("quick_tunnel_stop") };
}
