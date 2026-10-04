import { useEffect } from "react";
import { Terminal, useSessionStore, emitTauriEvent } from "anyscp";

// The terminal renders whatever the backend streams on "ssh:output"; the
// preview replays a short, realistic shell session through the Tauri mock.
useSessionStore.setState({
  sessions: new Map([["s-api", {
    id: "s-api", label: "deploy@api-prod-01.acme.dev", status: "Connected",
    hostConfig: { host: "api-prod-01.acme.dev", port: 22, username: "deploy", auth_method: { type: "privateKey", key_path: "~/.ssh/id_ed25519" } },
  }]]),
  activeSessionId: "s-api",
});

const G = "\x1b[32m", B = "\x1b[34m", C = "\x1b[36m", Y = "\x1b[33m", R = "\x1b[0m", BOLD = "\x1b[1m";
const prompt = `${BOLD}${G}deploy@api-prod-01${R}:${BOLD}${B}~/app${R}$ `;
const SESSION = [
  "Welcome to Ubuntu 24.04.1 LTS (GNU/Linux 6.8.0-45-generic x86_64)",
  "",
  "Last login: Tue Oct  1 09:12:44 2024 from 10.0.1.17",
  `${prompt}systemctl status nginx --no-pager | head -4`,
  `${G}●${R} nginx.service - A high performance web server and a reverse proxy server`,
  `     Loaded: loaded (/usr/lib/systemd/system/nginx.service; enabled; preset: enabled)`,
  `     Active: ${BOLD}${G}active (running)${R} since Mon 2024-09-30 22:03:11 UTC; 11h ago`,
  `   Main PID: 1184 (nginx)`,
  `${prompt}ls -la /var/log/nginx`,
  "total 18432",
  `drwxr-xr-x  2 root     adm      4096 Oct  1 00:00 ${B}.${R}`,
  `-rw-r-----  1 www-data adm   9813244 Oct  1 09:14 access.log`,
  `-rw-r-----  1 www-data adm      4410 Oct  1 06:52 error.log`,
  `-rw-r-----  1 www-data adm   1220391 Sep 30 23:59 ${Y}access.log.1.gz${R}`,
  `${prompt}df -h /`,
  "Filesystem      Size  Used Avail Use% Mounted on",
  `/dev/nvme0n1p1   80G   41G   39G  52% ${C}/${R}`,
  prompt,
].join("\r\n");

function useReplay(sessionId: string, text: string) {
  useEffect(() => {
    const bytes = Array.from(new TextEncoder().encode(text));
    const t = setTimeout(() => emitTauriEvent("ssh:output", { session_id: sessionId, data: bytes }), 300);
    return () => clearTimeout(t);
  }, [sessionId, text]);
}

export const Session = () => {
  useReplay("s-api", SESSION);
  return (
    <div className="rounded-lg overflow-hidden border border-border/60" style={{ width: 760, height: 380 }}>
      <Terminal sessionId="s-api" />
    </div>
  );
};
