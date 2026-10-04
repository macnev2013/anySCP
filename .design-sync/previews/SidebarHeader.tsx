import { SidebarHeader } from "anyscp";
import { Surface } from "./_fixtures";

// SidebarHeader is a deprecated no-op (renders null); the logo and nav now live
// inside Sidebar. This cell documents that it intentionally renders nothing.
export const Deprecated = () => (
  <Surface width={360}>
    <SidebarHeader />
    <p className="text-[length:var(--text-xs)] text-text-muted">
      SidebarHeader renders nothing — navigation moved into <span className="font-mono text-text-secondary">Sidebar</span>.
    </p>
  </Surface>
);
