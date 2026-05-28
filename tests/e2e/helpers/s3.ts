// S3 helpers — built on the testids added to HostsDashboard, S3ConnectDialog,
// and S3Card.

export interface S3Form {
    label: string;
    provider?: string;   // defaults to "minio"
    accessKey: string;
    secretKey: string;
    region?: string;     // defaults to "us-east-1"
    bucket: string;
    endpoint: string;    // required for non-AWS
}

/** Click "New S3" and wait for the dialog. */
export async function openNewS3Dialog(): Promise<void> {
    const btn = await $("[data-testid='new-s3-button']");
    await btn.waitForClickable({ timeout: 10_000 });
    await btn.click();
    await (await $("[data-testid='s3-dialog']")).waitForDisplayed({ timeout: 5_000 });
}

/** Pick a provider from the CustomSelect by value (e.g. "minio", "aws"). */
async function selectProvider(value: string): Promise<void> {
    const sel = await $("[data-testid='s3-dialog-provider']");
    await sel.click();
    const opt = await $(`[data-testid='s3-dialog-provider-option-${value}']`);
    await opt.waitForClickable({ timeout: 5_000 });
    await opt.click();
}

/** Fill out the dialog. Modal must already be open. */
export async function fillS3Form(f: S3Form): Promise<void> {
    if (f.provider) await selectProvider(f.provider);

    const setInput = async (testid: string, value: string) => {
        const el = await $(`[data-testid='${testid}']`);
        await el.click();
        await el.setValue(value);
    };

    await setInput("s3-dialog-label", f.label);
    await setInput("s3-dialog-access-key", f.accessKey);
    await setInput("s3-dialog-secret-key", f.secretKey);
    if (f.region) await setInput("s3-dialog-region", f.region);
    await setInput("s3-dialog-bucket", f.bucket);
    // Endpoint is conditional on provider !== "aws"; if visible, fill it.
    const endpoint = await $("[data-testid='s3-dialog-endpoint']");
    if (await endpoint.isExisting()) {
        await endpoint.click();
        // The provider preset may pre-populate the endpoint pattern — clear first.
        await browser.keys(["Control", "a"]);
        await browser.keys(["Backspace"]);
        await endpoint.setValue(f.endpoint);
    }
}

export async function clickS3Save(): Promise<void> {
    const btn = await $("[data-testid='s3-dialog-save']");
    await btn.waitForClickable({ timeout: 10_000 });
    await btn.click();
    await browser.waitUntil(
        async () => !(await (await $("[data-testid='s3-dialog']")).isExisting()),
        { timeout: 15_000, timeoutMsg: "S3 dialog did not close after Save" },
    );
}

export async function clickS3Connect(): Promise<void> {
    const btn = await $("[data-testid='s3-dialog-connect']");
    await btn.waitForClickable({ timeout: 10_000 });
    await btn.click();
    await browser.waitUntil(
        async () => !(await (await $("[data-testid='s3-dialog']")).isExisting()),
        { timeout: 30_000, timeoutMsg: "S3 dialog did not close after Connect" },
    );
}

export async function findS3Card(label: string): Promise<WebdriverIO.Element> {
    const card = await $(`[data-s3-label='${label}']`);
    await card.waitForExist({ timeout: 10_000 });
    return card;
}

export async function getS3Id(label: string): Promise<string> {
    const card = await findS3Card(label);
    const id = await card.getAttribute("data-s3-id");
    if (!id) throw new Error(`S3 card '${label}' missing data-s3-id`);
    return id;
}

export async function deleteS3Connection(label: string): Promise<void> {
    const id = await getS3Id(label);
    await browser.execute(async (cid: string) => {
        const w = window as unknown as {
            __e2eDeleteS3Connection?: (id: string) => Promise<void>;
            __e2eReloadS3Connections?: () => Promise<void>;
        };
        if (!w.__e2eDeleteS3Connection) throw new Error("__e2eDeleteS3Connection not registered");
        await w.__e2eDeleteS3Connection(cid);
        // HostsDashboard caches the S3 connection list in component state.
        // Trigger a reload so the card actually disappears from the DOM.
        if (w.__e2eReloadS3Connections) await w.__e2eReloadS3Connections();
    }, id);
    await browser.waitUntil(
        async () => !(await (await $(`[data-s3-label='${label}']`)).isExisting()),
        { timeout: 5_000, timeoutMsg: `S3 connection '${label}' still present` },
    );
}

export async function s3CardCount(): Promise<number> {
    const cards = await $$("[data-s3-id]");
    return cards.length;
}
