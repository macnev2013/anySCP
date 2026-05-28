// Download one of the seeded S3 objects (hello.txt) and verify the bytes
// arrived locally with the expected content.

import { expect } from "chai";
import { mkdtemp, readFile } from "node:fs/promises";
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
import { waitForExplorer } from "../helpers/sftp-ops.js";
import { activeS3SessionId, s3Download } from "../helpers/transfers.js";

const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT ?? "http://minio:9000";
const MINIO_BUCKET = process.env.MINIO_BUCKET ?? "anyscp-test";
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY ?? "minioadmin";
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY ?? "minioadmin";

describe("S3 download object", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("downloads a seeded object with matching content", async () => {
        await openNewS3Dialog();
        await fillS3Form({
            label: "s3-dl",
            provider: "minio",
            accessKey: MINIO_ACCESS_KEY,
            secretKey: MINIO_SECRET_KEY,
            region: "us-east-1",
            bucket: MINIO_BUCKET,
            endpoint: MINIO_ENDPOINT,
        });
        await clickS3Save();

        const id = await getS3Id("s3-dl");
        await (await $(`[data-testid='s3-card-${id}-explorer']`)).click();
        await waitForExplorer();

        const dir = await mkdtemp(join(tmpdir(), "e2e-s3dl-"));
        const local = join(dir, "hello-out.txt");

        const sessionId = await activeS3SessionId();
        await s3Download(sessionId, "hello.txt", local);

        const text = await readFile(local, "utf8");
        // The seed wrote `echo "hello from minio" | mc pipe`, which produces
        // exactly that string with a trailing newline.
        expect(text.trim()).to.equal("hello from minio");
    });
});
