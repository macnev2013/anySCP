// Encrypted backup / restore helpers.
//
// The export/import UI uses native file dialogs (and import relaunches the
// app), neither of which WebDriver can drive. So — exactly like the transfer
// helpers — these call window hooks registered in bundled source
// (hosts-store.ts) that invoke the backend commands directly with explicit
// paths. The injected callbacks must NOT `import("@tauri-apps/...")` themselves:
// a bare specifier can't be resolved in code injected at runtime, so the hook
// (which Vite bundled) does the import instead.

/** Encrypt all app data with `password` and write the backup to `path`. */
export async function backupExport(password: string, path: string): Promise<void> {
    await browser.execute(
        async (pw: string, p: string) => {
            const fn = (window as unknown as {
                __e2eBackupExport?: (a: string, b: string) => Promise<void>;
            }).__e2eBackupExport;
            if (!fn) throw new Error("__e2eBackupExport not registered");
            await fn(pw, p);
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
            const fn = (window as unknown as {
                __e2eBackupImport?: (a: string, b: string) => Promise<void>;
            }).__e2eBackupImport;
            if (!fn) throw new Error("__e2eBackupImport not registered");
            await fn(pw, p);
        },
        password,
        path,
    );
}

/** Wipe all data + credentials (factory reset), without the UI relaunch. */
export async function factoryReset(): Promise<void> {
    await browser.execute(async () => {
        const fn = (window as unknown as { __e2eFactoryReset?: () => Promise<void> })
            .__e2eFactoryReset;
        if (!fn) throw new Error("__e2eFactoryReset not registered");
        await fn();
    });
}

/** Row counts straight from the backend, across entity types — so a restore can
 *  be verified at the data layer, not just via the dashboard. */
export async function dataCounts(): Promise<{ hosts: number; groups: number; snippets: number }> {
    return await browser.execute(async () => {
        const fn = (window as unknown as {
            __e2eDataCounts?: () => Promise<{ hosts: number; groups: number; snippets: number }>;
        }).__e2eDataCounts;
        if (!fn) throw new Error("__e2eDataCounts not registered");
        return await fn();
    });
}
