// Issue #6: with multiple files selected, the context menu only offered Copy,
// Cut and Delete — no Download — so files had to be downloaded one at a time.
// A "Download N items" entry is now offered for a multi-selection.
//
// The download itself opens a native folder picker the WebDriver can't drive,
// so this asserts the menu entry is present for a multi-selection (the actual
// gap the issue reports). The batch download is handled by the existing
// enqueue_download backend, covered by 46-sftp-upload-recursive's sibling path.

import { resetApp } from "../helpers/reset.js";
import { waitForDashboard } from "../helpers/dashboard.js";
import {
    clickSave,
    fillPasswordHostForm,
    findHostCardByLabel,
    getHostId,
    openNewHostModal,
    waitForModalClosed,
} from "../helpers/host.js";
import { createFile, waitForEntry, waitForExplorer } from "../helpers/sftp-ops.js";

const SSHD_PASS_HOST = process.env.SSHD_PASS_HOST ?? "sshd-pass";
const SSHD_PASS_PORT = Number(process.env.SSHD_PASS_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";

describe("Explorer multi-select download (issue #6)", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("offers 'Download N items' when multiple files are selected", async () => {
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "multi-dl",
            host: SSHD_PASS_HOST,
            port: SSHD_PASS_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickSave();
        await waitForModalClosed();
        await findHostCardByLabel("multi-dl");
        const hostId = await getHostId("multi-dl");
        await (await $(`[data-testid='host-card-${hostId}-explorer']`)).click();
        await waitForExplorer();

        const stamp = Date.now();
        const a = `dl-a-${stamp}`;
        const b = `dl-b-${stamp}`;
        await createFile(a);
        await createFile(b);

        // Select both files via the e2e selection hook.
        await waitForEntry(a);
        await waitForEntry(b);
        await browser.execute((names: string[]) => {
            const fn = (window as unknown as {
                __e2eExplorerSetSelection?: (n: string[]) => void;
            }).__e2eExplorerSetSelection;
            if (!fn) throw new Error("__e2eExplorerSetSelection not registered");
            fn(names);
        }, [a, b]);

        // Open the multi-select context menu on a selected row. Dispatch a real
        // DOM contextmenu event (WebKitWebDriver's synthetic right-click doesn't
        // reliably fire one) — React's onContextMenu handles it the same way.
        await browser.execute((name: string) => {
            const el = document.querySelector(`[data-entry-name='${name}']`) as HTMLElement | null;
            el?.dispatchEvent(
                new MouseEvent("contextmenu", {
                    bubbles: true,
                    cancelable: true,
                    clientX: 120,
                    clientY: 120,
                }),
            );
        }, a);

        // The "Download N items" entry must be present and reflect the count.
        await browser.waitUntil(
            async () =>
                browser.execute(() =>
                    Array.from(document.querySelectorAll('button[role="menuitem"]')).some((b) =>
                        (b.textContent || "").includes("Download 2 items"),
                    ),
                ),
            { timeout: 5_000, timeoutMsg: "'Download 2 items' menu item was not shown" },
        );
    });
});
