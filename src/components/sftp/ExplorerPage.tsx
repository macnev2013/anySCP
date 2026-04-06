import { FolderOpen, Cloud } from "lucide-react";
import { SftpBrowser } from "./SftpBrowser";
import { S3Browser } from "../s3/S3Browser";
import { useSftpStore } from "../../stores/sftp-store";
import { useS3Store } from "../../stores/s3-store";

interface ExplorerPageProps {
  sftpSessionId?: string;
  s3SessionId?: string;
}

export function ExplorerPage({ sftpSessionId, s3SessionId }: ExplorerPageProps) {
  const sftpSession = useSftpStore((s) => sftpSessionId ? s.sessions.get(sftpSessionId) : null);
  const s3Session = useS3Store((s) => s3SessionId ? s.sessions.get(s3SessionId) : null);

  const label = sftpSession?.label ?? s3Session?.label ?? "Explorer";
  const isSftp = !!sftpSessionId;
  const Icon = isSftp ? FolderOpen : Cloud;

  return (
    <div className="flex flex-col h-full p-2">
      <div className="flex flex-col flex-1 min-h-0 rounded-lg overflow-hidden border border-border/60">
        {/* Pane header — matching terminal pane style */}
        <div className="flex items-center h-8 px-2.5 gap-2.5 shrink-0 no-select bg-bg-surface/80 border-b border-border/60">
          <Icon size={13} strokeWidth={1.8} className="shrink-0 text-status-connected" aria-hidden="true" />
          <span className="text-[11px] font-mono truncate flex-1 min-w-0 text-text-primary leading-none" title={label}>
            {label}
          </span>
        </div>

        {/* Browser content */}
        <div className="flex-1 min-h-0 bg-bg-base">
          {sftpSessionId && <SftpBrowser sftpSessionId={sftpSessionId} />}
          {s3SessionId && <S3Browser sessionId={s3SessionId} />}
        </div>
      </div>
    </div>
  );
}
