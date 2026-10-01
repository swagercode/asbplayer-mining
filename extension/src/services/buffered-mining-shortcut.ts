import { bindSingleKeyShortcut } from '@project/common/key-binder/single-key-shortcut';
import type { PlaybackShortcut } from '@project/common/key-binder/single-key-shortcut';

/** Mining shortcuts only claim configured presses outside text entry. */
export function bindBufferedMiningShortcut(
    mine: () => void,
    enabled: (event: KeyboardEvent) => boolean = () => true,
    key: PlaybackShortcut = 'n'
) {
    return bindSingleKeyShortcut(key, (event) => {
        if (!enabled(event)) return false;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!event.repeat) mine();
        return true;
    });
}
