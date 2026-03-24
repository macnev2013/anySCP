import { useSftpStore } from "../../stores/sftp-store";
import { SftpBrowser } from "./SftpBrowser";
import { SftpSessionPicker } from "./SftpSessionPicker";
import { SftpTabs } from "./SftpTabs";

export function SftpPage() {
  const sessions = useSftpStore((s) => s.sessions);
  const activeSftpSessionId = useSftpStore((s) => s.activeSftpSessionId);

  if (sessions.size === 0) {
    return <SftpSessionPicker />;
  }

  return (
    <div className="flex flex-col h-full">
      <SftpTabs />
      {activeSftpSessionId && (
        <div className="flex-1 min-h-0">
          <SftpBrowser sftpSessionId={activeSftpSessionId} />
        </div>
      )}
    </div>
  );
}
