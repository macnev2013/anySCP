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

/**
 * Wait until the backend has `key` saved as `value`. The settings store
 * saves fire-and-forget, so call this before {@link relaunchApp} — a restart
 * that beats the write reads back the old value.
 */
export async function waitForSavedSetting(key: string, value: string): Promise<void> {
    let last: string | null = null;
    try {
        await browser.waitUntil(
            async () => {
                last = await browser.executeAsync(
                    (k: string, done: (v: string | null) => void) => {
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        (window as any).__TAURI_INTERNALS__
                            .invoke("load_all_settings")
                            .then((rows: [string, string][]) =>
                                done(rows.find(([name]) => name === k)?.[1] ?? null),
                            )
                            .catch(() => done(null));
                    },
                    key,
                );
                return last === value;
            },
            { timeout: 10_000 },
        );
    } catch {
        throw new Error(`setting '${key}' was never saved as '${value}' (last: '${last}')`);
    }
}
