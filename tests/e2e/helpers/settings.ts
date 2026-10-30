/** Wait for a UI-triggered, asynchronous setting write to reach SQLite. */
export async function waitForPersistedSetting(key: string, value: string): Promise<void> {
    await browser.waitUntil(async () => browser.execute(async (settingKey, settingValue) => {
        const { invoke } = (window as unknown as {
            __TAURI_INTERNALS__: { invoke: (cmd: string) => Promise<[string, string][]> };
        }).__TAURI_INTERNALS__;
        const settings = await invoke("load_all_settings");
        return settings.some(([k, v]) => k === settingKey && v === settingValue);
    }, key, value), {
        timeout: 10_000,
        timeoutMsg: `Setting ${key} was not persisted as ${value}`,
    });
}
