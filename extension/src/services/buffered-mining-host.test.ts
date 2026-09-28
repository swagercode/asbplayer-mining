import { bindBufferedMiningHost } from './buffered-mining-host';
import * as screenshots from './buffered-mining-screenshot';

describe('buffered mining host routing', () => {
    const originalBrowser = (globalThis as any).browser;
    const sender = { id: 'asbplayer', tab: { id: 1 }, url: 'https://www.crunchyroll.com/watch/episode' };
    let receive: (request: any, sender: any, respond: jest.Mock) => unknown;
    let nativeMessage: (message: any) => void;
    let postMessage: jest.Mock;
    let respond: jest.Mock;
    beforeEach(() => {
        postMessage = jest.fn((request) => nativeMessage({ requestId: request.requestId, pending: true }));
        respond = jest.fn();
        (globalThis as any).browser = {
            runtime: {
                id: 'asbplayer',
                getURL: (path: string) => `chrome-extension://asbplayer${path}`,
                onMessage: {
                    addListener: (listener: typeof receive) => {
                        receive = listener;
                    },
                },
                connectNative: () => ({
                    postMessage,
                    onMessage: {
                        addListener: (listener: typeof nativeMessage) => {
                            nativeMessage = listener;
                        },
                    },
                    onDisconnect: { addListener: jest.fn() },
                }),
            },
        };
        bindBufferedMiningHost({} as any);
    });
    afterEach(() => {
        jest.restoreAllMocks();
        (globalThis as any).browser = originalBrowser;
    });
    const request = (context?: unknown) => ({
        sender: 'asbplayer-buffered-mining',
        action: 'explain',
        id: 'a'.repeat(36),
        sentence: '対象の文',
        context,
    });
    it('forwards the selected sentence and only the allowed context fields to the native host', async () => {
        const context = { before: ['前の文'], after: ['次の文'], extra: 'not forwarded' };
        expect(receive(request(context), sender, respond)).toBe(true);
        await Promise.resolve();
        expect(postMessage).toHaveBeenCalledWith({
            requestId: 1,
            action: 'explain',
            id: 'a'.repeat(36),
            sentence: '対象の文',
            context: { before: ['前の文'], after: ['次の文'] },
        });
        expect(respond).toHaveBeenCalledWith({ pending: true });
    });
    it('supports older content scripts that do not send context', async () => {
        receive(request(), sender, respond);
        await Promise.resolve();
        expect(postMessage.mock.calls[0][0].context).toEqual({ before: [], after: [] });
    });
    it('returns an error for oversized context without contacting the native host', async () => {
        receive(request({ before: ['x', 'x', 'x', 'x'], after: [] }), sender, respond);
        await Promise.resolve();
        expect(postMessage).not.toHaveBeenCalled();
        expect(respond).toHaveBeenCalledWith({ error: 'Invalid surrounding subtitles.' });
    });
    it('captures only the sending episode tab and does not send pixels to the native host before acceptance', async () => {
        const capture = jest.spyOn(screenshots, 'captureMiningScreenshot').mockResolvedValue('jpeg');
        receive(
            {
                sender: 'asbplayer-buffered-mining',
                action: 'capture-screenshot',
                tabId: 999,
                src: 'video',
                params: { rect: {} },
            },
            sender,
            respond
        );
        await Promise.resolve();
        await Promise.resolve();
        expect(capture).toHaveBeenCalledWith(1, 'video', { rect: {} });
        expect(respond).toHaveBeenCalledWith({ screenshot: 'jpeg' });
        expect(postMessage).not.toHaveBeenCalled();
    });
    it('forwards a bounded image only with card acceptance', async () => {
        const command = {
            sender: 'asbplayer-buffered-mining',
            action: 'confirm-choice',
            id: 'a'.repeat(36),
            cardType: 'normal',
            screenshot: 'jpeg',
        };
        receive(command, sender, respond);
        await Promise.resolve();
        expect(postMessage.mock.calls[0][0].screenshot).toBe('jpeg');
        receive({ ...command, action: 'choose', index: 0 }, sender, respond);
        await Promise.resolve();
        expect(postMessage.mock.calls[1][0]).not.toHaveProperty('screenshot');
        receive({ ...command, screenshot: 'a'.repeat(2_000_001) }, sender, respond);
        await Promise.resolve();
        expect(postMessage.mock.calls[2][0]).not.toHaveProperty('screenshot');
    });
});
