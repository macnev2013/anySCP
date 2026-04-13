import { useEffect, useMemo } from "react";
import type { ShortcutDef } from "../../hooks/use-keyboard-shortcuts";
import { useKeyboardShortcuts } from "../../hooks/use-keyboard-shortcuts";
import { useSftpTransfers } from "../../hooks/use-sftp-transfers";
import { useSshStatus } from "../../hooks/use-ssh-status";
import { useSessionStore } from "../../stores/session-store";
import { useSettingsStore } from "../../stores/settings-store";
import { useTabStore } from "../../stores/tab-store";
import { useTerminalSearchStore } from "../../stores/terminal-search-store";
import { useUiStore } from "../../stores/ui-store";
import { Sidebar } from "../sidebar";
import { TerminalArea } from "../terminal";
import { UnifiedTabBar } from "./UnifiedTabBar";

import { usePortForwardEvents } from "../../hooks/use-port-forward-events";
import { HostEditModal, HostsDashboard } from "../dashboard";
import { HistoryPage } from "../history";
import { PortForwardingPage } from "../port-forwarding";
import { SettingsPage } from "../settings";
import { ExplorerPage } from "../sftp";
import { SnippetsPage } from "../snippets";
import { SnippetPalette } from "../snippets/SnippetPalette";

export function AppShell() {
  const activeTabId = useTabStore((s) => s.activeTabId);
  const allTabs = useTabStore((s) => s.tabs);
  const activeTab = activeTabId ? allTabs.get(activeTabId) : null;

  const terminalTabs = useSessionStore((s) => s.tabs);

  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const setEditingHostId = useUiStore((s) => s.setEditingHostId);
  // Auto-open hosts tab if active tab gets removed
  useEffect(() => {
    if (!activeTabId || !allTabs.has(activeTabId)) {
      useTabStore.getState().openPageTab("hosts", "Hosts");
    }
  }, [activeTabId, allTabs]);

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
          const { activeTabId, tabs, removeTab } = useTabStore.getState();
          if (!activeTabId) return;
          const tab = tabs.get(activeTabId);
          if (!tab) return;

          // Hosts tab is permanent
          if (tab.type === "page" && tab.page === "hosts") return;

          if (tab.type === "terminal") {
            const { activeSessionId, tabs: termTabs, zoomedPaneId, unsplitPane, removeSession } = useSessionStore.getState();
            if (!activeSessionId) return;

            // If zoomed, just unzoom
            if (zoomedPaneId) {
              useSessionStore.getState().toggleZoom(zoomedPaneId);
              return;
            }

            const termTab = termTabs.get(activeTabId);
            const isInSplit = termTab && termTab.layout.type === "split";

            void (async () => {
              try {
                const { invoke } = await import("@tauri-apps/api/core");
                await invoke("ssh_disconnect", { sessionId: activeSessionId });
              } catch { /* already disconnected */ }

              if (isInSplit) {
                unsplitPane(activeSessionId);
              }
              removeSession(activeSessionId);

              // If that was the last pane, remove the unified tab
              const remaining = useSessionStore.getState().tabs.get(activeTabId);
              if (!remaining) {
                removeTab(activeTabId);
              }
            })();
          } else {
            // SFTP, S3, or settings — close via UnifiedTabBar handler
            // Simulated close: removeTab triggers fallback
            void (async () => {
              const { invoke } = await import("@tauri-apps/api/core");
              if (tab.type === "sftp") {
                try { await invoke("sftp_close", { sftpSessionId: activeTabId }); } catch { /* ok */ }
                const { useSftpStore } = await import("../../stores/sftp-store");
                useSftpStore.getState().closeSession(activeTabId);
              } else if (tab.type === "s3") {
                try { await invoke("s3_disconnect", { s3SessionId: activeTabId }); } catch { /* ok */ }
                const { useS3Store } = await import("../../stores/s3-store");
                useS3Store.getState().closeSession(activeTabId);
              }
              removeTab(activeTabId);
            })();
          }
        },
      },
      // Tab switching: Cmd+1 through Cmd+9
      ...Array.from({ length: 9 }, (_, i) => ({
        key: String(i + 1),
        meta: true,
        action: () => {
          const { tabOrder, setActiveTab } = useTabStore.getState();
          if (tabOrder[i]) setActiveTab(tabOrder[i]);
        },
      })),
      {
        key: "[",
        meta: true,
        action: () => {
          const { tabOrder, activeTabId, setActiveTab } = useTabStore.getState();
          const idx = tabOrder.indexOf(activeTabId ?? "");
          if (idx > 0) setActiveTab(tabOrder[idx - 1]);
          else if (tabOrder.length > 0) setActiveTab(tabOrder[tabOrder.length - 1]);
        },
      },
      {
        key: "]",
        meta: true,
        action: () => {
          const { tabOrder, activeTabId, setActiveTab } = useTabStore.getState();
          const idx = tabOrder.indexOf(activeTabId ?? "");
          if (idx < tabOrder.length - 1) setActiveTab(tabOrder[idx + 1]);
          else if (tabOrder.length > 0) setActiveTab(tabOrder[0]);
        },
      },
      // ─── Split pane shortcuts (terminal only) ────────────────────
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
        when: () => useTabStore.getState().tabs.get(useTabStore.getState().activeTabId ?? "")?.type === "terminal",
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
        when: () => useTabStore.getState().tabs.get(useTabStore.getState().activeTabId ?? "")?.type === "terminal",
      },
      {
        key: "enter",
        meta: true,
        shift: true,
        action: () => {
          const { activeSessionId, toggleZoom } = useSessionStore.getState();
          if (activeSessionId) toggleZoom(activeSessionId);
        },
        when: () => useTabStore.getState().tabs.get(useTabStore.getState().activeTabId ?? "")?.type === "terminal",
      },
      // ─── Terminal search ──────────────────────────────────────────
      {
        key: "f",
        meta: true,
        action: () => {
          const { activeSessionId } = useSessionStore.getState();
          if (!activeSessionId) return;
          useTerminalSearchStore.getState().openSearch(activeSessionId);
        },
        when: () => useTabStore.getState().tabs.get(useTabStore.getState().activeTabId ?? "")?.type === "terminal",
      },
      // ─── Snippet palette ─────────────────────────────────────────
      {
        key: "k",
        meta: true,
        action: () => {
          useUiStore.getState().toggleSnippetPanel();
        },
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

  // Determine what page content to show
  const activePageType = activeTab?.type === "page" ? activeTab.page : null;

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-bg-base no-select p-2 gap-2">
      {/* Sidebar rail */}
      <Sidebar />

      {/* Main content */}
      <div className="flex flex-col flex-1 min-w-0 rounded-xl overflow-hidden">
        {/* Unified tab bar — always shown */}
        <UnifiedTabBar />

        {/* Main content area */}
        <div className="flex-1 min-h-0 relative flex">
          <div className="flex-1 min-w-0 relative">
            {/* Terminal layouts — render ALL terminal tabs, toggle visibility */}
            {Array.from(allTabs.entries())
              .filter(([, tab]) => tab.type === "terminal")
              .map(([tabId]) => {
                const termTab = terminalTabs.get(tabId);
                if (!termTab) return null;
                const isVisible = tabId === activeTabId;
                return (
                  <div
                    key={tabId}
                    className={`absolute inset-0 p-2 ${isVisible ? "z-10 visible" : "z-0 invisible"}`}
                  >
                    <TerminalArea node={termTab.layout} tabId={tabId} />
                  </div>
                );
              })}


            {/* Page / SFTP / S3 content — rendered on top when active */}
            {activeTab && activeTab.type !== "terminal" && (
              <div className="absolute inset-0 z-10">
                {activeTab.type === "sftp" ? (
                  <ExplorerPage sftpSessionId={activeTab.id} />
                ) : activeTab.type === "s3" ? (
                  <ExplorerPage s3SessionId={activeTab.id} />
                ) : activePageType === "hosts" ? (
                  <HostsDashboard />
                ) : activePageType === "snippets" ? (
                  <SnippetsPage />
                ) : activePageType === "port-forwarding" ? (
                  <PortForwardingPage />
                ) : activePageType === "history" ? (
                  <HistoryPage />
                ) : activePageType === "settings" ? (
                  <SettingsPage />
                ) : null}
              </div>
            )}
          </div>

        </div>

      </div>

      {/* Host modal (new + edit) */}
      <HostEditModal />

      {/* Snippet command palette */}
      <SnippetPalette />
    </div>
  );
}
