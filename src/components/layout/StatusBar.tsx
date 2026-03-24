import { useSessionStore } from "../../stores/session-store";
import { useEffect, useState } from "react";

export function StatusBar() {
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const sessionCount = sessions.size;
  const activeSession = activeSessionId ? sessions.get(activeSessionId) : null;

  const [elapsed, setElapsed] = useState("");

  useEffect(() => {
    if (!activeSession || activeSession.status !== "Connected") {
      setElapsed("");
      return;
    }

    const start = Date.now();
    const interval = setInterval(() => {
      const diff = Math.floor((Date.now() - start) / 1000);
      const h = Math.floor(diff / 3600);
      const m = Math.floor((diff % 3600) / 60);
      const s = diff % 60;
      setElapsed(
        h > 0
          ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
          : `${m}:${String(s).padStart(2, "0")}`,
      );
    }, 1000);

    return () => clearInterval(interval);
  }, [activeSession]);

  const statusColor = !activeSession
    ? "bg-status-disconnected"
    : activeSession.status === "Connected"
      ? "bg-status-connected"
      : activeSession.status === "Connecting"
        ? "bg-status-connecting"
        : activeSession.status === "Error"
          ? "bg-status-error"
          : "bg-status-disconnected";

  return (
    <div className="flex items-center h-[var(--statusbar-height)] px-3 bg-bg-surface border-t border-border text-[length:var(--text-xs)] text-text-secondary no-select">
      {activeSession ? (
        <>
          <span className="flex items-center gap-1.5">
            <span className={`w-1.5 h-1.5 rounded-full ${statusColor} ${activeSession.status === "Connecting" ? "motion-safe:animate-pulse" : ""}`} />
            <span className="font-mono text-text-primary">
              {activeSession.hostConfig.username}@{activeSession.hostConfig.host}:{activeSession.hostConfig.port}
            </span>
          </span>
          <span className="mx-2 w-px h-3 bg-border" />
          <span>{activeSession.status}</span>
          {elapsed && (
            <>
              <span className="mx-2 w-px h-3 bg-border" />
              <span className="font-mono tabular-nums">{elapsed}</span>
            </>
          )}
          <span className="flex-1" />
          <span className="font-mono text-text-muted tabular-nums">
            {sessionCount} session{sessionCount !== 1 ? "s" : ""}
          </span>
        </>
      ) : (
        <span className="text-text-muted">No active session</span>
      )}
    </div>
  );
}
