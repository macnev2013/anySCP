// Port-forward helpers — built on testids in PortForwardingPage + RuleDialog.

/** Activate the Tunnels sidebar nav. */
export async function gotoPortForwardingPage(): Promise<void> {
    const nav = await $("[aria-label='Tunnels']");
    await nav.waitForClickable({ timeout: 10_000 });
    await nav.click();
    await (await $("[data-testid='new-rule-button']")).waitForDisplayed({ timeout: 10_000 });
}

export async function openNewRuleDialog(): Promise<void> {
    const btn = await $("[data-testid='new-rule-button']");
    await btn.waitForClickable({ timeout: 5_000 });
    await btn.click();
    await (await $("[data-testid='rule-dialog']")).waitForDisplayed({ timeout: 5_000 });
}

export interface RuleForm {
    label: string;
    hostId: string;
    localPort: number;
    remotePort: number;
}

/** Fill the rule dialog and save. */
export async function fillRuleAndSave(rule: RuleForm): Promise<void> {
    // Host CustomSelect — open then click the option.
    const hostSel = await $("[data-testid='rule-host-select']");
    await hostSel.click();
    const opt = await $(`[data-testid='rule-host-select-option-${rule.hostId}']`);
    await opt.waitForClickable({ timeout: 5_000 });
    await opt.click();

    const label = await $("[data-testid='rule-label-input']");
    await label.click();
    await label.setValue(rule.label);

    const lp = await $("[data-testid='rule-local-port']");
    await lp.click();
    await lp.setValue(String(rule.localPort));

    const rp = await $("[data-testid='rule-remote-port']");
    await rp.click();
    await rp.setValue(String(rule.remotePort));

    const save = await $("[data-testid='rule-dialog-save']");
    await save.waitForClickable({ timeout: 5_000 });
    await save.click();
    await browser.waitUntil(
        async () => !(await (await $("[data-testid='rule-dialog']")).isExisting()),
        { timeout: 10_000, timeoutMsg: "rule dialog did not close" },
    );
}

export async function findRuleCard(label: string): Promise<WebdriverIO.Element> {
    const card = await $(`[data-rule-label='${label}']`);
    await card.waitForExist({ timeout: 10_000 });
    return card;
}

export async function getRuleId(label: string): Promise<string> {
    const card = await findRuleCard(label);
    const id = await card.getAttribute("data-rule-id");
    if (!id) throw new Error(`rule card '${label}' missing data-rule-id`);
    return id;
}

export async function deleteRule(label: string): Promise<void> {
    const id = await getRuleId(label);
    await browser.execute(async (rid: string) => {
        const fn = (window as unknown as {
            __e2eDeleteRule?: (id: string) => Promise<void>;
        }).__e2eDeleteRule;
        if (!fn) throw new Error("__e2eDeleteRule not registered");
        await fn(rid);
    }, id);
    await browser.waitUntil(
        async () => !(await (await $(`[data-rule-label='${label}']`)).isExisting()),
        { timeout: 5_000, timeoutMsg: `rule '${label}' still present` },
    );
}

/** Toggle a rule on or off via its switch (the start/stop button). */
export async function toggleRule(label: string): Promise<void> {
    const card = await findRuleCard(label);
    // The switch is inside the card.
    const sw = await card.$("[role='switch']");
    await sw.click();
}

export async function ruleCount(): Promise<number> {
    const cards = await $$("[data-rule-id]");
    return cards.length;
}
