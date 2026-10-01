import type { KeyBindSet } from '@project/common/settings';
import { keyBindKeys } from '@project/common/settings';

/** Plain text only: model output never becomes HTML in the player. */
export class SentenceExplanationView {
    private readonly panel = document.createElement('div');
    private readonly answer = document.createElement('div');
    private readonly closeButton = document.createElement('button');

    constructor(
        private readonly video: HTMLVideoElement,
        sentence: string,
        keys: KeyBindSet,
        close: () => void
    ) {
        this.panel.dataset.asbplayerSentenceExplanation = '';
        this.panel.tabIndex = -1;
        this.panel.setAttribute('role', 'dialog');
        this.panel.setAttribute('aria-label', 'Sentence explanation');
        this.panel.style.cssText =
            'all:initial;position:fixed;inset:10% auto auto 50%;transform:translateX(-50%);' +
            'width:min(800px,85vw);max-height:75vh;overflow:auto;box-sizing:border-box;padding:24px;' +
            'z-index:2147483647;background:#202028;color:white;border-radius:8px;font:20px/1.6 system-ui;';
        const subtitle = document.createElement('div');
        subtitle.style.cssText = 'font:26px/1.5 sans-serif;margin-bottom:18px;white-space:pre-wrap;';
        subtitle.textContent = sentence;
        this.answer.style.whiteSpace = 'pre-wrap';
        this.answer.textContent = 'Explaining…';
        this.answer.setAttribute('aria-live', 'polite');
        this.closeButton.style.cssText =
            'display:block;margin-top:18px;padding:8px 12px;background:#454550;' +
            'color:white;border:0;border-radius:4px;font:14px system-ui;cursor:pointer;';
        this.closeButton.onclick = close;
        this.panel.append(subtitle, this.answer, this.closeButton);
        this.setKeyBindSet(keys);
        this.mount();
        document.addEventListener('fullscreenchange', this.mount);
        this.panel.focus({ preventScroll: true });
    }

    private mount = () => {
        const fullscreen = document.fullscreenElement;
        (fullscreen && fullscreen !== this.video && fullscreen.contains(this.video)
            ? fullscreen
            : document.body
        ).append(this.panel);
    };

    setKeyBindSet(keys: KeyBindSet) {
        const shortcut = keyBindKeys(keys.explainSentence).join(' / ').toUpperCase();
        this.closeButton.textContent = shortcut ? `${shortcut} · Close explanation` : 'Close explanation';
    }

    show(text: string) {
        this.answer.textContent = text;
    }

    close() {
        document.removeEventListener('fullscreenchange', this.mount);
        this.panel.remove();
    }
}
