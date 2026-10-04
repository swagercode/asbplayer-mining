import {
    defaultSettings,
    keyBindKeys,
    microSubtitleNavigationKeys,
    miningChoiceKeyBindNames,
} from '@project/common/settings';
import { matchesPlaybackShortcut } from '@project/common/key-binder/single-key-shortcut';
import type { KeyBindSet } from '@project/common/settings';
import { SentenceExplanationView } from '@project/extension/src/services/sentence-explanation';
import { sentenceExplanationContext } from '@project/extension/src/services/sentence-explanation-context';
import type { SubtitleModel } from '@project/common';
import { v4 as uuid } from 'uuid';
import { bindBufferedMiningShortcut } from '@project/extension/src/services/buffered-mining-shortcut';
import { BufferedMiningReview, YomitanMiningReview } from '@project/extension/src/services/buffered-mining-review';
import type { MiningCardType, MiningReviewPlayback } from '@project/extension/src/services/buffered-mining-review';

type PlaybackSample = {
    session: string;
    sequence: number;
    event: string;
    wall: number;
    media: number;
    rate: number;
    playing: boolean;
    paused: boolean;
    seeking: boolean;
    readyState: number;
    visible: boolean;
};

/** Prefer the displayed cue; gaps use the last cue, never a future cue. */
export function currentOrPreviousSubtitle<T extends SubtitleModel>(
    subtitles: readonly T[],
    now: number
): T | undefined {
    const usable = subtitles.filter((s) => s.text.trim() && !s.textImage && s.start <= now);
    const current = usable.filter((s) => now < s.end);
    return (current.length ? current : usable).reduce<T | undefined>(
        (best, s) => (!best || s.start > best.start ? s : best),
        undefined
    );
}

export class BufferedMiningController {
    private keys = defaultSettings.keyBindSet;
    private unbindExplainShortcut?: () => void;
    private explanation?: {
        id: string;
        view: SentenceExplanationView;
        resume: boolean;
        timer?: ReturnType<typeof setTimeout>;
    };
    private readonly session = uuid();
    private timer?: ReturnType<typeof setInterval>;
    private unbindShortcut?: () => void;
    private unbindAudioShortcut?: () => void;
    private unbindCancelShortcut?: () => void;
    private epoch = 0;
    private lastSource = '';
    private lastMine = 0;
    private sequence = 0;
    private history: PlaybackSample[] = [];
    private review?: BufferedMiningReview;
    private readonly events = ['play', 'playing', 'pause', 'waiting', 'seeking', 'seeked', 'ratechange', 'ended'];

    constructor(
        private readonly video: HTMLVideoElement,
        private readonly subtitles: () => readonly SubtitleModel[],
        private readonly currentTime: () => number,
        private readonly source: () => string,
        private readonly reviewPlayback?: MiningReviewPlayback,
        private readonly captureScreenshot?: () => Promise<string | undefined>
    ) {}

    private send = (action: string, data: object = {}) =>
        browser.runtime.sendMessage({ sender: 'asbplayer-buffered-mining', action, ...data });

    private sample = (event?: Event) => {
        const source = this.source();
        if (source !== this.lastSource || event?.type === 'seeking') {
            if (source !== this.lastSource) {
                this.review?.dispose();
                this.review = undefined;
            }
            void this.closeExplanation(false);
            this.epoch++;
            this.lastSource = source;
            this.history = [];
        }
        const sample: PlaybackSample = {
            session: `${this.session}:${this.epoch}`,
            sequence: ++this.sequence,
            event: event?.type ?? 'sample',
            wall: Date.now() / 1000,
            media: this.currentTime() / 1000,
            rate: this.video.playbackRate,
            playing: !this.video.paused && !this.video.seeking && this.video.readyState >= 3,
            paused: this.video.paused,
            seeking: this.video.seeking,
            readyState: this.video.readyState,
            visible: document.visibilityState === 'visible',
        };
        this.history.push(sample);
        this.history = this.history.filter((point) => sample.wall - point.wall <= 330).slice(-600);
        return sample;
    };

    private observe = (event?: Event) => {
        // Retain DOM transitions even before subtitles load or while the native bridge reconnects.
        const sample = this.sample(event);
        if (this.subtitles().length === 0) return;
        void this.send('observe', { sample }).catch(() => {});
    };

    setKeyBindSet(keys: KeyBindSet) {
        this.keys = keys;
        this.review?.setKeyBindSet(keys);
        this.explanation?.view.setKeyBindSet(keys);
    }

    async closeExplanation(resume = true) {
        const explanation = this.explanation;
        if (!explanation) return;
        this.explanation = undefined;
        clearTimeout(explanation.timer);
        explanation.view.close();
        if (resume && explanation.resume && this.video.isConnected) await this.reviewPlayback?.play();
    }

    async explain() {
        if (this.explanation) return this.closeExplanation();
        const subtitle = this.review?.sentence ?? currentOrPreviousSubtitle(this.subtitles(), this.currentTime());
        if (!subtitle || !this.reviewPlayback) return;
        const sentence = subtitle.text;
        const context = sentenceExplanationContext(this.subtitles(), subtitle);
        const id = uuid();
        const resume = !this.video.paused;
        this.reviewPlayback.pause();
        const view = new SentenceExplanationView(this.video, sentence, this.keys, () => {
            void this.closeExplanation().catch(() => {});
        });
        const explanation = { id, view, resume, timer: undefined as ReturnType<typeof setTimeout> | undefined };
        this.explanation = explanation;
        const poll = async (action: string) => {
            const result = await this.send(action, {
                id,
                ...(action === 'explain' ? { sentence, context } : {}),
            }).catch(() => ({ error: 'The sentence explanation bridge is unavailable.' }));
            if (this.explanation !== explanation) return;
            if (result.error) view.show(result.error);
            else if (result.text) view.show(result.text);
            else explanation.timer = setTimeout(() => void poll('explanation-status'), 300);
        };
        await poll('explain');
    }

