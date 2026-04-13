import { Columns2, Rows2, Maximize2, Minimize2, X } from "lucide-react";
import { useSessionStore } from "../../stores/session-store";

interface PaneHeaderProps {
  sessionId: string;
}

export function PaneHeader({ sessionId }: PaneHeaderProps) {
  const session = useSessionStore((s) => s.sessions.get(sessionId));
  const isActive = useSessionStore((s) => s.activeSessionId === sessionId);
  const isZoomed = useSessionStore((s) => s.zoomedPaneId === sessionId);
  const hasSplits = useSessionStore((s) => {
    const tabId = s.activeTerminalTabId;
    if (!tabId) return false;
    const tab = s.tabs.get(tabId);
    return tab ? tab.layout.type === "split" : false;
  });

  if (!session) return null;

  const status = session.status;
  const dotColor =
    status === "Connected"    ? "bg-status-connected" :
    status === "Connecting"   ? "bg-status-connecting motion-safe:animate-pulse" :
    status === "Error"        ? "bg-status-error" :
                                "bg-status-disconnected";

  const handleSplit = (direction: "horizontal" | "vertical") => {
    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const newId = await invoke<string>("ssh_split_session", {
          sourceSessionId: sessionId,
        });
        useSessionStore.getState().splitPane(direction, sessionId, newId);
      } catch (err) {
        console.error("Split failed:", err);
      }
    })();
  };

  const handleClose = () => {
    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("ssh_disconnect", { sessionId });
      } catch { /* already disconnected */ }

      const store = useSessionStore.getState();
      if (hasSplits) {
        store.unsplitPane(sessionId);
      }
      store.removeSession(sessionId);
    })();
  };

  const handleZoom = () => {
    useSessionStore.getState().toggleZoom(sessionId);
  };

  const btnClass =
    "inline-flex items-center justify-center w-5 h-5 rounded text-text-muted hover:text-text-primary hover:bg-bg-muted transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

  return (
    <div
      className={[
        "flex items-center h-8 px-2.5 gap-2.5 shrink-0 no-select",
        "border-b transition-colors duration-[var(--duration-fast)]",
        isActive
          ? "bg-bg-surface/80 border-border/60"
          : "bg-bg-surface/40 border-border/30",
      ].join(" ")}
    >
      {/* Status dot */}
      <span className={`w-2 h-2 rounded-full shrink-0 ${dotColor}`} />

      {/* Host label */}
      <span
        className={[
          "text-[11px] font-mono truncate flex-1 min-w-0 leading-none",
          isActive ? "text-text-primary" : "text-text-muted",
        ].join(" ")}
        title={session.label}
      >
        {session.hostConfig.host}
      </span>

      {/* Action buttons — visible on hover or when active */}
      <div
        className={[
          "flex items-center gap-0.5 transition-opacity duration-[var(--duration-fast)]",
          isActive ? "opacity-60 group-hover/pane:opacity-100" : "opacity-0 group-hover/pane:opacity-100",
        ].join(" ")}
      >
        {/* Split horizontal */}
        <button type="button" onClick={() => handleSplit("horizontal")} className={btnClass}
          aria-label="Split right" title="Split right (⌘D)">
          <Columns2 size={12} strokeWidth={1.8} aria-hidden="true" />
        </button>

        {/* Split vertical */}
        <button type="button" onClick={() => handleSplit("vertical")} className={btnClass}
          aria-label="Split down" title="Split down (⇧⌘D)">
          <Rows2 size={12} strokeWidth={1.8} aria-hidden="true" />
        </button>

        {/* Zoom toggle — only show when in a split */}
        {hasSplits && (
          <button
            type="button"
            onClick={handleZoom}
            className={[
              "inline-flex items-center justify-center w-5 h-5 rounded transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              isZoomed
                ? "text-accent hover:text-accent-hover hover:bg-accent/10"
                : "text-text-muted hover:text-text-primary hover:bg-bg-muted",
            ].join(" ")}
            aria-label={isZoomed ? "Unzoom pane" : "Zoom pane"}
            title={isZoomed ? "Unzoom (⇧⌘↵)" : "Zoom (⇧⌘↵)"}
          >
            {isZoomed ? (
              <Minimize2 size={11} strokeWidth={2} aria-hidden="true" />
            ) : (
              <Maximize2 size={11} strokeWidth={2} aria-hidden="true" />
            )}
          </button>
        )}

        {/* Close pane */}
        {hasSplits && (
          <button type="button" onClick={handleClose}
            className="inline-flex items-center justify-center w-5 h-5 rounded text-text-muted hover:text-status-error hover:bg-status-error/10 transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            aria-label="Close pane" title="Close pane (⌘W)">
            <X size={11} strokeWidth={2} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}
