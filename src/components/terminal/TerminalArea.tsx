import { useSessionStore } from "../../stores/session-store";
import { useTerminalSearchStore } from "../../stores/terminal-search-store";
import { useUiStore } from "../../stores/ui-store";
import type { LayoutNode } from "../../types";
import { DisconnectOverlay } from "./DisconnectOverlay";
import { HostPickerDropdown } from "./HostPickerDropdown";
import { PaneHeader } from "./PaneHeader";
import { SplitContainer } from "./SplitContainer";
import { Terminal } from "./Terminal";
import { TerminalSearchBar } from "./TerminalSearchBar";

interface TerminalAreaProps {
  node: LayoutNode;
  path?: number[];
  tabId: string;
}

export function TerminalPane({ sessionId }: { sessionId: string }) {
  const session = useSessionStore((s) => s.sessions.get(sessionId));
  const isPending = useUiStore((s) => s.pendingPanes.has(sessionId));
  const isActive = useSessionStore((s) => s.activeSessionId === sessionId);
  const isZoomed = useSessionStore((s) => s.zoomedPaneId === sessionId);
  const hasSplits = useSessionStore((s) => {
    const tabId = s.activeTerminalTabId;
    if (!tabId) return false;
    const tab = s.tabs.get(tabId);
    return tab ? tab.layout.type === "split" : false;
  });
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const searchOpen = useTerminalSearchStore((s) => s.openSessions.has(sessionId));

  // Pending pane — show embedded host picker instead of terminal
  if (isPending) {
    return (
      <div
        className={[
          "group/pane flex flex-col rounded-lg overflow-hidden border",
          "transition-[border-color,box-shadow] duration-[var(--duration-fast)]",
          "relative h-full w-full border-border/60",
        ].join(" ")}
      >
        <PaneHeader sessionId={sessionId} isPending />
        <div className="relative flex-1 min-h-0">
          <HostPickerDropdown pendingId={sessionId} />
        </div>
      </div>
    );
  }

  const showOverlay =
    session?.status === "Disconnected" || session?.status === "Error";

  // When zoomed, this pane expands to fill the entire tab area
  // while staying in the same DOM tree (no remount).
  // Non-zoomed sibling panes get hidden by SplitContainer.
  return (
    <div
      className={[
        "group/pane flex flex-col rounded-lg overflow-hidden border",
        "transition-[border-color,box-shadow] duration-[var(--duration-fast)]",
        isZoomed
          ? "fixed-zoom absolute inset-0 z-30 border-accent/40"
          : "relative h-full w-full",
        !isZoomed && isActive && hasSplits
          ? "border-accent/40 shadow-[0_0_0_1px_oklch(var(--accent)/.12)]"
          : !isZoomed ? "border-border/60" : "",
      ].join(" ")}
      onClick={() => {
        if (!isActive) setActiveSession(sessionId);
      }}
    >
      <PaneHeader sessionId={sessionId} />

      <div className="relative flex-1 min-h-0">
        <Terminal sessionId={sessionId} />

        {searchOpen && <TerminalSearchBar sessionId={sessionId} />}

        {showOverlay && session && (
          <DisconnectOverlay
            sessionId={sessionId}
            status={session.status as "Disconnected" | "Error"}
            message={session.statusMessage}
            hostConfig={session.hostConfig}
          />
        )}
      </div>
    </div>
  );
}

export function TerminalArea({ node, path = [], tabId }: TerminalAreaProps) {
  if (node.type === "pane") {
    return <TerminalPane sessionId={node.sessionId} />;
  }

  return <SplitContainer node={node} path={path} tabId={tabId} />;
}
