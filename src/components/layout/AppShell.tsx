import { useEffect, useMemo } from "react";
import { useSessionStore } from "../../stores/session-store";
import { useSftpStore } from "../../stores/sftp-store";
import { useS3Store } from "../../stores/s3-store";
import { useTerminalSearchStore } from "../../stores/terminal-search-store";
import { useSettingsStore } from "../../stores/settings-store";
import { useUiStore } from "../../stores/ui-store";
import { useKeyboardShortcuts } from "../../hooks/use-keyboard-shortcuts";
import { useSshStatus } from "../../hooks/use-ssh-status";
import { useSftpTransfers } from "../../hooks/use-sftp-transfers";
import type { ShortcutDef } from "../../hooks/use-keyboard-shortcuts";
import { Sidebar } from "../sidebar";
import { TerminalTabs, TerminalPane, TerminalArea } from "../terminal";
import { StatusBar } from "./StatusBar";
import { HostsDashboard, HostEditModal } from "../dashboard";
import { SnippetsPage, SnippetQuickPanel } from "../snippets";
import { ExplorerPage } from "../sftp";
import { SettingsPage } from "../settings";
import { PortForwardingPage } from "../port-forwarding";
import { HistoryPage } from "../history";
import { usePortForwardEvents } from "../../hooks/use-port-forward-events";

