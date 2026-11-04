// Issue #137: a bucket with ~180k objects never opened — s3_list_objects
// walked every page of the listing before returning anything. Listings now
// come back one page (1000 keys) at a time with a "Load more" footer.
//
// minio-seed fills the `anyscp-large` bucket with 1005 objects (obj-0001.txt …
// obj-1005.txt): one full page plus a short second page.

import { expect } from "chai";
import { resetApp } from "../helpers/reset.js";
import { waitForDashboard } from "../helpers/dashboard.js";
import { clickS3Save, fillS3Form, getS3Id, openNewS3Dialog } from "../helpers/s3.js";
import { waitForEntry, waitForExplorer } from "../helpers/sftp-ops.js";

const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT ?? "http://minio:9000";
const MINIO_LARGE_BUCKET = process.env.MINIO_LARGE_BUCKET ?? "anyscp-large";
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY ?? "minioadmin";
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY ?? "minioadmin";

async function entryCount(): Promise<number> {
    return (await $$("[data-entry-name]")).length;
}

describe("S3 large bucket paging (issue #137)", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("shows the first page, then loads the rest on demand", async () => {
        await openNewS3Dialog();
        await fillS3Form({
            label: "minio-large",
            provider: "minio",
            accessKey: MINIO_ACCESS_KEY,
            secretKey: MINIO_SECRET_KEY,
            region: "us-east-1",
            bucket: MINIO_LARGE_BUCKET,
            endpoint: MINIO_ENDPOINT,
        });
        await clickS3Save();

        const id = await getS3Id("minio-large");
        const explorerBtn = await $(`[data-testid='s3-card-${id}-explorer']`);
        await explorerBtn.waitForClickable({ timeout: 10_000 });
        await explorerBtn.click();
        await waitForExplorer();

        // First page only: 1000 entries and a Load more footer.
        await waitForEntry("obj-0001.txt");
        const footer = await $("[data-testid='s3-load-more']");
        await footer.waitForDisplayed({ timeout: 15_000 });
        expect(await (await $("[data-testid='s3-load-more-count']")).getText()).to.include(
            "Showing 1,000 items",
        );
        expect(await entryCount()).to.equal(1000);
        expect(await (await $("[data-entry-name='obj-1005.txt']")).isExisting()).to.equal(false);

        // Load the remaining 5; the footer disappears once the listing is complete.
        await (await $("[data-testid='s3-load-more-button']")).click();
        await waitForEntry("obj-1005.txt");
        await browser.waitUntil(async () => !(await footer.isExisting()), {
            timeout: 15_000,
            timeoutMsg: "Load more footer still shown after the last page",
        });
        expect(await entryCount()).to.equal(1005);
    });
});
