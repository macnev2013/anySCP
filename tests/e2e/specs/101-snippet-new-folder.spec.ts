// Issue #150: the New Snippet dialog's folder picker had no way to create a
// folder — you had to cancel, make the folder from the page, and start over.
// The picker now ends with "+ New folder…", which swaps in a name input; the
// folder is created on Enter and selected for the snippet being written.

import { expect } from "chai";
import { resetApp } from "../helpers/reset.js";
import {
    fillSnippetAndSave,
    findSnippetCard,
    gotoSnippetsPage,
    openNewSnippetModal,
} from "../helpers/snippets.js";

const FOLDER = "Deploys";

// The picker and the name input replace each other, so look each one up
// fresh; a held element reference goes stale after the swap.
const picker = () => $("[data-testid='snippet-modal-folder']");
const newOption = () => $("[data-testid='snippet-modal-folder-option-__new_folder__']");
const nameInput = () => $("[data-testid='snippet-modal-new-folder-name']");

async function chooseNewFolder(): Promise<void> {
    await (await picker()).waitForClickable({ timeout: 5_000 });
    await (await picker()).click();
    await (await newOption()).waitForClickable({ timeout: 5_000 });
    await (await newOption()).click();
    await (await nameInput()).waitForDisplayed({ timeout: 5_000 });
}

describe("New Snippet — create a folder from the folder picker (issue #150)", () => {
    beforeEach(async () => {
        await resetApp();
        await gotoSnippetsPage();
    });

    it("creates the folder, selects it, and saves the snippet into it", async () => {
        await openNewSnippetModal();

        // Escape backs out of the name input without closing the dialog.
        await chooseNewFolder();
        await browser.keys("Escape");
        await (await picker()).waitForDisplayed({ timeout: 5_000 });
        expect(await (await $("[data-testid='snippet-modal']")).isDisplayed()).to.equal(true);

        await chooseNewFolder();
        await (await nameInput()).setValue(FOLDER);
        await browser.keys("Enter");

        // Back to the picker, with a real folder id selected and labelled with
        // the new name. textContent, not getText(): WebKit's driver reports
        // empty visible text for the combobox button.
        await browser.waitUntil(
            async () => {
                const p = await picker();
                if (!(await p.isExisting())) return false;
                const value = await p.getAttribute("data-value");
                const label = String(await p.getProperty("textContent")).trim();
                return !!value && value !== "__new_folder__" && label === FOLDER;
            },
            { timeout: 10_000, timeoutMsg: `folder picker never showed '${FOLDER}'` },
        );
        // Enter created the folder; it did not submit the snippet form.
        expect(await (await $("[data-testid='snippet-modal']")).isDisplayed()).to.equal(true);

        await fillSnippetAndSave({ name: "Ship it", command: "make deploy" });

        // The folder exists on the page, and the snippet lives in it.
        const folderCard = await $(`[data-folder-name='${FOLDER}']`);
        await folderCard.waitForClickable({ timeout: 10_000 });
        expect(await (await $$(`[data-folder-name='${FOLDER}']`)).length).to.equal(1);
        await folderCard.click();
        await findSnippetCard("Ship it");
    });
});
