import { activeProfileKey, defaultSettings, prefixKey } from '@project/common/settings';
import { observeKeyBindSet } from './key-bind-settings';

it('loads saved shortcuts, follows edits/profile switches, and disposes its observer', async () => {
    const original = (globalThis as any).browser;
    let changed!: (changes: Record<string, unknown>, area: string) => void;
    const data: Record<string, unknown> = {
        keyBindSet: { ...defaultSettings.keyBindSet, explainSentence: { keys: 'shift+G' } },
        settingsProfiles: [{ name: 'other' }],
        [prefixKey('keyBindSet', 'other')]: { ...defaultSettings.keyBindSet, bufferedMiningNormal: { keys: 'J' } },
    };
    const remove = jest.fn();
    (globalThis as any).browser = {
        storage: {
            local: {
                get: jest.fn(async (keys) =>
                    typeof keys === 'string'
                        ? { [keys]: data[keys] }
                        : Object.fromEntries(
                              Object.entries(keys).map(([key, fallback]) => [key, data[key] ?? fallback])
                          )
                ),
            },
            onChanged: {
                addListener: (listener: typeof changed) => {
                    changed = listener;
                },
                removeListener: remove,
            },
        },
    };
    const update = jest.fn();
    const stop = observeKeyBindSet(update);
    const flush = async () => {
        for (let i = 0; i < 12; i++) await Promise.resolve();
    };
    try {
        await flush();
        expect(update.mock.lastCall?.[0].explainSentence.keys).toBe('shift+G');
        data.keyBindSet = { ...defaultSettings.keyBindSet, bufferedMiningAudio: { keys: '' } };
        changed({ keyBindSet: {} }, 'local');
        await flush();
        expect(update.mock.lastCall?.[0].bufferedMiningAudio.keys).toBe('');
        data[activeProfileKey] = 'other';
        changed({ [activeProfileKey]: {} }, 'local');
        await flush();
        expect(update.mock.lastCall?.[0].bufferedMiningNormal.keys).toBe('J');
        data[prefixKey('keyBindSet', 'other')] = { ...defaultSettings.keyBindSet, bufferedMiningNormal: { keys: 'K' } };
        changed({ [prefixKey('keyBindSet', 'other')]: {} }, 'local');
        await flush();
        expect(update.mock.lastCall?.[0].bufferedMiningNormal.keys).toBe('K');
        const calls = update.mock.calls.length;
        changed({ unrelated: {} }, 'local');
        await flush();
        expect(update).toHaveBeenCalledTimes(calls);
        stop();
        expect(remove).toHaveBeenCalledWith(changed);
    } finally {
        stop();
        (globalThis as any).browser = original;
    }
});
