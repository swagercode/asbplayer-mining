import { bindChatGptSubtitleHost } from '@project/extension/src/services/chatgpt-subtitle-host';

describe.each(['moz-extension', 'chrome-extension'])('ChatGPT subtitle bridge routing (%s)', (scheme) => {
    const extensionId = 'asbplayer-test';
    const episodeUrl = 'https://www.crunchyroll.com/watch/GVWU04MN4/guardian-fitz';
    const request = { sender: 'asbplayer-subtitle-selector', action: 'complete', prompt: 'Choose a subtitle' };
    const response = { text: '{"index":1}', model: 'gpt-5.6-luna' };
    const testGlobal = globalThis as typeof globalThis & { browser: typeof browser };
    const originalBrowser = testGlobal.browser;
    let listener: (request: unknown, sender: unknown, sendResponse: jest.Mock) => unknown;
    let sendNativeMessage: jest.Mock;
    let sendResponse: jest.Mock;

    beforeEach(() => {
        sendNativeMessage = jest.fn().mockResolvedValue(response);
        sendResponse = jest.fn();
        testGlobal.browser = {
            runtime: {
                id: extensionId,
                getURL: (path: string) => `${scheme}://asbplayer${path}`,
                onMessage: { addListener: (callback: typeof listener) => (listener = callback) },
                sendNativeMessage,
            },
        } as unknown as typeof browser;
        bindChatGptSubtitleHost();
    });

    afterEach(() => {
        testGlobal.browser = originalBrowser;
    });

    const sender = (url: string, tabUrl = episodeUrl) => ({
        id: extensionId,
        frameId: 0,
        url,
        tab: { id: 1, url: tabUrl },
    });

    it.each([episodeUrl, 'https://www.crunchyroll.com/series/G24H1N3MP/mushoku-tensei-jobless-reincarnation'])(
        'routes episode requests when the document originally loaded %s',
        async (documentUrl) => {
            expect(listener(request, sender(documentUrl), sendResponse)).toBe(true);
            await Promise.resolve();
            expect(sendNativeMessage).toHaveBeenCalledWith('com.asbplayer.chatgpt', {
                action: 'complete',
                prompt: request.prompt,
            });
            expect(sendResponse).toHaveBeenCalledWith(response);
        }
    );

    it('keeps the response channel open until the native host finishes', async () => {
        let finish!: (value: unknown) => void;
        sendNativeMessage.mockReturnValue(new Promise((resolve) => (finish = resolve)));
        expect(listener(request, sender(episodeUrl), sendResponse)).toBe(true);
        expect(sendResponse).not.toHaveBeenCalled();
        finish(response);
        await Promise.resolve();
        expect(sendResponse).toHaveBeenCalledWith(response);
    });

    it('allows the extension settings to check native host status', async () => {
        listener(
            { sender: request.sender, action: 'status' },
            { id: extensionId, url: `${scheme}://asbplayer/options.html` },
            sendResponse
        );
        await Promise.resolve();
        expect(sendNativeMessage).toHaveBeenCalledWith('com.asbplayer.chatgpt', {
            action: 'status',
            prompt: undefined,
        });
    });

    it.each([
        ['another origin', sender('https://example.com/', episodeUrl)],
        ['a deceptive hostname', sender('https://www.crunchyroll.com.evil.test/', episodeUrl)],
        ['a tab that left the episode', sender(episodeUrl, 'https://www.crunchyroll.com/series/example')],
        ['an embedded frame', { ...sender(episodeUrl), frameId: 1 }],
    ])('rejects %s with an explicit error instead of an empty response', (_name, source) => {
        listener(request, source, sendResponse);
        expect(sendNativeMessage).not.toHaveBeenCalled();
        expect(sendResponse).toHaveBeenCalledWith({
            error: 'ChatGPT subtitle selection requires an open Crunchyroll episode tab.',
        });
    });

    it('ignores other extensions and unrelated messages', () => {
        listener(request, { ...sender(episodeUrl), id: 'another-extension' }, sendResponse);
        listener({ sender: 'something-else' }, sender(episodeUrl), sendResponse);
        expect(sendNativeMessage).not.toHaveBeenCalled();
        expect(sendResponse).not.toHaveBeenCalled();
    });

    it('returns a native connection error when the host cannot start', async () => {
        sendNativeMessage.mockRejectedValue(new Error('Native host missing'));
        listener(request, sender(episodeUrl), sendResponse);
        await Promise.resolve();
        expect(sendResponse).toHaveBeenCalledWith({ error: expect.stringContaining('Could not connect') });
    });
});
