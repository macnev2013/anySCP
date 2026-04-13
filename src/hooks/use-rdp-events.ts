import { useEffect, useRef } from "react";
import type { RdpSessionId, RdpStatusPayload } from "../types";

export function useRdpStatus(
  sessionId: RdpSessionId | null,
  onStatus: (payload: RdpStatusPayload) => void,
): void {
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;

  useEffect(() => {
    if (!sessionId) return;

    let unlisten: (() => void) | undefined;
    let cancelled = false;

    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      if (cancelled) return;

      unlisten = await listen<RdpStatusPayload>("rdp:status", (event) => {
        if (event.payload.session_id === sessionId) {
          onStatusRef.current(event.payload);
        }
      });
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [sessionId]);
}
