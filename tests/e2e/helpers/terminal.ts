// Terminal helpers — drive an active xterm session through the in-app hook.
//
// The Terminal component registers each xterm instance in
// `window.__e2eTerminals` (keyed by sessionId) so tests can read the buffer
// without touching canvas pixels or DOM rows.

/** Wait until at least one terminal exists in the DOM. Returns its sessionId. */
export async function waitForAnyTerminal(timeoutMs = 30_000): Promise<string> {
    const el = await $("[data-testid^='terminal-']");
    await el.waitForExist({ timeout: timeoutMs });
    const id = await el.getAttribute("data-session-id");
    if (!id) throw new Error("terminal element missing data-session-id");
    return id;
}

/** Wait for the terminal buffer to contain `needle`. */
export async function waitForTerminalText(
    sessionId: string,
    needle: string,
    opts: { timeoutMs?: number; ignoreCase?: boolean } = {},
): Promise<void> {
    const timeoutMs = opts.timeoutMs ?? 15_000;
    const ignoreCase = opts.ignoreCase ?? true;
    await browser.waitUntil(
        async () => {
            const text = await readTerminalText(sessionId);
            return ignoreCase
                ? text.toLowerCase().includes(needle.toLowerCase())
                : text.includes(needle);
        },
        {
            timeout: timeoutMs,
            interval: 250,
            timeoutMsg: `terminal '${sessionId}' did not show '${needle}' within ${timeoutMs}ms`,
        },
    );
}

/** Read the full terminal buffer as plain text. */
export async function readTerminalText(sessionId: string): Promise<string> {
    return await browser.execute((sid: string) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const reg = (window as any).__e2eTerminals as Map<string, any> | undefined;
        const term = reg?.get(sid);
        if (!term) return "";
        const buf = term.buffer.active;
        const lines: string[] = [];
        for (let i = 0; i < buf.length; i++) {
            const line = buf.getLine(i);
            if (line) lines.push(line.translateToString(true));
        }
        return lines.join("\n");
    }, sessionId);
}

/** Send keystrokes to a terminal as if the user typed them. */
export async function typeIntoTerminal(sessionId: string, text: string): Promise<void> {
    // `term.paste()` is the documented public API for programmatically
    // injecting input. It goes through the same `onData` path real
    // keystrokes do, which is what `ssh_send_input` is wired to.
    await browser.execute(
        (sid: string, payload: string) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const reg = (window as any).__e2eTerminals as Map<string, any> | undefined;
            const term = reg?.get(sid);
            if (!term) throw new Error(`no terminal registered for ${sid}`);
            term.paste(payload);
        },
        sessionId,
        text,
    );
}

/** Send a command + newline and wait for the next prompt to appear. */
export async function runCommand(
    sessionId: string,
    cmd: string,
    expectedOutput: string,
    timeoutMs = 10_000,
): Promise<void> {
    await typeIntoTerminal(sessionId, `${cmd}\n`);
    await waitForTerminalText(sessionId, expectedOutput, { timeoutMs });
}
