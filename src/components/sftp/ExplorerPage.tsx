import { FolderOpen, Cloud } from "lucide-react";
import { ExplorerView } from "./ExplorerView";
import { S3Browser } from "../s3/S3Browser";
import { useSftpStore } from "../../stores/sftp-store";
import { useS3Store } from "../../stores/s3-store";
import type { Transport } from "../../lib/explorer-transport";

interface ExplorerPageProps {
  /** SFTP/SCP transport session id (both live in the sftp store). */
  sftpSessionId?: string;
  /** Defaults to "sftp"; "scp" when the host fell back to SCP. */
  transport?: Transport;
  s3SessionId?: string;
}

export function ExplorerPage({ sftpSessionId, transport = "sftp", s3SessionId }: ExplorerPageProps) {
  const sftpSession = useSftpStore((s) => sftpSessionId ? s.sessions.get(sftpSessionId) : null);
  const s3Session = useS3Store((s) => s3SessionId ? s.sessions.get(s3SessionId) : null);

  const baseLabel = sftpSession?.label ?? s3Session?.label ?? "Explorer";
  // Surface SCP fallback subtly so the user understands why server-side
  // metadata (timestamps, etc.) may look slightly different.
  const label = sftpSessionId && transport === "scp" ? `${baseLabel} · SCP` : baseLabel;
  const isSftp = !!sftpSessionId;
  const Icon = isSftp ? FolderOpen : Cloud;

  return (
    <div className="flex flex-col h-full p-2">
      <div className="flex flex-col flex-1 min-h-0 rounded-lg overflow-hidden border border-border/60">
        {/* Pane header — matching terminal pane style */}
        <div className="flex items-center h-8 px-2.5 gap-2.5 shrink-0 no-select bg-bg-surface/80 border-b border-border/60">
          <Icon size={14} strokeWidth={1.8} className="shrink-0 text-status-connected" aria-hidden="true" />
          <span className="text-[11px] font-mono truncate flex-1 min-w-0 text-text-primary leading-none" title={label}>
            {label}
          </span>
        </div>

        {/* Browser content */}
        <div
          className="flex-1 min-h-0 bg-bg-base"
          data-explorer-transport={sftpSessionId ? transport : s3SessionId ? "s3" : undefined}
        >
          {sftpSessionId && <ExplorerView sessionId={sftpSessionId} transport={transport} />}
          {s3SessionId && <S3Browser sessionId={s3SessionId} />}
        </div>
      </div>
    </div>
  );
}
