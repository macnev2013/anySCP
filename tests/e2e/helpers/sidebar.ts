// Sidebar helpers — read collapsed/expanded state from the data attribute.

export async function sidebarExpanded(): Promise<boolean> {
    const sidebar = await $("[data-testid='sidebar']");
    const v = await sidebar.getAttribute("data-sidebar-expanded");
    return v === "true";
}

export async function clickCollapseToggle(): Promise<void> {
    // The toggle's aria-label flips between "Expand" and "Collapse" — match either.
    const btn = await $("[aria-label='Collapse'], [aria-label='Expand']");
    await btn.waitForClickable({ timeout: 5_000 });
    await btn.click();
}
