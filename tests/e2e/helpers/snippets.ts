// Snippets helpers — built on testids in SnippetsPage, SnippetCard,
// SnippetEditModal, and SnippetPalette.

/** Activate the Snippets sidebar nav. */
export async function gotoSnippetsPage(): Promise<void> {
    const nav = await $("[aria-label='Snippets']");
    await nav.waitForClickable({ timeout: 10_000 });
    await nav.click();
    // The New Snippet button is the page's main affordance — wait for it.
    await (await $("[data-testid='new-snippet-button']")).waitForDisplayed({
        timeout: 10_000,
    });
}

/** Click "New Snippet" and wait for the modal. */
export async function openNewSnippetModal(): Promise<void> {
    const btn = await $("[data-testid='new-snippet-button']");
    await btn.waitForClickable({ timeout: 5_000 });
    await btn.click();
    await (await $("[data-testid='snippet-modal']")).waitForDisplayed({ timeout: 5_000 });
}

export interface SnippetForm {
    name: string;
    command: string;
}

/** Fill out the snippet modal and click Save. */
export async function fillSnippetAndSave(s: SnippetForm): Promise<void> {
    const name = await $("[data-testid='snippet-modal-name']");
    await name.click();
    await name.setValue(s.name);
    const cmd = await $("[data-testid='snippet-modal-command']");
    await cmd.click();
    await cmd.setValue(s.command);
    const save = await $("[data-testid='snippet-modal-save']");
    await save.waitForClickable({ timeout: 5_000 });
    await save.click();
    await browser.waitUntil(
        async () => !(await (await $("[data-testid='snippet-modal']")).isExisting()),
        { timeout: 10_000, timeoutMsg: "snippet modal did not close" },
    );
}

/** Find a snippet card by name. */
export async function findSnippetCard(name: string): Promise<WebdriverIO.Element> {
    const card = await $(`[data-snippet-name='${name}']`);
    await card.waitForExist({ timeout: 10_000 });
    return card;
}

/** Read a snippet's id from its rendered data attribute. */
export async function getSnippetId(name: string): Promise<string> {
    const card = await findSnippetCard(name);
    const id = await card.getAttribute("data-snippet-id");
    if (!id) throw new Error(`snippet card '${name}' missing data-snippet-id`);
    return id;
}

/** Delete a snippet via the store hook (UI uses right-click context menu). */
export async function deleteSnippet(name: string): Promise<void> {
    const id = await getSnippetId(name);
    await browser.execute(async (sid: string) => {
        const fn = (window as unknown as {
            __e2eDeleteSnippet?: (id: string) => Promise<void>;
        }).__e2eDeleteSnippet;
        if (!fn) throw new Error("__e2eDeleteSnippet not registered");
        await fn(sid);
    }, id);
    await browser.waitUntil(
        async () => !(await (await $(`[data-snippet-name='${name}']`)).isExisting()),
        { timeout: 5_000, timeoutMsg: `snippet '${name}' still present` },
    );
}

export async function snippetCount(): Promise<number> {
    const cards = await $$("[data-snippet-id]");
    return cards.length;
}

// ─── Snippet palette ──────────────────────────────────────────────────────────

/** Wait for the snippet palette overlay. */
export async function waitForSnippetPalette(): Promise<void> {
    await (await $("[data-testid='snippet-palette']")).waitForDisplayed({ timeout: 5_000 });
}

/** Click a snippet entry in the palette by snippet name. */
export async function clickPaletteSnippet(name: string): Promise<void> {
    const item = await $(`[data-snippet-name='${name}']`);
    await item.waitForClickable({ timeout: 5_000 });
    await item.click();
}
