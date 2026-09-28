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
