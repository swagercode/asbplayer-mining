const hostName = 'com.asbplayer.chatgpt';

// Only the extension's own UI and its Crunchyroll content script may reach the
// native host. The host exposes subtitle classification, not arbitrary commands.
export const bindChatGptSubtitleHost = () => {
    browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request?.sender !== 'asbplayer-subtitle-selector') return;
        if (sender.id !== browser.runtime.id) return;
        const ownUi = sender.url?.startsWith(browser.runtime.getURL('/')) === true;
        // Firefox retains the original document URL in sender.url after SPA
        // navigation. A series page can therefore be the sender of a request
        // from an episode. Validate its origin and the browser's current tab URL.
        const episodePage =
            sender.frameId === 0 &&
            /^https:\/\/(?:www\.)?crunchyroll\.com\//.test(sender.url ?? '') &&
            /^https:\/\/(?:www\.)?crunchyroll\.com\/watch\/[A-Za-z0-9]+(?:[/?#]|$)/.test(sender.tab?.url ?? '');
        if (!ownUi && !episodePage) {
            sendResponse({ error: 'ChatGPT subtitle selection requires an open Crunchyroll episode tab.' });
            return;
        }
        if (request.action !== 'complete' && request.action !== 'status') return;
        if (request.action === 'complete' && (typeof request.prompt !== 'string' || request.prompt.length > 200000)) {
            sendResponse({ error: 'Invalid subtitle selection request' });
            return;
        }
        void browser.runtime
            .sendNativeMessage(hostName, { action: request.action, prompt: request.prompt })
            .then(sendResponse, () =>
                sendResponse({
                    error: 'Could not connect to the local ChatGPT subtitle bridge. Run scripts/chatgpt-subtitle-host/install.py and sign in with codex login.',
                })
            );
        return true;
    });
};
