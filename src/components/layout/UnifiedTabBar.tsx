import {
  X,
  Code,
  Maximize2,
  Columns2,
  Rows2,
  TerminalSquare,
  FolderOpen,
  Cloud,
  Monitor,
  Braces,
  Plug,
  History,
  Settings,
} from "lucide-react";
import { useTabStore, type UnifiedTab, type PageId } from "../../stores/tab-store";
import { useSessionStore, countPanes, getTopDirection } from "../../stores/session-store";
import { useUiStore } from "../../stores/ui-store";

// ─── Icon mapping ───────────────────────────────────────────────────────────

const PAGE_ICONS: Record<PageId, React.ElementType> = {
  hosts: Monitor,
  snippets: Braces,
  "port-forwarding": Plug,
  history: History,
  settings: Settings,
};

function getTabIcon(tab: UnifiedTab): React.ElementType {
  if (tab.type === "terminal") return TerminalSquare;
  if (tab.type === "sftp") return FolderOpen;
  if (tab.type === "s3") return Cloud;
  return PAGE_ICONS[tab.page] ?? Monitor;
}

// ─── Component ──────────────────────────────────────────────────────────────

export function UnifiedTabBar() {
  const tabOrder = useTabStore((s) => s.tabOrder);
  const tabs = useTabStore((s) => s.tabs);
  const activeTabId = useTabStore((s) => s.activeTabId);
  const setActiveTab = useTabStore((s) => s.setActiveTab);
  const removeTab = useTabStore((s) => s.removeTab);

  const sessions = useSessionStore((s) => s.sessions);
  const terminalTabs = useSessionStore((s) => s.tabs);
  const zoomedPaneId = useSessionStore((s) => s.zoomedPaneId);

  const toggleSnippetPanel = useUiStore((s) => s.toggleSnippetPanel);
  const snippetPanelOpen = useUiStore((s) => s.snippetPanelOpen);

  const handleClose = async (tabId: string, tab: UnifiedTab, e: React.MouseEvent) => {
    e.stopPropagation();
    const { invoke } = await import("@tauri-apps/api/core");

    if (tab.type === "terminal") {
      // Disconnect all sessions in the terminal layout tree
      const termTab = terminalTabs.get(tabId);
      if (termTab) {
        const sessionIds = collectLayoutIds(termTab.layout);
        for (const sid of sessionIds) {
          try { await invoke("ssh_disconnect", { sessionId: sid }); } catch { /* ok */ }
          useSessionStore.getState().removeSession(sid);
        }
      }
    } else if (tab.type === "sftp") {
      try { await invoke("sftp_close", { sftpSessionId: tabId }); } catch { /* ok */ }
      const { useSftpStore } = await import("../../stores/sftp-store");
      useSftpStore.getState().closeSession(tabId);
    } else if (tab.type === "s3") {
      try { await invoke("s3_disconnect", { s3SessionId: tabId }); } catch { /* ok */ }
      const { useS3Store } = await import("../../stores/s3-store");
      useS3Store.getState().closeSession(tabId);
    }

    removeTab(tabId);
  };

  if (tabOrder.length === 0) return null;

  return (
    <div className="flex items-center h-[var(--tabbar-height)] no-select px-2">
      <div className="flex items-center gap-1.5 overflow-x-auto overflow-y-hidden flex-1 min-w-0">
        {tabOrder.map((tabId) => {
          const tab = tabs.get(tabId);
          if (!tab) return null;

          const isActive = tabId === activeTabId;
          const Icon = getTabIcon(tab);

          // Terminal-specific metadata
          let statusDot: string | null = null;
          let paneCount = 1;
          let topDir: "horizontal" | "vertical" | null = null;
          let isZoomed = false;

          if (tab.type === "terminal") {
            const termTab = terminalTabs.get(tabId);
            if (termTab) {
              paneCount = countPanes(termTab.layout);
              topDir = getTopDirection(termTab.layout);
            }
            // Status from first session in layout
            const firstSessionId = getFirstSessionIdFromTab(tabId);
            const firstSession = firstSessionId ? sessions.get(firstSessionId) : null;
            const status = firstSession?.status ?? "Disconnected";
            statusDot =
              status === "Connected"    ? "bg-status-connected" :
              status === "Connecting"   ? "bg-status-connecting motion-safe:animate-pulse" :
              status === "Error"        ? "bg-status-error" :
                                          "bg-status-disconnected";
            isZoomed = isActive && zoomedPaneId !== null;
          }

          const closeable = !(tab.type === "page" && tab.page === "hosts");

          return (
            <button
              key={tabId}
              onClick={() => setActiveTab(tabId)}
              title={tab.label + (paneCount > 1 ? ` (${paneCount} panes)` : "")}
              className={[
                "group relative flex items-center gap-2 px-3.5 h-[28px] shrink-0 max-w-[220px]",
                "text-[length:var(--text-sm)] leading-none rounded-lg",
                "transition-[color,background-color] duration-[var(--duration-fast)]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                isActive
                  ? "bg-accent/15 text-accent border border-accent/40"
                  : "bg-bg-overlay/80 text-text-secondary border border-border/60 hover:text-text-primary hover:bg-bg-overlay hover:border-border",
              ].join(" ")}
            >
              {/* Tab icon */}
              <Icon
                size={13}
                strokeWidth={1.8}
                className={[
                  "shrink-0",
                  tab.type === "terminal" && statusDot ? statusDot.replace("bg-", "text-") : "",
                  tab.type === "sftp" || tab.type === "s3" ? "text-status-connected" : "",
                  tab.type === "page" && isActive ? "text-accent" : "",
                  tab.type === "page" && !isActive ? "text-text-muted" : "",
                ].join(" ")}
                aria-hidden="true"
              />

              {/* Label */}
              <span className={`truncate ${isActive ? "font-medium" : ""}`}>
                {tab.label}
              </span>

              {/* Split indicator (terminal only) */}
              {tab.type === "terminal" && paneCount === 2 && topDir && (
                <span className="shrink-0 text-text-muted" aria-hidden="true">
                  {topDir === "horizontal" ? (
                    <Columns2 size={12} strokeWidth={1.8} />
                  ) : (
                    <Rows2 size={12} strokeWidth={1.8} />
                  )}
                </span>
              )}
              {tab.type === "terminal" && paneCount >= 3 && (
                <span className="flex items-center justify-center min-w-[16px] h-[16px] px-1 rounded-lg bg-bg-muted text-[9px] font-bold text-text-secondary tabular-nums leading-none shrink-0">
                  {paneCount}
                </span>
              )}

              {/* Zoom indicator */}
              {isZoomed && (
                <span className="shrink-0 text-accent" aria-hidden="true" title="Zoomed pane">
                  <Maximize2 size={10} strokeWidth={2} />
                </span>
              )}

              {/* Close button */}
              {closeable && (
                <button
                  onClick={(e) => void handleClose(tabId, tab, e)}
                  className={[
                    "ml-auto p-0.5 -mr-1 rounded-lg shrink-0",
                    isActive
                      ? "text-accent/60 hover:text-accent hover:bg-accent/10"
                      : "text-text-muted hover:text-text-primary hover:bg-bg-muted",
                    "opacity-0 group-hover:opacity-100",
                    "transition-all duration-[var(--duration-fast)]",
                    "focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  ].join(" ")}
                  aria-label={`Close ${tab.label}`}
                  tabIndex={-1}
                >
                  <X size={11} strokeWidth={2} aria-hidden="true" />
                </button>
              )}
            </button>
          );
        })}

      </div>

      {/* Right actions */}
      <div className="flex items-center gap-1 pl-2 shrink-0">
        <button
          onClick={toggleSnippetPanel}
          title="Snippets"
          aria-label="Toggle snippets panel"
          aria-pressed={snippetPanelOpen}
          className={[
            "flex items-center justify-center w-7 h-7 rounded-md",
            "transition-colors duration-[var(--duration-fast)]",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            snippetPanelOpen
              ? "bg-accent/15 text-accent"
              : "text-text-muted hover:text-text-secondary hover:bg-bg-subtle",
          ].join(" ")}
        >
          <Code size={14} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function collectLayoutIds(node: import("../../types").LayoutNode): string[] {
  if (node.type === "pane") return [node.sessionId];
  return [...collectLayoutIds(node.children[0]), ...collectLayoutIds(node.children[1])];
}

function getFirstSessionIdFromTab(tabId: string): string | null {
  const tab = useSessionStore.getState().tabs.get(tabId);
  if (!tab) return null;
  let node = tab.layout;
  while (node.type === "split") node = node.children[0];
  return node.sessionId;
}
