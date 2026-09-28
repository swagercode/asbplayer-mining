import { CrunchyrollSeekController, seekCrunchyrollTimeline } from '@project/extension/src/services/crunchyroll-seek';
import { adjacentSubtitle } from '@project/common/key-binder';

describe('Crunchyroll seeking', () => {
    let video: HTMLVideoElement;
    let slider: HTMLInputElement;
    let controller: CrunchyrollSeekController;
    let commits: number[];
    let currentTime: number;
    let seeking: boolean;
    let readyState: number;
    let paused: boolean;
    let source: string;
    let rawSeek: jest.Mock;

    const complete = (time: number) => {
        currentTime = time;
        seeking = false;
        readyState = 4;
        video.dispatchEvent(new Event('seeked'));
        video.dispatchEvent(new Event('canplay'));
        jest.advanceTimersByTime(300);
    };

    beforeEach(() => {
        jest.useFakeTimers();
        document.body.innerHTML =
            '<div id="player-container"><video></video><input class="timeline-slider" type="range" min="0" max="300" step="0.25"></div><button>Keep focus</button>';
        video = document.querySelector('video')!;
        slider = document.querySelector('input')!;
        commits = [];
        currentTime = 120;
        seeking = false;
        readyState = 4;
        paused = true;
        source = 'blob:episode1';
        rawSeek = jest.fn();
        Object.defineProperties(video, {
            currentTime: { configurable: true, get: () => currentTime, set: rawSeek },
            seeking: { get: () => seeking },
            readyState: { get: () => readyState },
            duration: { get: () => 300 },
            paused: { get: () => paused },
            currentSrc: { get: () => source },
        });
        // The native timeline commits on mouseup only after mousedown. Like the
        // player, seek() returns before the new media data has finished loading.
        let dragging = false;
        slider.addEventListener('mousedown', () => {
            dragging = true;
        });
        slider.addEventListener('mouseup', () => {
            if (!dragging) return;
            dragging = false;
            commits.push(slider.valueAsNumber);
            currentTime = slider.valueAsNumber;
            seeking = true;
            readyState = 1;
            // Real media events arrive asynchronously, including recovery seeks.
            setTimeout(() => video.dispatchEvent(new Event('seeking')), 0);
        });
        jest.spyOn(video, 'play').mockImplementation(async () => {
            paused = false;
            video.dispatchEvent(new Event('play'));
        });
        controller = new CrunchyrollSeekController(video);
    });

    afterEach(() => {
        controller.dispose();
        jest.useRealTimers();
        document.body.replaceChildren();
    });

    it('uses the player timeline with precise subtitle time and preserves focus and pause', () => {
        const button = document.querySelector('button')!;
        button.focus();
        expect(seekCrunchyrollTimeline(video, 105.123)).toBe(true);
        expect(commits).toEqual([105.123]);
        expect(slider.step).toBe('0.25');
        expect(document.activeElement).toBe(button);
        expect(video.paused).toBe(true);
        expect(rawSeek).not.toHaveBeenCalled();
    });

    it('coalesces repeated previous-subtitle presses using the requested position', async () => {
        const subtitles = Array.from({ length: 13 }, (_, index) => ({
            start: index * 10000,
            end: index * 10000 + 5000,
            originalStart: index * 10000,
            originalEnd: index * 10000 + 5000,
            text: `${index}`,
            track: 0,
            index,
        }));
        const waits = [];
        for (let i = 0; i < 10; i++) {
            const subtitle = adjacentSubtitle(false, controller.navigationTimeMs, subtitles, 1)!;
            waits.push(controller.seek(subtitle.start));
            jest.advanceTimersByTime(20);
        }
        expect(controller.navigationTimeMs).toBe(20000);
        expect(currentTime).toBe(120);
        jest.advanceTimersByTime(200);
        expect(commits).toEqual([20]);
        complete(20);
        await Promise.all(waits);
    });

    it('waits for an in-flight seek before committing the newest queued destination', async () => {
        const first = controller.seek(100000);
        jest.advanceTimersByTime(250);
        const second = controller.seek(90000);
        const third = controller.seek(80000);
        jest.advanceTimersByTime(200);
        expect(commits).toEqual([100]);
        expect(controller.navigationTimeMs).toBe(80000);
        complete(100);
        expect(commits).toEqual([100, 80]);
        let finished = false;
        void third.then(() => {
            finished = true;
        });
        await Promise.resolve();
        expect(finished).toBe(false);
        complete(80);
        await Promise.all([first, second, third]);
        expect(finished).toBe(true);
    });

    it('recovers a stalled shortcut seek through the timeline once, without auto-playing', async () => {
        const done = controller.seek(60000);
        jest.advanceTimersByTime(2100);
        expect(commits).toEqual([60, 59.5]);
        expect(paused).toBe(true);
        complete(59.5);
        expect(commits).toEqual([60, 59.5, 60]);
        complete(60);
        await done;
        jest.advanceTimersByTime(10000);
        expect(commits).toHaveLength(3);
    });

    it('also recovers a stalled native left-arrow seek, without a retry loop', () => {
        currentTime = 50;
        seeking = true;
        readyState = 1;
        video.dispatchEvent(new Event('seeking'));
        jest.advanceTimersByTime(10000);
        expect(commits).toEqual([49.5, 50]);
        expect(rawSeek).not.toHaveBeenCalled();
    });

    it('does not interfere with a healthy native seek while paused or playing', () => {
        video.dispatchEvent(new Event('seeking'));
        jest.advanceTimersByTime(2000);
        expect(commits).toEqual([]);
        paused = false;
        video.dispatchEvent(new Event('seeking'));
        currentTime += 1;
        jest.advanceTimersByTime(2000);
        expect(commits).toEqual([]);
    });

    it('lets a manual timeline change cancel queued subtitle navigation', async () => {
        const done = controller.seek(60000);
        jest.advanceTimersByTime(250);
        const queued = controller.seek(30000);
        currentTime = 150;
        video.dispatchEvent(new Event('seeking'));
        complete(150);
        await Promise.all([done, queued]);
        expect(commits).toEqual([60]);
        expect(controller.navigationTimeMs).toBe(150000);
    });

    it('cancels stale recovery when the episode changes', async () => {
        const done = controller.seek(60000);
        jest.advanceTimersByTime(250);
        source = 'blob:episode2';
        jest.advanceTimersByTime(10000);
        await done;
        expect(commits).toEqual([60]);
    });

    it('releases waiting play requests after a broken stream and on disposal', async () => {
        const done = controller.seek(60000);
        jest.advanceTimersByTime(10000);
        await done;
        expect(commits).toHaveLength(3);
        const disposed = controller.seek(30000);
        controller.dispose();
        await disposed;
        jest.advanceTimersByTime(10000);
        expect(commits).toHaveLength(3);
    });

    it('does not call a ready-but-frozen clock successful, and returns from recovery to the exact cue', async () => {
        controller.dispose();
        paused = false;
        controller = new CrunchyrollSeekController(video);
        const done = controller.seek(60000);
        jest.advanceTimersByTime(250);
        complete(60); // DOM says ready, but the player clock is latched.
        let finished = false;
        void done.then(() => {
            finished = true;
        });
        await Promise.resolve();
        expect(finished).toBe(false);
        jest.advanceTimersByTime(1700);
        expect(commits).toEqual([60, 59.5]);
        complete(59.5);
        expect(commits).toEqual([60, 59.5, 60]);
        complete(60.2);
        await done;
        expect(finished).toBe(true);
        expect(video.play).not.toHaveBeenCalled();
    });

    it('recovers an ignored native Play click after a paused seek, even without a new DOM event', () => {
        const button = document.createElement('button');
        button.dataset.testid = 'play-pause-button';
        button.setAttribute('aria-label', 'Play');
        video.parentElement!.append(button);
        button.click(); // Simulate native Play being ignored: no play/playing event.
        jest.advanceTimersByTime(1900);
        expect(commits).toEqual([119.5]);
        complete(119.5);
        expect(commits).toEqual([119.5, 120]);
        paused = false;
        complete(120.2);
        jest.advanceTimersByTime(5000);
        expect(commits).toHaveLength(2);
    });

    it('preserves an explicit pause while a playing seek is pending', async () => {
        controller.dispose();
        paused = false;
        controller = new CrunchyrollSeekController(video);
        const done = controller.seek(60000);
        jest.advanceTimersByTime(250);
        paused = true; // Internal seek pause; the visible control still says Pause.
        video.dispatchEvent(new Event('pause'));
        const button = document.createElement('button');
        button.dataset.testid = 'play-pause-button';
        button.setAttribute('aria-label', 'Pause');
        video.parentElement!.append(button);
        button.click();
        complete(60);
        await done;
        expect(video.play).not.toHaveBeenCalled();
        expect(paused).toBe(true);
        expect(commits).toEqual([60]);
    });

    it('restores playing intent when the player auto-pauses during a seek', async () => {
        controller.dispose();
        paused = false;
        controller = new CrunchyrollSeekController(video);
        const done = controller.seek(60000);
        jest.advanceTimersByTime(250);
        paused = true;
        video.dispatchEvent(new Event('pause'));
        complete(60);
        expect(video.play).toHaveBeenCalledTimes(1);
        complete(60.4);
        await done;
        expect(commits).toEqual([60]);
    });

    it('does not fall back to bypassing the player when the timeline is unavailable', async () => {
        slider.remove();
        const done = controller.seek(60000);
        jest.advanceTimersByTime(250);
        await done;
        expect(rawSeek).not.toHaveBeenCalled();
        expect(commits).toEqual([]);
    });

    it('keeps controls hidden across repeated subtitle seeks and their internal pause events', async () => {
        controller.dispose();
        paused = false;
        controller = new CrunchyrollSeekController(video);
        const root = video.parentElement!;
        expect(root.getAttribute('data-asbplayer-playback-controls')).toBe('playing');
        const done = controller.seek(60000);
        const latest = controller.seek(50000);
        jest.advanceTimersByTime(250);
        paused = true;
        video.dispatchEvent(new Event('pause'));
        expect(root.getAttribute('data-asbplayer-playback-controls')).toBe('playing');
        complete(50);
        complete(50.2);
        await Promise.all([done, latest]);
        expect(root.getAttribute('data-asbplayer-playback-controls')).toBe('playing');
        paused = true;
        video.dispatchEvent(new Event('pause'));
        expect(root.getAttribute('data-asbplayer-playback-controls')).toBe('paused');
        paused = false;
        video.dispatchEvent(new Event('play'));
        expect(root.getAttribute('data-asbplayer-playback-controls')).toBe('playing');
        controller.dispose();
        expect(root.hasAttribute('data-asbplayer-playback-controls')).toBe(false);
        expect(root.querySelector('style')).toBeNull();
    });

    it('shows controls for an explicit pause during a seek and when recovery cannot resume', () => {
        controller.dispose();
        paused = false;
        controller = new CrunchyrollSeekController(video);
        void controller.seek(60000);
        controller.pauseRequested();
        paused = true;
        expect(video.parentElement!.getAttribute('data-asbplayer-playback-controls')).toBe('paused');
        controller.playRequested();
        expect(video.parentElement!.getAttribute('data-asbplayer-playback-controls')).toBe('playing');
        jest.advanceTimersByTime(10000);
        expect(video.parentElement!.getAttribute('data-asbplayer-playback-controls')).toBe('paused');
    });
});
