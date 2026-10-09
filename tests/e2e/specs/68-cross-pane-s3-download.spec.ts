// Cross-pane recursive S3 download (dual-pane explorer): downloading an S3
// "folder" (a prefix) into the local pane must mirror the WHOLE tree to disk,
// contents intact. This guards the recursive DownloadDir path — the same one
// whose earlier shallow bug (a prefix reporting Completed before its objects
// landed) made a directory move destructive. This spec covers the COPY/download
// half; it asserts every nested object arrives locally with the right bytes,
// not merely that a same-named entry appeared.

import { expect } from "chai";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetApp } from "../helpers/reset.js";
import { waitForDashboard } from "../helpers/dashboard.js";
import { clickS3Save, fillS3Form, getS3Id, openNewS3Dialog } from "../helpers/s3.js";
import { waitForExplorer } from "../helpers/sftp-ops.js";
import { activeS3SessionId, s3Upload } from "../helpers/transfers.js";
import {
    crossPaneCopy,
    enableDualPane,
    waitForBothPanes,
    type CrossPaneEntry,
} from "../helpers/cross-pane.js";

const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT ?? "http://minio:9000";
const MINIO_BUCKET = process.env.MINIO_BUCKET ?? "anyscp-test";
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY ?? "minioadmin";
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY ?? "minioadmin";

async function exists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

describe("cross-pane recursive S3 download (S3 → local)", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("mirrors a whole S3 prefix (including a nested subdir) to the local pane", async () => {
        await enableDualPane();

        await openNewS3Dialog();
        await fillS3Form({
            label: "xpane-s3",
            provider: "minio",
            accessKey: MINIO_ACCESS_KEY,
            secretKey: MINIO_SECRET_KEY,
            region: "us-east-1",
            bucket: MINIO_BUCKET,
            endpoint: MINIO_ENDPOINT,
        });
        await clickS3Save();

        const id = await getS3Id("xpane-s3");
        await (await $(`[data-testid='s3-card-${id}-explorer']`)).click();
        await waitForExplorer();
        await waitForBothPanes("s3");

        // Seed a prefix with a nested tree using explicit object keys (so the
        // bucket layout is deterministic — s3_upload_files would fold in the
        // uploaded dir's own name). alpha at the root, beta one level down.
        const stamp = Date.now();
        const src = await mkdtemp(join(tmpdir(), `e2e-xps3-src-${stamp}-`));
        const alphaLocal = join(src, "alpha.txt");
        const betaLocal = join(src, "beta.txt");
        await writeFile(alphaLocal, "alpha-body\n", "utf8");
        await writeFile(betaLocal, "beta-body\n", "utf8");

        const prefixFolder = `xps3-${stamp}`;
        const sessionId = await activeS3SessionId();
        await s3Upload(sessionId, alphaLocal, `${prefixFolder}/alpha.txt`);
        await s3Upload(sessionId, betaLocal, `${prefixFolder}/nested/beta.txt`);

        // Download the prefix "folder" into a fresh local dir via the cross-pane
        // coordinator. The dir entry id is the prefix (trailing slash → the
        // backend takes the recursive DownloadDir path).
        const dest = await mkdtemp(join(tmpdir(), `e2e-xps3-dst-${stamp}-`));
        const dirEntry: CrossPaneEntry = { id: `${prefixFolder}/`, name: prefixFolder, entryType: "Directory" };
        await crossPaneCopy("remote", [dirEntry], dest);

        // DownloadDir mirrors into <dest>/<prefixFolder>/… — assert the whole
        // tree landed, not just the first object.
        const alpha = join(dest, prefixFolder, "alpha.txt");
        const beta = join(dest, prefixFolder, "nested", "beta.txt");
        await browser.waitUntil(async () => (await exists(alpha)) && (await exists(beta)), {
            timeout: 20_000,
            timeoutMsg: "recursive S3 download never mirrored the full tree to local disk",
        });

        // Bytes, not just names — a truncated/zero-byte download must fail here.
        expect(await readFile(alpha, "utf8")).to.equal("alpha-body\n");
        expect(await readFile(beta, "utf8")).to.equal("beta-body\n");
    });
});
