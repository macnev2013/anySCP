// Drag-and-drop reorder helpers — drive the dnd-kit sortable grids on the
// dashboard via W3C pointer actions, and read the resulting order from both the
// DOM and the persisted backend (via the bundled __e2e store hooks).

/** Labels of the host cards in current DOM order. */
export async function domHostOrder(): Promise<string[]> {
    const cards = await $$("[data-host-id]");
    const labels: string[] = [];
    for (const card of cards) {
        labels.push((await card.getAttribute("data-host-label")) ?? "");
    }
    return labels;
}

/** Names of the group cards in current DOM order. */
export async function domGroupOrder(): Promise<string[]> {
    const cards = await $$("[data-group-id]");
    const names: string[] = [];
    for (const card of cards) {
        names.push((await card.getAttribute("data-group-name")) ?? "");
    }
    return names;
}

/** Labels of the S3 connection cards in current DOM order. */
export async function domS3Order(): Promise<string[]> {
    const cards = await $$("[data-s3-id]");
    const labels: string[] = [];
    for (const card of cards) {
        labels.push((await card.getAttribute("data-s3-label")) ?? "");
    }
    return labels;
}

/** Host labels in persisted (DB) order — confirms the async write landed. */
export async function persistedHostOrder(): Promise<string[]> {
    return browser.execute(async () => {
        const fn = (window as unknown as {
            __e2eHostOrder?: () => Promise<string[]>;
        }).__e2eHostOrder;
        if (!fn) throw new Error("__e2eHostOrder not registered");
        return fn();
    });
}

/** Group names in persisted (DB) order — confirms the async write landed. */
export async function persistedGroupOrder(): Promise<string[]> {
    return browser.execute(async () => {
        const fn = (window as unknown as {
            __e2eGroupOrder?: () => Promise<string[]>;
        }).__e2eGroupOrder;
        if (!fn) throw new Error("__e2eGroupOrder not registered");
        return fn();
    });
}

/** S3 connection labels in persisted (DB) order — confirms the async write landed. */
export async function persistedS3Order(): Promise<string[]> {
    return browser.execute(async () => {
        const fn = (window as unknown as {
            __e2eS3Order?: () => Promise<string[]>;
        }).__e2eS3Order;
        if (!fn) throw new Error("__e2eS3Order not registered");
        return fn();
    });
}

/**
 * Drag `source` onto `target` with a mouse pointer gesture. The moves exceed
 * dnd-kit's 5px MouseSensor activation distance and settle over the target's
 * centre so the sortable registers the swap. Element origins keep the gesture
 * correct regardless of page scroll.
 */
export async function dragOnto(
    source: WebdriverIO.Element,
    target: WebdriverIO.Element,
): Promise<void> {
    await source.scrollIntoView();
    await browser.performActions([
        {
            type: "pointer",
            id: "mouse",
            parameters: { pointerType: "mouse" },
            actions: [
                { type: "pointerMove", duration: 0, origin: source, x: 0, y: 0 },
                { type: "pointerDown", button: 0 },
                { type: "pause", duration: 150 },
                // Exceed the 5px activation distance to start the drag.
                { type: "pointerMove", duration: 80, origin: source, x: 14, y: 0 },
                { type: "pause", duration: 60 },
                // Settle over the target so closestCenter picks it as the drop.
                { type: "pointerMove", duration: 180, origin: target, x: 0, y: 0 },
                { type: "pause", duration: 150 },
                { type: "pointerUp", button: 0 },
            ],
        },
    ]);
    await browser.releaseActions();
}

/** Wait until the persisted host order equals `expected` (JSON compared). */
export async function waitForPersistedHostOrder(expected: string[]): Promise<void> {
    await browser.waitUntil(
        async () =>
            JSON.stringify(await persistedHostOrder()) === JSON.stringify(expected),
        { timeout: 10_000, timeoutMsg: "host order did not persist to the backend" },
    );
}

/** Wait until the persisted S3 order equals `expected` (JSON compared). */
export async function waitForPersistedS3Order(expected: string[]): Promise<void> {
    await browser.waitUntil(
        async () =>
            JSON.stringify(await persistedS3Order()) === JSON.stringify(expected),
        { timeout: 10_000, timeoutMsg: "S3 order did not persist to the backend" },
    );
}

/** Wait until the persisted group order equals `expected` (JSON compared). */
export async function waitForPersistedGroupOrder(expected: string[]): Promise<void> {
    await browser.waitUntil(
        async () =>
            JSON.stringify(await persistedGroupOrder()) === JSON.stringify(expected),
        { timeout: 10_000, timeoutMsg: "group order did not persist to the backend" },
    );
}
