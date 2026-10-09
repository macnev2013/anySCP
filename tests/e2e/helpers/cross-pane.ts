// Cross-pane transfer helpers — drive the dual-pane explorer's copy/move
// coordinator via the window hooks registered in settings-store.ts (dual-pane
// toggle) and ExplorerPage.tsx (__e2eCrossPaneCopy/Move). Specs assert the real
// transfer outcome (bytes land in the sibling pane; a move deletes its source
// only once the transfer completes) against a live server — no flaky drag.

/** The entry descriptor a cross-pane transfer needs. `id` is the absolute
 *  source path (local) or object key (remote); a directory key ends with "/". */
export interface CrossPaneEntry {
    id: string;
    name: string;
    entryType: "File" | "Directory";
}

/** Turn on the dual-pane explorer before opening a host, so the tab mounts with
 *  both a local and a remote pane (and both runtimes register). */
export async function enableDualPane(): Promise<void> {
    await browser.waitUntil(
        async () =>
            await browser.execute(() => {
                const fn = (window as unknown as { __e2eSetDualPane?: (on: boolean) => void })
                    .__e2eSetDualPane;
                if (!fn) return false;
                fn(true);
                return true;
            }),
        { timeout: 10_000, timeoutMsg: "__e2eSetDualPane never registered" },
    );
}

/** Wait until both panes of a dual-pane explorer have mounted. `remote` is the
 *  remote pane's transport ("sftp" | "scp" | "s3"); the local pane is "local". */
export async function waitForBothPanes(remote: "sftp" | "scp" | "s3" = "sftp"): Promise<void> {
    await (await $("[data-explorer-transport='local']")).waitForExist({ timeout: 30_000 });
    await (await $(`[data-explorer-transport='${remote}']`)).waitForExist({ timeout: 30_000 });
    // The coordinator hook is registered by an effect once cross-pane is live.
    await browser.waitUntil(
        async () =>
            await browser.execute(
                () => typeof (window as unknown as { __e2eCrossPaneCopy?: unknown }).__e2eCrossPaneCopy === "function",
            ),
        { timeout: 10_000, timeoutMsg: "__e2eCrossPaneCopy never registered" },
    );
}

/** Copy `entries` from the given pane into the sibling pane (optionally into a
 *  specific target dir). Fire-and-forget — poll for the outcome after. */
export async function crossPaneCopy(
    from: "local" | "remote",
    entries: CrossPaneEntry[],
    targetDir?: string,
): Promise<void> {
    await browser.execute(
        (f: string, es: CrossPaneEntry[], td: string | undefined) => {
            const fn = (window as unknown as {
                __e2eCrossPaneCopy?: (from: string, entries: CrossPaneEntry[], targetDir?: string) => void;
            }).__e2eCrossPaneCopy;
            if (!fn) throw new Error("__e2eCrossPaneCopy not registered");
            fn(f, es, td);
        },
        from,
        entries,
        targetDir,
    );
}

/** Move `entries` from the given pane into the sibling pane. The source is
 *  deleted only once its transfer completes (never on failure). */
export async function crossPaneMove(
    from: "local" | "remote",
    entries: CrossPaneEntry[],
    targetDir?: string,
): Promise<void> {
    await browser.execute(
        (f: string, es: CrossPaneEntry[], td: string | undefined) => {
            const fn = (window as unknown as {
                __e2eCrossPaneMove?: (from: string, entries: CrossPaneEntry[], targetDir?: string) => void;
            }).__e2eCrossPaneMove;
            if (!fn) throw new Error("__e2eCrossPaneMove not registered");
            fn(f, es, td);
        },
        from,
        entries,
        targetDir,
    );
}

/** Click a specific pane's refresh button (scoped by transport so it doesn't
 *  hit the sibling pane's identically-tagged toolbar). */
export async function refreshPane(transport: "local" | "sftp" | "scp" | "s3"): Promise<void> {
    const btn = await $(`[data-explorer-transport='${transport}'] [data-testid='explorer-refresh']`);
    await btn.waitForClickable({ timeout: 5_000 });
    await btn.click();
}

/** True if the named entry is present in the given pane. */
export async function paneEntryExists(
    transport: "local" | "sftp" | "scp" | "s3",
    name: string,
): Promise<boolean> {
    return await browser.execute(
        (t: string, n: string) =>
            !!document.querySelector(`[data-explorer-transport='${t}'] [data-entry-name='${n}']`),
        transport,
        name,
    );
}

/** Poll (refreshing the pane each round) until the named entry appears. */
export async function waitForPaneEntry(
    transport: "local" | "sftp" | "scp" | "s3",
    name: string,
    timeoutMs = 20_000,
): Promise<void> {
    await browser.waitUntil(
        async () => {
            await refreshPane(transport);
            return await paneEntryExists(transport, name);
        },
        { timeout: timeoutMs, timeoutMsg: `entry '${name}' never appeared in the ${transport} pane` },
    );
}
