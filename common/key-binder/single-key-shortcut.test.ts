import { bindPriorityNavigationKeys, bindSingleKeyShortcut } from '@project/common/key-binder/single-key-shortcut';

describe('document-start priority navigation', () => {
    const fire = (type: string, key: string, target: EventTarget = document.body, init: KeyboardEventInit = {}) => {
        const event = new KeyboardEvent(type, { key, bubbles: true, cancelable: true, composed: true, ...init });
        target.dispatchEvent(event);
        return event;
    };
    let cleanup: (() => void)[];
    let site: jest.Mock;
    let seek: jest.Mock;

    beforeEach(() => {
        cleanup = [bindPriorityNavigationKeys(['w', 's'], () => true)];
        // The page installs its window capture listeners before the late video binding.
        site = jest.fn((event: Event) => event.stopImmediatePropagation());
        for (const type of ['keydown', 'keypress', 'keyup']) window.addEventListener(type, site, true);
        seek = jest.fn((event: KeyboardEvent) => {
            event.preventDefault();
            event.stopImmediatePropagation();
            return true;
        });
    });

    afterEach(() => {
        cleanup.forEach((unbind) => unbind());
        for (const type of ['keydown', 'keypress', 'keyup']) window.removeEventListener(type, site, true);
        document.body.replaceChildren();
    });

    it('gives each W/S press exclusively to the late asbplayer binding, including keyup and keypress', () => {
        cleanup.push(bindSingleKeyShortcut('w', seek), bindSingleKeyShortcut('s', seek));
        for (const key of ['w', 's', 'w']) {
            for (const type of ['keydown', 'keypress', 'keyup']) expect(fire(type, key).defaultPrevented).toBe(true);
        }
        expect(seek.mock.calls.map(([event]) => event.key)).toEqual(['w', 's', 'w']);
        expect(site).not.toHaveBeenCalled();
    });

    it('reserves the keys while subtitles are loading instead of falling through to the site', () => {
        expect(fire('keydown', 'w').defaultPrevented).toBe(true);
        expect(fire('keyup', 'w').defaultPrevented).toBe(true);
        expect(site).not.toHaveBeenCalled();
        cleanup.push(bindSingleKeyShortcut('w', seek));
        fire('keydown', 'w');
        expect(seek).toHaveBeenCalledTimes(1);
    });

    it('does not block text input, browser shortcuts, or unrelated keys', () => {
        cleanup.push(bindSingleKeyShortcut('w', seek));
        const input = document.createElement('input');
        document.body.append(input);
        expect(fire('keydown', 'w', input).defaultPrevented).toBe(false);
        expect(fire('keydown', 'w', document.body, { metaKey: true }).defaultPrevented).toBe(false);
        expect(fire('keydown', 'm').defaultPrevented).toBe(false);
        expect(seek).not.toHaveBeenCalled();
        expect(site).toHaveBeenCalledTimes(3);
    });

    it('handles a timeline slider and does not depend on receiving previous releases', () => {
        cleanup.push(bindSingleKeyShortcut('w', seek), bindSingleKeyShortcut('s', seek));
        const slider = document.createElement('input');
        slider.type = 'range';
        document.body.append(slider);
        fire('keydown', 'w', slider);
        window.dispatchEvent(new Event('blur'));
        document.dispatchEvent(new Event('fullscreenchange'));
        fire('keydown', 's', slider);
        fire('keydown', 'w', slider);
        expect(seek).toHaveBeenCalledTimes(3);
        expect(site).not.toHaveBeenCalled();
    });
});

