import {
    defaultSettings,
    keyBindKeys,
    miningChoiceKeyBindNames,
    playbackToggleKeys,
    subtitleNavigationKeys,
} from '@project/common/settings';
import { bindPriorityNavigationKeys } from '@project/common/key-binder/single-key-shortcut';
import { BufferedMiningController } from '@project/extension/src/services/buffered-mining';
import KeyBindings from '@project/extension/src/services/key-bindings';
import type Binding from '@project/extension/src/services/binding';

const keys = {
    ...defaultSettings.keyBindSet,
    bufferedMiningNormal: { keys: 'N', alternateKeys: 'H' },
    bufferedMiningAudio: { keys: 'V', alternateKeys: 'G' },
    bufferedMiningCancel: { keys: 'B', alternateKeys: 'J' },
    explainSentence: { keys: 'F', alternateKeys: 'C' },
    toggleFullscreen: { keys: 'R' },
    togglePlay: { keys: 'space', alternateKeys: 'L' },
    bufferedMiningChoice1: { keys: '1', alternateKeys: 'C' },
    bufferedMiningChoice2: { keys: '2', alternateKeys: 'F' },
    bufferedMiningChoice3: { keys: '3', alternateKeys: 'D' },
    bufferedMiningChoice4: { keys: '4', alternateKeys: 'E' },
    seekToPreviousSubtitle: { keys: 'S', alternateKeys: 'K' },
    seekToNextSubtitle: { keys: 'right', alternateKeys: 'M' },
};
const options = ['労力', '成果', '栄誉', '賢人'].map((word, index) => ({
    word,
    index,
    reading: 'ことば',
    confidence: 0.8,
    definition: 'Test definition',
}));

