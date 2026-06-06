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

// A debug/dev binary (`tauri dev` or `tauri build --debug`, e.g. the E2E build)
// must NEVER download + install a release over itself — that overwrites the
// running executable and corrupts it. Only a real release build self-updates.
// Resolved once from the Rust side (`is_release_build`) and cached.
let releaseBuild: boolean | null = null;
async function isReleaseBuild(): Promise<boolean> {
  if (releaseBuild === null) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      releaseBuild = await invoke<boolean>("is_release_build");
    } catch {
      releaseBuild = false; // be conservative — never self-install if unknown
    }
  }
  return releaseBuild;
}

/** Download + install an update, reporting progress into the store. */
async function downloadInstall(
  update: Update,
  set: (partial: Partial<UpdaterState>) => void,
): Promise<void> {
  // Guard every install path here: a non-release build can't self-install
  // without corrupting its own binary, so just surface that an update exists.
  if (!(await isReleaseBuild())) {
    set({ status: "available" });
    return;
  }
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
        // downloadInstall self-guards: on a debug/dev binary it just surfaces
        // that an update exists instead of overwriting the running executable.
        await downloadInstall(update, set);
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
      // downloadInstall no-ops on a non-release build (status stays
      // "available"); only relaunch once an update is actually installed.
      if (get().status !== "ready") return;
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
