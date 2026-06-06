// Host form helpers — drive the HostEditModal via testids.

export interface PasswordHost {
    label: string;
    host: string;
    port: number;
    username: string;
    password: string;
}

export interface KeyHost {
    label: string;
    host: string;
    port: number;
    username: string;
    keyPath: string;
}

/** Click the "New Server" button on the hosts dashboard. */
export async function openNewHostModal(): Promise<void> {
    const btn = await $("[data-testid='new-host-button']");
    await btn.waitForClickable({ timeout: 10_000 });
    await btn.click();
    await waitForModalOpen();
}

/** Wait for the host modal to be present + visible. */
export async function waitForModalOpen(): Promise<void> {
    const modal = await $("[data-testid='host-modal']");
    await modal.waitForExist({ timeout: 5_000 });
    await modal.waitForDisplayed({ timeout: 5_000 });
}

/** Wait for the host modal to fully unmount. If it doesn't, surface any
 *  error banner text in the failure message — the banner is at the bottom
 *  of the scrolling modal body and is otherwise invisible in screenshots. */
export async function waitForModalClosed(): Promise<void> {
    try {
        await browser.waitUntil(
            async () => !(await (await $("[data-testid='host-modal']")).isExisting()),
            { timeout: 15_000, timeoutMsg: "modal did not close" },
        );
    } catch (err) {
        const errBanner = await $("[data-testid='host-modal-error']");
        if (await errBanner.isExisting()) {
            const text = await errBanner.getText();
            throw new Error(`modal did not close — error banner: "${text}"`);
        }
        throw err;
    }
}

async function setInput(testid: string, value: string): Promise<void> {
    const el = await $(`[data-testid='${testid}']`);
    await el.waitForExist({ timeout: 5_000 });
    await el.click();
    // setValue clears + types — safer than 'addValue' for inputs that may
    // have a placeholder showing the previous saved value.
    await el.setValue(value);
}

/** Pick an option from the auth-type CustomSelect (password|privateKey). */
async function selectAuthType(value: "password" | "privateKey"): Promise<void> {
    const current = await (await $("[data-testid='host-modal-auth']")).getText();
    const wantPwd = value === "password";
    if (wantPwd && current.toLowerCase().includes("password")) return;
    if (!wantPwd && current.toLowerCase().includes("private")) return;

    await (await $("[data-testid='host-modal-auth']")).click();
    const opt = await $(`[data-testid='host-modal-auth-option-${value}']`);
    await opt.waitForExist({ timeout: 5_000 });
    await opt.click();
}

/** Pick a group in the host modal's group CustomSelect by its id. Options are
 *  rendered as `host-modal-group-option-<groupId>`; waitForDisplayed handles the
 *  dropdown open + async group load. */
export async function selectHostGroup(groupId: string): Promise<void> {
    const trigger = await $("[data-testid='host-modal-group']");
    await trigger.waitForClickable({ timeout: 5_000 });
    await trigger.click();
    const opt = await $(`[data-testid='host-modal-group-option-${groupId}']`);
    await opt.waitForDisplayed({ timeout: 5_000 });
    await opt.click();
}

/** Fill the password-auth form fields. Modal must already be open. */
export async function fillPasswordHostForm(h: PasswordHost): Promise<void> {
    await selectAuthType("password");
    await setInput("host-modal-label", h.label);
    await setInput("host-modal-host", h.host);
    await setInput("host-modal-port", String(h.port));
    await setInput("host-modal-username", h.username);
    await setInput("host-modal-password", h.password);
}

