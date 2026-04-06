import { SftpBrowser } from "./SftpBrowser";
import { S3Browser } from "../s3/S3Browser";

interface ExplorerPageProps {
  sftpSessionId?: string;
  s3SessionId?: string;
}

export function ExplorerPage({ sftpSessionId, s3SessionId }: ExplorerPageProps) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 min-h-0">
        {sftpSessionId && <SftpBrowser sftpSessionId={sftpSessionId} />}
        {s3SessionId && <S3Browser sessionId={s3SessionId} />}
      </div>
    </div>
  );
}