describe('configurable priority shortcuts', () => {
    it('accepts keyboard and controller alternatives, including overlapping held presses and live edits', () => {
        let shortcuts = ['N', 'H'];
        const priority = bindPriorityNavigationKeys(
            () => shortcuts,
            () => true
        );
        const site = jest.fn();
        window.addEventListener('keydown', site, true);
        const action = jest.fn((event: KeyboardEvent) => {
            event.preventDefault();
            event.stopImmediatePropagation();
            return true;
        });
        const unbind = bindSingleKeyShortcut(() => shortcuts, action);
        const fire = (type: string, key: string, target: EventTarget = document.body) => {
            const event = new KeyboardEvent(type, { key, bubbles: true, cancelable: true });
            target.dispatchEvent(event);
            return event.defaultPrevented;
        };
        try {
            expect(fire('keydown', 'n')).toBe(true);
            expect(fire('keydown', 'h')).toBe(true);
            expect(fire('keyup', 'n')).toBe(true);
            expect(fire('keyup', 'h')).toBe(true);
            expect(action).toHaveBeenCalledTimes(2);
            expect(site).not.toHaveBeenCalled();
            const input = document.createElement('input');
            document.body.append(input);
            expect(fire('keydown', 'h', input)).toBe(false);
            input.remove();
            shortcuts = ['N', 'G'];
            expect(fire('keydown', 'h')).toBe(false);
            expect(fire('keydown', 'g')).toBe(true);
            expect(action).toHaveBeenCalledTimes(3);
        } finally {
            priority();
            unbind();
            window.removeEventListener('keydown', site, true);
        }
    });

    it('remaps in place ahead of site listeners and preserves modifiers and full physical presses', () => {
        let shortcut = 'ctrl+shift+j';
        let enabled = true;
        const priority = bindPriorityNavigationKeys(
            () => [shortcut],
            () => enabled
        );
        const site = jest.fn();
        window.addEventListener('keydown', site, true);
        window.addEventListener('keyup', site, true);
        const action = jest.fn((event: KeyboardEvent) => {
            event.preventDefault();
            event.stopImmediatePropagation();
            enabled = false;
            return true;
        });
        const unbind = bindSingleKeyShortcut(() => shortcut, action);
        const press = (type: string, key: string, init: KeyboardEventInit = {}) => {
            const event = new KeyboardEvent(type, { key, bubbles: true, cancelable: true, ...init });
            document.body.dispatchEvent(event);
            return event;
        };
        try {
            expect(press('keydown', 'j').defaultPrevented).toBe(false);
            site.mockClear();
            expect(press('keydown', 'J', { ctrlKey: true, shiftKey: true, code: 'KeyJ' }).defaultPrevented).toBe(true);
            expect(action).toHaveBeenCalledTimes(1);
            expect(action.mock.calls[0][0].ctrlKey).toBe(true);
            expect(action.mock.calls[0][0].shiftKey).toBe(true);
            // Modifier released first, settings changed and the overlay disappeared.
            shortcut = '⌥+left';
            expect(press('keyup', 'j', { code: 'KeyJ' }).defaultPrevented).toBe(true);
            expect(site).not.toHaveBeenCalled();
            enabled = true;
            expect(press('keydown', 'j', { ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(false);
            expect(press('keydown', 'ArrowLeft', { altKey: true }).defaultPrevented).toBe(true);
            expect(action).toHaveBeenCalledTimes(2);
            shortcut = '';
            enabled = true;
            expect(press('keydown', 'ArrowLeft', { altKey: true }).defaultPrevented).toBe(false);
        } finally {
            priority();
            unbind();
            window.removeEventListener('keydown', site, true);
            window.removeEventListener('keyup', site, true);
        }
    });
});

it.each([
    ['shift+1', '!', 'Digit1', { shiftKey: true }],
    ['⌥+J', '∆', 'KeyJ', { altKey: true }],
    ['shift+[', '{', 'BracketLeft', { shiftKey: true }],
])('matches %s even when the modifier changes the typed character', (shortcut, key, code, modifiers) => {
    const action = jest.fn(() => true);
    const unbind = bindSingleKeyShortcut(shortcut, action);
    try {
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key, code, ...modifiers, bubbles: true }));
        expect(action).toHaveBeenCalledTimes(1);
    } finally {
        unbind();
    }
});
