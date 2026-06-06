import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useTabStore } from "../../stores/tab-store";
import { useSessionStore } from "../../stores/session-store";
import { useTerminalSearchStore } from "../../stores/terminal-search-store";
import { useSettingsStore } from "../../stores/settings-store";
import { useUpdaterStore } from "../../stores/updater-store";
import { useUiStore } from "../../stores/ui-store";
import { useKeyboardShortcuts } from "../../hooks/use-keyboard-shortcuts";
import { useSshStatus } from "../../hooks/use-ssh-status";
import { useSftpTransfers } from "../../hooks/use-sftp-transfers";
import type { ShortcutDef } from "../../hooks/use-keyboard-shortcuts";
import { Sidebar } from "../sidebar";
import { TerminalArea } from "../terminal";
import { UnifiedTabBar } from "./UnifiedTabBar";

import { HostsDashboard, HostEditModal } from "../dashboard";
import { NEW_HOST_ID } from "../dashboard/HostEditModal";
import { SnippetsPage } from "../snippets";
import { SnippetPalette } from "../snippets/SnippetPalette";
import { ExplorerPage } from "../sftp";
import { SettingsPage } from "../settings";
import { PortForwardingPage } from "../port-forwarding";
import { HistoryPage } from "../history";
import { usePortForwardEvents } from "../../hooks/use-port-forward-events";
import { UpdateDialog } from "../updater/UpdateDialog";

export function AppShell() {
  const themeMode = useSettingsStore((s) => s.themeMode);
  const accentHue = useSettingsStore((s) => s.accentHue);
  const accentCustom = useSettingsStore((s) => s.accentCustom);
  const interfaceFont = useSettingsStore((s) => s.interfaceFont);
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

  const openNewHost = () => setEditingHostId(NEW_HOST_ID);

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
        action: openNewHost,
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

  // Check for updates once on launch, after settings load so the auto-update
  // preference is known. The check always runs; the silent download/install
  // only happens in packaged builds (see updater store).
  const settingsLoaded = useSettingsStore((s) => s.loaded);
  const didUpdateCheck = useRef(false);
  useEffect(() => {
    if (!settingsLoaded || didUpdateCheck.current) return;
    didUpdateCheck.current = true;
    void useUpdaterStore.getState().loadAppVersion();
    void useUpdaterStore.getState().checkOnStartup();
  }, [settingsLoaded]);

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = themeMode;
  }, [themeMode]);

  useLayoutEffect(() => {
    document.documentElement.style.setProperty("--accent-hue", String(accentHue));
  }, [accentHue]);

  useLayoutEffect(() => {
    document.documentElement.style.setProperty("--font-sans", interfaceFont);
    document.documentElement.dataset.interfaceFont = interfaceFont;
  }, [interfaceFont]);

  // A custom accent overrides the hue-based tokens directly (supports any
  // lightness/chroma, e.g. gray or darker shades). Clearing it falls back to
  // the theme's hue-driven accent.
  useLayoutEffect(() => {
    const st = document.documentElement.style;
    const props = ["--color-accent", "--color-accent-hover", "--color-accent-muted", "--color-border-focus", "--color-ring"];
    if (!accentCustom) {
      props.forEach((prop) => st.removeProperty(prop));
      delete document.documentElement.dataset.accentCustom;
      return;
    }
    const { l, c, h } = accentCustom;
    st.setProperty("--color-accent", `oklch(${l} ${c} ${h})`);
    st.setProperty("--color-accent-hover", `oklch(${Math.max(0, l - 0.05)} ${c} ${h})`);
    st.setProperty("--color-accent-muted", `oklch(${l} ${c} ${h} / 0.15)`);
    st.setProperty("--color-border-focus", `oklch(${l} ${c} ${h})`);
    st.setProperty("--color-ring", `oklch(${l} ${c} ${h} / 0.40)`);
    document.documentElement.dataset.accentCustom = `${l} ${c} ${h}`;
  }, [accentCustom]);

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


            {/* Explorer (SFTP/S3) tabs — render ALL and toggle visibility, like
                terminals, so the open directory and selection survive switching
                tabs instead of resetting to the home/default dir (issue #17). */}
            {Array.from(allTabs.entries())
              .filter(([, tab]) => tab.type === "sftp" || tab.type === "s3")
              .map(([tabId, tab]) => {
                const isVisible = tabId === activeTabId;
                return (
                  <div
                    key={tabId}
                    className={`absolute inset-0 ${isVisible ? "z-10 visible" : "z-0 invisible"}`}
                  >
                    {tab.type === "sftp" ? (
                      <ExplorerPage
                        sftpSessionId={tabId}
                        transport={tab.transport ?? "sftp"}
                        isActive={isVisible}
                      />
                    ) : (
                      <ExplorerPage s3SessionId={tabId} isActive={isVisible} />
                    )}
                  </div>
                );
              })}

            {/* Page content — rendered on top when its tab is active */}
            {activeTab && activeTab.type === "page" && (
              <div className="absolute inset-0 z-10">
                {activePageType === "hosts" ? (
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

      {/* Update-available popup */}
      <UpdateDialog />

      {/* Snippet command palette */}
      <SnippetPalette />
    </div>
  );
}
