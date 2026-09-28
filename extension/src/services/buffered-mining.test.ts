import { BufferedMiningController, currentOrPreviousSubtitle } from '@project/extension/src/services/buffered-mining';
import type { SubtitleModel } from '@project/common';
import { YomitanMiningReview } from '@project/extension/src/services/buffered-mining-review';

const cue = (text: string, start: number, end: number): SubtitleModel => ({
    text,
    start,
    end,
    originalStart: start,
    originalEnd: end,
    track: 0,
});

describe('buffered mining button', () => {
    it('shows the word and resumes playback without waiting for Chrome, then attaches the frozen image on acceptance', async () => {
        const originalBrowser = (globalThis as any).browser;
        const sendMessage = jest.fn(async ({ action }) =>
            action === 'job-status' ? { word: '労力', reading: 'ろうりょく' } : { queued: true }
        );
        (globalThis as any).browser = { runtime: { sendMessage } };
        const showWord = jest.spyOn(YomitanMiningReview.prototype, 'showWord').mockImplementation(() => {});
        let finish: (image: string) => void = () => {};
        const capture = jest.fn(
            () =>
                new Promise<string>((resolve) => {
                    finish = resolve;
                })
        );
        const video = document.createElement('video');
        const playback = {
            pause: jest.fn(),
            seek: jest.fn().mockResolvedValue(undefined),
            play: jest.fn().mockResolvedValue(undefined),
        };
        const controller = new BufferedMiningController(
            video,
            () => [cue('労力', 1000, 3000)],
            () => 3500,
            () => 'episode',
            playback,
            capture
        );
        try {
            await controller.mine();
            await Promise.resolve();
            expect(showWord).toHaveBeenCalledWith('労力', 'ろうりょく');
            expect(capture).toHaveBeenCalledTimes(1);
            await controller.mine();
            expect(playback.play).toHaveBeenCalledTimes(1);
            expect(sendMessage.mock.calls.some(([m]) => m.action === 'confirm-choice')).toBe(false);
            finish('frozen-chrome-image');
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(sendMessage).toHaveBeenCalledWith(
                expect.objectContaining({ action: 'confirm-choice', screenshot: 'frozen-chrome-image' })
            );
        } finally {
            controller.unbind();
            showWord.mockRestore();
            (globalThis as any).browser = originalBrowser;
        }
    });

    it.each([
        ['v', 'v', 'audio'],
        ['v', 'n', 'normal'],
        ['n', 'v', 'audio'],
        ['n', 'n', 'normal'],
    ])('%s starts review and %s accepts a %s card', async (startKey, acceptKey, cardType) => {
        const originalBrowser = (globalThis as any).browser;
        const sendMessage = jest
            .fn()
            .mockImplementation(async ({ action }) =>
                action === 'job-status' ? { word: '労力', reading: 'ろうりょく' } : { queued: true }
            );
        (globalThis as any).browser = { runtime: { sendMessage } };
        const showWord = jest.spyOn(YomitanMiningReview.prototype, 'showWord').mockImplementation(() => {});
        const video = document.createElement('video');
        document.body.append(video);
        const playback = {
            pause: jest.fn(),
            seek: jest.fn().mockResolvedValue(undefined),
            play: jest.fn().mockResolvedValue(undefined),
        };
        const controller = new BufferedMiningController(
            video,
            () => [cue('労力に見合った成果', 1000, 3000)],
            () => 3500,
            () => 'episode',
            playback
        );
        const press = async (key: string) => {
            for (const type of ['keydown', 'keyup']) {
                video.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true }));
            }
            await new Promise((resolve) => setTimeout(resolve, 0));
        };
        try {
            controller.bind();
            await press(startKey);
            expect(showWord).toHaveBeenCalledWith('労力', 'ろうりょく');
            expect(playback.pause).toHaveBeenCalledTimes(1);
            expect(sendMessage.mock.calls.filter(([m]) => m.action === 'confirm-choice')).toHaveLength(0);
            await press(acceptKey);
            expect(sendMessage.mock.calls.filter(([m]) => m.action === 'enqueue')).toHaveLength(1);
            expect(sendMessage.mock.calls.filter(([m]) => m.action === 'confirm-choice')).toHaveLength(1);
            expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ action: 'confirm-choice', cardType }));
            expect(playback.seek).toHaveBeenCalledWith(1000);
            expect(playback.play).toHaveBeenCalledTimes(1);
        } finally {
            controller.unbind();
            video.remove();
            showWord.mockRestore();
            (globalThis as any).browser = originalBrowser;
        }
    });

    it.each(['normal', 'audio'] as const)(
        'accepts a %s card without starting another mining cycle',
        async (cardType) => {
            const originalBrowser = (globalThis as any).browser;
            const sendMessage = jest
                .fn()
                .mockImplementation(async ({ action }) =>
                    action === 'enqueue'
                        ? { queued: true }
                        : { state: 'creating card', word: '労力', reading: 'ろうりょく' }
                );
            (globalThis as any).browser = { runtime: { sendMessage } };
            const showWord = jest.spyOn(YomitanMiningReview.prototype, 'showWord').mockImplementation(() => {});
            const now = jest.spyOn(Date, 'now').mockReturnValue(10000);
            const playback = {
                pause: jest.fn(),
                seek: jest.fn().mockResolvedValue(undefined),
                play: jest.fn().mockResolvedValue(undefined),
            };
            const video = document.createElement('video');
            const controller = new BufferedMiningController(
                video,
                () => [cue('労力に見合った成果', 1000, 3000)],
                () => 3500,
                () => 'episode',
                playback
            );
            try {
                await controller.mine();
                await Promise.resolve();
                expect(showWord).toHaveBeenCalledWith('労力', 'ろうりょく');
                now.mockReturnValue(11000);
                await expect(controller.mine(cardType)).resolves.toEqual({ reviewClosed: true });
                expect(sendMessage).toHaveBeenCalledWith(
                    expect.objectContaining({ action: 'confirm-choice', cardType })
                );
                expect(sendMessage.mock.calls.filter(([m]) => m.action === 'enqueue')).toHaveLength(1);
                expect(playback.seek).toHaveBeenCalledWith(1000);
                expect(playback.play).toHaveBeenCalledTimes(1);
                expect(document.querySelector('[data-asbplayer-mining-review]')).toBeNull();
                now.mockReturnValue(12000);
                await controller.mine();
                expect(sendMessage.mock.calls.filter(([m]) => m.action === 'enqueue')).toHaveLength(2);
                expect(playback.pause).toHaveBeenCalledTimes(2);
            } finally {
                controller.unbind();
                showWord.mockRestore();
                now.mockRestore();
                (globalThis as any).browser = originalBrowser;
            }
        }
    );

    it('retains DOM pause/resume history before subtitles load and includes it with the queued cue', async () => {
        const originalBrowser = (globalThis as any).browser;
        const sendMessage = jest.fn().mockResolvedValue({ queued: true });
        (globalThis as any).browser = { runtime: { sendMessage } };
        const now = jest.spyOn(Date, 'now').mockReturnValue(100000);
        const video = document.createElement('video');
        let paused = false;
        let readyState = 4;
        let media = 0;
        let subtitles: SubtitleModel[] = [];
        Object.defineProperties(video, {
            paused: { get: () => paused },
            readyState: { get: () => readyState },
        });
        const controller = new BufferedMiningController(
            video,
            () => subtitles,
            () => media,
            () => 'episode'
        );
        try {
            controller.bind();
            now.mockReturnValue(101000);
            media = 1000;
            paused = true;
            video.dispatchEvent(new Event('pause'));
            now.mockReturnValue(110000);
            paused = false;
            readyState = 2;
            video.dispatchEvent(new Event('play'));
            now.mockReturnValue(110400);
            media = 1400;
            readyState = 4;
            video.dispatchEvent(new Event('playing'));
            subtitles = [cue('途中で止めた文', 0, 2500)];
            await controller.mine();
            const job = sendMessage.mock.calls.find(([message]) => message.action === 'enqueue')![0].job;
            expect(job.history.map((point: any) => point.event)).toEqual([
                'sample',
                'pause',
                'play',
                'playing',
                'sample',
            ]);
            expect(job.history.map((point: any) => point.playing)).toEqual([true, false, false, true, true]);
            expect(new Set(job.history.map((point: any) => point.session)).size).toBe(1);
            // A real seek starts a different timeline and must not mix old audio into it.
            now.mockReturnValue(111000);
            media = 2200;
            video.dispatchEvent(new Event('seeking'));
            await controller.mine();
            const second = sendMessage.mock.calls.filter(([message]) => message.action === 'enqueue')[1][0].job;
            expect(second.history).toHaveLength(2);
            expect(second.sample.session).not.toBe(job.sample.session);
            expect(job.history).toHaveLength(5);
        } finally {
            controller.unbind();
            now.mockRestore();
            (globalThis as any).browser = originalBrowser;
        }
    });

    it('queues more presses while an earlier request is pending, without seeking or playing', async () => {
        const originalBrowser = (globalThis as any).browser;
        const originalUuid = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');
        Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: () => 'test-session' });
        let finishFirst: (value: unknown) => void = () => {};
        const sendMessage = jest
            .fn()
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        finishFirst = resolve;
                    })
            )
            .mockResolvedValueOnce({ queued: true });
        (globalThis as any).browser = { runtime: { sendMessage } };
        const now = jest.spyOn(Date, 'now').mockReturnValue(10000);
        try {
            const video = document.createElement('video');
            video.currentTime = 8;
            const play = jest.spyOn(video, 'play');
            const pause = jest.spyOn(video, 'pause');
            let media = 2500;
            const controller = new BufferedMiningController(
                video,
                () => [cue('最初', 1000, 2000), cue('次', 3000, 4000)],
                () => media,
                () => 'episode'
            );
            const first = controller.mine();
            now.mockReturnValue(11000);
            media = 3500;
            await expect(controller.mine()).resolves.toEqual({ queued: true });
            expect(sendMessage).toHaveBeenCalledTimes(2);
            expect(sendMessage.mock.calls[0][0].job.subtitle.text).toBe('最初');
            expect(sendMessage.mock.calls[1][0].job.subtitle.text).toBe('次');
            expect(video.currentTime).toBe(8);
            expect(play).not.toHaveBeenCalled();
            expect(pause).not.toHaveBeenCalled();
            finishFirst({ queued: true });
            await first;
        } finally {
            now.mockRestore();
            (globalThis as any).browser = originalBrowser;
            if (originalUuid) Object.defineProperty(crypto, 'randomUUID', originalUuid);
            else delete (crypto as any).randomUUID;
        }
    });
});

