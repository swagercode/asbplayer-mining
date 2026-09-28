import { captureMiningScreenshot, cleanMiningScreenshot } from './buffered-mining-screenshot';

describe('buffered mining Chrome screenshots', () => {
    const originalBrowser = (globalThis as any).browser;
    const params = {
        maxWidth: 0,
        maxHeight: 0,
        rect: { left: 10, top: 20, width: 1920, height: 1080 },
        frameId: 'player',
    };
    let tabs: any;
    beforeEach(() => {
        tabs = {
            get: jest.fn().mockResolvedValue({ active: true, windowId: 3, url: 'https://episode' }),
            captureVisibleTab: jest.fn().mockResolvedValue('data:image/jpeg;base64,full-tab'),
            sendMessage: jest.fn().mockResolvedValue({ dataUrl: 'data:image/jpeg;base64,cropped' }),
        };
        (globalThis as any).browser = { tabs };
    });
    afterEach(() => {
        (globalThis as any).browser = originalBrowser;
        jest.useRealTimers();
        document.body.replaceChildren();
    });

    it('uses native Chrome capture and the existing iframe-aware crop without playback commands', async () => {
        await expect(captureMiningScreenshot(5, 'video-src', params)).resolves.toBe('cropped');
        expect(tabs.captureVisibleTab).toHaveBeenCalledWith(3, { format: 'jpeg', quality: 100 });
        expect(tabs.sendMessage).toHaveBeenCalledWith(5, {
            sender: 'asbplayer-extension-to-video',
            src: 'video-src',
            message: {
                command: 'crop-and-resize',
                dataUrl: 'data:image/jpeg;base64,full-tab',
                rect: params.rect,
                frameId: 'player',
                maxWidth: 1280,
                maxHeight: 720,
            },
        });
    });
    it('never captures another active tab when mining from the background viewer', async () => {
        tabs.get.mockResolvedValue({ active: false, windowId: 3 });
        await expect(captureMiningScreenshot(5, 'src', params)).rejects.toThrow('not visible');
        expect(tabs.captureVisibleTab).not.toHaveBeenCalled();
    });
    it('discards capture if the user switches tabs while Chrome is capturing', async () => {
        tabs.captureVisibleTab.mockImplementation(async () => {
            tabs.get.mockResolvedValue({ active: false, windowId: 3 });
            return 'data:image/jpeg;base64,other-tab';
        });
        await expect(captureMiningScreenshot(5, 'src', params)).rejects.toThrow('changed');
        expect(tabs.sendMessage).not.toHaveBeenCalled();
    });
    it('does not forward invalid crops or oversized images to the mining bridge', async () => {
        await expect(
            captureMiningScreenshot(5, 'src', { ...params, rect: { ...params.rect, width: 0 } })
        ).rejects.toThrow('bounds');
        expect(tabs.captureVisibleTab).not.toHaveBeenCalled();
        tabs.sendMessage.mockResolvedValue({ dataUrl: 'data:image/jpeg;base64,' + 'x'.repeat(2_000_001) });
        await expect(captureMiningScreenshot(5, 'src', params)).rejects.toThrow('too large');
    });
    it('removes temporary hiding after success and never captures video through canvas', async () => {
        jest.useFakeTimers();
        const count = document.querySelectorAll('style').length;
        const capture = jest.fn().mockResolvedValue('image');
        const pending = cleanMiningScreenshot(capture);
        expect(document.querySelectorAll('style')).toHaveLength(count + 1);
        await jest.advanceTimersByTimeAsync(20);
        await expect(pending).resolves.toBe('image');
        expect(document.querySelectorAll('style')).toHaveLength(count);
    });
    it('drops a slow image and restores controls without waiting for it', async () => {
        jest.useFakeTimers();
        const count = document.querySelectorAll('style').length;
        const pending = cleanMiningScreenshot(() => new Promise(() => {}));
        await jest.advanceTimersByTimeAsync(750);
        await expect(pending).resolves.toBeUndefined();
        expect(document.querySelectorAll('style')).toHaveLength(count);
    });
    it('does not save a screenshot if choices were already displayed', async () => {
        jest.useFakeTimers();
        const pending = cleanMiningScreenshot(async () => {
            const panel = document.createElement('div');
            panel.dataset.asbplayerMiningChoices = '';
            document.body.append(panel);
            return 'image-with-choices';
        });
        await jest.advanceTimersByTimeAsync(20);
        await expect(pending).resolves.toBeUndefined();
    });
});
