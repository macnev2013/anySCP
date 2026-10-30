import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ExplorerEntry } from "../types/explorer";

export type QuickLookTarget =
  | { transport: "sftp" | "scp"; sessionId: string; path: string }
  | { transport: "s3"; sessionId: string; bucketName: string; key: string };
export interface PreviewIdentity { ownerId: string; requestId: string; revision: number }
export interface QuickLookState extends PreviewIdentity {
  phase: "preparing" | "downloading" | "visible" | "closed" | "cancelled" | "error";
  bytesReceived: number;
  totalBytes: number | null;
  error?: { kind: string; message: string } | null;
}
export interface PreviewProgress extends QuickLookState { fileName: string }
interface Snapshot { revision: number; current: QuickLookState | null }
interface Backend {
  invoke: typeof invoke;
  listen: (handler: (state: QuickLookState) => void) => Promise<() => void>;
}
const backend: Backend = {
  invoke,
  listen: (handler) => getCurrentWindow().listen<QuickLookState>("quicklook:state", (event) => handler(event.payload)),
};

// Every Explorer in this webview shares the same clock, including cleanup.
// A backend snapshot also reconciles this after a webview reload/HMR.
export class PreviewClock {
  private revision = 0;
  observe(revision: number) { this.revision = Math.max(this.revision, revision); }
  next() { return ++this.revision; }
}
const clock = new PreviewClock();

export function canQuickLook(entry: ExplorerEntry): boolean {
  return entry.entryType === "File" && !entry.isSymlink;
}

export function isPreviewKey(event: {
  key: string; repeat: boolean; isComposing: boolean;
  metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean;
}, target: Element): boolean {
  return (event.key === " " || event.key === "Escape") && !event.isComposing
    && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
    && !target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox']");
}

type Active = {
  identity: PreviewIdentity; entryId: string; fileName: string;
  restore: () => void; lastPhase: QuickLookState["phase"];
};

/** One owner, window-wide revisions. State is set before IPC so even an event
 * arriving before the open response has an identity to match. */
export class QuickLookClient {
  private active: Active | null = null;
  private focusAfterClose: Active | null = null;
  private unlisten?: () => void;
  private disposed = false;
  private supported = false;
  private ready?: Promise<boolean>;

  constructor(
    private ownerId: string,
    private changed: (state: PreviewProgress | null) => void,
    private error: (message: string) => void,
    private api: Backend = backend,
    private revisions = clock,
  ) {}

  connect(): Promise<boolean> {
    return this.ready ??= (async () => {
      try {
        const capabilities = await this.api.invoke<{ supported: boolean }>("quicklook_capabilities");
        if (this.disposed || !capabilities.supported) return false;
        const unlisten = await this.api.listen((state) => this.receive(state));
        if (this.disposed) { unlisten(); return false; }
        this.unlisten = unlisten;
        const snapshot = await this.api.invoke<Snapshot>("quicklook_state");
        if (this.disposed) return false;
        this.revisions.observe(snapshot.revision);
        // A snapshot is only allowed to update this owner's current request.
        if (snapshot.current) this.receive(snapshot.current);
        this.supported = true;
        return true;
      } catch {
        // Browser previews and unsupported platforms retain normal Space input.
        this.unlisten?.();
        return false;
      }
    })();
  }

  toggle(entry: ExplorerEntry, target: QuickLookTarget, restore: () => void): void {
    if (this.disposed || !this.supported || !canQuickLook(entry)) return;
    if (this.active?.entryId === entry.id) { this.close(true); return; }
    this.close(false);
    this.focusAfterClose = null;
    const identity = { ownerId: this.ownerId, requestId: crypto.randomUUID(), revision: this.revisions.next() };
    const active: Active = { identity, entryId: entry.id, fileName: entry.name, restore, lastPhase: "preparing" };
    this.active = active;
    this.changed({ ...identity, phase: "preparing", bytesReceived: 0, totalBytes: null, fileName: entry.name });
    void this.api.invoke<boolean>("quicklook_open", { identity, target }).then((accepted) => {
      if (!accepted && this.active === active) { this.active = null; this.changed(null); }
    }).catch((error: unknown) => {
      if (this.active !== active || this.disposed) return;
      this.active = null; this.changed(null);
      this.error(errorMessage(error));
    });
  }

  selectionChanged(entries: ExplorerEntry[]): void {
    if (this.active && (entries.length !== 1 || entries[0].id !== this.active.entryId || !canQuickLook(entries[0]))) this.close(false);
  }

  close(restoreFocus = false): void {
    const active = this.active;
    if (!restoreFocus) this.focusAfterClose = null;
    if (!active) return;
    this.active = null;
    this.focusAfterClose = restoreFocus ? active : null;
    this.changed(null);
    const identity = { ...active.identity, revision: this.revisions.next() };
    void this.api.invoke("quicklook_close", { identity }).catch((error: unknown) => {
      if (!this.disposed) this.error(errorMessage(error));
    });
  }

  private receive(state: QuickLookState): void {
    this.revisions.observe(state.revision);
    if (this.disposed || state.ownerId !== this.ownerId) return;
    const terminal = state.phase === "closed" || state.phase === "cancelled" || state.phase === "error";
    if (terminal && !this.active && this.focusAfterClose?.identity.requestId === state.requestId) {
      const focus = this.focusAfterClose;
      this.focusAfterClose = null;
      if (state.phase !== "error") focus.restore();
      return;
    }
    const active = this.active;
    if (!active || state.requestId !== active.identity.requestId || state.revision !== active.identity.revision) return;
    // A duplicate/late progress event cannot regress a visible panel.
    if (active.lastPhase === "visible" && !terminal && state.phase !== "visible") return;
    active.lastPhase = state.phase;
    if (terminal) {
      this.active = null; this.changed(null);
      if (state.phase === "error" && state.error?.kind !== "cancelled") this.error(state.error?.message ?? "Quick Look failed");
      if (state.phase === "closed") active.restore();
    } else {
      this.changed({ ...state, fileName: active.fileName });
    }
  }

  dispose(): void {
    this.disposed = true;
    this.close(false);
    this.unlisten?.();
  }
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return typeof error === "string" ? error : "Quick Look failed";
}
