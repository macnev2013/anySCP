// History page helpers.

/** Activate the History sidebar nav. */
export async function gotoHistoryPage(): Promise<void> {
    const nav = await $("[aria-label='History']");
    await nav.waitForClickable({ timeout: 10_000 });
    await nav.click();
    // Page is rendered when at least one entry exists OR a search bar is shown.
    await browser.pause(200);
}

export async function historyEntryCount(): Promise<number> {
    const entries = await $$("[data-testid^='history-entry-']");
    return entries.length;
}

export async function waitForHistoryEntry(hostLabel: string, timeoutMs = 10_000): Promise<void> {
    const el = await $(`[data-history-host-label='${hostLabel}']`);
    await el.waitForExist({ timeout: timeoutMs });
}