it('keeps an early accepted review attached until capture finishes, so repeated keys cannot queue another card', async () => {
    const originalBrowser = (globalThis as any).browser;
    const sendMessage = jest
        .fn()
        .mockImplementation(async ({ action }) =>
            action === 'job-status'
                ? { options: [{ index: 0, word: '労力', reading: 'ろうりょく', confidence: 0.9 }] }
                : {}
        );
    (globalThis as any).browser = { runtime: { sendMessage } };
    const showWord = jest.spyOn(YomitanMiningReview.prototype, 'showWord').mockImplementation(() => {});
    const video = document.createElement('video');
    let media = 2000;
    const playback = {
        pause: jest.fn(),
        seek: jest.fn().mockResolvedValue(undefined),
        play: jest.fn().mockResolvedValue(undefined),
    };
    const controller = new BufferedMiningController(
        video,
        () => [cue('労力に見合った成果', 1000, 3000)],
        () => media,
        () => 'episode',
        playback
    );
    try {
        await controller.mine();
        await Promise.resolve();
        const accepted = controller.mine('audio');
        const repeated = controller.mine('normal');
        expect(sendMessage.mock.calls.filter(([m]) => m.action === 'enqueue')).toHaveLength(1);
        expect(playback.seek).not.toHaveBeenCalled();
        media = 3000;
        video.dispatchEvent(new Event('timeupdate'));
        await Promise.all([accepted, repeated]);
        expect(sendMessage.mock.calls.filter(([m]) => m.action === 'enqueue')).toHaveLength(1);
        expect(sendMessage).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'confirm-choice', cardType: 'audio' })
        );
        expect(playback.seek).toHaveBeenCalledTimes(1);
        expect(playback.play).toHaveBeenCalledTimes(1);
    } finally {
        controller.unbind();
        showWord.mockRestore();
        (globalThis as any).browser = originalBrowser;
    }
});

