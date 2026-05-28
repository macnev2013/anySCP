// Dashboard helpers — assertions about the hosts dashboard.

/** Wait for the hosts dashboard ("New Server" button visible). */
export async function waitForDashboard(timeoutMs = 30_000): Promise<void> {
    const btn = await $("[data-testid='new-host-button']");
    await btn.waitForDisplayed({ timeout: timeoutMs });
}

/** Number of host cards currently rendered. */
export async function hostCardCount(): Promise<number> {
    // `data-host-id` only appears on the outer card div — using it avoids
    // matching the inner terminal/explorer action buttons (which also have
    // testids starting with `host-card-…`).
    const cards = await $$("[data-host-id]");
    return cards.length;
}
