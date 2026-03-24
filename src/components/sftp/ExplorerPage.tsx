import { useState, useEffect } from "react";
import { useSftpStore } from "../../stores/sftp-store";
import { useS3Store } from "../../stores/s3-store";
import { SftpBrowser } from "./SftpBrowser";
import { SftpSessionPicker } from "./SftpSessionPicker";
import { ExplorerTabs } from "./ExplorerTabs";
import { S3Browser } from "../s3/S3Browser";
import type { ExplorerTab } from "./ExplorerTabs";

export function ExplorerPage() {
  const sftpSessions = useSftpStore((s) => s.sessions);
  const activeSftpSessionId = useSftpStore((s) => s.activeSftpSessionId);
  const setActiveSftpSession = useSftpStore((s) => s.setActiveSftpSession);

  const s3Sessions = useS3Store((s) => s.sessions);
  const activeS3SessionId = useS3Store((s) => s.activeS3SessionId);
  const setActiveS3Session = useS3Store((s) => s.setActiveS3Session);

  const totalSessions = sftpSessions.size + s3Sessions.size;

  // Derive the active tab from store state
  const [activeTab, setActiveTab] = useState<ExplorerTab | null>(null);

  // Sync active tab from stores
  useEffect(() => {
    if (activeSftpSessionId && sftpSessions.has(activeSftpSessionId)) {
      const session = sftpSessions.get(activeSftpSessionId)!;
      setActiveTab({ type: "sftp", id: activeSftpSessionId, label: session.label });
    } else if (activeS3SessionId && s3Sessions.has(activeS3SessionId)) {
      const session = s3Sessions.get(activeS3SessionId)!;
      setActiveTab({ type: "s3", id: activeS3SessionId, label: session.label });
    } else if (sftpSessions.size > 0) {
      const first = sftpSessions.values().next().value;
      if (first) {
        setActiveTab({ type: "sftp", id: first.sftpSessionId, label: first.label });
        setActiveSftpSession(first.sftpSessionId);
      }
    } else if (s3Sessions.size > 0) {
      const first = s3Sessions.values().next().value;
      if (first) {
        setActiveTab({ type: "s3", id: first.sessionId, label: first.label });
        setActiveS3Session(first.sessionId);
      }
    } else {
      setActiveTab(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSftpSessionId, activeS3SessionId, sftpSessions.size, s3Sessions.size]);

  const handleSelectTab = (tab: ExplorerTab) => {
    setActiveTab(tab);
    if (tab.type === "sftp") {
      setActiveSftpSession(tab.id);
      setActiveS3Session(null);
    } else {
      setActiveS3Session(tab.id);
      setActiveSftpSession(null);
    }
  };

  // No sessions — show the session picker
  if (totalSessions === 0) {
    return <SftpSessionPicker />;
  }

  return (
    <div className="flex flex-col h-full">
      <ExplorerTabs activeTab={activeTab} onSelectTab={handleSelectTab} />
      <div className="flex-1 min-h-0">
        {activeTab?.type === "sftp" && (
          <SftpBrowser sftpSessionId={activeTab.id} />
        )}
        {activeTab?.type === "s3" && (
          <S3Browser sessionId={activeTab.id} />
        )}
      </div>
    </div>
  );
}
