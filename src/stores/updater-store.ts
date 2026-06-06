import { create } from "zustand";
import { useSettingsStore } from "./settings-store";
import type { Update } from "@tauri-apps/plugin-updater";

export type UpdaterStatus =
  | "idle"
  | "checking"
  | "available"   // found, awaiting user decision (auto-update off)
  | "downloading"
  | "ready"       // downloaded + installed, pending restart
  | "up-to-date"
  | "error";

interface UpdaterState {
  status: UpdaterStatus;
  version: string | null;
  progress: number;
  error: string | null;
  appVersion: string | null;
  dialogOpen: boolean;

  loadAppVersion: () => Promise<void>;
  checkOnStartup: () => Promise<void>;
  checkManually: () => Promise<void>;
  installAndRelaunch: () => Promise<void>;
  relaunchNow: () => Promise<void>;
  dismissDialog: () => void;
  skipUpdate: () => void;
}

const message = (err: unknown, fallback: string) =>
  err instanceof Error ? err.message : fallback;

/** Download + install an update, reporting progress into the store. */
async function downloadInstall(
  update: Update,
  set: (partial: Partial<UpdaterState>) => void,
): Promise<void> {
  set({ status: "downloading", progress: 0 });
  let downloaded = 0;
  let total = 0;
  await update.downloadAndInstall((event) => {
    if (event.event === "Started") {
      total = event.data.contentLength ?? 0;
    } else if (event.event === "Progress") {
      downloaded += event.data.chunkLength;
      if (total > 0) set({ progress: Math.round((downloaded / total) * 100) });
    } else if (event.event === "Finished") {
      set({ status: "ready" });
    }
  });
  set({ status: "ready" });
}

export const useUpdaterStore = create<UpdaterState>((set, get) => ({
  status: "idle",
  version: null,
  progress: 0,
  error: null,
  appVersion: null,
  dialogOpen: false,

  loadAppVersion: async () => {
    try {
      const { getVersion } = await import("@tauri-apps/api/app");
      set({ appVersion: await getVersion() });
    } catch { /* best-effort */ }
  },

  // Runs once on launch. With auto-update on, silently downloads + installs the
  // update (applied next launch). With it off, surfaces a popup unless the user
  // skipped this exact version.
  checkOnStartup: async () => {
    if (get().status === "checking" || get().status === "downloading") return;
    set({ status: "checking", error: null });
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (!update) { set({ status: "up-to-date" }); return; }

      set({ version: update.version });
      const { autoUpdate, skippedUpdateVersion } = useSettingsStore.getState();

      if (autoUpdate) {
        // A dev build can't self-install; just surface that an update exists
        // rather than downloading a full release on every dev launch.
        if (import.meta.env.PROD) {
          await downloadInstall(update, set);
        } else {
          set({ status: "available" });
        }
      } else if (skippedUpdateVersion === update.version) {
        set({ status: "idle" });
      } else {
        set({ status: "available", dialogOpen: true });
      }
    } catch (err) {
      set({ status: "error", error: message(err, "Failed to check for updates") });
    }
  },

  // The Settings "Check" button. Honours the auto-update setting: installs
  // silently when on, otherwise opens the popup.
  checkManually: async () => {
    if (get().status === "checking" || get().status === "downloading") return;
    set({ status: "checking", error: null });
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (!update) { set({ status: "up-to-date" }); return; }

      set({ version: update.version });
      if (useSettingsStore.getState().autoUpdate) {
        await downloadInstall(update, set);
      } else {
        set({ status: "available", dialogOpen: true });
      }
    } catch (err) {
      set({ status: "error", error: message(err, "Failed to check for updates") });
    }
  },

  // Popup "Install" — download, install, and restart right away.
  installAndRelaunch: async () => {
    set({ dialogOpen: false, error: null });
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (!update) { set({ status: "up-to-date" }); return; }
      await downloadInstall(update, set);
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (err) {
      set({ status: "error", error: message(err, "Download failed") });
    }
  },

  relaunchNow: async () => {
    try {
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (err) {
      set({ status: "error", error: message(err, "Couldn't restart automatically — please reopen the app") });
    }
  },

  dismissDialog: () => set({ dialogOpen: false }),

  skipUpdate: () => {
    const v = get().version;
    if (v) useSettingsStore.getState().setSkippedUpdateVersion(v);
    set({ dialogOpen: false, status: "idle" });
  },
}));
