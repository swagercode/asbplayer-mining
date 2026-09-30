import hotkeys from 'hotkeys-js';
import { DefaultKeyBinder } from '@project/common/key-binder/key-binder';
import type { SubtitleModel } from '@project/common';
import type { KeyBindSet } from '@project/common/settings';
import { bindPriorityNavigationKeys } from '@project/common/key-binder/single-key-shortcut';

describe('fullscreen subtitle navigation', () => {
    const subtitles: SubtitleModel[] = [
        { text: '前', start: 1000, end: 2000, originalStart: 1000, originalEnd: 2000, track: 0 },
        { text: '今', start: 3000, end: 4000, originalStart: 3000, originalEnd: 4000, track: 0 },
    ];
    const key = (type: string, value: string, target: EventTarget = document.body, init: KeyboardEventInit = {}) => {
        const event = new KeyboardEvent(type, {
            key: value,
            keyCode: value.toUpperCase().charCodeAt(0),
            bubbles: true,
            composed: true,
            cancelable: true,
            ...init,
        });
        target.dispatchEvent(event);
        return event;
    };
    let onSeek: jest.Mock;
    let unbind: () => void;
    let time: number;
    let disabled: boolean;
    const siteHandler = (event: Event) => event.stopImmediatePropagation();

    beforeEach(() => {
        // Simulate fullscreen controls installed before the extension, and other hotkeys
        // sharing the library's pressed-key state.
        document.addEventListener('keydown', siteHandler, true);
        hotkeys('ctrl+g', () => {});
        time = 3500;
        disabled = false;
        onSeek = jest.fn((event: KeyboardEvent) => {
            event.preventDefault();
            event.stopImmediatePropagation();
        });
        const binder = new DefaultKeyBinder({
            seekToBeginningOfCurrentSubtitle: { keys: 'W' },
            seekToPreviousSubtitle: { keys: 'S' },
            seekToNextSubtitle: { keys: '' },
        } as KeyBindSet);
        const current = binder.bindSeekToBeginningOfCurrentSubtitle(
            onSeek,
            () => disabled,
            () => time,
            () => subtitles,
            () => 1,
            true
        );
        const previous = binder.bindSeekToSubtitle(
            onSeek,
            () => disabled,
            () => time,
            () => subtitles,
            () => 1,
            true
        );
        unbind = () => {
            current();
            previous();
        };
    });

    afterEach(() => {
        unbind();
        hotkeys.unbind();
        document.removeEventListener('keydown', siteHandler, true);
        document.body.replaceChildren();
    });

    it('handles W/S before fullscreen controls can swallow them, once per keydown', () => {
        expect(key('keydown', 'w').defaultPrevented).toBe(true);
        expect(key('keyup', 'w').defaultPrevented).toBe(true);
        key('keydown', 's');
        key('keyup', 's');
        expect(onSeek.mock.calls.map(([, subtitle]) => subtitle.text)).toEqual(['今', '前']);
    });

    it('still works when the timeline or a player button has focus', () => {
        const slider = document.createElement('input');
        slider.type = 'range';
        const button = document.createElement('button');
        document.body.append(slider, button);
        slider.focus();
        key('keydown', 'w', slider);
        key('keyup', 'w', slider);
        button.focus();
        key('keydown', 's', button);
        expect(onSeek).toHaveBeenCalledTimes(2);
    });

    it('recovers when an unrelated key release is lost during fullscreen/focus changes', () => {
        document.removeEventListener('keydown', siteHandler, true);
        key('keydown', 'f'); // Its keyup never reaches the document.
        document.dispatchEvent(new Event('fullscreenchange'));
        key('keydown', 'w');
        window.dispatchEvent(new Event('blur'));
        key('keydown', 's');
        expect(onSeek.mock.calls.map(([, subtitle]) => subtitle.text)).toEqual(['今', '前']);
    });

    it('works at the exact subtitle end instead of silently skipping that cue', () => {
        time = 4000;
        key('keydown', 'w');
        key('keyup', 'w');
        key('keydown', 's');
        expect(onSeek.mock.calls.map(([, subtitle]) => subtitle.text)).toEqual(['今', '今']);
    });

    it('leaves typing, modifiers, IME input, and disabled bindings untouched', () => {
        const host = document.createElement('div');
        const shadow = host.attachShadow({ mode: 'open' });
        const input = document.createElement('input');
        shadow.append(input);
        document.body.append(host);
        key('keydown', 'w', input);
        const editor = document.createElement('div');
        editor.contentEditable = 'true';
        editor.setAttribute('contenteditable', 'true');
        document.body.append(editor);
        key('keydown', 's', editor);
        for (const modifier of ['ctrlKey', 'altKey', 'metaKey', 'shiftKey', 'isComposing']) {
            key('keydown', 'w', document.body, { [modifier]: true });
        }
        disabled = true;
        key('keydown', 'w');
        expect(onSeek).not.toHaveBeenCalled();
    });

    it('removes direct listeners when settings or video bindings are replaced', () => {
        unbind();
        key('keydown', 'w');
        key('keydown', 's');
        expect(onSeek).not.toHaveBeenCalled();
    });
});

