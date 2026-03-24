import { X } from "lucide-react";
import { useSftpStore } from "../../stores/sftp-store";

export function SftpTabs() {
  const sessions = useSftpStore((s) => s.sessions);
  const activeSftpSessionId = useSftpStore((s) => s.activeSftpSessionId);
  const setActiveSftpSession = useSftpStore((s) => s.setActiveSftpSession);
  const closeSession = useSftpStore((s) => s.closeSession);

  if (sessions.size === 0) return null;

  const sessionList = Array.from(sessions.values());

  const handleClose = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("sftp_close", { sftpSessionId: id });
    } catch {
      // Already closed
    }
    closeSession(id);
  };

  return (
    <div className="flex items-end h-[var(--tabbar-height)] bg-bg-surface border-b border-border no-select px-1.5">
      <div className="flex items-end gap-1 overflow-x-auto flex-1 min-w-0 pb-0">
        {sessionList.map((session) => {
          const isActive = session.sftpSessionId === activeSftpSessionId;

          return (
            <button
              key={session.sftpSessionId}
              onClick={() => setActiveSftpSession(session.sftpSessionId)}
              title={session.label}
              className={[
                "group relative flex items-center gap-2 px-3.5 h-[32px] shrink-0 max-w-[220px]",
                "text-[length:var(--text-sm)] leading-none rounded-t-lg",
                "transition-[color,background-color,box-shadow] duration-[var(--duration-fast)]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                isActive
                  ? "bg-bg-base text-text-primary shadow-[0_-1px_0_0_var(--color-border),1px_0_0_0_var(--color-border),-1px_0_0_0_var(--color-border)]"
                  : "text-text-secondary hover:text-text-primary hover:bg-bg-base/30",
              ].join(" ")}
            >
              <span className={`truncate ${isActive ? "font-medium" : ""}`}>
                {session.label}
              </span>

              <button
                onClick={(e) => void handleClose(session.sftpSessionId, e)}
                className={[
                  "ml-auto p-1 -mr-1 rounded shrink-0",
                  "text-text-muted hover:text-text-primary hover:bg-bg-muted",
                  isActive ? "opacity-50 group-hover:opacity-100" : "opacity-0 group-hover:opacity-100",
                  "transition-all duration-[var(--duration-fast)]",
                  "focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                ].join(" ")}
                aria-label={`Close ${session.label}`}
                tabIndex={-1}
              >
                <X size={12} strokeWidth={2} aria-hidden="true" />
              </button>

              {isActive && (
                <span
                  className="absolute -bottom-px left-0 right-0 h-px bg-bg-base"
                  aria-hidden="true"
                />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
