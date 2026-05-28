// Snippets CRUD: create, find, delete a snippet.

import { expect } from "chai";
import { resetApp } from "../helpers/reset.js";
import {
    deleteSnippet,
    fillSnippetAndSave,
    findSnippetCard,
    gotoSnippetsPage,
    openNewSnippetModal,
    snippetCount,
} from "../helpers/snippets.js";

describe("snippets CRUD", () => {
    beforeEach(async () => {
        await resetApp();
        await gotoSnippetsPage();
    });

    it("creates, finds, and deletes a snippet", async () => {
        expect(await snippetCount()).to.equal(0);

        await openNewSnippetModal();
        await fillSnippetAndSave({
            name: "Echo Hello",
            command: "echo hello",
        });
        await findSnippetCard("Echo Hello");
        expect(await snippetCount()).to.equal(1);

        await deleteSnippet("Echo Hello");
        expect(await snippetCount()).to.equal(0);
    });
});
