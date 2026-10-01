import { defaultSettings, hasMicroMiningKeys, keyBindKeys, miningChoiceKeyBindNames } from '@project/common/settings';
import type { KeyBindSet } from '@project/common/settings';
import type { SubtitleModel } from '@project/common';
import { bindSingleKeyShortcut } from '@project/common/key-binder/single-key-shortcut';

export type MiningWordOption = {
    index: number;
    word: string;
    reading: string;
    confidence: number;
    definition?: string;
};
export type MiningCardType = 'normal' | 'audio';

export type MiningReviewPlayback = {
    pause: () => void;
    seek: (timestampMs: number) => Promise<void>;
    play: () => Promise<unknown>;
};

export type MiningReviewStatus = {
    state?: string;
    error?: string;
    word?: string;
    reading?: string;
    definition?: string;
    options?: MiningWordOption[];
};

export interface MiningReviewView {
    message(text: string): void;
    showWord(word: string, reading?: string, definition?: string): void;
    showChoices(options: MiningWordOption[], choose: (option: MiningWordOption) => void): void;
    close(): void;
    setKeyBindSet?(keys: KeyBindSet): void;
}

/** A small scan target lets the installed Yomitan render its own dictionary popup. */
export class YomitanMiningReview implements MiningReviewView {
    private static latestScan?: YomitanMiningReview;
    private readonly panel = document.createElement('div');
    private readonly word = document.createElement('span');
    private readonly status = document.createElement('div');
    private readonly definition = document.createElement('div');
    private readonly choices = document.createElement('div');
    private unbindChoices: (() => void)[] = [];
    private focusTimer?: ReturnType<typeof setTimeout>;
    private closeTimer?: ReturnType<typeof setTimeout>;
    private scanFrame?: number;
    private closed = false;
    private showingWord = false;
    private scanDispatched = false;

    private statusPrefix = '';

    constructor(
        private readonly video: HTMLVideoElement,
        private keys = defaultSettings.keyBindSet
    ) {
        this.panel.dataset.asbplayerMiningReview = '';
        this.panel.tabIndex = -1;
        this.panel.style.cssText =
            'all:initial;position:fixed;top:12%;left:25%;max-width:65vw;padding:12px 18px;' +
            'z-index:2147483646;background:#202028;color:#fff;border-radius:6px;' +
            'font:16px/1.5 sans-serif;box-shadow:0 2px 12px #0008;outline:none;';
        this.word.style.cssText = 'display:block;font:32px/1.4 sans-serif;color:inherit;white-space:pre;';
        this.status.style.cssText = 'font:14px/1.5 sans-serif;color:#ddd;';
        this.definition.style.cssText =
            'font:20px/1.6 sans-serif;color:#fff;white-space:pre-wrap;max-width:650px;max-height:45vh;overflow:auto;';
        this.panel.append(this.word, this.status, this.definition, this.choices);
        this.mount();
        document.addEventListener('fullscreenchange', this.mount);
        window.addEventListener('blur', this.returnKeyboardFocus);
    }

    private mount = () => {
        const fullscreen = document.fullscreenElement;
        const parent =
            fullscreen && fullscreen !== this.video && fullscreen.contains(this.video) ? fullscreen : document.body;
        parent.append(this.panel);
    };

    private returnKeyboardFocus = () => {
        clearTimeout(this.focusTimer);
        this.focusTimer = setTimeout(() => {
            // Yomitan focuses its cross-origin iframe on open/click. Keep mining keys in the player,
            // but never steal focus when the user switches tabs or applications.
            if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
            if (this.closed) {
                if (YomitanMiningReview.latestScan === this) {
                    this.clearPopup();
                    // The iframe also focuses during initialization, before it is visible.
                    // Restore the player now so a subsequent display focus is caught too.
                    const tabIndex = this.video.getAttribute('tabindex');
                    this.video.tabIndex = -1;
                    this.video.focus({ preventScroll: true });
                    if (tabIndex === null) this.video.removeAttribute('tabindex');
                    else this.video.setAttribute('tabindex', tabIndex);
                }
            } else this.panel.focus({ preventScroll: true });
        }, 0);
    };

    private clearPopup() {
        document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    }

    private stopFocusListener() {
        clearTimeout(this.closeTimer);
        clearTimeout(this.focusTimer);
        window.removeEventListener('blur', this.returnKeyboardFocus);
        window.removeEventListener('pointermove', this.manualScan);
        window.removeEventListener('pointerdown', this.manualScan);
        if (this.closed && YomitanMiningReview.latestScan === this) YomitanMiningReview.latestScan = undefined;
    }