    bind() {
        this.unbindShortcut?.();
        this.unbindShortcut = bindBufferedMiningShortcut(
            () => {
                void this.mine().catch(() => {});
            },
            () =>
                !this.explanation &&
                this.video.isConnected &&
                (this.review !== undefined || this.subtitles().length > 0),
            () => keyBindKeys(this.keys.bufferedMiningNormal)
        );
        this.unbindCancelShortcut?.();
        this.unbindAudioShortcut?.();
        this.unbindAudioShortcut = bindBufferedMiningShortcut(
            () => {
                void this.mine('audio').catch(() => {});
            },
            () =>
                !this.explanation &&
                this.video.isConnected &&
                (this.review !== undefined || this.subtitles().length > 0),
            () => keyBindKeys(this.keys.bufferedMiningAudio)
        );
        this.unbindCancelShortcut = bindBufferedMiningShortcut(
            () => {
                void (this.explanation ? this.closeExplanation() : this.cancelReview()).catch(() => {});
            },
            () => this.video.isConnected && (this.review !== undefined || this.explanation !== undefined),
            () => keyBindKeys(this.keys.bufferedMiningCancel)
        );
        this.unbindExplainShortcut?.();
        this.unbindExplainShortcut = bindBufferedMiningShortcut(
            () => {
                void this.explain().catch(() => {});
            },
            (event) =>
                this.video.isConnected &&
                (this.explanation !== undefined || this.subtitles().length > 0) &&
                // Horizontal D-pad presses belong to navigation or word selection.
                // R2's distinct key still opens and closes explanations.
                !matchesPlaybackShortcut(
                    [...microSubtitleNavigationKeys(this.keys, false), ...microSubtitleNavigationKeys(this.keys, true)],
                    event
                ) &&
                !(
                    !this.explanation &&
                    document.querySelector('[data-asbplayer-mining-review]:not([data-asbplayer-mining-word])') &&
                    miningChoiceKeyBindNames.some((name) =>
                        matchesPlaybackShortcut(keyBindKeys(this.keys[name]), event)
                    )
                ),
            () => keyBindKeys(this.keys.explainSentence)
        );
        this.timer = setInterval(this.observe, 1000);
        for (const event of this.events) this.video.addEventListener(event, this.observe);
        document.addEventListener('visibilitychange', this.observe);
        this.observe();
    }

    unbind() {
        void this.closeExplanation(false);
        this.unbindExplainShortcut?.();
        this.review?.dispose();
        this.review = undefined;
        this.unbindShortcut?.();
        this.unbindAudioShortcut?.();
        this.unbindCancelShortcut?.();
        clearInterval(this.timer);
        for (const event of this.events) this.video.removeEventListener(event, this.observe);
        document.removeEventListener('visibilitychange', this.observe);
    }

    async cancelReview() {
        const review = this.review;
        if (!review) return;
        this.review = undefined;
        this.lastMine = Date.now();
        await review.cancel();
    }

    async mine(cardType: MiningCardType = 'normal') {
        if (this.explanation) return { error: 'Close the sentence explanation before mining.' };
        if (this.review) {
            const review = this.review;
            this.lastMine = Date.now();
            try {
                await review.resume(cardType);
            } finally {
                if (this.review === review && review.closed) this.review = undefined;
            }
            return { reviewClosed: review.closed };
        }
        // Ignore keyboard repeat/double-clicks, but never wait for a preceding job.
        if (Date.now() - this.lastMine < 400) return { queued: false };
        this.lastMine = Date.now();
        const subtitle = currentOrPreviousSubtitle(this.subtitles(), this.currentTime());
        if (!subtitle) return { error: 'No current or previous subtitle is available.' };
        const sample = this.sample();
        const id = uuid();
        const source = this.source();
        const captureEpoch = this.epoch;
        // Each mining cycle owns its image, independently of ranking and audio.
        const screenshot = this.captureScreenshot?.()
            .then((image) => (this.source() === source && this.epoch === captureEpoch ? image : undefined))
            .catch(() => undefined);
        const review = this.reviewPlayback
            ? new BufferedMiningReview(
                  id,
                  { ...subtitle },
                  this.video,
                  this.currentTime,
                  this.source,
                  this.reviewPlayback,
                  () => this.send('job-status', { id }),
                  new YomitanMiningReview(this.video, this.keys),
                  (index) => this.send('choose', { id, index }),
                  () => this.send('cancel-choice', { id }),
                  async (cardType) => {
                      const image = await screenshot;
                      return this.send('confirm-choice', { id, cardType, ...(image ? { screenshot: image } : {}) });
                  }
              )
            : undefined;
        this.review = review;
        const response = await this.send('enqueue', {
            job: {
                id,
                selectionMode: 'ranked',
                reviewBeforeExport: review !== undefined,
                sample,
                history: this.history.slice(),
                subtitle: { text: subtitle.text, start: subtitle.start / 1000, end: subtitle.end / 1000 },
                title: document.title,
                url: location.href,
            },
        }).catch((error) => ({ error: String(error) }));
        void review?.queued(response);
        return response;
    }
}
