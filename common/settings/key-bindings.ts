import type { KeyBind, KeyBindName, KeyBindSet } from '@project/common/settings/settings';

export const keyBindKeys = (binding: KeyBind): string[] =>
    [binding.keys, binding.alternateKeys].filter((key): key is string => Boolean(key));

const microMiningKeys = {
    bufferedMiningNormal: 'H',
    bufferedMiningAudio: 'G',
    bufferedMiningCancel: 'J',
    bufferedMiningChoice1: 'C',
    bufferedMiningChoice2: 'F',
    bufferedMiningChoice3: 'D',
    bufferedMiningChoice4: 'E',
} as const;

export const hasMicroMiningKeys = (keys: KeyBindSet) =>
    Object.entries(microMiningKeys).every(
        ([name, key]) =>
            keys[name as KeyBindName] &&
            keyBindKeys(keys[name as KeyBindName]).some((value) => value.toUpperCase() === key)
    );

/** The Micro's horizontal D-pad doubles as subtitle navigation outside the chooser. */
export function microSubtitleNavigationKeys(keys: KeyBindSet, forward: boolean): string[] {
    if (!hasMicroMiningKeys(keys)) return [];
    return keyBindKeys(keys[forward ? 'bufferedMiningChoice2' : 'bufferedMiningChoice4']).filter(
        (key) => key.toUpperCase() === (forward ? 'F' : 'E')
    );
}

export const subtitleNavigationKeys = (keys: KeyBindSet, forward: boolean) => [
    ...keyBindKeys(keys[forward ? 'seekToNextSubtitle' : 'seekToPreviousSubtitle']),
    ...microSubtitleNavigationKeys(keys, forward),
];

/** The original Micro setup replaced the keyboard keys. Preserve both on upgrade. */
export function restoreMicroKeyboardKeys(keys: KeyBindSet, defaults: KeyBindSet): KeyBindSet {
    if (!hasMicroMiningKeys(keys)) return keys;
    // An alternate field, including an intentionally empty one, means this
    // profile has already been migrated or edited. Never undo that edit.
    if (Object.values(keys).some((binding) => binding.alternateKeys !== undefined)) return keys;
    const result = { ...keys };
    const controllerKeys = {
        ...microMiningKeys,
        explainSentence: 'R',
        togglePlay: 'L',
        seekToPreviousSubtitle: 'K',
        seekToNextSubtitle: 'M',
        seekToBeginningOfCurrentSubtitle: 'I',
    };
    for (const [name, controllerKey] of Object.entries(controllerKeys)) {
        const action = name as KeyBindName;
        if (keys[action].keys.toUpperCase() === controllerKey) {
            result[action] = { keys: defaults[action].keys, alternateKeys: keys[action].keys };
        }
    }
    return result;
}
