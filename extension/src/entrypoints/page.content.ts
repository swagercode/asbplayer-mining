import { defaultSettings, miningChoiceKeyBindNames } from '@project/common/settings';
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
                () => miningChoiceKeyBindNames.map((name) => keys[name].keys),
                () =>
                    document.querySelector('[data-asbplayer-mining-review]:not([data-asbplayer-mining-word])') !==
                        null && document.querySelector('[data-asbplayer-sentence-explanation]') === null
            ),
            bindPriorityNavigationKeys(
                () => [keys.bufferedMiningCancel.keys],
                () =>
                    document.querySelector('[data-asbplayer-mining-review], [data-asbplayer-sentence-explanation]') !==
                    null
            ),
        ];
        if (/^(www\.)?crunchyroll\.com$/.test(location.hostname)) {
            // Install before the site's window capture listeners, then update keys in place.
            cleanup.push(
                bindPriorityNavigationKeys(
                    () => [
                        keys.seekToPreviousSubtitle.keys,
                        keys.seekToNextSubtitle.keys,
                        keys.seekToBeginningOfCurrentSubtitle.keys,
                        keys.bufferedMiningNormal.keys,
                        keys.bufferedMiningAudio.keys,
                        keys.explainSentence.keys,
                    ],
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
