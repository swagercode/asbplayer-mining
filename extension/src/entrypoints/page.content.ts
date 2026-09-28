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
        bindPriorityNavigationKeys(
            ['1', '2', '3', '4', '5', '6', '7', '8', '9'],
            () => document.querySelector('[data-asbplayer-mining-review]:not([data-asbplayer-mining-word])') !== null
        );
        bindPriorityNavigationKeys(['b'], () => document.querySelector('[data-asbplayer-mining-review]') !== null);
        if (/^(www\.)?crunchyroll\.com$/.test(location.hostname)) {
            // Synchronous: installing this after settings/page detection lets the site's
            // earlier window capture listeners swallow W/S, especially in fullscreen.
            bindPriorityNavigationKeys(['w', 's', 'n', 'v'], () => /\/watch\//.test(location.pathname));
        }
        void currentPageDelegate().then((pageDelegate) => pageDelegate.loadScripts());
    },
});
