import { useState } from "react";
import { TerminalSquare, FolderOpen, Loader2 } from "lucide-react";
import { useSessionStore } from "../../stores/session-store";
import { useSftpStore } from "../../stores/sftp-store";

export function SftpSessionPicker() {
  const sessions = useSessionStore((s) => s.sessions);
  const openSession = useSftpStore((s) => s.openSession);

  const [openingId, setOpeningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const connectedSessions = Array.from(sessions.values()).filter(
    (s) => s.status === "Connected",
  );

  const handleOpenSftp = async (sshSessionId: string, label: string) => {
    setOpeningId(sshSessionId);
    setError(null);

    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const sftpSessionId = await invoke<string>("sftp_open", { sessionId: sshSessionId });
      openSession(sftpSessionId, sshSessionId, label);
    } catch (err: unknown) {
      const msg =
        err && typeof err === "object" && "message" in err
          ? String((err as { message: string }).message)
          : "Failed to open SFTP session";
      setError(msg);
    } finally {
      setOpeningId(null);
    }
  };

  // ─── Status dot ───────────────────────────────────────────────────────────

  const statusColor = (status: string) => {
    switch (status) {
      case "Connected": return "var(--color-status-connected)";
      case "Connecting": return "var(--color-status-connecting)";
      case "Error": return "var(--color-status-error)";
      default: return "var(--color-status-disconnected)";
    }
  };

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full overflow-y-auto bg-bg-base">
      <div className="max-w-lg w-full mx-auto px-8 py-12 flex flex-col gap-6">

        {/* Header */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2.5">
            <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-bg-surface border border-border">
              <FolderOpen size={20} strokeWidth={1.8} className="text-accent" aria-hidden="true" />
            </div>
            <h1 className="text-[length:var(--text-lg)] font-semibold text-text-primary">
              File Browser
            </h1>
          </div>
          <p className="text-[length:var(--text-sm)] text-text-muted">
            Select an active SSH session to browse its filesystem.
          </p>
        </div>

        {/* Error banner */}
        {error && (
          <div className="px-4 py-3 rounded-lg bg-status-error/10 border border-status-error/20">
            <p className="text-[length:var(--text-sm)] text-status-error">{error}</p>
          </div>
        )}

        {/* Session list */}
        {connectedSessions.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="flex flex-col gap-2">
            <h2 className="text-[length:var(--text-xs)] font-semibold uppercase tracking-widest text-text-muted">
              Active Sessions
            </h2>

            <div className="flex flex-col gap-1.5">
              {connectedSessions.map((session) => {
                const isOpening = openingId === session.id;

                return (
                  <div
                    key={session.id}
                    className={[
                      "flex items-center gap-3 px-4 py-3 rounded-xl",
                      "bg-bg-surface border border-border",
                      "hover:border-border-focus hover:bg-bg-overlay",
                      "transition-all duration-[var(--duration-fast)]",
                    ].join(" ")}
                  >
                    {/* Session icon */}
                    <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-bg-base shrink-0">
                      <TerminalSquare size={15} strokeWidth={1.8} className="text-text-muted" aria-hidden="true" />
                    </div>

                    {/* Label + status */}
                    <div className="flex-1 min-w-0">
                      <p className="text-[length:var(--text-sm)] font-medium text-text-primary truncate">
                        {session.label}
                      </p>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <span
                          className="w-1.5 h-1.5 rounded-full shrink-0"
                          style={{ backgroundColor: statusColor(session.status) }}
                          aria-hidden="true"
                        />
                        <span className="text-[length:var(--text-xs)] text-text-muted capitalize">
                          {session.status}
                        </span>
                      </div>
                    </div>

                    {/* Open SFTP button */}
                    <button
                      onClick={() => void handleOpenSftp(session.id, session.label)}
                      disabled={isOpening}
                      title={`Open SFTP for ${session.label}`}
                      aria-label={`Open file browser for ${session.label}`}
                      className={[
                        "flex items-center gap-1.5 px-3 py-1.5 rounded-lg shrink-0",
                        "text-[length:var(--text-xs)] font-medium uppercase tracking-wide",
                        "bg-accent/10 text-accent border border-accent/20",
                        "hover:bg-accent/20 hover:border-accent/40",
                        "disabled:opacity-50 disabled:pointer-events-none",
                        "transition-all duration-[var(--duration-fast)]",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      ].join(" ")}
                    >
                      {isOpening ? (
                        <>
                          <Loader2 size={12} strokeWidth={2} className="animate-spin" aria-hidden="true" />
                          Opening…
                        </>
                      ) : (
                        <>
                          <FolderOpen size={12} strokeWidth={2} aria-hidden="true" />
                          Open SFTP
                        </>
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-4 py-16 text-center">
      <div className="flex items-center justify-center w-14 h-14 rounded-xl bg-bg-surface border border-border">
        <TerminalSquare size={24} strokeWidth={1.4} className="text-text-muted" aria-hidden="true" />
      </div>
      <div>
        <p className="text-[length:var(--text-sm)] font-medium text-text-secondary">
          No active SSH sessions
        </p>
        <p className="text-[length:var(--text-xs)] text-text-muted mt-1 max-w-xs">
          Connect to a host from the{" "}
          <span className="text-accent font-medium">Hosts</span> page first, then
          return here to browse files.
        </p>
      </div>
    </div>
  );
}