export function AppShell() {
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const tabs = useSessionStore((s) => s.tabs);
  const activeTabId = useSessionStore((s) => s.activeTabId);
  const zoomedPaneId = useSessionStore((s) => s.zoomedPaneId);

  const activePage = useUiStore((s) => s.activePage);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const setEditingHostId = useUiStore((s) => s.setEditingHostId);
  const snippetPanelOpen = useUiStore((s) => s.snippetPanelOpen);
  const snippetPanelPinned = useUiStore((s) => s.snippetPanelPinned);

  const setActivePage = useUiStore((s) => s.setActivePage);

  // Show terminal when explicitly on the terminal page and there's an active session
  const showTerminal = activePage === "terminal" && sessions.size > 0 && activeSessionId;

  const sftpSessionCount = useSftpStore((s) => s.sessions.size);
  const s3SessionCount = useS3Store((s) => s.sessions.size);

  // Auto-navigate to hosts when all sessions close
  useEffect(() => {
    if (activePage === "terminal" && tabs.size === 0) {
      setActivePage("hosts");
    }
    if (activePage === "sftp" && sftpSessionCount === 0 && s3SessionCount === 0) {
      setActivePage("hosts");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePage, tabs.size, sftpSessionCount, setActivePage]);

  const shortcuts = useMemo<ShortcutDef[]>(
    () => [
      {
        key: "b",
        meta: true,
        action: () => toggleSidebar(),
      },
      {
        key: "t",
        meta: true,
        action: () => {
          // New tab with embedded host picker
          const pendingId = crypto.randomUUID();
          useUiStore.getState().addPendingPane(pendingId);
          useSessionStore.getState().addPendingTab(pendingId);
          useUiStore.getState().setActivePage("terminal");
        },
      },
      {
        key: "w",
        meta: true,
        action: () => {
          const { activeSessionId, tabs, activeTabId, removeSession, unsplitPane, zoomedPaneId } = useSessionStore.getState();
          if (!activeSessionId) return;

          // If zoomed, just unzoom
          if (zoomedPaneId) {
            useSessionStore.getState().toggleZoom(zoomedPaneId);
            return;
          }

          // Check if this pane is in a split
          const activeTab = activeTabId ? tabs.get(activeTabId) : null;
          const isInSplit = activeTab && activeTab.layout.type === "split";

          const isPending = useUiStore.getState().pendingPanes.has(activeSessionId);

          if (isPending) {
            // Pending pane has no SSH session — just clean up layout
            useUiStore.getState().removePendingPane(activeSessionId);
            if (isInSplit) unsplitPane(activeSessionId);
            else removeSession(activeSessionId);
            return;
          }

          (async () => {
            try {
              const { invoke } = await import("@tauri-apps/api/core");
              await invoke("ssh_disconnect", { sessionId: activeSessionId });
            } catch { /* already disconnected */ }

            if (isInSplit) {
              // Remove pane from split tree, keep others alive
              unsplitPane(activeSessionId);
            }
            removeSession(activeSessionId);
          })();
        },
      },
      // Tab switching: Cmd+1 through Cmd+9
      ...Array.from({ length: 9 }, (_, i) => ({
        key: String(i + 1),
        meta: true,
        action: () => {
          const { tabOrder, setActiveTab } = useSessionStore.getState();
          if (tabOrder[i]) setActiveTab(tabOrder[i]);
        },
      })),
      {
        key: "[",
        meta: true,
        action: () => {
          const { tabOrder, activeTabId, setActiveTab } = useSessionStore.getState();
          const idx = tabOrder.indexOf(activeTabId ?? "");
          if (idx > 0) setActiveTab(tabOrder[idx - 1]);
          else if (tabOrder.length > 0) setActiveTab(tabOrder[tabOrder.length - 1]);
        },
      },
      {
        key: "]",
        meta: true,
        action: () => {
          const { tabOrder, activeTabId, setActiveTab } = useSessionStore.getState();
          const idx = tabOrder.indexOf(activeTabId ?? "");
          if (idx < tabOrder.length - 1) setActiveTab(tabOrder[idx + 1]);
          else if (tabOrder.length > 0) setActiveTab(tabOrder[0]);
        },
      },
      // ─── Split pane shortcuts ──────────────────────────────────────
      {
        key: "d",
        meta: true,
        action: () => {
          const { activeSessionId } = useSessionStore.getState();
          if (!activeSessionId) return;
          void (async () => {
            try {
              const { invoke } = await import("@tauri-apps/api/core");
              const newId = await invoke<string>("ssh_split_session", {
                sourceSessionId: activeSessionId,
              });
              useSessionStore.getState().splitPane("horizontal", activeSessionId, newId);
            } catch (err) {
              console.error("Split failed:", err);
            }
          })();
        },
      },
      {
        key: "d",
        meta: true,
        shift: true,
        action: () => {
          const { activeSessionId } = useSessionStore.getState();
          if (!activeSessionId) return;
          void (async () => {
            try {
              const { invoke } = await import("@tauri-apps/api/core");
              const newId = await invoke<string>("ssh_split_session", {
                sourceSessionId: activeSessionId,
              });
              useSessionStore.getState().splitPane("vertical", activeSessionId, newId);
            } catch (err) {
              console.error("Split failed:", err);
            }
          })();
        },
      },
      {
        key: "enter",
        meta: true,
        shift: true,
        action: () => {
          const { activeSessionId, toggleZoom } = useSessionStore.getState();
          if (activeSessionId) toggleZoom(activeSessionId);
        },
      },
      // ─── Terminal search ───────────────────────────────────────────
      {
        key: "f",
        meta: true,
        action: () => {
          const { activeSessionId } = useSessionStore.getState();
          if (!activeSessionId) return;
          useTerminalSearchStore.getState().openSearch(activeSessionId);
        },
        when: () => useUiStore.getState().activePage === "terminal",
      },
      // ─── New tab / split with host picker ──────────────────────────
      {
        key: "n",
        meta: true,
        action: () => {
          // New tab with embedded host picker
          const pendingId = crypto.randomUUID();
          useUiStore.getState().addPendingPane(pendingId);
          useSessionStore.getState().addPendingTab(pendingId);
          useUiStore.getState().setActivePage("terminal");
        },
      },
      {
        key: "n",
        meta: true,
        shift: true,
        action: () => {
          const { activeSessionId } = useSessionStore.getState();
          if (!activeSessionId) return;
          // Split pane with embedded host picker in the new half
          const pendingId = crypto.randomUUID();
          useUiStore.getState().addPendingPane(pendingId);
          useSessionStore.getState().addPendingSplit("horizontal", activeSessionId, pendingId);
        },
        when: () => useUiStore.getState().activePage === "terminal",
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [toggleSidebar, setEditingHostId],
  );

  useKeyboardShortcuts(shortcuts);
  useSshStatus();

  // Load persisted settings on mount
  useEffect(() => {
    void useSettingsStore.getState().loadSettings();
  }, []);
  useSftpTransfers();
  usePortForwardEvents();

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-bg-base no-select p-2 gap-2">
      {/* Sidebar rail */}
      <Sidebar />

      {/* Main content */}
      <div className="flex flex-col flex-1 min-w-0 rounded-xl bg-bg-surface border border-border overflow-hidden">
        {/* Tab bar — only on terminal page */}
        {showTerminal && <TerminalTabs />}

        {/* Main content area */}
        <div className="flex-1 min-h-0 relative flex">
          {/* Terminal layouts — one per tab, only active tab visible */}
          <div className="flex-1 min-w-0 relative">
            {showTerminal && Array.from(tabs.entries()).map(([tabId, tab]) => (
              <div
                key={tabId}
                className={`absolute inset-0 ${
                  tabId === activeTabId ? "z-10 visible" : "z-0 invisible"
                }`}
              >
                {zoomedPaneId && tabId === activeTabId ? (
                  <TerminalPane sessionId={zoomedPaneId} />
                ) : (
                  <TerminalArea node={tab.layout} tabId={tabId} />
                )}
              </div>
            ))}

            {/* Snippet panel (floating / unpinned) — inside terminal container so it overlays */}
            {showTerminal && snippetPanelOpen && !snippetPanelPinned && (
              <SnippetQuickPanel />
            )}

            {/* Page layer — dashboard, snippets, history */}
            {!showTerminal && (
              <div className="absolute inset-0 z-10">
                {activePage === "hosts" ? (
                  <HostsDashboard />
                ) : activePage === "snippets" ? (
                  <SnippetsPage />
                ) : activePage === "sftp" || activePage === "s3" ? (
                  <ExplorerPage />
                ) : activePage === "port-forwarding" ? (
                  <PortForwardingPage />
                ) : activePage === "history" ? (
                  <HistoryPage />
                ) : activePage === "settings" ? (
                  <SettingsPage />
                ) : (
                  <PlaceholderPage page={activePage} />
                )}
              </div>
            )}
          </div>

          {/* Snippet quick panel — pinned: docked as flex sibling, unpinned: floating inside terminal container */}
          {showTerminal && snippetPanelOpen && snippetPanelPinned && (
            <SnippetQuickPanel />
          )}
        </div>

        {/* Status bar */}
        <StatusBar />
      </div>

      {/* Host modal (new + edit) */}
      <HostEditModal />
    </div>
  );
}

function PlaceholderPage({ page }: { page: string }) {
  const label = page.replace("-", " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return (
    <div className="flex items-center justify-center h-full text-text-muted no-select">
      <p className="text-[length:var(--text-sm)]">{label} — coming soon</p>
    </div>
  );
}
