import { BufferedMiningReview } from '@project/extension/src/services/buffered-mining-review';
import type { MiningReviewStatus } from '@project/extension/src/services/buffered-mining-review';

describe('mining definition review', () => {
    const subtitle = { text: '難しい文', start: 1000, end: 3000, originalStart: 1000, originalEnd: 3000, track: 0 };
    let video: HTMLVideoElement;
    let media: number;
    let source: string;
    let playback: { pause: jest.Mock; seek: jest.Mock; play: jest.Mock };
    let view: { message: jest.Mock; showWord: jest.Mock; showChoices: jest.Mock; close: jest.Mock };
    let status: jest.Mock<Promise<MiningReviewStatus>>;
    let review: BufferedMiningReview;

    beforeEach(() => {
        jest.useFakeTimers();
        video = document.createElement('video');
        media = 2000;
        source = 'episode one';
        playback = {
            pause: jest.fn(),
            seek: jest.fn().mockResolvedValue(undefined),
            play: jest.fn().mockResolvedValue(undefined),
        };
        view = { message: jest.fn(), showWord: jest.fn(), showChoices: jest.fn(), close: jest.fn() };
        status = jest.fn().mockResolvedValue({ state: 'choosing word' });
        review = new BufferedMiningReview(
            'job',
            { ...subtitle },
            video,
            () => media,
            () => source,
            playback,
            status,
            view
        );
    });

    afterEach(() => {
        review.dispose();
        jest.useRealTimers();
    });

    it('lets the sentence finish, pauses for the chosen word, then resumes continuous playback from its start', async () => {
        await review.queued({});
        expect(playback.pause).not.toHaveBeenCalled();
        media = 3050;
        video.dispatchEvent(new Event('timeupdate'));
        expect(playback.pause).toHaveBeenCalledTimes(1);
        status.mockResolvedValue({ state: 'creating card', word: '労力', reading: 'ろうりょく' });
        await jest.advanceTimersByTimeAsync(300);
        expect(view.showWord).toHaveBeenCalledWith('労力', 'ろうりょく');
        await review.resume();
        expect(view.close).toHaveBeenCalledTimes(1);
        expect(playback.seek).toHaveBeenCalledWith(1000);
        expect(playback.play).toHaveBeenCalledTimes(1);
        // The sentence boundary is no longer special after the second N.
        media = 6000;
        video.dispatchEvent(new Event('timeupdate'));
        await jest.advanceTimersByTimeAsync(10000);
        expect(playback.pause).toHaveBeenCalledTimes(1);
        expect(status).toHaveBeenCalledTimes(2);
    });

    it('ignores a late word response after the review has closed', async () => {
        let resolve!: (result: MiningReviewStatus) => void;
        status.mockImplementation(() => new Promise((done) => (resolve = done)));
        const pending = review.queued({});
        await review.resume();
        resolve({ word: '遅延', reading: 'ちえん' });
        await pending;
        media = 6000;
        video.dispatchEvent(new Event('timeupdate'));
        expect(view.showWord).not.toHaveBeenCalled();
        expect(playback.pause).not.toHaveBeenCalled();
        expect(playback.play).toHaveBeenCalledTimes(1);
    });

    it('finishes seeking before playing so an ended video does not restart at zero', async () => {
        let seeking = true;
        Object.defineProperty(video, 'seeking', { get: () => seeking });
        const resumed = review.resume();
        await Promise.resolve();
        expect(playback.play).not.toHaveBeenCalled();
        seeking = false;
        video.dispatchEvent(new Event('seeked'));
        await resumed;
        expect(playback.play).toHaveBeenCalledTimes(1);
    });

    it('does not start polling when enqueue returns after closing', async () => {
        await review.resume();
        await review.queued({});
        expect(status).not.toHaveBeenCalled();
    });

    it('discards a review on an episode change without seeking the new episode', async () => {
        source = 'episode two';
        await review.resume();
        expect(view.close).toHaveBeenCalledTimes(1);
        expect(playback.seek).not.toHaveBeenCalled();
        expect(playback.play).not.toHaveBeenCalled();
    });

    it('can close a failed mining job and resume normally', async () => {
        status.mockResolvedValue({ state: 'failed', error: 'No eligible vocabulary' });
        await review.queued({});
        expect(view.message).toHaveBeenLastCalledWith('No eligible vocabulary');
        await review.resume();
        expect(playback.play).toHaveBeenCalledTimes(1);
        expect(view.showWord).not.toHaveBeenCalled();
    });

    it('prepares choices during speech, shows them at the cue boundary, and opens the word before the choose response', async () => {
        review.dispose();
        const option = { index: 12, word: '労力', reading: 'ろうりょく', confidence: 0.8 };
        const choose = jest.fn().mockReturnValue(new Promise(() => {}));
        const cancel = jest.fn().mockResolvedValue({});
        const options = [option, { index: 2, word: '成果', reading: 'せいか', confidence: 0.15 }];
        status.mockResolvedValue({ options });
        review = new BufferedMiningReview(
            'job',
            subtitle,
            video,
            () => media,
            () => source,
            playback,
            status,
            view,
            choose,
            cancel
        );
        await review.queued({});
        expect(view.showChoices).not.toHaveBeenCalled();
        expect(playback.pause).not.toHaveBeenCalled();
        media = 3000;
        video.dispatchEvent(new Event('timeupdate'));
        expect(view.showChoices).toHaveBeenCalledWith(options, expect.any(Function));
        const pick = view.showChoices.mock.calls[0][1];
        pick(option);
        pick(option);
        expect(choose).toHaveBeenCalledTimes(1);
        expect(choose).toHaveBeenCalledWith(12);
        expect(view.showWord).toHaveBeenCalledWith('労力', 'ろうりょく');
        expect(playback.pause).toHaveBeenCalledTimes(1);
        await review.resume();
        expect(cancel).not.toHaveBeenCalled();
        expect(playback.play).toHaveBeenCalledTimes(1);
    });

    it.each([false, true])(
        'opens a sole candidate without a choice screen (ranking arrives after pause: %s)',
        async (afterPause) => {
            review.dispose();
            const option = { index: 12, word: '労力', reading: 'ろうりょく', confidence: 0.8 };
            const choose = jest.fn().mockReturnValue(new Promise(() => {}));
            const confirm = jest.fn().mockResolvedValue({});
            status.mockResolvedValue({ options: [option] });
            if (afterPause) media = 3000;
            review = new BufferedMiningReview(
                'job',
                subtitle,
                video,
                () => media,
                () => source,
                playback,
                status,
                view,
                choose,
                undefined,
                confirm
            );
            await review.queued({});
            if (!afterPause) {
                expect(choose).not.toHaveBeenCalled();
                expect(view.showWord).not.toHaveBeenCalled();
                media = 3000;
                video.dispatchEvent(new Event('timeupdate'));
            }
            expect(view.showChoices).not.toHaveBeenCalled();
            expect(view.showWord).toHaveBeenCalledWith(option.word, option.reading);
            expect(playback.pause).toHaveBeenCalledTimes(1);
            expect(choose).toHaveBeenCalledWith(12);
            // Rendering does not wait for the bridge, and selection is not acceptance.
            expect(confirm).not.toHaveBeenCalled();
            video.dispatchEvent(new Event('timeupdate'));
            await jest.advanceTimersByTimeAsync(1000);
            expect(choose).toHaveBeenCalledTimes(1);
            expect(status).toHaveBeenCalledTimes(1);
            expect(view.showWord).toHaveBeenCalledTimes(1);
        }
    );

    it('cancels an unchosen job even when enqueue arrives after close', async () => {
        review.dispose();
        const cancel = jest.fn().mockResolvedValue({});
        review = new BufferedMiningReview(
            'job',
            subtitle,
            video,
            () => media,
            () => source,
            playback,
            status,
            view,
            jest.fn(),
            cancel
        );
        await review.resume();
        expect(cancel).toHaveBeenCalledTimes(1);
        await review.queued({});
        expect(cancel).toHaveBeenCalledTimes(2);
        expect(status).not.toHaveBeenCalled();
    });
    it('opens the generated definition immediately and keeps V/N confirmation separate', async () => {
        review.dispose();
        media = 3500;
        const option = {
            index: 9,
            word: '死域',
            reading: 'しいき',
            confidence: 0.82,
            definition: '死の危険が及ぶ領域。',
        };
        status.mockResolvedValue({ options: [option] });
        const choose = jest.fn().mockReturnValue(new Promise(() => {}));
        const confirm = jest.fn();
        review = new BufferedMiningReview(
            'job',
            subtitle,
            video,
            () => media,
            () => source,
            playback,
            status,
            view,
            choose,
            jest.fn().mockResolvedValue({}),
            confirm
        );
        await review.queued({});
        expect(view.showWord).toHaveBeenCalledWith(option.word, option.reading, option.definition);
        expect(view.showChoices).not.toHaveBeenCalled();
        expect(choose).toHaveBeenCalledWith(9);
        expect(confirm).not.toHaveBeenCalled();
    });

    it('B dismisses a chosen definition without a card, seek, or late popup', async () => {
        review.dispose();
        const option = { index: 0, word: '労力', reading: 'ろうりょく', confidence: 0.8 };
        let finishChoose!: (value: MiningReviewStatus) => void;
        const choose = jest.fn(
            () =>
                new Promise<MiningReviewStatus>((resolve) => {
                    finishChoose = resolve;
                })
        );
        const cancel = jest.fn().mockResolvedValue({});
        const confirm = jest.fn().mockResolvedValue({});
        media = 3000;
        status.mockResolvedValue({ options: [option] });
        review = new BufferedMiningReview(
            'job',
            subtitle,
            video,
            () => media,
            () => source,
            playback,
            status,
            view,
            choose,
            cancel,
            confirm
        );
        await review.queued({});
        expect(view.showChoices).not.toHaveBeenCalled();
        expect(choose).toHaveBeenCalledWith(option.index);
        expect(view.showWord).toHaveBeenCalledTimes(1);
        await review.cancel();
        expect(view.close).toHaveBeenCalled();
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(confirm).not.toHaveBeenCalled();
        expect(playback.seek).not.toHaveBeenCalled();
        expect(playback.play).toHaveBeenCalledTimes(1);
        finishChoose({ word: '労力' });
        await jest.advanceTimersByTimeAsync(1000);
        expect(confirm).not.toHaveBeenCalled();
        expect(view.showWord).toHaveBeenCalledTimes(1);
        media = 6000;
        video.dispatchEvent(new Event('timeupdate'));
        expect(playback.pause).toHaveBeenCalledTimes(1);
    });

    it.each(['normal', 'audio'] as const)(
        '%s acceptance resumes before the outstanding choice is saved',
        async (cardType) => {
            review.dispose();
            const option = { index: 0, word: '労力', reading: 'ろうりょく', confidence: 0.8 };
            let finishChoose!: (value: MiningReviewStatus) => void;
            const choose = jest.fn(
                () =>
                    new Promise<MiningReviewStatus>((resolve) => {
                        finishChoose = resolve;
                    })
            );
            const cancel = jest.fn().mockResolvedValue({});
            const confirm = jest.fn().mockResolvedValue({});
            media = 3000;
            status.mockResolvedValue({ options: [option] });
            review = new BufferedMiningReview(
                'job',
                subtitle,
                video,
                () => media,
                () => source,
                playback,
                status,
                view,
                choose,
                cancel,
                confirm
            );
            await review.queued({});
            expect(view.showChoices).not.toHaveBeenCalled();
            expect(choose).toHaveBeenCalledWith(option.index);
            await review.resume(cardType);
            expect(playback.play).toHaveBeenCalledTimes(1);
            expect(confirm).not.toHaveBeenCalled();
            expect(cancel).not.toHaveBeenCalled();
            finishChoose({ word: '労力' });
            await jest.advanceTimersByTimeAsync(1);
            expect(confirm).toHaveBeenCalledTimes(1);
            expect(confirm).toHaveBeenCalledWith(cardType);
        }
    );

    it('B cancels before Jev responds and does not pause later at the cue end', async () => {
        review.dispose();
        const cancel = jest.fn().mockResolvedValue({});
        let finishStatus!: (value: MiningReviewStatus) => void;
        status.mockImplementation(
            () =>
                new Promise((resolve) => {
                    finishStatus = resolve;
                })
        );
        review = new BufferedMiningReview(
            'job',
            subtitle,
            video,
            () => media,
            () => source,
            playback,
            status,
            view,
            jest.fn(),
            cancel
        );
        const queued = review.queued({});
        await review.cancel();
        finishStatus({ options: [{ index: 0, word: '労力', reading: 'ろうりょく', confidence: 0.8 }] });
        await queued;
        media = 3500;
        video.dispatchEvent(new Event('timeupdate'));
        expect(playback.pause).not.toHaveBeenCalled();
        expect(view.showChoices).not.toHaveBeenCalled();
        expect(playback.seek).not.toHaveBeenCalled();
        expect(cancel).toHaveBeenCalledTimes(1);
    });
});
