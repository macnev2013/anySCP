import { ExternalLink } from "lucide-react";
import { useUpdaterStore } from "../../stores/updater-store";

const REPO_URL = "https://github.com/macnev2013/anySCP";

const BTN_BASE = [
  "px-3 py-1.5 rounded-lg text-[length:var(--text-sm)] font-medium",
  "transition-all duration-[var(--duration-fast)]",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
].join(" ");

/**
 * Shown when an update is available and automatic updates are off (or the user
 * triggered a manual check with auto off). Lets them install now, defer, or
 * skip the version. The changelog lives on the tagged GitHub release.
 */
export function UpdateDialog() {
  const open = useUpdaterStore((s) => s.dialogOpen);
  const version = useUpdaterStore((s) => s.version);
  const appVersion = useUpdaterStore((s) => s.appVersion);
  const install = useUpdaterStore((s) => s.installAndRelaunch);
  const dismiss = useUpdaterStore((s) => s.dismissDialog);
  const skip = useUpdaterStore((s) => s.skipUpdate);

  if (!open || !version) return null;

  const openChangelog = async () => {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(`${REPO_URL}/releases/tag/v${version}`);
    } catch { /* best-effort */ }
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4 no-select animate-[fadeIn_120ms_var(--ease-expo-out)_both]">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Update available"
        className="w-full max-w-md rounded-2xl bg-bg-overlay border border-border shadow-[var(--shadow-lg)] p-5"
      >
        <h2 className="text-[length:var(--text-lg)] font-semibold text-text-primary">
          Update available
        </h2>
        <p className="mt-1 text-[length:var(--text-sm)] text-text-secondary">
          anySCP <span className="font-medium text-text-primary">v{version}</span> is available
          {appVersion ? <span className="text-text-muted"> — you have v{appVersion}</span> : null}.
        </p>

        <button
          type="button"
          onClick={() => void openChangelog()}
          className="mt-3 inline-flex items-center gap-1.5 text-[length:var(--text-sm)] font-medium text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
        >
          View changelog on GitHub
          <ExternalLink size={13} strokeWidth={2} />
        </button>

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={skip}
            className={`${BTN_BASE} text-text-muted hover:text-text-primary`}
          >
            Skip this version
          </button>
          <button
            type="button"
            onClick={dismiss}
            className={`${BTN_BASE} bg-bg-base border border-border text-text-secondary hover:text-text-primary hover:border-border-focus`}
          >
            Later
          </button>
          <button
            type="button"
            onClick={() => void install()}
            className={`${BTN_BASE} bg-accent text-text-inverse hover:bg-accent-hover`}
          >
            Install
          </button>
        </div>
      </div>
    </div>
  );
}
