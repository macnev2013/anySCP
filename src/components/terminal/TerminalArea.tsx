import type { LayoutNode } from "../../types";
import { Terminal } from "./Terminal";
import { SplitContainer } from "./SplitContainer";
import { DisconnectOverlay } from "./DisconnectOverlay";
import { TerminalSearchBar } from "./TerminalSearchBar";
import { useSessionStore } from "../../stores/session-store";
import { useTerminalSearchStore } from "../../stores/terminal-search-store";

interface TerminalAreaProps {
  node: LayoutNode;
  path?: number[];
  tabId: string;
}

export function TerminalPane({ sessionId }: { sessionId: string }) {
  const session = useSessionStore((s) => s.sessions.get(sessionId));
  const isActive = useSessionStore((s) => s.activeSessionId === sessionId);
  const hasSplits = useSessionStore((s) => {
    const tabId = s.activeTabId;
    if (!tabId) return false;
    const tab = s.tabs.get(tabId);
    return tab ? tab.layout.type === "split" : false;
  });
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const searchOpen = useTerminalSearchStore((s) => s.openSessions.has(sessionId));

  const showOverlay =
    session?.status === "Disconnected" || session?.status === "Error";

  const showFocusRing = isActive && hasSplits;

  return (
    <div
      className={[
        "relative h-full w-full",
        showFocusRing ? "ring-1 ring-inset ring-accent/40" : "",
      ].join(" ")}
      onClick={() => {
        if (!isActive) setActiveSession(sessionId);
      }}
    >
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
  );
}

export function TerminalArea({ node, path = [], tabId }: TerminalAreaProps) {
  if (node.type === "pane") {
    return <TerminalPane sessionId={node.sessionId} />;
  }

  return <SplitContainer node={node} path={path} tabId={tabId} />;
}
