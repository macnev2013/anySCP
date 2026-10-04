import { SftpTabs, useSftpStore } from "anyscp";
import type { SftpSession } from "../../src/stores/sftp-store";
import { Surface } from "./_fixtures";

function sess(id: string, label: string, currentPath: string): SftpSession {
  return {
    sftpSessionId: id, sshSessionId: `ssh-${id}`, label, username: "deploy", sudoMode: false,
    currentPath, startDirectory: "", entries: [], loading: false, error: null, sortBy: "name", sortAsc: true,
  };
}

useSftpStore.setState({
  sessions: new Map([
    ["sftp-api", sess("sftp-api", "deploy@api-prod-01", "/var/log/nginx")],
    ["sftp-web", sess("sftp-web", "ubuntu@web-staging", "/var/www/html")],
    ["sftp-db", sess("sftp-db", "postgres@db-replica", "/var/lib/postgresql/16/main")],
  ]),
  activeSftpSessionId: "sftp-web",
});

export const ThreeSessions = () => (
  <Surface width={760} pad={0}><SftpTabs /></Surface>
);
