import { isPlainPlaybackKey } from '@project/common/key-binder/single-key-shortcut';
import { CrunchyrollPlaybackControls } from './crunchyroll-playback-controls';

// Crunchyroll's timeline calls player.seek(), which updates both its media pipeline
// and playback state machine. Writing video.currentTime bypasses that state machine.
export function seekCrunchyrollTimeline(video: HTMLMediaElement, seconds: number): boolean {
    const root = video.closest('#player-container') ?? video.parentElement;
    const slider = root?.querySelector<HTMLInputElement>('input.timeline-slider[type="range"]');
    if (!slider || !Number.isFinite(seconds)) return false;

    const max = Number(slider.max);
    if (!Number.isFinite(max) || max <= 0) return false;
    const target = Math.max(Number(slider.min) || 0, Math.min(max, seconds));
    const step = slider.getAttribute('step');
    // Subtitle boundaries need more precision than the timeline's 250 ms steps.
    slider.step = 'any';
    try {
        slider.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
        slider.valueAsNumber = target;
        slider.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    } finally {
        if (step === null) slider.removeAttribute('step');
        else slider.setAttribute('step', step);
    }
    return true;
}

interface SeekAttempt {
    target: number;
    committedTarget: number;
    started: number;
    source: string;
    playing: boolean;
    recovery: 'none' | 'away' | 'back';
    readySince?: number;
    playTried: boolean;
}

/** Serialize seeks and check clock progress, not just HTMLMediaElement readiness. */
export class CrunchyrollSeekController {
    private pending?: number;
    private active?: SeekAttempt;
    private nativeSeek?: SeekAttempt;
    private debounce?: ReturnType<typeof setTimeout>;
    private monitor?: ReturnType<typeof setInterval>;
    private waiters: (() => void)[] = [];
    private disposed = false;
    private committing = false;
    private playing: boolean;
    private lastCommit?: { target: number; source: string; time: number };
    private readonly root: Element | null;
    private readonly controls?: CrunchyrollPlaybackControls;

    constructor(private readonly video: HTMLMediaElement) {
        this.playing = !video.paused;
        this.root = video.closest('#player-container') ?? video.parentElement;
        if (this.root) {
            this.controls = new CrunchyrollPlaybackControls(this.root);
            this.controls.update(this.playing);
        }
        video.addEventListener('seeking', this.onSeeking);
        video.addEventListener('play', this.onPlay);
        video.addEventListener('pause', this.onPause);
        video.addEventListener('emptied', this.reset);
        this.root?.addEventListener('click', this.onClick, true);
        window.addEventListener('keydown', this.onKey, true);
    }

    get navigationTimeMs(): number {
        return (this.pending ?? this.active?.target ?? this.video.currentTime) * 1000;
    }

    seek(timestampMs: number): Promise<void> {
        if (this.disposed || !Number.isFinite(timestampMs)) return Promise.resolve();
        if (!this.active && !this.nativeSeek && this.pending === undefined) this.playing = !this.video.paused;
        this.pending = Math.max(0, Math.min(this.video.duration || Infinity, timestampMs / 1000));
        if (this.debounce !== undefined) clearTimeout(this.debounce);
        // The cursor moves on every press. The player receives the last target in a burst.
        this.debounce = setTimeout(() => {
            this.debounce = undefined;
            this.flush();
        }, 200);
        return this.waitForIdle();
    }

    waitForIdle(): Promise<void> {
        if (this.pending === undefined && !this.active) return Promise.resolve();
        return new Promise((resolve) => this.waiters.push(resolve));
    }

    /** Called by asbplayer too, so deliberate pauses during a seek stay paused. */
    pauseRequested() {
        this.setPlaying(false);
    }

    /** Also monitor a Play request which the native player silently ignores. */
    playRequested() {
        this.setPlaying(true);
        if (!this.active && !this.nativeSeek) this.nativeSeek = this.attempt(this.video.currentTime);
        this.startMonitor();
    }

    private setPlaying(playing: boolean) {
        this.playing = playing;
        this.controls?.update(playing);
        for (const attempt of [this.active, this.nativeSeek]) {
            if (attempt) {
                attempt.playing = playing;
                attempt.playTried = false;
                attempt.readySince = undefined;
            }
        }
    }

    private onPlay = () => this.playRequested();
    private onPause = () => {
        // Bitmovin temporarily pauses while seeking. A DOM pause in the middle of
        // that operation is not a user pause; explicit controls are tracked below.
        if (!this.active && !this.nativeSeek && this.pending === undefined) this.setPlaying(false);
    };

    private onClick = (event: Event) => {
        if (this.committing || !(event.target instanceof Element)) return;
        const button = event.target.closest('[data-testid="play-pause-button"]');
        if (button) {
            const label = button.getAttribute('aria-label');
            if (label === 'Pause') this.pauseRequested();
            else if (label === 'Play' || this.video.paused) this.playRequested();
            else this.pauseRequested();
        } else if (event.target === this.video) {
            if (this.video.paused) this.playRequested();
            else this.pauseRequested();
        }
    };

    private onKey = (event: KeyboardEvent) => {
        if (event.repeat || !isPlainPlaybackKey(event) || ![' ', 'k'].includes(event.key.toLowerCase())) return;
        const label = this.root?.querySelector('[data-testid="play-pause-button"]')?.getAttribute('aria-label');
        if (label === 'Pause') this.pauseRequested();
        else if (label === 'Play' || this.video.paused) this.playRequested();
        else this.pauseRequested();
    };