describe('fullscreen play/pause', () => {
    const fire = (type: string, target: EventTarget = document.body, init: KeyboardEventInit = {}) => {
        const event = new KeyboardEvent(type, {
            key: 'l',
            code: 'KeyL',
            keyCode: 76,
            bubbles: true,
            composed: true,
            cancelable: true,
            ...init,
        });
        target.dispatchEvent(event);
        return event;
    };
    let cleanup: (() => void)[];
    let toggle: jest.Mock;
    let site: jest.Mock;
    let disabled: boolean;

    beforeEach(() => {
        disabled = false;
        cleanup = [bindPriorityNavigationKeys(['l'], () => !disabled)];
        // Crunchyroll's capture listener is registered before the video binding.
        site = jest.fn((event: Event) => event.stopImmediatePropagation());
        for (const type of ['keydown', 'keypress', 'keyup']) window.addEventListener(type, site, true);
        toggle = jest.fn((event: KeyboardEvent) => {
            event.preventDefault();
            event.stopImmediatePropagation();
        });
        const binder = new DefaultKeyBinder({ togglePlay: { keys: 'L' } } as KeyBindSet);
        cleanup.push(binder.bindPlay(toggle, () => disabled, true));
    });

    afterEach(() => {
        cleanup.forEach((unbind) => unbind());
        for (const type of ['keydown', 'keypress', 'keyup']) window.removeEventListener(type, site, true);
        document.body.replaceChildren();
    });

    it('toggles once per controller press and consumes held repeats before the site', () => {
        for (let press = 0; press < 2; press++) {
            expect(fire('keydown').defaultPrevented).toBe(true);
            for (let repeat = 0; repeat < 4; repeat++) {
                expect(fire('keydown', document.body, { repeat: true }).defaultPrevented).toBe(true);
            }
            expect(fire('keypress').defaultPrevented).toBe(true);
            expect(fire('keyup').defaultPrevented).toBe(true);
        }
        expect(toggle).toHaveBeenCalledTimes(2);
        expect(site).not.toHaveBeenCalled();
    });

    it('works on a fullscreen timeline or button after a lost key release', () => {
        const slider = document.createElement('input');
        slider.type = 'range';
        const button = document.createElement('button');
        document.body.append(slider, button);
        fire('keydown', slider);
        window.dispatchEvent(new Event('blur'));
        document.dispatchEvent(new Event('fullscreenchange'));
        fire('keydown', button);
        fire('keyup', button);
        expect(toggle).toHaveBeenCalledTimes(2);
        expect(site).not.toHaveBeenCalled();
    });

    it('leaves typing, modifiers and disabled shortcuts alone', () => {
        const input = document.createElement('input');
        document.body.append(input);
        expect(fire('keydown', input).defaultPrevented).toBe(false);
        expect(fire('keydown', document.body, { metaKey: true }).defaultPrevented).toBe(false);
        disabled = true;
        expect(fire('keydown').defaultPrevented).toBe(false);
        expect(toggle).not.toHaveBeenCalled();
    });

    it('removes the listener when settings or the video binding change', () => {
        cleanup[1]();
        fire('keydown');
        expect(toggle).not.toHaveBeenCalled();
    });
});
