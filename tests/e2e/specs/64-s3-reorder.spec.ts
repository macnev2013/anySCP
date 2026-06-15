// Drag-and-drop reordering for S3 connections — verifies that a manual order
// set via a real pointer drag is persisted in SQLite and survives an app
// restart. Mirrors 63-host-reorder for the Cloud Storage section.

import { expect } from "chai";
import { resetApp, relaunchApp } from "../helpers/reset.js";
import { waitForDashboard } from "../helpers/dashboard.js";
import {
    clickS3Save,
    fillS3Form,
    findS3Card,
    openNewS3Dialog,
} from "../helpers/s3.js";
import {
    domS3Order,
    dragOnto,
    waitForPersistedS3Order,
} from "../helpers/reorder.js";

const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT ?? "http://minio:9000";
const MINIO_BUCKET = process.env.MINIO_BUCKET ?? "anyscp-test";
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY ?? "minioadmin";
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY ?? "minioadmin";

async function createS3Connection(label: string): Promise<void> {
    await openNewS3Dialog();
    await fillS3Form({
        label,
        provider: "minio",
        accessKey: MINIO_ACCESS_KEY,
        secretKey: MINIO_SECRET_KEY,
        region: "us-east-1",
        bucket: MINIO_BUCKET,
        endpoint: MINIO_ENDPOINT,
    });
    await clickS3Save();
    await findS3Card(label);
}

describe("S3 connection drag-and-drop reordering persists across restart", () => {
    it("reorders S3 cards and persists the new order", async () => {
        await resetApp();
        await waitForDashboard();

        // Labels chosen so the default order (sort_order 0 → label ASC) is a,b,c.
        await createS3Connection("s3-reorder-a");
        await createS3Connection("s3-reorder-b");
        await createS3Connection("s3-reorder-c");

        expect(await domS3Order()).to.deep.equal([
            "s3-reorder-a",
            "s3-reorder-b",
            "s3-reorder-c",
        ]);

        // Drag the first card onto the last → dnd-kit arrayMove(0, 2) = [b, c, a].
        const first = await findS3Card("s3-reorder-a");
        const last = await findS3Card("s3-reorder-c");
        await dragOnto(first, last);

        const expected = ["s3-reorder-b", "s3-reorder-c", "s3-reorder-a"];
        // Confirm the async DB write landed before tearing the session down.
        await waitForPersistedS3Order(expected);

        // Relaunch without wiping the DB; the new order must reload from SQLite.
        await relaunchApp();
        await waitForDashboard();
        await findS3Card("s3-reorder-a");
        expect(await domS3Order()).to.deep.equal(expected);
    });
});
