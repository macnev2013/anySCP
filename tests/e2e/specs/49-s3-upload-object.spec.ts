// Upload a local file as an S3 object via s3_upload_file, then verify it
// appears in the bucket listing.

import { mkdtemp, writeFile } from "node:fs/promises";
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
import { activeS3SessionId, s3Upload } from "../helpers/transfers.js";

const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT ?? "http://minio:9000";
const MINIO_BUCKET = process.env.MINIO_BUCKET ?? "anyscp-test";
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY ?? "minioadmin";
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY ?? "minioadmin";

describe("S3 upload object", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("uploads a local file as an S3 object", async () => {
        await openNewS3Dialog();
        await fillS3Form({
            label: "s3-upload",
            provider: "minio",
            accessKey: MINIO_ACCESS_KEY,
            secretKey: MINIO_SECRET_KEY,
            region: "us-east-1",
            bucket: MINIO_BUCKET,
            endpoint: MINIO_ENDPOINT,
        });
        await clickS3Save();

        const id = await getS3Id("s3-upload");
        await (await $(`[data-testid='s3-card-${id}-explorer']`)).click();
        await waitForExplorer();

        const stamp = Date.now();
        const dir = await mkdtemp(join(tmpdir(), "e2e-s3up-"));
        const localPath = join(dir, "src.txt");
        const key = `e2e-uploaded-${stamp}.txt`;
        await writeFile(localPath, "uploaded from e2e\n", "utf8");

        const sessionId = await activeS3SessionId();
        await s3Upload(sessionId, localPath, key);

        await browser.waitUntil(
            async () => {
                await refreshExplorer();
                return await (await $(`[data-entry-name='${key}']`)).isExisting();
            },
            { timeout: 15_000, timeoutMsg: `S3 object '${key}' never appeared` },
        );

        await waitForEntry(key);
    });
});
