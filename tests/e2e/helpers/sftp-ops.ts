// SFTP explorer interactions — built on the testids added to
// ExplorerToolbar and ExplorerFileTable.

/** Wait until the explorer toolbar is rendered (refresh button visible). */
export async function waitForExplorer(timeoutMs = 30_000): Promise<void> {
    const refresh = await $("[data-testid='explorer-refresh']");
    await refresh.waitForDisplayed({ timeout: timeoutMs });
}

/** Find a directory entry by its display name. Waits up to timeoutMs. */
export async function waitForEntry(
    name: string,
    timeoutMs = 10_000,
): Promise<WebdriverIO.Element> {
    const el = await $(`[data-entry-name='${name}']`);
    await el.waitForExist({ timeout: timeoutMs });
    return el;
}

/** True if no entry with that name is visible. */
export async function assertEntryAbsent(name: string, timeoutMs = 10_000): Promise<void> {
    await browser.waitUntil(
        async () => !(await (await $(`[data-entry-name='${name}']`)).isExisting()),
        { timeout: timeoutMs, timeoutMsg: `entry '${name}' still present` },
    );
}

/** Double-click an entry to navigate (if directory) or open (if file). */
export async function openEntry(name: string): Promise<void> {
    const entry = await waitForEntry(name);
    await entry.doubleClick();
}

/** Click the explorer refresh button. */
export async function refreshExplorer(): Promise<void> {
    const btn = await $("[data-testid='explorer-refresh']");
    await btn.waitForClickable({ timeout: 5_000 });
    await btn.click();
}

/** Click the home/root toolbar button (navigates to the filesystem root `/`). */
export async function navigateExplorerHome(): Promise<void> {
    const btn = await $("[data-testid='explorer-home']");
    await btn.waitForClickable({ timeout: 5_000 });
    await btn.click();
}

/** Navigate to the parent of the current directory by clicking the
 *  second-to-last breadcrumb segment. Unlike {@link navigateExplorerHome}
 *  (which jumps to root), this goes exactly one level up — use it to return to
 *  the directory an entry was created in after stepping into a subfolder. */
export async function navigateUp(): Promise<void> {
    await browser.execute(() => {
        const container = document.querySelector("[aria-label='Current path']");
        const buttons = container
            ? Array.from(container.querySelectorAll("button"))
            : [];
        const parent = buttons[buttons.length - 2] as HTMLButtonElement | undefined;
        parent?.click();
    });
}

/** Current pressed-state of the sudo toggle ("true"/"false"), or null if the
 *  button isn't rendered (e.g. SCP transport or a root login). */
export async function sudoToggleState(): Promise<string | null> {
    const btn = await $("[data-testid='explorer-sudo-toggle']");
    if (!(await btn.isExisting())) return null;
    return await btn.getAttribute("aria-pressed");
}

/** Click the sudo toggle and wait until the (remounted) explorer reports the
 *  expected pressed state. Toggling reopens the SFTP session over `sudo
 *  sftp-server` and remounts the view, so the button element is replaced. */
export async function toggleSudo(expectOn: boolean): Promise<void> {
    const btn = await $("[data-testid='explorer-sudo-toggle']");
    await btn.waitForClickable({ timeout: 10_000 });
    await btn.click();
    await browser.waitUntil(async () => (await sudoToggleState()) === String(expectOn), {
        timeout: 30_000,
        timeoutMsg: `sudo toggle never reached aria-pressed=${expectOn}`,
    });
    // The reopened session re-lists its directory; wait for the toolbar to settle.
    await waitForExplorer();
}

/** Create a folder via the toolbar. Waits for the new entry to appear. */
export async function createFolder(name: string): Promise<void> {
    await (await $("[data-testid='explorer-new-folder']")).click();
    const input = await $("[data-testid='explorer-new-folder-input']");
    await input.waitForDisplayed({ timeout: 5_000 });
    await input.setValue(name);
    await browser.keys(["Enter"]);
    await waitForEntry(name);
}

/** Create an empty file via the toolbar. */
export async function createFile(name: string): Promise<void> {
    await (await $("[data-testid='explorer-new-file']")).click();
    const input = await $("[data-testid='explorer-new-file-input']");
    await input.waitForDisplayed({ timeout: 5_000 });
    await input.setValue(name);
    await browser.keys(["Enter"]);
    await waitForEntry(name);
}

/** Select an entry by clicking it, then press Delete and confirm. */
export async function deleteEntry(name: string): Promise<void> {
    const entry = await waitForEntry(name);
    await entry.click();
    await browser.keys(["Delete"]);
    const confirm = await $("[data-testid='explorer-delete-confirm-button']");
    await confirm.waitForClickable({ timeout: 5_000 });
    await confirm.click();
    await assertEntryAbsent(name);
}

