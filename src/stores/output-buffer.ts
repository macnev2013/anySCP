import type { SessionId, SshOutputPayload } from "../types";

/**
 * Module-level circular buffer per session.
 * Captures SSH output globally (outside React lifecycle) so terminal
 * content survives component unmount/remount cycles.
 */

const MAX_BUFFER_BYTES = 256 * 1024; // 256 KB per session

interface SessionBuffer {
  chunks: Uint8Array[];
  totalBytes: number;
  unlisten?: () => void;
}

const buffers = new Map<SessionId, SessionBuffer>();

/** Start capturing output for a session. Call once when the session is created. */
export async function startBuffering(sessionId: SessionId): Promise<void> {
  if (buffers.has(sessionId)) return;

  const buf: SessionBuffer = { chunks: [], totalBytes: 0 };
  buffers.set(sessionId, buf);

  const { listen } = await import("@tauri-apps/api/event");
  buf.unlisten = await listen<SshOutputPayload>("ssh:output", (event) => {
    if (event.payload.session_id === sessionId) {
      const data = new Uint8Array(event.payload.data);
      buf.chunks.push(data);
      buf.totalBytes += data.length;

      // Trim from the front if we exceed the cap
      while (buf.totalBytes > MAX_BUFFER_BYTES && buf.chunks.length > 1) {
        const removed = buf.chunks.shift()!;
        buf.totalBytes -= removed.length;
      }
    }
  });
}

/** Stop capturing and discard buffer for a session. */
export function stopBuffering(sessionId: SessionId): void {
  const buf = buffers.get(sessionId);
  if (!buf) return;
  buf.unlisten?.();
  buffers.delete(sessionId);
}

/** Drain all buffered chunks (returns them and clears the buffer). */
export function drainBuffer(sessionId: SessionId): Uint8Array[] {
  const buf = buffers.get(sessionId);
  if (!buf) return [];
  const chunks = buf.chunks.splice(0);
  buf.totalBytes = 0;
  return chunks;
}
