import { ExplorerPage, mockTauri, useS3Store, useSftpStore } from "anyscp";
import type { SftpEntry } from "../../src/types";
import type { SftpSession } from "../../src/stores/sftp-store";

const now = Math.floor(Date.now() / 1000);
const MODE: Record<string, number> = { "-rw-r--r--": 0o644, "-rw-r-----": 0o640, "-rwxr-xr-x": 0o755, "drwxr-xr-x": 0o755, "drwx------": 0o700, "lrwxrwxrwx": 0o777 };
const e = (dir: string, name: string, size: number, ageSec: number, perms = "-rw-r--r--"): SftpEntry => ({
  name, path: `${dir}/${name}`, size, modified: now - ageSec, permissions_display: perms, permissions: MODE[perms] ?? 0o644,
  entry_type: perms[0] === "d" ? "Directory" : perms[0] === "l" ? "Symlink" : "File", is_symlink: perms[0] === "l",
});

const DIRS: Record<string, SftpEntry[]> = {
  "/var/log/nginx": [
    e("/var/log/nginx", "archive", 4096, 3 * 86400, "drwxr-xr-x"),
    e("/var/log/nginx", "access.log", 48_213_904, 120),
    e("/var/log/nginx", "access.log.1", 112_448_210, 86400),
    e("/var/log/nginx", "access.log.2.gz", 9_812_331, 2 * 86400),
    e("/var/log/nginx", "error.log", 1_342_118, 840, "-rw-r-----"),
    e("/var/log/nginx", "error.log.1", 884_120, 86400, "-rw-r-----"),
    e("/var/log/nginx", "healthcheck.log", 22_310, 30),
  ],
  "/etc/nginx": [
    e("/etc/nginx", "conf.d", 4096, 9 * 86400, "drwxr-xr-x"),
    e("/etc/nginx", "sites-available", 4096, 2 * 86400, "drwxr-xr-x"),
    e("/etc/nginx", "sites-enabled", 4096, 2 * 86400, "drwxr-xr-x"),
    e("/etc/nginx", "ssl", 4096, 60 * 86400, "drwx------"),
    e("/etc/nginx", "mime.types", 5_349, 400 * 86400),
    e("/etc/nginx", "nginx.conf", 2_431, 3 * 86400),
    e("/etc/nginx", "fastcgi_params", 1_007, 400 * 86400),
  ],
  "/home/ubuntu/app": [
    e("/home/ubuntu/app", "node_modules", 4096, 5 * 3600, "drwxr-xr-x"),
    e("/home/ubuntu/app", "dist", 4096, 5 * 3600, "drwxr-xr-x"),
    e("/home/ubuntu/app", ".env.production", 812, 20 * 86400, "-rw-r-----"),
    e("/home/ubuntu/app", "deploy.sh", 2_204, 7 * 86400, "-rwxr-xr-x"),
    e("/home/ubuntu/app", "package.json", 3_118, 5 * 3600),
    e("/home/ubuntu/app", "ecosystem.config.js", 640, 30 * 86400),
  ],
};

const listDir = (args: Record<string, unknown>) => {
  const path = String(args.path);
  if (path === "/root") throw { message: "Permission denied (os error 13): /root" };
  return DIRS[path] ?? [];
};
mockTauri({ sftp_list_dir: listDir, scp_list_dir: listDir, sftp_home_dir: "/home/deploy", scp_home_dir: "/home/deploy" });

function sess(id: string, label: string, username: string, currentPath: string, sudoMode = false): SftpSession {
  return {
    sftpSessionId: id, sshSessionId: `ssh-${id}`, label, username, sudoMode, currentPath,
    startDirectory: "", entries: DIRS[currentPath] ?? [], loading: false, error: null, sortBy: "name", sortAsc: true,
  };
}

useSftpStore.setState({
  sessions: new Map([
    ["sftp-logs", sess("sftp-logs", "api-prod-01", "deploy", "/var/log/nginx")],
    ["sftp-sudo", sess("sftp-sudo", "web-staging", "ubuntu", "/etc/nginx", true)],
    ["scp-app", sess("scp-app", "homelab-pi", "ubuntu", "/home/ubuntu/app")],
    ["sftp-denied", sess("sftp-denied", "db-replica", "postgres", "/root")],
  ]),
  activeSftpSessionId: "sftp-logs",
});


const iso = (days: number) => new Date(Date.now() - days * 86400_000).toISOString();
mockTauri({
  s3_list_objects: {
    entries: [
      { name: "fonts", key: "fonts/", entry_type: "Directory", size: 0, last_modified: null, storage_class: null },
      { name: "img", key: "img/", entry_type: "Directory", size: 0, last_modified: null, storage_class: null },
      { name: "app.4f2c9e.js", key: "app.4f2c9e.js", entry_type: "File", size: 812_330, last_modified: iso(0.2), storage_class: "STANDARD" },
      { name: "app.4f2c9e.css", key: "app.4f2c9e.css", entry_type: "File", size: 96_114, last_modified: iso(0.2), storage_class: "STANDARD" },
      { name: "robots.txt", key: "robots.txt", entry_type: "File", size: 212, last_modified: iso(90), storage_class: "STANDARD" },
      { name: "release-2025-q4.tar.gz", key: "release-2025-q4.tar.gz", entry_type: "File", size: 1_204_882_112, last_modified: iso(280), storage_class: "GLACIER" },
    ],
    continuation_token: null, is_truncated: false, prefix: "",
  },
});
useS3Store.setState({
  sessions: new Map([["s3-assets", {
    sessionId: "s3-assets", label: "acme-static-assets", currentBucket: "acme-static-assets", currentPrefix: "",
    entries: [], buckets: [], loading: false, error: null, sortBy: "name", sortAsc: true,
  }]]),
  activeS3SessionId: "s3-assets",
});

const Frame = ({ children }: { children: React.ReactNode }) => (
  <div className="bg-bg-base text-text-primary font-sans" style={{ width: 1232, height: 752 }}>{children}</div>
);

export const SftpLogs = () => <Frame><ExplorerPage sftpSessionId="sftp-logs" /></Frame>;
export const ScpFallback = () => <Frame><ExplorerPage sftpSessionId="scp-app" transport="scp" /></Frame>;
export const S3Bucket = () => <Frame><ExplorerPage s3SessionId="s3-assets" /></Frame>;
