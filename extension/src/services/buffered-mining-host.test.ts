import { bindBufferedMiningHost } from './buffered-mining-host';

describe('sentence explanation context routing', () => {
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
});
