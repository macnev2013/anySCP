// Drag-and-drop reordering — verifies that a manual host/group order set via a
// real pointer drag is persisted in SQLite and survives an app restart.

import { expect } from "chai";
import { resetApp, relaunchApp } from "../helpers/reset.js";
import { waitForDashboard } from "../helpers/dashboard.js";
import {
    clickSave,
    fillPasswordHostForm,
    findHostCardByLabel,
    openNewHostModal,
    waitForModalClosed,
} from "../helpers/host.js";
import {
    fillGroupAndSave,
    findGroupCard,
    openNewGroupModal,
} from "../helpers/groups.js";
import {
    domGroupOrder,
    domHostOrder,
    dragOnto,
    waitForPersistedGroupOrder,
    waitForPersistedHostOrder,
} from "../helpers/reorder.js";

const SSHD_PASS_HOST = process.env.SSHD_PASS_HOST ?? "sshd-pass";
const SSHD_PASS_PORT = Number(process.env.SSHD_PASS_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";

async function createHost(label: string): Promise<void> {
    await openNewHostModal();
    await fillPasswordHostForm({
        label,
        host: SSHD_PASS_HOST,
        port: SSHD_PASS_PORT,
        username: SSH_USER,
        password: SSH_PASS,
    });
    await clickSave();
    await waitForModalClosed();
    await findHostCardByLabel(label);
}

describe("drag-and-drop reordering persists across restart", () => {
    it("reorders host cards and persists the new order", async () => {
        await resetApp();
        await waitForDashboard();

        // Labels chosen so the default order (sort_order 0 → label ASC) is a,b,c.
        await createHost("reorder-a");
        await createHost("reorder-b");
        await createHost("reorder-c");

        expect(await domHostOrder()).to.deep.equal([
            "reorder-a",
            "reorder-b",
            "reorder-c",
        ]);

        // Drag the first card onto the last → dnd-kit arrayMove(0, 2) = [b, c, a].
        const first = await findHostCardByLabel("reorder-a");
        const last = await findHostCardByLabel("reorder-c");
        await dragOnto(first, last);

        const expected = ["reorder-b", "reorder-c", "reorder-a"];
        // Confirm the async DB write landed before tearing the session down.
        await waitForPersistedHostOrder(expected);

        // Relaunch without wiping the DB; the new order must reload from SQLite.
        await relaunchApp();
        await waitForDashboard();
        await findHostCardByLabel("reorder-a");
        expect(await domHostOrder()).to.deep.equal(expected);
    });

    it("reorders group cards and persists the new order", async () => {
        await resetApp();
        await waitForDashboard();

        // Groups get sort_order = creation index, so creation order is a,b,c.
        await openNewGroupModal();
        await fillGroupAndSave("grp-a");
        await openNewGroupModal();
        await fillGroupAndSave("grp-b");
        await openNewGroupModal();
        await fillGroupAndSave("grp-c");
        await findGroupCard("grp-c");

        expect(await domGroupOrder()).to.deep.equal(["grp-a", "grp-b", "grp-c"]);

        // Drag the first group card onto the last → [b, c, a].
        const first = await findGroupCard("grp-a");
        const last = await findGroupCard("grp-c");
        await dragOnto(first, last);

        const expected = ["grp-b", "grp-c", "grp-a"];
        await waitForPersistedGroupOrder(expected);

        await relaunchApp();
        await waitForDashboard();
        await findGroupCard("grp-a");
        expect(await domGroupOrder()).to.deep.equal(expected);
    });
});
