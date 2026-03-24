import { useEffect, useRef } from "react";
import type { SessionId, SshOutputPayload } from "../types";

export function useSshOutput(
  sessionId: SessionId | null,
  onData: (data: Uint8Array) => void,
): void {
  const onDataRef = useRef(onData);
  onDataRef.current = onData;

  useEffect(() => {
    if (!sessionId) return;

    let unlisten: (() => void) | undefined;
    let cancelled = false;

    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      if (cancelled) return;

      unlisten = await listen<SshOutputPayload>("ssh:output", (event) => {
        if (event.payload.session_id === sessionId) {
          onDataRef.current(new Uint8Array(event.payload.data));
        }
      });
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [sessionId]);
}
