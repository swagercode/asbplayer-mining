import { defaultSettings, ensureConsistencyOnRead } from '@project/common/settings/settings-provider';
import {
    hasMicroMiningKeys,
    keyBindKeys,
    restoreMicroKeyboardKeys,
    subtitleNavigationKeys,
} from '@project/common/settings/key-bindings';

const micro = {
    ...defaultSettings.keyBindSet,
    bufferedMiningNormal: { keys: 'H' },
    bufferedMiningAudio: { keys: 'G' },
    bufferedMiningCancel: { keys: 'J' },
    bufferedMiningChoice1: { keys: 'C' },
    bufferedMiningChoice2: { keys: 'F' },
    bufferedMiningChoice3: { keys: 'D' },
    bufferedMiningChoice4: { keys: 'E' },
    explainSentence: { keys: 'R' },
    togglePlay: { keys: 'L' },
    seekToPreviousSubtitle: { keys: 'K' },
    seekToNextSubtitle: { keys: 'M' },
    seekToBeginningOfCurrentSubtitle: { keys: 'I' },
};

it('restores keyboard keys without losing any Micro mapping or changing stored input', () => {
    const migrated = ensureConsistencyOnRead({ keyBindSet: micro }).keyBindSet!;
    for (const name of Object.keys(micro) as (keyof typeof micro)[]) {
        if (micro[name].keys) expect(keyBindKeys(migrated[name])).toContain(micro[name].keys);
    }
    expect(migrated.bufferedMiningNormal).toEqual({ keys: 'N', alternateKeys: 'H' });
    expect(migrated.bufferedMiningChoice2).toEqual({ keys: '2', alternateKeys: 'F' });
    expect(migrated.explainSentence).toEqual({ keys: 'F', alternateKeys: 'R' });
    expect(migrated.togglePlay).toEqual({ keys: 'space', alternateKeys: 'L' });
    expect(migrated.seekToBeginningOfCurrentSubtitle).toEqual({ keys: 'W', alternateKeys: 'I' });
    expect(migrated.seekToPreviousSubtitle).toEqual({ keys: 'S', alternateKeys: 'K' });
    expect(migrated.seekToNextSubtitle).toEqual({ keys: 'right', alternateKeys: 'M' });
    expect(hasMicroMiningKeys(migrated)).toBe(true);
    expect(micro.bufferedMiningNormal).toEqual({ keys: 'H' });
    expect(restoreMicroKeyboardKeys(migrated, defaultSettings.keyBindSet)).toBe(migrated);
});

it('keeps custom, disabled, incomplete and already edited profiles unchanged', () => {
    const custom = { ...micro, explainSentence: { keys: '' }, togglePlay: { keys: 'P' } };
    const migrated = restoreMicroKeyboardKeys(custom, defaultSettings.keyBindSet);
    expect(migrated.explainSentence).toEqual({ keys: '' });
    expect(migrated.togglePlay).toEqual({ keys: 'P' });
    for (const keys of [
        defaultSettings.keyBindSet,
        { ...micro, bufferedMiningChoice4: { keys: 'Q' } },
        { ...micro, bufferedMiningNormal: { keys: 'H', alternateKeys: '' } },
    ]) {
        expect(restoreMicroKeyboardKeys(keys, defaultSettings.keyBindSet)).toBe(keys);
    }
});

it('adds the horizontal Micro keys without taking number keys or replacing the shoulder/keyboard binds', () => {
    const keys = restoreMicroKeyboardKeys(micro, defaultSettings.keyBindSet);
    expect(subtitleNavigationKeys(keys, false)).toEqual(['S', 'K', 'E']);
    expect(subtitleNavigationKeys(keys, true)).toEqual(['right', 'M', 'F']);
    expect(subtitleNavigationKeys(defaultSettings.keyBindSet, false)).toEqual(['S']);
    expect(subtitleNavigationKeys(defaultSettings.keyBindSet, true)).toEqual(['right']);
    expect(subtitleNavigationKeys({ ...keys, bufferedMiningChoice4: { keys: 'Q' } }, false)).toEqual(['S', 'K']);
});
