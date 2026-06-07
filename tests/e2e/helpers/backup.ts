// Encrypted backup / restore helpers.
//
// The export/import UI uses native file dialogs (and the import relaunches the
// app), neither of which WebDriver can drive. So — exactly like the transfer
// helpers — these invoke the backend commands directly via the in-page Tauri
// IPC with explicit file paths. The real passphrase modal and the typed-DELETE
// confirmation are exercised against the UI in the spec; the relaunch is
// reproduced with `relaunchApp()` (a fresh session re-reads the DB), which is
// what the production flow does.

/** Encrypt all app data with `password` and write the backup to `path`. */
export async function backupExport(password: string, path: string): Promise<void> {
    await browser.execute(
        async (pw: string, p: string) => {
            const { invoke } = await import("@tauri-apps/api/core");
            await invoke("backup_export", { password: pw, path: p });
        },
        password,
        path,
    );
}

/** Decrypt the backup at `path` with `password` and restore it (replaces all
 *  current data). Rejects on a wrong password or an invalid file. */
export async function backupImport(password: string, path: string): Promise<void> {
    await browser.execute(
        async (pw: string, p: string) => {
            const { invoke } = await import("@tauri-apps/api/core");
            await invoke("backup_import", { password: pw, path: p });
        },
        password,
        path,
    );
}

/** Wipe all data + credentials (factory reset), without the UI relaunch. */
export async function factoryReset(): Promise<void> {
    await browser.execute(async () => {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("factory_reset");
    });
}
