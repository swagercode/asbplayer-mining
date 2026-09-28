import { bindSingleKeyShortcut } from '@project/common/key-binder/single-key-shortcut';

/** Mining shortcuts only claim configured presses outside text entry. */
export function bindBufferedMiningShortcut(
    mine: () => void,
    enabled: () => boolean = () => true,
    key: string | (() => string) = 'n'
) {
    return bindSingleKeyShortcut(key, (event) => {
        if (!enabled()) return false;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!event.repeat) mine();
        return true;
    });
}
