// Save a MinIO S3 connection, then click the Explorer button on the saved
// S3 card to open the bucket and verify the seeded objects render.
//
// Note: the dialog's "Connect" button is buggy — it creates the session in
// the backend but doesn't open a tab. The card-click path is what actually
// opens the explorer (it calls addTab + setCurrentBucket). The test uses
// the working path.

import { resetApp } from "../helpers/reset.js";
import { waitForDashboard } from "../helpers/dashboard.js";
import {
    clickS3Save,
    fillS3Form,
    getS3Id,
    openNewS3Dialog,
} from "../helpers/s3.js";
import { waitForEntry, waitForExplorer } from "../helpers/sftp-ops.js";

const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT ?? "http://minio:9000";
const MINIO_BUCKET = process.env.MINIO_BUCKET ?? "anyscp-test";
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY ?? "minioadmin";
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY ?? "minioadmin";

describe("S3 connect + list", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("connects to MinIO and lists the seeded objects", async () => {
        await openNewS3Dialog();
        await fillS3Form({
            label: "minio-explore",
            provider: "minio",
            accessKey: MINIO_ACCESS_KEY,
            secretKey: MINIO_SECRET_KEY,
            region: "us-east-1",
            bucket: MINIO_BUCKET,
            endpoint: MINIO_ENDPOINT,
        });
        await clickS3Save();

        // Click the Explorer action button on the saved card.
        const id = await getS3Id("minio-explore");
        const explorerBtn = await $(`[data-testid='s3-card-${id}-explorer']`);
        await explorerBtn.waitForClickable({ timeout: 10_000 });
        await explorerBtn.click();

        await waitForExplorer();
        await waitForEntry("hello.txt");
        await waitForEntry("data.json");
    });
});
