// Keyboard helpers — anySCP shortcuts use the meta key (Cmd on macOS,
// Ctrl on Linux/Windows). Inside the container we're on Linux, so
// WebdriverIO's "Control" maps onto what the app sees as "meta".
//
// `useKeyboardShortcuts` listens for `metaKey || ctrlKey`, so Control
// works on Linux.

const META = "Control";

/** Tap a single key with the meta modifier (e.g. Cmd+T). */
export async function cmd(key: string): Promise<void> {
    await browser.keys([META, key]);
    // browser.keys() with an array is treated as a chord that releases all
    // keys at the end, so no separate release needed.
}

/** Tap meta+shift+key. */
export async function cmdShift(key: string): Promise<void> {
    await browser.keys([META, "Shift", key]);
}

/** Tap a single key. */
export async function tap(key: string): Promise<void> {
    await browser.keys([key]);
}