    private manualScan = (event: PointerEvent) => {
        if (event.isTrusted && (event.type === 'pointerdown' || event.shiftKey)) this.stopFocusListener();
    };

    setKeyBindSet(keys: KeyBindSet) {
        this.keys = keys;
        if (!this.panel.hasAttribute('data-asbplayer-mining-choices')) this.refreshStatus();
        this.choices.querySelectorAll('button').forEach((button, i) => {
            const label = this.choiceLabel(i);
            button.firstElementChild!.textContent = label;
            button.setAttribute('aria-label', `${label ? label + ': ' : ''}${button.lastElementChild!.textContent}`);
        });
    }

    private choiceLabel(index: number) {
        // The Micro's keyboard-mode D-pad sends C/F/D/E clockwise from up.
        // Recognize its complete mining layout so ordinary custom shortcuts keep their key labels.
        return hasMicroMiningKeys(this.keys) && index < 4
            ? ['↑', '→', '↓', '←'][index]
            : keyBindKeys(this.keys[miningChoiceKeyBindNames[index]]).join(' / ').toUpperCase();
    }

    private refreshStatus() {
        const hints = [
            [keyBindKeys(this.keys.bufferedMiningAudio).join(' / '), 'audio'],
            [keyBindKeys(this.keys.bufferedMiningNormal).join(' / '), 'normal'],
            [keyBindKeys(this.keys.bufferedMiningCancel).join(' / '), 'skip'],
        ]
            .filter(([key]) => key)
            .map(([key, action]) => `${key.toUpperCase()} ${action}`);
        this.status.textContent = [this.statusPrefix, ...hints].filter(Boolean).join(' · ');
    }

    message(text: string) {
        this.clearChoices();
        this.definition.textContent = '';
        this.statusPrefix = text;
        this.refreshStatus();
    }

    private clearChoices() {
        delete this.panel.dataset.asbplayerMiningChoices;
        this.choices.replaceChildren();
        this.unbindChoices.splice(0).forEach((unbind) => unbind());
    }

    showChoices(options: MiningWordOption[], choose: (option: MiningWordOption) => void) {
        this.clearChoices();
        this.panel.dataset.asbplayerMiningChoices = '';
        this.panel.style.left = '50%';
        this.panel.style.top = '30%';
        this.panel.style.transform = 'translateX(-50%)';
        this.panel.style.maxWidth = '90vw';
        this.panel.style.width = 'max-content';
        this.word.textContent = '';
        this.status.textContent = '';
        this.choices.style.cssText = 'display:flex;flex-wrap:wrap;justify-content:center;gap:24px 40px;padding:12px;';
        let picked = false;
        const pick = (option: MiningWordOption) => {
            if (picked || this.closed) return;
            picked = true;
            this.clearChoices();
            choose(option);
        };
        options.slice(0, 9).forEach((option, i) => {
            const button = document.createElement('button');
            button.style.cssText =
                'all:unset;display:flex;flex-direction:column;align-items:center;cursor:pointer;color:#fff;';
            button.setAttribute('aria-label', `${i + 1}: ${option.word}`);
            const number = document.createElement('span');
            number.style.cssText = 'font:600 24px/1.4 system-ui;color:#ddd;';
            number.textContent = this.choiceLabel(i);
            const word = document.createElement('span');
            word.style.cssText = 'font:500 clamp(36px,4vw,64px)/1.4 sans-serif;white-space:nowrap;';
            word.textContent = option.word;
            button.append(number, word);
            button.onclick = () => pick(option);
            this.choices.append(button);
        });
        // Reserve all nine keys, including unassigned numbers. Never forward an
        // invalid choice to Crunchyroll's seek shortcuts.
        for (let i = 0; i < 9; i++) {
            this.unbindChoices.push(
                bindSingleKeyShortcut(
                    () => keyBindKeys(this.keys[miningChoiceKeyBindNames[i]]),
                    (event) => {
                        if (document.querySelector('[data-asbplayer-sentence-explanation]')) return false;
                        event.preventDefault();
                        event.stopImmediatePropagation();
                        if (!event.repeat && options[i]) pick(options[i]);
                        return true;
                    }
                )
            );
        }
        this.setKeyBindSet(this.keys);
        this.panel.focus({ preventScroll: true });
    }