    dispose() {
        this.disposed = true;
        this.video.removeEventListener('seeking', this.onSeeking);
        this.video.removeEventListener('play', this.onPlay);
        this.video.removeEventListener('pause', this.onPause);
        this.video.removeEventListener('emptied', this.reset);
        this.root?.removeEventListener('click', this.onClick, true);
        window.removeEventListener('keydown', this.onKey, true);
        this.reset();
        this.controls?.dispose();
    }

    private reset = () => {
        if (this.debounce !== undefined) clearTimeout(this.debounce);
        this.debounce = undefined;
        this.stopMonitor();
        this.pending = undefined;
        this.active = undefined;
        this.nativeSeek = undefined;
        this.playing = !this.video.paused;
        this.controls?.update(this.playing);
        this.resolveWaiters();
    };

    private onSeeking = () => {
        if (this.committing) return;
        const expected = this.active ?? this.nativeSeek;
        if (
            !expected &&
            this.lastCommit &&
            performance.now() - this.lastCommit.time < 600 &&
            this.lastCommit.source === (this.video.currentSrc || this.video.src) &&
            Math.abs(this.video.currentTime - this.lastCommit.target) < 0.35
        )
            return;
        if (expected && Math.abs(this.video.currentTime - expected.committedTarget) < 0.35) return;
        // A real timeline click/native arrow replaces the shortcut queue.
        const playing = expected ? this.playing : !this.video.paused;
        this.reset();
        this.playing = playing;
        this.controls?.update(playing);
        this.nativeSeek = this.attempt(this.video.currentTime);
        this.startMonitor();
    };

    private attempt(target: number): SeekAttempt {
        return {
            target,
            committedTarget: target,
            started: performance.now(),
            recovery: 'none',
            source: this.video.currentSrc || this.video.src,
            playing: this.playing,
            playTried: false,
        };
    }

    private commit(target: number): boolean {
        this.committing = true;
        this.lastCommit = { target, source: this.video.currentSrc || this.video.src, time: performance.now() };
        try {
            return seekCrunchyrollTimeline(this.video, target);
        } finally {
            this.committing = false;
        }
    }

    private tryPlay() {
        this.committing = true;
        try {
            const button = this.root?.querySelector<HTMLButtonElement>('[data-testid="play-pause-button"]');
            if (button?.getAttribute('aria-label') === 'Play') button.click();
            else void this.video.play().catch(() => {});
        } finally {
            this.committing = false;
        }
    }

    private flush() {
        if (this.active || this.debounce !== undefined || this.pending === undefined) return;
        const target = this.pending;
        this.pending = undefined;
        this.nativeSeek = undefined;
        this.active = this.attempt(target);
        if (!this.commit(target)) {
            this.active = undefined;
            this.resolveWaiters();
            return;
        }
        this.startMonitor();
    }

    private startMonitor() {
        if (!this.disposed) this.monitor ??= setInterval(() => this.tick(), 100);
    }

    private tick() {
        const attempt = this.active ?? this.nativeSeek;
        if (!attempt) return this.stopMonitor();
        if ((this.video.currentSrc || this.video.src) !== attempt.source) return this.reset();

        const now = performance.now();
        const ready = !this.video.seeking && this.video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA;
        const offset = this.video.currentTime - attempt.committedTarget;
        const arrived = Math.abs(offset) < 0.35 || (attempt.playing && offset > 0 && offset < 5);
        if (ready && arrived) attempt.readySince ??= now;
        else attempt.readySince = undefined;
        const settled = attempt.readySince !== undefined && now - attempt.readySince >= 200;
        if (settled && attempt.recovery === 'away') {
            // A distinct timeline destination clears the stuck seek latch. Return to
            // the exact subtitle start instead of leaving a permanent audio offset.
            attempt.recovery = 'back';
            attempt.committedTarget = attempt.target;
            attempt.readySince = undefined;
            attempt.playTried = false;
            this.commit(attempt.target);
            return;
        }
        if (settled && (!attempt.playing || (!this.video.paused && offset >= 0.05))) {
            this.finishAttempt();
            return;
        }
        if (settled && attempt.playing && this.video.paused && !attempt.playTried) {
            attempt.playTried = true;
            this.tryPlay();
        }
        if (now - attempt.started >= 1800 && attempt.recovery === 'none') {
            attempt.recovery = 'away';
            // 10 ms is below player seek tolerance and can leave the same latch set.
            attempt.committedTarget =
                attempt.target >= 0.5 ? attempt.target - 0.5 : Math.min(this.video.duration, attempt.target + 0.5);
            attempt.readySince = undefined;
            this.commit(attempt.committedTarget);
        } else if (now - attempt.started >= 8000) {
            // Bounded recovery; never leave pending playback/navigation promises locked.
            if (attempt.recovery === 'away') this.commit(attempt.target);
            this.finishAttempt();
        }
    }

    private finishAttempt() {
        this.active = undefined;
        this.nativeSeek = undefined;
        this.stopMonitor();
        // If bounded recovery gave up, expose controls for the genuinely paused player.
        if (this.pending === undefined) this.controls?.update(!this.video.paused);
        this.flush();
        if (this.pending === undefined && !this.active) this.resolveWaiters();
    }

    private stopMonitor() {
        if (this.monitor !== undefined) clearInterval(this.monitor);
        this.monitor = undefined;
    }

    private resolveWaiters() {
        for (const resolve of this.waiters.splice(0)) resolve();
    }
}
