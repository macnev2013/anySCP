// S3 connection save + delete via the dashboard.

import { expect } from "chai";
import { resetApp } from "../helpers/reset.js";
import { waitForDashboard } from "../helpers/dashboard.js";
import {
    clickS3Save,
    deleteS3Connection,
    fillS3Form,
    findS3Card,
    openNewS3Dialog,
    s3CardCount,
} from "../helpers/s3.js";

const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT ?? "http://minio:9000";
const MINIO_BUCKET = process.env.MINIO_BUCKET ?? "anyscp-test";
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY ?? "minioadmin";
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY ?? "minioadmin";

describe("S3 connection save", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("saves a MinIO S3 connection and shows it on the dashboard", async () => {
        expect(await s3CardCount()).to.equal(0);

        await openNewS3Dialog();
        await fillS3Form({
            label: "minio-test",
            provider: "minio",
            accessKey: MINIO_ACCESS_KEY,
            secretKey: MINIO_SECRET_KEY,
            region: "us-east-1",
            bucket: MINIO_BUCKET,
            endpoint: MINIO_ENDPOINT,
        });
        await clickS3Save();

        await findS3Card("minio-test");
        expect(await s3CardCount()).to.equal(1);

        await deleteS3Connection("minio-test");
        expect(await s3CardCount()).to.equal(0);
    });
});
