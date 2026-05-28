// Recursive S3 upload via s3_upload_files — give it a directory and verify
// the nested files appear as objects under the given prefix.

import { expect } from "chai";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetApp } from "../helpers/reset.js";
import { waitForDashboard } from "../helpers/dashboard.js";
import {
    clickS3Save,
    fillS3Form,
    getS3Id,
    openNewS3Dialog,
} from "../helpers/s3.js";
import {
    refreshExplorer,
    waitForEntry,
    waitForExplorer,
} from "../helpers/sftp-ops.js";
import { activeS3SessionId, s3UploadFiles } from "../helpers/transfers.js";

const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT ?? "http://minio:9000";
const MINIO_BUCKET = process.env.MINIO_BUCKET ?? "anyscp-test";
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY ?? "minioadmin";
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY ?? "minioadmin";

describe("S3 recursive upload", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("uploads a directory tree under a prefix", async () => {
        await openNewS3Dialog();
        await fillS3Form({
            label: "s3-rec",
            provider: "minio",
            accessKey: MINIO_ACCESS_KEY,
            secretKey: MINIO_SECRET_KEY,
            region: "us-east-1",
            bucket: MINIO_BUCKET,
            endpoint: MINIO_ENDPOINT,
        });
        await clickS3Save();

        const id = await getS3Id("s3-rec");
        await (await $(`[data-testid='s3-card-${id}-explorer']`)).click();
        await waitForExplorer();

        // Build a local tree.
        const stamp = Date.now();
        const tree = await mkdtemp(join(tmpdir(), `e2e-s3rec-${stamp}-`));
        await writeFile(join(tree, "alpha.txt"), "a\n", "utf8");
        await mkdir(join(tree, "nested"), { recursive: true });
        await writeFile(join(tree, "nested", "beta.txt"), "b\n", "utf8");

        // s3_upload_files walks the dir and writes objects under
        // `${prefix}<relative-path>`. With prefix "e2e-rec-XXX/" we expect
        // the top-level folder in the bucket to be "e2e-rec-XXX".
        const prefix = `e2e-rec-${stamp}/`;
        const prefixFolder = prefix.replace(/\/$/, "");
        const sessionId = await activeS3SessionId();
        const uploaded = await s3UploadFiles(sessionId, [tree], prefix);
        expect(uploaded).to.be.greaterThanOrEqual(2);

        await browser.waitUntil(
            async () => {
                await refreshExplorer();
                return await (await $(`[data-entry-name='${prefixFolder}']`)).isExisting();
            },
            { timeout: 15_000, timeoutMsg: `S3 prefix folder '${prefixFolder}' never appeared` },
        );

        await waitForEntry(prefixFolder);
    });
});
