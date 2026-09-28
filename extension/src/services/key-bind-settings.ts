import { activeProfileKey, defaultSettings, profilesKey, SettingsProvider } from '@project/common/settings';
import type { KeyBindSet } from '@project/common/settings';
import { ExtensionSettingsStorage } from './extension-settings-storage';

/** Observe persisted binds, including profile changes and settings imports. */
export function observeKeyBindSet(update: (keys: KeyBindSet) => void) {
    const settings = new SettingsProvider(new ExtensionSettingsStorage());
    let disposed = false;
    let revision = 0;
    let previous = '';
    const refresh = async () => {
        const current = ++revision;
        try {
            const { keyBindSet } = await settings.get(['keyBindSet']);
            const serialized = JSON.stringify(keyBindSet);
            if (!disposed && current === revision && serialized !== previous) {
                previous = serialized;
                update(keyBindSet);
            }
        } catch {
            /* Keep the last bindings if the extension is being reloaded. */
        }
    };
    const changed = (changes: Record<string, unknown>, area: string) => {
        if (
            area === 'local' &&
            Object.keys(changes).some(
                (key) => key.endsWith('keyBindSet') || key === activeProfileKey || key === profilesKey
            )
        )
            void refresh();
    };
    update(defaultSettings.keyBindSet);
    browser.storage.onChanged.addListener(changed);
    void refresh();
    return () => {
        disposed = true;
        browser.storage.onChanged.removeListener(changed);
    };
}
