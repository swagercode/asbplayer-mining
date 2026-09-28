import { bindPriorityNavigationKeys } from '@project/common/key-binder/single-key-shortcut';
import { bindBufferedMiningShortcut } from '@project/extension/src/services/buffered-mining-shortcut';

describe('buffered mining shortcut', () => {
    let mine: jest.Mock;
    let unbind: () => void;
    const key = (type: string, value: string, options: KeyboardEventInit = {}, target: EventTarget = document.body) => {
        const event = new KeyboardEvent(type, { key: value, bubbles: true, cancelable: true, ...options });
        target.dispatchEvent(event);
        return event;
    };
    beforeEach(() => {
        mine = jest.fn();
        unbind = bindBufferedMiningShortcut(mine);
    });
    afterEach(() => {
        unbind();
        document.body.replaceChildren();
    });

    it('mines once per N press and leaves M to the player', () => {
        expect(key('keydown', 'm').defaultPrevented).toBe(false);
        expect(key('keydown', 'n').defaultPrevented).toBe(true);
        key('keydown', 'n', { repeat: true });
        expect(mine).toHaveBeenCalledTimes(1);
        expect(key('keyup', 'n').defaultPrevented).toBe(true);
        key('keydown', 'n');
        expect(mine).toHaveBeenCalledTimes(2);
    });

    it('does not mine while typing, composing or using modified shortcuts', () => {
        for (const tag of ['input', 'textarea', 'select']) {
            const field = document.createElement(tag);
            document.body.append(field);
            expect(key('keydown', 'n', {}, field).defaultPrevented).toBe(false);
        }
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        const child = document.createElement('span');
        editor.append(child);
        document.body.append(editor);
        expect(key('keydown', 'n', {}, child).defaultPrevented).toBe(false);
        for (const option of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey', 'isComposing']) {
            expect(key('keydown', 'n', { [option]: true }).defaultPrevented).toBe(false);
        }
        expect(mine).not.toHaveBeenCalled();
    });

    it('mines when the fullscreen player timeline has focus', () => {
        const timeline = document.createElement('input');
        timeline.type = 'range';
        document.body.append(timeline);
        timeline.focus();
        expect(key('keydown', 'n', {}, timeline).defaultPrevented).toBe(true);
        expect(key('keyup', 'n', {}, timeline).defaultPrevented).toBe(true);
        expect(mine).toHaveBeenCalledTimes(1);
    });

    it('only claims N while enabled and removes handlers on cleanup', () => {
        unbind();
        let enabled = false;
        unbind = bindBufferedMiningShortcut(mine, () => enabled);
        expect(key('keydown', 'n').defaultPrevented).toBe(false);
        enabled = true;
        key('keydown', 'n');
        window.dispatchEvent(new Event('blur'));
        key('keydown', 'n');
        expect(mine).toHaveBeenCalledTimes(2);
        unbind();
        expect(key('keydown', 'n').defaultPrevented).toBe(false);
        expect(mine).toHaveBeenCalledTimes(2);
    });
    it.each(['b', 'v'] as const)(
        '%s has priority for the whole physical press, including after review closes',
        (shortcut) => {
            unbind();
            let active = true;
            const site = jest.fn();
            const priority = bindPriorityNavigationKeys([shortcut], () => active);
            unbind = bindBufferedMiningShortcut(
                () => {
                    mine();
                    active = false;
                },
                () => active,
                shortcut
            );
            window.addEventListener('keydown', site, true);
            window.addEventListener('keyup', site, true);
            try {
                expect(key('keydown', shortcut).defaultPrevented).toBe(true);
                expect(key('keydown', shortcut, { repeat: true }).defaultPrevented).toBe(true);
                expect(key('keypress', shortcut).defaultPrevented).toBe(true);
                expect(key('keyup', shortcut).defaultPrevented).toBe(true);
                expect(site).not.toHaveBeenCalled();
                expect(mine).toHaveBeenCalledTimes(1);
                expect(key('keydown', shortcut).defaultPrevented).toBe(false);
                expect(site).toHaveBeenCalledTimes(1);
            } finally {
                priority();
                window.removeEventListener('keydown', site, true);
                window.removeEventListener('keyup', site, true);
            }
        }
    );
});