describe('keyboard and Micro together', () => {
    const originalBrowser = (globalThis as any).browser;
    let controller: BufferedMiningController;
    let video: HTMLVideoElement;
    let cleanup: (() => void)[];
    let send: jest.Mock;
    let site: jest.Mock;
    let explain: jest.SpyInstance;
    let navigation: KeyBindings;
    let seek: jest.Mock;
    let pause: jest.Mock;
    let play: jest.Mock;
    let paused: boolean;
    let fullscreen: Element | null;
    let exitFullscreen: jest.Mock;
    const press = async (key: string) => {
        for (const type of ['keydown', 'keypress', 'keyup']) {
            const event = new KeyboardEvent(type, { key, bubbles: true, cancelable: true });
            document.activeElement!.dispatchEvent(event);
            expect(event.defaultPrevented).toBe(true);
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
    };

    beforeEach(() => {
        send = jest.fn(async ({ action }) => (action === 'job-status' ? { options } : { queued: true }));
        (globalThis as any).browser = { runtime: { sendMessage: send } };
        cleanup = [
            bindPriorityNavigationKeys(
                miningChoiceKeyBindNames.flatMap((name) => keyBindKeys(keys[name])),
                () =>
                    document.querySelector('[data-asbplayer-mining-review]:not([data-asbplayer-mining-word])') !== null
            ),
            bindPriorityNavigationKeys(
                [
                    ...subtitleNavigationKeys(keys, false),
                    ...subtitleNavigationKeys(keys, true),
                    ...playbackToggleKeys(keys),
                    ...[
                        keys.toggleFullscreen,
                        keys.bufferedMiningNormal,
                        keys.bufferedMiningAudio,
                        keys.bufferedMiningCancel,
                        keys.explainSentence,
                    ].flatMap(keyBindKeys),
                ],
                () => true
            ),
        ];
        site = jest.fn((event: Event) => event.stopImmediatePropagation());
        for (const type of ['keydown', 'keypress', 'keyup']) window.addEventListener(type, site, true);
        video = document.createElement('video');
        document.body.append(video);
        paused = false;
        Object.defineProperty(video, 'paused', { get: () => paused });
        fullscreen = document.body;
        Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreen });
        exitFullscreen = jest.fn(async () => {
            fullscreen = null;
        });
        Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exitFullscreen });
        controller = new BufferedMiningController(
            video,
            () => [
                {
                    text: '労力に見合った成果',
                    start: 1000,
                    end: 3000,
                    originalStart: 1000,
                    originalEnd: 3000,
                    track: 0,
                },
            ],
            () => 3500,
            () => 'episode',
            {
                pause: jest.fn(),
                seek: jest.fn().mockResolvedValue(undefined),
                play: jest.fn().mockResolvedValue(undefined),
            }
        );
        controller.setKeyBindSet(keys);
        explain = jest.spyOn(controller, 'explain').mockResolvedValue(undefined);
        controller.bind();
        seek = jest.fn().mockResolvedValue(undefined);
        pause = jest.fn(() => {
            paused = true;
        });
        play = jest.fn(async () => {
            paused = false;
        });
        navigation = new KeyBindings();
        navigation.setKeyBindSet(
            {
                video,
                synced: true,
                navigationTimeMs: 3500,
                seekableTracks: 1,
                seek,
                pause,
                play,
                subtitleController: {
                    subtitles: [1000, 3000, 5000].map((start) => ({ start, end: start + 1000, track: 0 })),
                },
            } as unknown as Binding,
            keys
        );
    });

    afterEach(() => {
        controller.unbind();
        navigation.unbind();
        cleanup.forEach((unbind) => unbind());
        for (const type of ['keydown', 'keypress', 'keyup']) window.removeEventListener(type, site, true);
        explain.mockRestore();
        video.remove();
        delete (document as any).fullscreenElement;
        delete (document as any).exitFullscreen;
        (globalThis as any).browser = originalBrowser;
    });

    it.each([
        ['n', '1', 'v', 'audio', 0],
        ['h', 'c', 'n', 'normal', 0],
        ['v', '2', 'h', 'normal', 1],
        ['g', 'f', 'g', 'audio', 1],
        ['n', 'd', 'v', 'audio', 2],
        ['h', 'e', 'h', 'normal', 3],
    ])('starts with %s, selects with %s and accepts with %s', async (start, choose, accept, type, index) => {
        await press(start);
        expect(document.querySelector('[data-asbplayer-mining-choices]')?.textContent).toBe('↑労力→成果↓栄誉←賢人');
        await press(choose);
        expect(explain).not.toHaveBeenCalled();
        expect(send).toHaveBeenCalledWith(expect.objectContaining({ action: 'choose', index }));
        await press(accept);
        expect(send.mock.calls.filter(([message]) => message.action === 'enqueue')).toHaveLength(1);
        expect(send.mock.calls.filter(([message]) => message.action === 'confirm-choice')).toHaveLength(1);
        expect(send).toHaveBeenCalledWith(expect.objectContaining({ action: 'confirm-choice', cardType: type }));
        expect(site).not.toHaveBeenCalled();
        expect(seek).not.toHaveBeenCalled();
    });

    it.each(['b', 'j'])('cancels with %s without creating a card', async (cancel) => {
        await press('n');
        await press(cancel);
        expect(send).toHaveBeenCalledWith(expect.objectContaining({ action: 'cancel-choice' }));
        expect(send.mock.calls.some(([message]) => message.action === 'confirm-choice')).toBe(false);
        expect(document.querySelector('[data-asbplayer-mining-review]')).toBeNull();
        expect(site).not.toHaveBeenCalled();
    });

    it('uses the horizontal D-pad for navigation, then choices, then navigation again', async () => {
        await press('e');
        await press('f');
        expect(seek.mock.calls.map(([time]) => time)).toEqual([1000, 5000]);
        expect(explain).not.toHaveBeenCalled();
        await press('c');
        expect(explain).toHaveBeenCalledTimes(1);
        seek.mockClear();
        await press('n');
        await press('r');
        expect(exitFullscreen).toHaveBeenCalledTimes(1);
        expect(explain).toHaveBeenCalledTimes(1);
        await press('f');
        expect(explain).toHaveBeenCalledTimes(1);
        expect(seek).not.toHaveBeenCalled();
        expect(send).toHaveBeenCalledWith(expect.objectContaining({ action: 'choose', index: 1 }));
        await press('f');
        expect(seek).toHaveBeenCalledWith(5000);
        expect(explain).toHaveBeenCalledTimes(1);
        expect(site).not.toHaveBeenCalled();
    });

    it.each(['d', 'l', ' '])('pauses and resumes with %s without a seek', async (key) => {
        await press(key);
        expect(pause).toHaveBeenCalledTimes(1);
        expect(paused).toBe(true);
        await press(key);
        expect(play).toHaveBeenCalledTimes(1);
        expect(paused).toBe(false);
        expect(seek).not.toHaveBeenCalled();
        expect(site).not.toHaveBeenCalled();
    });

    it.each([
        ['c', 0],
        ['d', 2],
    ])('keeps %s as a choice while the picker is open', async (key, index) => {
        await press('n');
        await press(key);
        expect(send).toHaveBeenCalledWith(expect.objectContaining({ action: 'choose', index }));
        expect(pause).not.toHaveBeenCalled();
        expect(play).not.toHaveBeenCalled();
        expect(explain).not.toHaveBeenCalled();
        expect(site).not.toHaveBeenCalled();
    });

    it('does not toggle pause repeatedly when D-pad down is held', async () => {
        await press('d');
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', repeat: true, bubbles: true }));
        expect(pause).toHaveBeenCalledTimes(1);
        expect(play).not.toHaveBeenCalled();
    });

    it('toggles fullscreen with R2 without explaining or changing playback', async () => {
        fullscreen = null;
        const player = document.createElement('div');
        player.id = 'player-container';
        document.body.append(player);
        player.append(video);
        const enter = jest.fn(async () => {
            fullscreen = player;
        });
        player.requestFullscreen = enter;
        try {
            await press('r');
            expect(enter).toHaveBeenCalledTimes(1);
            expect(fullscreen).toBe(player);
            document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', repeat: true, bubbles: true }));
            expect(exitFullscreen).not.toHaveBeenCalled();
            await press('r');
            expect(exitFullscreen).toHaveBeenCalledTimes(1);
            expect(fullscreen).toBeNull();
            expect(explain).not.toHaveBeenCalled();
            expect(pause).not.toHaveBeenCalled();
            expect(play).not.toHaveBeenCalled();
            expect(site).not.toHaveBeenCalled();
        } finally {
            document.body.append(video);
            player.remove();
        }
    });

    it.each(['s', 'k', 'm', 'ArrowRight'])('keeps the existing %s navigation key', async (key) => {
        await press(key);
        expect(seek).toHaveBeenCalledTimes(1);
        expect(site).not.toHaveBeenCalled();
    });
});
