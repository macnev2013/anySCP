import { X, Code, Columns2, Rows2, Maximize2 } from "lucide-react";
import { useSessionStore, countPanes, getTopDirection } from "../../stores/session-store";
import type { Tab } from "../../stores/session-store";
import { useTabStore } from "../../stores/tab-store";
import { useUiStore } from "../../stores/ui-store";

export function TerminalTabs() {
  const tabOrder = useTabStore((s) => s.tabOrder);
  const tabs = useSessionStore((s) => s.tabs);
  const sessions = useSessionStore((s) => s.sessions);
  const activeTabId = useTabStore((s) => s.activeTabId);
  const setActiveTab = useTabStore((s) => s.setActiveTab);
  const zoomedPaneId = useSessionStore((s) => s.zoomedPaneId);

  const toggleSnippetPanel = useUiStore((s) => s.toggleSnippetPanel);
  const snippetPanelOpen = useUiStore((s) => s.snippetPanelOpen);

  const handleClose = async (tabId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    // Disconnect all sessions in this tab
    const tab = tabs.get(tabId);
    if (!tab) return;
    const sessionIds = collectIds(tab);
    const { invoke } = await import("@tauri-apps/api/core");
    const { pendingPanes, removePendingPane } = useUiStore.getState();
    for (const sid of sessionIds) {
      if (pendingPanes.has(sid)) {
        removePendingPane(sid);
      } else {
        try { await invoke("ssh_disconnect", { sessionId: sid }); } catch { /* already disconnected */ }
      }
      useSessionStore.getState().removeSession(sid);
    }
  };

  if (tabOrder.length === 0) return null;

  return (
    <div className="flex items-end h-[var(--tabbar-height)] bg-bg-surface border-b border-border no-select px-1.5">
      <div className="flex items-end gap-1 overflow-x-auto overflow-y-hidden flex-1 min-w-0 pb-0">
        {tabOrder.map((tabId) => {
          const tab = tabs.get(tabId);
          if (!tab) return null;

          const isActive = tabId === activeTabId;
          const paneCount = countPanes(tab.layout);
          const topDir = getTopDirection(tab.layout);
          const firstSessionId = getFirstSessionId(tab);
          const firstSession = firstSessionId ? sessions.get(firstSessionId) : null;

          // Status dot color from the first session
          const status = firstSession?.status ?? "Disconnected";
          const dotColor =
            status === "Connected"    ? "bg-status-connected" :
            status === "Connecting"   ? "bg-status-connecting motion-safe:animate-pulse" :
            status === "Error"        ? "bg-status-error" :
                                        "bg-status-disconnected";

          // Tab is zoomed if the active tab has a zoomed pane
          const isZoomed = isActive && zoomedPaneId !== null;

          return (
            <button
              key={tabId}
              onClick={() => { setActiveTab(tabId); }}
              title={tab.label + (paneCount > 1 ? ` (${paneCount} panes)` : "")}
              aria-label={`${tab.label}${paneCount > 1 ? `, ${paneCount} panes` : ""}`}
              className={[
                "group relative flex items-center gap-2 px-3.5 h-[32px] shrink-0 max-w-[220px]",
                "text-[length:var(--text-sm)] leading-none rounded-t-lg",
                "transition-[color,background-color,box-shadow] duration-[var(--duration-fast)]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                isActive
                  ? "bg-bg-base text-text-primary shadow-[0_-1px_0_0_var(--color-border),1px_0_0_0_var(--color-border),-1px_0_0_0_var(--color-border)]"
                  : "text-text-secondary hover:text-text-primary hover:bg-bg-overlay/50",
              ].join(" ")}
            >
              {/* Status dot */}
              <span className={`w-[7px] h-[7px] rounded-full shrink-0 ${dotColor}`} />

              {/* Label */}
              <span className={`truncate ${isActive ? "font-medium" : ""}`}>
                {tab.label}
              </span>

              {/* Split indicator */}
              {paneCount === 2 && topDir && (
                <span className="shrink-0 text-text-muted" aria-hidden="true">
                  {topDir === "horizontal" ? (
                    <Columns2 size={12} strokeWidth={1.8} />
                  ) : (
                    <Rows2 size={12} strokeWidth={1.8} />
                  )}
                </span>
              )}
              {paneCount >= 3 && (
                <span className="flex items-center justify-center min-w-[16px] h-[16px] px-1 rounded-full bg-bg-muted text-[9px] font-bold text-text-secondary tabular-nums leading-none shrink-0">
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
              <button
                onClick={(e) => void handleClose(tabId, e)}
                className={[
                  "ml-auto p-1 -mr-1 rounded shrink-0",
                  "text-text-muted hover:text-text-primary hover:bg-bg-muted",
                  isActive ? "opacity-50 group-hover:opacity-100" : "opacity-0 group-hover:opacity-100",
                  "transition-all duration-[var(--duration-fast)]",
                  "focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                ].join(" ")}
                aria-label={`Close ${tab.label}`}
                tabIndex={-1}
              >
                <X size={12} strokeWidth={2} aria-hidden="true" />
              </button>

              {/* Active: bottom edge overlaps the border */}
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

      {/* Right actions */}
      <div className="flex items-center gap-1.5 pb-1.5 pl-2 shrink-0">
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function collectIds(tab: Tab): string[] {
  return collectNodeIds(tab.layout);
}

function collectNodeIds(node: import("../../types").LayoutNode): string[] {
  if (node.type === "pane") return [node.sessionId];
  return [...collectNodeIds(node.children[0]), ...collectNodeIds(node.children[1])];
}

function getFirstSessionId(tab: Tab): string | null {
  let node = tab.layout;
  while (node.type === "split") node = node.children[0];
  return node.sessionId;
}
