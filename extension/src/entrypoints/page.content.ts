import { defaultSettings, keyBindKeys, miningChoiceKeyBindNames } from '@project/common/settings';
import { observeKeyBindSet } from '@/services/key-bind-settings';
import { currentPageDelegate } from '@/services/pages';
import { bindPriorityNavigationKeys } from '@project/common/key-binder/single-key-shortcut';

const excludeGlobs = ['*://app.asbplayer.dev/*'];

if (import.meta.env.DEV) {
    excludeGlobs.push('*://localhost:3000/*');
}

export default defineContentScript({
    // Set manifest options
    matches: ['<all_urls>'],
    excludeGlobs,
    allFrames: true,
    runAt: 'document_start',

    main() {
        let keys = defaultSettings.keyBindSet;
        const cleanup = [
            bindPriorityNavigationKeys(
                () => miningChoiceKeyBindNames.flatMap((name) => keyBindKeys(keys[name])),
                () =>
                    document.querySelector('[data-asbplayer-mining-review]:not([data-asbplayer-mining-word])') !==
                        null && document.querySelector('[data-asbplayer-sentence-explanation]') === null
            ),
            bindPriorityNavigationKeys(
                () => keyBindKeys(keys.bufferedMiningCancel),
                () =>
                    document.querySelector('[data-asbplayer-mining-review], [data-asbplayer-sentence-explanation]') !==
                    null
            ),
        ];
        if (/^(www\.)?crunchyroll\.com$/.test(location.hostname)) {
            // Install before the site's window capture listeners, then update keys in place.
            cleanup.push(
                bindPriorityNavigationKeys(
                    () =>
                        [
                            keys.togglePlay,
                            keys.seekToPreviousSubtitle,
                            keys.seekToNextSubtitle,
                            keys.seekToBeginningOfCurrentSubtitle,
                            keys.bufferedMiningNormal,
                            keys.bufferedMiningAudio,
                            keys.explainSentence,
                        ].flatMap(keyBindKeys),
                    () => /\/watch\//.test(location.pathname)
                )
            );
        }
        cleanup.push(
            observeKeyBindSet((updated) => {
                keys = updated;
            })
        );
        window.addEventListener('pagehide', () => cleanup.forEach((unbind) => unbind()), { once: true });
        void currentPageDelegate().then((pageDelegate) => pageDelegate.loadScripts());
    },
});
