import { useEffect } from "react";
import { usePortForwardStore } from "../stores/port-forward-store";
import type { TunnelStatus } from "../types";

/**
 * Listens to `pf:status` Tauri events and updates the port forward store.
 * Mount once globally (in AppShell).
 */
export function usePortForwardEvents() {
  const updateTunnelStatus = usePortForwardStore((s) => s.updateTunnelStatus);

  useEffect(() => {
    let aborted = false;
    let unlisten: (() => void) | undefined;

    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        if (aborted) return;

        const unsub = await listen<TunnelStatus>("pf:status", (event) => {
          updateTunnelStatus(event.payload);
        });

        if (aborted) { unsub(); } else { unlisten = unsub; }
      } catch {
        // Tauri API not available
      }
    })();

    return () => {
      aborted = true;
      unlisten?.();
    };
  }, [updateTunnelStatus]);
}
