import { PathBar } from "anyscp";
import { noop, Surface } from "./_fixtures";

export const NginxLogs = () => (
  <Surface width={640} pad={0}><PathBar path="/var/log/nginx" onNavigate={noop} /></Surface>
);
export const DeepPath = () => (
  <Surface width={640} pad={0}><PathBar path="/home/deploy/apps/api-gateway/releases/2026-10-01/config" onNavigate={noop} /></Surface>
);
export const Root = () => (
  <Surface width={640} pad={0}><PathBar path="/" onNavigate={noop} /></Surface>
);
