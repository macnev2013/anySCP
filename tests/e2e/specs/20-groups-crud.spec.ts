// Groups CRUD: create a group, verify it renders, delete it, verify it's gone.

import { expect } from "chai";
import { resetApp } from "../helpers/reset.js";
import { waitForDashboard } from "../helpers/dashboard.js";
import {
    deleteGroup,
    fillGroupAndSave,
    findGroupCard,
    groupCount,
    openNewGroupModal,
} from "../helpers/groups.js";

describe("groups CRUD", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("creates a group and shows it on the dashboard", async () => {
        expect(await groupCount()).to.equal(0);
        await openNewGroupModal();
        await fillGroupAndSave("production");
        await findGroupCard("production");
        expect(await groupCount()).to.equal(1);
    });

    it("deletes a group", async () => {
        await openNewGroupModal();
        await fillGroupAndSave("to-delete");
        await findGroupCard("to-delete");
        await deleteGroup("to-delete");
        expect(await groupCount()).to.equal(0);
    });
});
