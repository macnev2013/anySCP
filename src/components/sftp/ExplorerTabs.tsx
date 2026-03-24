import { X, FolderOpen, Cloud } from "lucide-react";
import { useSftpStore } from "../../stores/sftp-store";
import { useS3Store } from "../../stores/s3-store";

export type ExplorerTab =
  | { type: "sftp"; id: string; label: string }
  | { type: "s3"; id: string; label: string };

interface ExplorerTabsProps {
  activeTab: ExplorerTab | null;
  onSelectTab: (tab: ExplorerTab) => void;
}

export function ExplorerTabs({ activeTab, onSelectTab }: ExplorerTabsProps) {
  const sftpSessions = useSftpStore((s) => s.sessions);
  const closeSftpSession = useSftpStore((s) => s.closeSession);
  const s3Sessions = useS3Store((s) => s.sessions);
  const closeS3Session = useS3Store((s) => s.closeSession);

  // Build unified tab list
  const tabs: ExplorerTab[] = [
    ...Array.from(sftpSessions.values()).map((s) => ({
      type: "sftp" as const,
      id: s.sftpSessionId,
      label: s.label,
    })),
    ...Array.from(s3Sessions.values()).map((s) => ({
      type: "s3" as const,
      id: s.sessionId,
      label: s.label,
    })),
  ];

  if (tabs.length === 0) return null;

  const handleClose = async (tab: ExplorerTab, e: React.MouseEvent) => {
    e.stopPropagation();
    if (tab.type === "sftp") {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("sftp_close", { sftpSessionId: tab.id });
      } catch { /* already closed */ }
      closeSftpSession(tab.id);
    } else {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("s3_disconnect", { s3SessionId: tab.id });
      } catch { /* already closed */ }
      closeS3Session(tab.id);
    }
  };

  const isActive = (tab: ExplorerTab) =>
    activeTab?.type === tab.type && activeTab?.id === tab.id;

  return (
    <div className="flex items-end h-[var(--tabbar-height)] bg-bg-surface border-b border-border no-select px-1.5">
      <div className="flex items-end gap-1 overflow-x-auto overflow-y-hidden flex-1 min-w-0 pb-0">
        {tabs.map((tab) => {
          const active = isActive(tab);
          const Icon = tab.type === "sftp" ? FolderOpen : Cloud;

          return (
            <button
              key={`${tab.type}-${tab.id}`}
              onClick={() => onSelectTab(tab)}
              title={tab.label}
              className={[
                "group relative flex items-center gap-2 px-3.5 h-[32px] shrink-0 max-w-[220px]",
                "text-[length:var(--text-sm)] leading-none rounded-t-lg",
                "transition-[color,background-color,box-shadow] duration-[var(--duration-fast)]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                active
                  ? "bg-bg-base text-text-primary shadow-[0_-1px_0_0_var(--color-border),1px_0_0_0_var(--color-border),-1px_0_0_0_var(--color-border)]"
                  : "text-text-secondary hover:text-text-primary hover:bg-bg-base/30",
              ].join(" ")}
            >
              <Icon
                size={13}
                strokeWidth={1.8}
                className={active ? "text-accent shrink-0" : "text-text-muted shrink-0"}
                aria-hidden="true"
              />

              <span className={`truncate ${active ? "font-medium" : ""}`}>
                {tab.label}
              </span>

              <button
                onClick={(e) => void handleClose(tab, e)}
                className={[
                  "ml-auto p-1 -mr-1 rounded shrink-0",
                  "text-text-muted hover:text-text-primary hover:bg-bg-muted",
                  active ? "opacity-50 group-hover:opacity-100" : "opacity-0 group-hover:opacity-100",
                  "transition-all duration-[var(--duration-fast)]",
                  "focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                ].join(" ")}
                aria-label={`Close ${tab.label}`}
                tabIndex={-1}
              >
                <X size={12} strokeWidth={2} aria-hidden="true" />
              </button>

              {active && (
                <span className="absolute -bottom-px left-0 right-0 h-px bg-bg-base" aria-hidden="true" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
