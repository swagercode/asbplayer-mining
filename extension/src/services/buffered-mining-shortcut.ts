import { bindSingleKeyShortcut } from '@project/common/key-binder/single-key-shortcut';

/** Plain mining keys only claim presses outside text entry; modified shortcuts remain untouched. */
export function bindBufferedMiningShortcut(
    mine: () => void,
    enabled: () => boolean = () => true,
    key: 'n' | 'v' | 'b' = 'n'
) {
    return bindSingleKeyShortcut(key, (event) => {
        if (!enabled()) return false;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!event.repeat) mine();
        return true;
    });
}
