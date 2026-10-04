import { DropOverwriteDialog } from "anyscp";
import { noop } from "./_fixtures";


// Modal overlays use `position: fixed; inset: 0`; give them a sized, transformed
// containing block so the backdrop fills the cell instead of the content height.
const Stage = ({ children }: { children: React.ReactNode }) => (
  <div className="font-sans bg-bg-base" style={{ width: 912, height: 632, transform: "translateZ(0)" }}>{children}</div>
);

export const MultipleConflicts = () => (
  <Stage><DropOverwriteDialog
    conflicts={["index.html", "favicon.ico", "assets", "robots.txt", "manifest.webmanifest"]}
    targetDir="/var/www/html"
    onConfirm={noop}
    onCancel={noop}
  /></Stage>
);

export const SingleFile = () => (
  <Stage><DropOverwriteDialog conflicts={["docker-compose.yml"]} targetDir="/home/deploy/apps/api-gateway" onConfirm={noop} onCancel={noop} /></Stage>
);