    showWord(word: string, reading?: string, definition?: string) {
        this.panel.dataset.asbplayerMiningWord = '';
        this.clearChoices();
        this.panel.style.left = '25%';
        this.panel.style.top = '12%';
        this.panel.style.transform = '';
        this.panel.style.width = '';
        this.showingWord = true;
        this.word.textContent = word;
        this.statusPrefix = reading || '';
        this.refreshStatus();
        this.definition.textContent = definition ? `Luna\n${definition}` : '';
        this.panel.focus({ preventScroll: true });
        // No dictionary entry exists for generated vocabulary. Show its definition
        // directly in the fullscreen review instead of opening a misleading fragment.
        if (definition) return;
        this.scanFrame = requestAnimationFrame(() => {
            if (this.closed || !this.word.firstChild) return;
            if (YomitanMiningReview.latestScan?.closed) YomitanMiningReview.latestScan.stopFocusListener();
            YomitanMiningReview.latestScan = this;
            this.scanDispatched = true;
            const range = document.createRange();
            range.setStart(this.word.firstChild, 0);
            range.setEnd(this.word.firstChild, 1);
            const rect = range.getBoundingClientRect();
            // Use Yomitan's normal Shift-hover scanner; no extra model request or dictionary copy.
            this.word.dispatchEvent(
                new PointerEvent('pointermove', {
                    bubbles: true,
                    clientX: rect.x + rect.width / 2,
                    clientY: rect.y + rect.height / 2,
                    shiftKey: true,
                    pointerType: 'mouse',
                    pointerId: 1,
                    isPrimary: true,
                })
            );
        });
    }

    close() {
        this.clearChoices();
        this.closed = true;
        clearTimeout(this.focusTimer);
        if (this.scanFrame !== undefined) cancelAnimationFrame(this.scanFrame);
        document.removeEventListener('fullscreenchange', this.mount);
        if (this.showingWord) {
            // Let Yomitan clear its own state. Removing its iframe would break later lookups.
            this.clearPopup();
        }
        // A dictionary lookup already sent to Yomitan cannot be cancelled. If it focuses
        // its popup after close, dismiss that late result too. A new scan supersedes this guard.
        if (this.scanDispatched) {
            window.addEventListener('pointermove', this.manualScan);
            window.addEventListener('pointerdown', this.manualScan);
            this.closeTimer = setTimeout(() => this.stopFocusListener(), 5000);
        } else this.stopFocusListener();
        this.panel.remove();
    }
}

/** V accepts an audio card, N a normal card; B discards it. Export never holds up playback. */
export class BufferedMiningReview {
    private active = true;
    private paused = false;
    private timer?: ReturnType<typeof setTimeout>;
    private readonly originalSource: string;
    private chosen = false;
    private accepted = false;
    private selection?: Promise<MiningReviewStatus>;
    private choicesShown = false;
    private pendingOptions?: MiningWordOption[];
    private resumePromise?: Promise<void>;
    private finishSentenceWait?: (finished: boolean) => void;

    constructor(
        readonly id: string,
        private readonly subtitle: SubtitleModel,
        private readonly video: HTMLVideoElement,
        private readonly currentTime: () => number,
        private readonly source: () => string,
        private readonly playback: MiningReviewPlayback,
        private readonly status: () => Promise<MiningReviewStatus>,
        private readonly view: MiningReviewView = new YomitanMiningReview(video),
        private readonly choose?: (index: number) => Promise<MiningReviewStatus>,
        private readonly cancelChoice?: () => Promise<unknown>,
        private readonly confirmChoice?: (cardType: MiningCardType) => Promise<unknown>
    ) {
        this.originalSource = source();
        this.view.message('Finishing sentence audio…');
        video.addEventListener('timeupdate', this.pauseAfterSentence);
        this.pauseAfterSentence();
    }

    get closed() {
        return !this.active;
    }

    get sentence() {
        return this.subtitle;
    }

    setKeyBindSet(keys: KeyBindSet) {
        this.view.setKeyBindSet?.(keys);
    }

    private valid() {
        if (this.active && this.source() !== this.originalSource) this.dispose();
        return this.active;
    }

    private pauseAfterSentence = () => {
        if (!this.valid() || this.paused || this.currentTime() < this.subtitle.end) return;
        this.paused = true;
        this.playback.pause();
        if (!this.choicesShown && !this.chosen) this.view.message('Choosing word…');
        this.showReadyChoices();
        this.finishSentenceWait?.(true);
        this.finishSentenceWait = undefined;
    };

