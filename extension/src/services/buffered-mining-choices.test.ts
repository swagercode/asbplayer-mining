import { YomitanMiningReview } from './buffered-mining-review';
import { bindPriorityNavigationKeys } from '@project/common/key-binder/single-key-shortcut';

describe('fullscreen numbered mining choices', () => {
    it('shows a generated definition as text inside fullscreen without scanning a dictionary fragment', () => {
        const root = document.createElement('div');
        const video = document.createElement('video');
        root.append(video);
        document.body.append(root);
        Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => root });
        const scan = jest.spyOn(window, 'requestAnimationFrame');
        const view = new YomitanMiningReview(video);
        try {
            view.showWord('死域', 'しいき', '死の危険が及ぶ領域。\n<img src=x onerror=alert(1)>');
            const panel = root.querySelector('[data-asbplayer-mining-word]')!;
            expect(panel.textContent).toContain('死域');
            expect(panel.textContent).toContain('しいき');
            expect(panel.textContent).toContain('Luna');
            expect(panel.textContent).toContain('<img src=x onerror=alert(1)>');
            expect(panel.querySelector('img')).toBeNull();
            expect(scan).not.toHaveBeenCalled();
        } finally {
            view.close();
            scan.mockRestore();
            delete (document as any).fullscreenElement;
            root.remove();
        }
    });

    it('shows only numbers and words, outranks earlier site handlers, and swallows the whole chosen key press', () => {
        const root = document.createElement('div');
        const video = document.createElement('video');
        root.append(video);
        document.body.append(root);
        Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => root });
        const unbind = bindPriorityNavigationKeys(
            ['1', '2', '3', '4', '5', '6', '7', '8', '9'],
            () => document.querySelector('[data-asbplayer-mining-review]:not([data-asbplayer-mining-word])') !== null
        );
        const site = jest.fn((e: Event) => e.stopImmediatePropagation());
        for (const type of ['keydown', 'keypress', 'keyup']) window.addEventListener(type, site, true);
        const view = new YomitanMiningReview(video);
        const pick = jest.fn(() => {
            // The real callback immediately opens the selected word.
            root.querySelector<HTMLElement>('[data-asbplayer-mining-review]')!.dataset.asbplayerMiningWord = '';
        });
        const fire = (type: string, key: string, init: KeyboardEventInit = {}) => {
            const event = new KeyboardEvent(type, { key, bubbles: true, cancelable: true, ...init });
            document.activeElement!.dispatchEvent(event);
            return event;
        };
        const options = [
            { index: 7, word: '労力', reading: 'ろうりょく', confidence: 0.8 },
            { index: 2, word: '成果', reading: 'せいか', confidence: 0.15 },
        ];
        try {
            expect(fire('keydown', '1').defaultPrevented).toBe(true);
            fire('keyup', '1');
            expect(pick).not.toHaveBeenCalled();
            view.showChoices(options, pick);
            const panel = root.querySelector('[data-asbplayer-mining-choices]')!;
            expect(panel.textContent).toBe('1労力2成果');
            expect(fire('keydown', '9').defaultPrevented).toBe(true);
            fire('keyup', '9');
            expect(pick).not.toHaveBeenCalled();
            expect(fire('keydown', '2', { repeat: true }).defaultPrevented).toBe(true);
            fire('keyup', '2');
            expect(pick).not.toHaveBeenCalled();
            expect(fire('keydown', '2', { code: 'Numpad2' }).defaultPrevented).toBe(true);
            expect(pick).toHaveBeenCalledWith(options[1]);
            // Opening Yomitan can move focus after the choice overlay disappeared.
            window.dispatchEvent(new Event('blur'));
            expect(fire('keypress', '2').defaultPrevented).toBe(true);
            expect(fire('keydown', '2', { repeat: true }).defaultPrevented).toBe(true);
            expect(fire('keyup', '2').defaultPrevented).toBe(true);
            expect(pick).toHaveBeenCalledTimes(1);
            expect(site).not.toHaveBeenCalled();
            expect(fire('keydown', '2').defaultPrevented).toBe(false);
            expect(site).toHaveBeenCalledTimes(1);
        } finally {
            view.close();
            unbind();
            for (const type of ['keydown', 'keypress', 'keyup']) window.removeEventListener(type, site, true);
            delete (document as any).fullscreenElement;
            root.remove();
        }
    });
});