describe('buffered mining subtitle selection', () => {
    const subtitles = [cue('前の文', 1000, 2000), cue('現在の文', 3000, 4000), cue('次の文', 5000, 6000)];
    it('uses the current subtitle', () => {
        expect(currentOrPreviousSubtitle(subtitles, 3500)?.text).toBe('現在の文');
    });
    it('uses the last subtitle during a gap, without selecting the next one', () => {
        expect(currentOrPreviousSubtitle(subtitles, 4500)?.text).toBe('現在の文');
        expect(currentOrPreviousSubtitle(subtitles, 2000)?.text).toBe('前の文');
    });
    it('has no fallback before the first subtitle', () => {
        expect(currentOrPreviousSubtitle(subtitles, 500)).toBeUndefined();
    });
    it('selects by time even with unsorted cues and ignores empty text', () => {
        expect(
            currentOrPreviousSubtitle([subtitles[2], subtitles[0], subtitles[1], cue(' ', 4200, 4400)], 4500)?.text
        ).toBe('現在の文');
    });
    it('does not retain a future subtitle after seeking backward', () => {
        expect(currentOrPreviousSubtitle(subtitles, 6500)?.text).toBe('次の文');
        expect(currentOrPreviousSubtitle(subtitles, 2500)?.text).toBe('前の文');
    });
});