    private showReadyChoices() {
        // Ranking and review can happen while the rest of the sentence is captured.
        // Only the replay seek on acceptance needs to wait for the cue boundary.
        if (this.choicesShown || this.chosen || !this.pendingOptions?.length || !this.choose) return;
        this.choicesShown = true;
        if (this.pendingOptions.length === 1) {
            void this.pick(this.pendingOptions[0]);
        } else {
            this.view.showChoices(this.pendingOptions, (option) => void this.pick(option));
        }
    }

    async queued(response: { error?: string }) {
        if (!this.valid()) {
            if (!this.accepted) void this.cancelChoice?.().catch(() => {});
            return;
        }
        if (response.error) {
            this.fail(response.error);
            return;
        }
        await this.poll();
    }

    private async poll() {
        if (!this.valid()) return;
        try {
            const result = await this.status();
            if (!this.valid() || this.chosen) return;
            this.pauseAfterSentence();
            if (result.word) {
                this.chosen = true;
                if (result.definition) this.view.showWord(result.word, result.reading, result.definition);
                else this.view.showWord(result.word, result.reading);
                return;
            }
            if (result.error || result.state === 'failed') {
                this.fail(result.error || 'Mining failed. Check the mining queue.');
                return;
            }
            if (result.options?.length && this.choose && !this.choicesShown) {
                this.pendingOptions = result.options;
                this.showReadyChoices();
            }
        } catch (error) {
            if (!this.valid()) return;
            this.fail(String(error));
            return;
        }
        if (this.valid() && !this.chosen) {
            this.timer = setTimeout(() => void this.poll(), this.pendingOptions ? 300 : 75);
        }
    }

    private async pick(option: MiningWordOption) {
        if (!this.valid() || this.chosen || !this.choose) return;
        this.chosen = true;
        clearTimeout(this.timer);
        // Local display does not wait for a network round trip, OBS or Anki.
        if (option.definition) this.view.showWord(option.word, option.reading, option.definition);
        else this.view.showWord(option.word, option.reading);
        try {
            this.selection = this.choose(option.index);
            const result = await this.selection;
            if (this.valid() && result.error) this.fail(result.error);
        } catch (error) {
            if (this.valid()) this.fail(String(error));
        }
    }

    private fail(error: string) {
        this.finishSentenceWait?.(false);
        this.finishSentenceWait = undefined;
        this.chosen = false;
        this.video.removeEventListener('timeupdate', this.pauseAfterSentence);
        if (!this.paused) this.playback.pause();
        this.paused = true;
        this.view.message(error);
    }

    async cancel() {
        const valid = this.valid();
        this.dispose();
        // Declining continues at the pause point, without replaying or mining.
        if (valid && this.source() === this.originalSource) await this.playback.play();
    }

    resume(cardType: MiningCardType = 'normal') {
        // Repeated acceptance while audio finishes keeps the original card type.
        this.resumePromise ??= this.finishResume(cardType).finally(() => {
            this.resumePromise = undefined;
        });
        return this.resumePromise;
    }

    private async finishResume(cardType: MiningCardType) {
        if (this.valid() && this.chosen && !this.paused && this.currentTime() < this.subtitle.end) {
            const finished = await new Promise<boolean>((resolve) => {
                this.finishSentenceWait = resolve;
            });
            if (!finished) return;
        }
        const valid = this.valid();
        this.accepted = valid && this.chosen;
        if (this.accepted) {
            // Preserve choose-before-confirm ordering, even for a very quick number/N.
            // The view and playback close immediately; slow bridge/Anki work stays queued.
            void Promise.resolve(this.selection)
                .then((result) => {
                    if (result?.error) return;
                    return this.confirmChoice?.(cardType);
                })
                .catch(() => {});
        }
        this.dispose();
        if (!valid) return;
        await this.playback.seek(this.subtitle.start);
        // In particular, let a seek clear the media element's ended flag before play(),
        // otherwise Chrome can restart the entire video at zero.
        if (this.video.seeking) {
            await new Promise<void>((resolve) => {
                const finish = () => {
                    clearTimeout(timer);
                    this.video.removeEventListener('seeked', finish);
                    resolve();
                };
                const timer = setTimeout(finish, 1500);
                this.video.addEventListener('seeked', finish);
            });
        }
        if (this.source() === this.originalSource) await this.playback.play();
        // No sentence-end listener, repeat mode, or delayed pause survives this point.
    }

    dispose() {
        if (!this.active) return;
        this.active = false;
        this.finishSentenceWait?.(false);
        this.finishSentenceWait = undefined;
        if (!this.accepted) void this.cancelChoice?.().catch(() => {});
        clearTimeout(this.timer);
        this.video.removeEventListener('timeupdate', this.pauseAfterSentence);
        this.view.close();
    }
}
