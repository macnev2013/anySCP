import { useEffect } from "react";
import { useSessionStore } from "../stores/session-store";
import type { SshStatusPayload } from "../types";

/**
 * Global listener for `ssh:status` events emitted by the Rust backend.
 * Updates the session store so the UI reflects connection state changes.
 * Mount once in AppShell.
 */
export function useSshStatus(): void {
  const updateStatus = useSessionStore((s) => s.updateStatus);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      if (cancelled) return;

      unlisten = await listen<SshStatusPayload>("ssh:status", (event) => {
        const { session_id, status } = event.payload;
        updateStatus(session_id, status.status, status.message);
      });
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [updateStatus]);
}
