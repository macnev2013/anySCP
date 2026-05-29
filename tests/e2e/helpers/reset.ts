// Reset helper — wipes the app's persisted state and relaunches the Tauri
// process so each test starts from a clean DB.
//
// The Tauri app reads `$XDG_DATA_HOME/com.macnev2013.anyscp/anyscp.db`.
// Deleting the directory between sessions is sufficient; the app re-creates
// the schema on startup.

import { rm } from "node:fs/promises";
import { join } from "node:path";

const APP_DATA_DIR = join(
    process.env.XDG_DATA_HOME ?? `${process.env.HOME}/.local/share`,
    "com.macnev2013.anyscp",
);

/**
 * Delete the app's data directory and start a fresh WebDriver session.
 * Call this in a `beforeEach` so tests get full isolation.
 */
export async function resetApp(): Promise<void> {
    // The app process is still alive here and keeps writing to the DB dir
    // (SQLite WAL/journal), so a child file can reappear between rm's unlink
    // pass and the final rmdir → ENOTEMPTY. maxRetries makes rm retry the
    // rmdir with a linear backoff until the writes settle.
    await rm(APP_DATA_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
    await browser.reloadSession();
}

/**
 * Relaunch the app without touching the DB — used to verify persistence
 * across restarts.
 */
export async function relaunchApp(): Promise<void> {
    await browser.reloadSession();
}
