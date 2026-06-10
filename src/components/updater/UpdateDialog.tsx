import { ExternalLink } from "lucide-react";
import { useUpdaterStore } from "../../stores/updater-store";
import { ModalShell, BTN_GHOST, BTN_SECONDARY, BTN_PRIMARY } from "../shared/ModalShell";

const REPO_URL = "https://github.com/macnev2013/anySCP";

/**
 * Shown when an update is available. Lets users install now, defer, or skip.
 * The changelog lives on the tagged GitHub release.
 */
export function UpdateDialog() {
  const open = useUpdaterStore((s) => s.dialogOpen);
  const version = useUpdaterStore((s) => s.version);
  const appVersion = useUpdaterStore((s) => s.appVersion);
  const install = useUpdaterStore((s) => s.installAndRelaunch);
  const dismiss = useUpdaterStore((s) => s.dismissDialog);
  const skip = useUpdaterStore((s) => s.skipUpdate);

  const openChangelog = async () => {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(`${REPO_URL}/releases/tag/v${version}`);
    } catch { /* best-effort */ }
  };

  return (
    <ModalShell
      open={open && !!version}
      onClose={dismiss}
      title="Update available"
      maxWidth="sm"
      footerStart={
        <button type="button" onClick={skip} className={BTN_GHOST}>
          Skip this version
        </button>
      }
      footer={
        <>
          <button type="button" onClick={dismiss} className={BTN_SECONDARY}>
            Later
          </button>
          {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
          <button autoFocus type="button" onClick={() => void install()} className={BTN_PRIMARY}>
            Install
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3 no-select">
        <p className="text-[length:var(--text-sm)] text-text-secondary">
          anySCP <span className="font-medium text-text-primary">v{version}</span> is available
          {appVersion ? <span className="text-text-muted"> — you have v{appVersion}</span> : null}.
        </p>
        <button
          type="button"
          onClick={() => void openChangelog()}
          className="self-start inline-flex items-center gap-1.5 text-[length:var(--text-sm)] font-medium text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
        >
          View changelog on GitHub
          <ExternalLink size={13} strokeWidth={2} />
        </button>
      </div>
    </ModalShell>
  );
}
