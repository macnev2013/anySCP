// Issue #133: compress files and folders into one archive on the server, so
// a folder of many small files downloads as a single file. zip is used when
// the server has it (sshd-sudo's image adds it); otherwise tar.gz (sshd-pass
// has only busybox tar).

import { expect } from "chai";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
import { refreshExplorer, waitForEntry, waitForExplorer } from "../helpers/sftp-ops.js";
import { activeSftpSessionId, sftpDownload, sftpUpload } from "../helpers/transfers.js";

const SSHD_PASS_HOST = process.env.SSHD_PASS_HOST ?? "sshd-pass";
const SSHD_PASS_PORT = Number(process.env.SSHD_PASS_PORT ?? 2222);
const SSHD_SUDO_HOST = process.env.SSHD_SUDO_HOST ?? "sshd-sudo";
const SSHD_SUDO_PORT = Number(process.env.SSHD_SUDO_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";
const REMOTE_HOME = "/config";

async function openExplorer(label: string, host: string, port: number): Promise<void> {
    await openNewHostModal();
    await fillPasswordHostForm({ label, host, port, username: SSH_USER, password: SSH_PASS });
    await clickSave();
    await waitForModalClosed();
    await findHostCardByLabel(label);
    const hostId = await getHostId(label);
    await (await $(`[data-testid='host-card-${hostId}-explorer']`)).click();
    await waitForExplorer();
}

/** Upload small files into the home directory and wait until they're listed. */
async function seedFiles(files: Record<string, string>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "e2e-compress-"));
    const sid = await activeSftpSessionId();
    for (const [name, body] of Object.entries(files)) {
        const local = join(dir, name);
        await writeFile(local, body, "utf8");
        await sftpUpload(sid, local, `${REMOTE_HOME}/${name}`);
    }
    for (const name of Object.keys(files)) {
        await browser.waitUntil(
            async () => {
                await refreshExplorer();
                return await (await $(`[data-entry-name='${name}']`)).isExisting();
            },
            { timeout: 15_000, timeoutMsg: `${name} never appeared` },
        );
    }
}

/** Select `names`, right-click the first, and choose the menu item `label`. */
async function compressVia(names: string[], label: string): Promise<void> {
    await browser.execute((n: string[]) => {
        const fn = (window as unknown as {
            __e2eExplorerSetSelection?: (n: string[]) => void;
        }).__e2eExplorerSetSelection;
        if (!fn) throw new Error("__e2eExplorerSetSelection not registered");
        fn(n);
    }, names);
    // A real DOM contextmenu event: WebKitWebDriver's synthetic right-click
    // doesn't reliably fire one.
    await browser.execute((name: string) => {
        document.querySelector(`[data-entry-name='${name}']`)?.dispatchEvent(
            new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 120 }),
        );
    }, names[0]);
    await browser.waitUntil(
        async () =>
            browser.execute((l: string) => {
                const item = Array.from(document.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]'))
                    .find((b) => (b.textContent ?? "").trim() === l);
                item?.click();
                return !!item;
            }, label),
        { timeout: 5_000, timeoutMsg: `menu item '${label}' not shown` },
    );
}

/** Download a remote file to the runner and return its bytes. */
async function fetchRemote(name: string): Promise<Buffer> {
    const local = join(await mkdtemp(join(tmpdir(), "e2e-archive-")), name);
    await sftpDownload(await activeSftpSessionId(), `${REMOTE_HOME}/${name}`, local);
    let bytes: Buffer = Buffer.alloc(0);
    await browser.waitUntil(
        async () => {
            try {
                bytes = await readFile(local);
                return bytes.length > 0;
            } catch {
                return false;
            }
        },
        { timeout: 15_000, timeoutMsg: `${name} never downloaded` },
    );
    // Let the transfer finish writing.
    await browser.pause(500);
    return await readFile(local);
}

describe("compress entries into an archive (issue #133)", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("falls back to tar.gz without zip, and never overwrites an archive", async () => {
        await openExplorer("compress-tar", SSHD_PASS_HOST, SSHD_PASS_PORT);
        const stamp = Date.now();
        const a = `cz-a-${stamp}.log`;
        const b = `cz-b-${stamp}.log`;
        await seedFiles({ [a]: "alpha\n", [b]: "beta\n" });

        await compressVia([a], "Compress");
        await waitForEntry(`${a}.tar.gz`, 20_000);

        // Same name again: a numbered sibling, not an overwrite.
        await compressVia([a], "Compress");
        await waitForEntry(`${a} (1).tar.gz`, 20_000);

        // Two files at once land in "Archive.tar.gz" holding both.
        await compressVia([a, b], "Compress 2 items");
        await waitForEntry("Archive.tar.gz", 20_000);
        const tarball = gunzipSync(await fetchRemote("Archive.tar.gz")).toString("latin1");
        expect(tarball).to.contain(a);
        expect(tarball).to.contain(b);
        expect(tarball).to.contain("alpha\n");
    });

    it("creates a .zip when the server has zip", async () => {
        await openExplorer("compress-zip", SSHD_SUDO_HOST, SSHD_SUDO_PORT);
        const stamp = Date.now();
        const a = `cz-z-${stamp}.txt`;
        await seedFiles({ [a]: "zipped payload\n" });

        await compressVia([a], "Compress");
        await waitForEntry(`${a}.zip`, 20_000);
        const zip = await fetchRemote(`${a}.zip`);
        expect(zip.subarray(0, 4).toString("latin1")).to.equal("PK\u0003\u0004");
        expect(zip.toString("latin1")).to.contain(a);
    });
});
