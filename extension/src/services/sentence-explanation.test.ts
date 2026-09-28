import { defaultSettings } from '@project/common/settings';
import { BufferedMiningController } from './buffered-mining';

const cue = { text: '品がないのう', start: 1000, end: 2000, originalStart: 1000, originalEnd: 2000, track: 0 };

describe('sentence explanation shortcut', () => {
    let controller: BufferedMiningController;
    let send: jest.Mock;
    let video: HTMLVideoElement;
    let playback: { pause: jest.Mock; play: jest.Mock; seek: jest.Mock };
    let originalBrowser: unknown;
    let root: HTMLElement;
    const flush = async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
    };
    const press = (key: string, init: KeyboardEventInit = {}) => {
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
        video.dispatchEvent(event);
        video.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, ...init }));
        return event;
    };
    beforeEach(() => {
        jest.useFakeTimers();
        originalBrowser = (globalThis as any).browser;
        send = jest.fn().mockResolvedValue({ text: 'No class.\nのう is a sentence ending.' });
        (globalThis as any).browser = { runtime: { sendMessage: send } };
        root = document.createElement('div');
        video = document.createElement('video');
        root.append(video);
        document.body.append(root);
        Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => root });
        Object.defineProperty(video, 'paused', { configurable: true, get: () => false });
        playback = { pause: jest.fn(), play: jest.fn().mockResolvedValue(undefined), seek: jest.fn() };
        controller = new BufferedMiningController(
            video,
            () => [cue],
            () => 2500,
            () => 'episode',
            playback
        );
        controller.bind();
        send.mockClear();
    });
    afterEach(() => {
        controller.unbind();
        root.remove();
        delete (document as any).fullscreenElement;
        (globalThis as any).browser = originalBrowser;
        jest.useRealTimers();
    });
    it('uses the last subtitle in a gap, pauses, shows inside fullscreen, and closes without mining or seeking', async () => {
        expect(press('f').defaultPrevented).toBe(true);
        await flush();
        expect(playback.pause).toHaveBeenCalledTimes(1);
        expect(send).toHaveBeenCalledWith(expect.objectContaining({ action: 'explain', sentence: cue.text }));
        expect(root.querySelector('[role="dialog"]')?.textContent).toContain('のう is a sentence ending.');
        press('f', { repeat: true });
        expect(root.querySelector('[role="dialog"]')).not.toBeNull();
        press('f');
        await flush();
        expect(root.querySelector('[role="dialog"]')).toBeNull();
        expect(playback.play).toHaveBeenCalledTimes(1);
        expect(playback.seek).not.toHaveBeenCalled();
        expect(send).toHaveBeenCalledTimes(1);
    });
    it('uses remapped keys and hints, treats output as text, and keeps an already paused video paused', async () => {
        Object.defineProperty(video, 'paused', { get: () => true });
        controller.setKeyBindSet({
            ...defaultSettings.keyBindSet,
            explainSentence: { keys: 'shift+E' },
            bufferedMiningCancel: { keys: 'Q' },
        });
        expect(press('f').defaultPrevented).toBe(false);
        send.mockResolvedValue({ text: '<img src=x onerror=alert(1)>' });
        expect(press('E', { shiftKey: true }).defaultPrevented).toBe(true);
        await flush();
        expect(root.querySelector('button')?.textContent).toContain('SHIFT+E');
        expect(root.querySelector('img')).toBeNull();
        expect(root.textContent).toContain('<img src=x onerror=alert(1)>');
        press('q');
        await flush();
        expect(root.querySelector('[role="dialog"]')).toBeNull();
        expect(playback.play).not.toHaveBeenCalled();
    });
    it('ignores a response after closing and does not poll it or create a card', async () => {
        let finish!: (value: any) => void;
        send.mockImplementation(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                })
        );
        press('f');
        press('b');
        finish({ pending: true });
        await flush();
        jest.advanceTimersByTime(500);
        await flush();
        expect(send).toHaveBeenCalledTimes(1);
        expect(root.querySelector('[role="dialog"]')).toBeNull();
        expect(playback.seek).not.toHaveBeenCalled();
    });
    it('polls one request and discards a pending panel when the player seeks', async () => {
        send.mockResolvedValueOnce({ pending: true }).mockResolvedValueOnce({ text: 'Explanation' });
        press('f');
        await flush();
        jest.advanceTimersByTime(300);
        await flush();
        expect(send.mock.calls.map(([m]) => m.action)).toEqual(['explain', 'explanation-status']);
        expect(root.textContent).toContain('Explanation');
        video.dispatchEvent(new Event('seeking'));
        expect(root.querySelector('[role="dialog"]')).toBeNull();
        expect(playback.play).not.toHaveBeenCalled();
    });
});
