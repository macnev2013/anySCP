import { useEffect } from "react";
import { usePortForwardStore } from "../stores/port-forward-store";
import { toast } from "../stores/toast-store";
import type { TunnelStatus } from "../types";

/**
 * Listens to `pf:status` Tauri events and updates the port forward store.
 * Mount once globally (in AppShell).
 *
 * Backend-driven failures (most importantly tunnels auto-started on host
 * connect — e.g. a privileged/blocked port that can't bind) arrive here as an
 * `Error` status. Surface those as a toast so the user finds out even when the
 * Tunnels page isn't open; the per-card error remains as the persistent detail.
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
          const status = event.payload;
          if (status.status === "Error" && status.error) {
            const rule = usePortForwardStore
              .getState()
              .rules.find((r) => r.id === status.rule_id);
            const name = rule?.label || `Port ${status.local_port || rule?.local_port || ""}`.trim();
            toast.error(`Tunnel “${name}” failed to start: ${status.error}`);
          }
          updateTunnelStatus(status);
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
