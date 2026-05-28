// Group helpers — built on data-testids in HostsDashboard, GroupModal, GroupCard.

/** Click "New Group" and wait for the modal to appear. */
export async function openNewGroupModal(): Promise<void> {
    const btn = await $("[data-testid='new-group-button']");
    await btn.waitForClickable({ timeout: 10_000 });
    await btn.click();
    await (await $("[data-testid='group-modal']")).waitForDisplayed({ timeout: 5_000 });
}

/** Fill name + save a group. Modal must already be open. */
export async function fillGroupAndSave(name: string): Promise<void> {
    const input = await $("[data-testid='group-modal-name']");
    await input.waitForDisplayed({ timeout: 5_000 });
    await input.click();
    await input.setValue(name);
    const save = await $("[data-testid='group-modal-save']");
    await save.waitForClickable({ timeout: 5_000 });
    await save.click();
    await browser.waitUntil(
        async () => !(await (await $("[data-testid='group-modal']")).isExisting()),
        { timeout: 10_000, timeoutMsg: "group modal did not close" },
    );
}

/** Find a group card by display name. */
export async function findGroupCard(name: string): Promise<WebdriverIO.Element> {
    const card = await $(`[data-group-name='${name}']`);
    await card.waitForExist({ timeout: 10_000 });
    return card;
}

/** Get the group's id from its rendered data attribute. */
export async function getGroupId(name: string): Promise<string> {
    const card = await findGroupCard(name);
    const id = await card.getAttribute("data-group-id");
    if (!id) throw new Error(`group card '${name}' missing data-group-id`);
    return id;
}

/** Delete a group via the store hook (UI uses right-click context menu). */
export async function deleteGroup(name: string): Promise<void> {
    const id = await getGroupId(name);
    await browser.execute(async (groupId: string) => {
        const fn = (window as unknown as {
            __e2eDeleteGroup?: (id: string) => Promise<void>;
        }).__e2eDeleteGroup;
        if (!fn) throw new Error("__e2eDeleteGroup not registered");
        await fn(groupId);
    }, id);
    await browser.waitUntil(
        async () => !(await (await $(`[data-group-name='${name}']`)).isExisting()),
        { timeout: 5_000, timeoutMsg: `group '${name}' still present` },
    );
}

/** Count group cards currently rendered. */
export async function groupCount(): Promise<number> {
    const cards = await $$("[data-group-id]");
    return cards.length;
}