/** Select a set of entries (via __e2eExplorerSetSelection) then Delete + confirm. */
export async function multiSelectAndDelete(names: string[]): Promise<void> {
    if (names.length === 0) return;
    for (const name of names) await waitForEntry(name);

    await browser.execute((items: string[]) => {
        const fn = (window as unknown as {
            __e2eExplorerSetSelection?: (names: string[]) => void;
        }).__e2eExplorerSetSelection;
        if (!fn) throw new Error("__e2eExplorerSetSelection not registered");
        fn(items);
    }, names);

    // Focus a selected row so the Delete keydown fires on it.
    await browser.execute((firstName: string) => {
        const el = document.querySelector(
            `[data-entry-name='${firstName}']`,
        ) as HTMLElement | null;
        el?.focus();
    }, names[0]);

    await browser.keys(["Delete"]);
    const confirm = await $("[data-testid='explorer-delete-confirm-button']");
    await confirm.waitForClickable({ timeout: 5_000 });
    await confirm.click();
    for (const name of names) await assertEntryAbsent(name);
}

/** Read the displayed rwx permission string of an entry (e.g. "rw-r--r--"),
 *  or null if the entry/permissions cell isn't present. */
export async function entryPermissions(name: string): Promise<string | null> {
    return await browser.execute((n: string) => {
        const row = document.querySelector(`[data-entry-name='${n}']`);
        const cell = row?.querySelector("[data-entry-perms]");
        return cell?.getAttribute("data-entry-perms") ?? null;
    }, name);
}

/** Change an entry's permissions via the __e2eExplorerChmod(name, mode) hook
 *  (which drives onApplyPermissions → sftp_chmod → directory refresh), then
 *  wait until the listing reflects the expected rwx string. `mode` is octal. */
export async function setPermissions(
    name: string,
    mode: number,
    expectedDisplay: string,
    recursive = false,
): Promise<void> {
    await waitForEntry(name);
    // Drive the chmod and AWAIT its promise inside the page so a rejection from
    // the Tauri command surfaces here as a real error (with its reason) instead
    // of being dropped — which would otherwise show up only as the waitUntil
    // timeout below, hiding the actual cause.
    const chmodError = await browser.executeAsync(
        (n: string, m: number, r: boolean, done: (err: string | null) => void) => {
            const fn = (window as unknown as {
                __e2eExplorerChmod?: (n: string, m: number, r?: boolean) => Promise<unknown> | undefined;
            }).__e2eExplorerChmod;
            if (!fn) {
                done("__e2eExplorerChmod not registered");
                return;
            }
            Promise.resolve(fn(n, m, r)).then(
                () => done(null),
                (e: unknown) => done(String((e as { message?: string })?.message ?? e)),
            );
        },
        name,
        mode,
        recursive,
    );
    if (chmodError) {
        throw new Error(`chmod('${name}', ${mode.toString(8)}) failed: ${chmodError}`);
    }
    await browser.waitUntil(
        async () => (await entryPermissions(name)) === expectedDisplay,
        {
            timeout: 10_000,
            timeoutMsg: `entry '${name}' permissions never became '${expectedDisplay}'`,
        },
    );
}

/** Read the current order of entries in the listing (top to bottom). */
export async function entryOrder(): Promise<string[]> {
    return await browser.execute(() => {
        return Array.from(
            document.querySelectorAll<HTMLElement>("[data-entry-row='true']"),
        ).map((el) => el.getAttribute("data-entry-name") ?? "");
    });
}

/** Click a column header to (re)sort by that column. */
export async function clickSortHeader(col: "name" | "size" | "modified"): Promise<void> {
    const btn = await $(`[data-testid='explorer-sort-${col}']`);
    await btn.waitForClickable({ timeout: 5_000 });
    await btn.click();
}

/** Rename an entry. Calls the __e2eExplorerStartRename(oldName, newName) hook
 *  which invokes onRename directly — sidesteps the inline rename input UI
 *  whose autoFocus + onBlur cancel races with WebDriver's setValue. */
export async function renameEntry(oldName: string, newName: string): Promise<void> {
    await waitForEntry(oldName);
    await browser.execute(
        (oldN: string, newN: string) => {
            const fn = (window as unknown as {
                __e2eExplorerStartRename?: (o: string, n?: string) => void;
            }).__e2eExplorerStartRename;
            if (!fn) throw new Error("__e2eExplorerStartRename not registered");
            fn(oldN, newN);
        },
        oldName,
        newName,
    );
    await waitForEntry(newName);
    await assertEntryAbsent(oldName);
}
