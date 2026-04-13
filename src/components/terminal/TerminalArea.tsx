import { useState } from "react";
import { Columns2, Rows2, Globe, Maximize2, Minimize2, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import type { LayoutNode } from "../../types";
import { Terminal } from "./Terminal";
import { SplitContainer } from "./SplitContainer";
import { DisconnectOverlay } from "./DisconnectOverlay";
import { TerminalSearchBar } from "./TerminalSearchBar";
import { HostPickerDropdown } from "./HostPickerDropdown";
import { ContextMenu } from "../shared/ContextMenu";
import type { ContextMenuItem } from "../shared/ContextMenu";
import { useSessionStore } from "../../stores/session-store";
import { useUiStore } from "../../stores/ui-store";
import { useTerminalSearchStore } from "../../stores/terminal-search-store";

interface TerminalAreaProps {
  node: LayoutNode;
  path?: number[];
  tabId: string;
}

export function TerminalPane({ sessionId }: { sessionId: string }) {
  const session = useSessionStore((s) => s.sessions.get(sessionId));
  const isPending = useUiStore((s) => s.pendingPanes.has(sessionId));
  const isActive = useSessionStore((s) => s.activeSessionId === sessionId);
  const hasSplits = useSessionStore((s) => {
    const tabId = s.activeTabId;
    if (!tabId) return false;
    const tab = s.tabs.get(tabId);
    return tab ? tab.layout.type === "split" : false;
  });
  const zoomedPaneId = useSessionStore((s) => s.zoomedPaneId);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const searchOpen = useTerminalSearchStore((s) => s.openSessions.has(sessionId));

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  // Pending pane — show embedded host picker instead of terminal
  if (isPending) {
    return (
      <div className="relative h-full w-full">
        <HostPickerDropdown pendingId={sessionId} />
      </div>
    );
  }

  const showOverlay =
    session?.status === "Disconnected" || session?.status === "Error";

  const showFocusRing = isActive && hasSplits;

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const contextItems: ContextMenuItem[] = [
    {
      label: "Split Horizontal",
      icon: Columns2,
      onClick: () => {
        invoke<string>("ssh_split_session", { sourceSessionId: sessionId })
            .then((newId) => useSessionStore.getState().splitPane("horizontal", sessionId, newId))
            .catch((err) => console.error("Split failed:", err));
      },
    },
    {
      label: "Split Vertical",
      icon: Rows2,
      onClick: () => {
        invoke<string>("ssh_split_session", { sourceSessionId: sessionId })
            .then((newId) => useSessionStore.getState().splitPane("vertical", sessionId, newId))
            .catch((err) => console.error("Split failed:", err));
      },
    },
    {
      label: "Connect to Host...",
      icon: Globe,
      separator: true,
      onClick: () => {
        // Create a pending split to pick a new host
        const pendingId = crypto.randomUUID();
        useUiStore.getState().addPendingPane(pendingId);
        useSessionStore.getState().addPendingSplit("horizontal", sessionId, pendingId);
      },
    },
    {
      label: zoomedPaneId === sessionId ? "Unzoom Pane" : "Zoom Pane",
      icon: zoomedPaneId === sessionId ? Minimize2 : Maximize2,
      separator: true,
      onClick: () => {
        useSessionStore.getState().toggleZoom(sessionId);
      },
    },
    ...(hasSplits
      ? [
          {
            label: "Close Pane",
            icon: X,
            danger: true,
            onClick: () => {
              invoke("ssh_disconnect", { sessionId })
                .catch(() => { /* already disconnected */ })
                .finally(() => {
                  useSessionStore.getState().unsplitPane(sessionId);
                  useSessionStore.getState().removeSession(sessionId);
                });
            },
          } satisfies ContextMenuItem,
        ]
      : []),
  ];

  return (
    <div
      className={[
        "relative h-full w-full",
        showFocusRing ? "ring-1 ring-inset ring-accent/40" : "",
      ].join(" ")}
      onClick={() => {
        if (!isActive) setActiveSession(sessionId);
      }}
      onContextMenu={handleContextMenu}
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

      {contextMenu && (
        <ContextMenu
          items={contextItems}
          position={contextMenu}
          onClose={() => setContextMenu(null)}
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