/** Fill the key-auth form fields. Modal must already be open. */
export async function fillKeyHostForm(h: KeyHost): Promise<void> {
    await selectAuthType("privateKey");
    await setInput("host-modal-label", h.label);
    await setInput("host-modal-host", h.host);
    await setInput("host-modal-port", String(h.port));
    await setInput("host-modal-username", h.username);
    // The keypath field is either a CustomSelect (when SSH keys were auto-
    // discovered in ~/.ssh) or a plain text input. In the container the
    // ~/.ssh dir is empty so we get the input.
    const keyInput = await $("[data-testid='host-modal-keypath']");
    if (await keyInput.isExisting()) {
        await keyInput.click();
        await keyInput.setValue(h.keyPath);
    } else {
        throw new Error(
            "host-modal-keypath input not present — SSH key auto-discovery " +
                "found keys and rendered a select instead. Wire that path up if needed.",
        );
    }
}

export async function clickSave(): Promise<void> {
    const btn = await $("[data-testid='host-modal-save']");
    await btn.waitForClickable({ timeout: 5_000 });
    await btn.click();
}

/** Toggle the "Connect through SSH tunnel" checkbox to the desired state. */
export async function setTunnelEnabled(on: boolean): Promise<void> {
    const cb = await $("[data-testid='host-modal-tunnel-enabled']");
    await cb.waitForExist({ timeout: 5_000 });
    if ((await cb.isSelected()) !== on) {
        await cb.click();
    }
}

/** Pick a tunnel host by its id from the tunnel CustomSelect. Modal must be open
 *  and the tunnel toggle enabled. */
export async function selectTunnelHost(hostId: string): Promise<void> {
    const trigger = await $("[data-testid='host-modal-tunnel-host']");
    await trigger.waitForClickable({ timeout: 5_000 });
    await trigger.click();
    const opt = await $(`[data-testid='host-modal-tunnel-host-option-${hostId}']`);
    await opt.waitForDisplayed({ timeout: 5_000 });
    await opt.click();
}

export async function clickConnect(): Promise<void> {
    const btn = await $("[data-testid='host-modal-connect']");
    await btn.waitForClickable({ timeout: 5_000 });
    await btn.click();
}

/** Open the edit modal for an existing host. Drives the UI store directly via
 *  the `__e2eOpenHostEdit` window hook (right-click context menu is flaky in
 *  WebKitWebDriver). */
export async function openHostEdit(hostLabel: string): Promise<void> {
    const hostId = await getHostId(hostLabel);
    await browser.execute((id: string) => {
        const fn = (window as unknown as { __e2eOpenHostEdit?: (id: string) => void })
            .__e2eOpenHostEdit;
        if (!fn) throw new Error("__e2eOpenHostEdit not registered");
        fn(id);
    }, hostId);
    await waitForModalOpen();
}

/** Find a host card on the dashboard by its display label. */
export async function findHostCardByLabel(label: string): Promise<WebdriverIO.Element> {
    const card = await $(`[data-testid^='host-card-'][data-host-label='${label}']`);
    await card.waitForExist({ timeout: 10_000 });
    return card;
}

/** Assert that no host card with the given label exists. */
export async function assertHostAbsent(label: string): Promise<void> {
    await browser.waitUntil(
        async () => {
            const el = await $(`[data-testid^='host-card-'][data-host-label='${label}']`);
            return !(await el.isExisting());
        },
        { timeout: 10_000, timeoutMsg: `host '${label}' still present on dashboard` },
    );
}

/** Read the host id from the data attribute on its card. */
export async function getHostId(label: string): Promise<string> {
    const card = await findHostCardByLabel(label);
    const id = await card.getAttribute("data-host-id");
    if (!id) throw new Error(`host card '${label}' missing data-host-id`);
    return id;
}

/** Duplicate a host via the store hook (avoids right-click context menu). */
export async function duplicateHost(label: string): Promise<void> {
    const hostId = await getHostId(label);
    await browser.execute(async (id: string) => {
        const fn = (window as unknown as {
            __e2eDuplicateHost?: (id: string) => Promise<void>;
        }).__e2eDuplicateHost;
        if (!fn) throw new Error("__e2eDuplicateHost not registered");
        await fn(id);
    }, hostId);
}
