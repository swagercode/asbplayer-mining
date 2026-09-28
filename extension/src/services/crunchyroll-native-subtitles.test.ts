import { disableCrunchyrollNativeSubtitles } from '@project/extension/src/services/crunchyroll-native-subtitles';

describe('Crunchyroll native subtitle preference', () => {
    let current: boolean;
    let languageButton: HTMLButtonElement;
    let menu: HTMLDivElement;
    let none: HTMLDivElement;
    let noneClick: jest.Mock;
    let audioClick: jest.Mock;
    let selected: string;

    beforeEach(() => {
        jest.useFakeTimers();
        current = true;
        selected = 'English';
        document.body.innerHTML = '<button aria-label="Audio and subtitle language options"></button>';
        languageButton = document.querySelector('button')!;
        menu = document.createElement('div');
        menu.setAttribute('role', 'menu');
        menu.innerHTML = `
            <div role="menuitemradio" aria-label="Japanese" aria-checked="true">Japanese audio</div>
            <div role="menuitemradio" aria-label="English" aria-checked="true">English subtitles</div>
            <div role="menuitemradio" aria-label="None" aria-checked="false" aria-disabled="false">None</div>`;
        none = menu.querySelector('[aria-label="None"]')!;
        noneClick = jest.fn(() => {
            selected = 'None';
            none.setAttribute('aria-checked', 'true');
            menu.querySelector('[aria-label="English"]')!.setAttribute('aria-checked', 'false');
        });
        audioClick = jest.fn();
        none.addEventListener('click', noneClick);
        menu.querySelector('[aria-label="Japanese"]')!.addEventListener('click', audioClick);
        languageButton.addEventListener('click', () => {
            if (menu.isConnected) menu.remove();
            else document.body.append(menu);
        });
    });

    afterEach(() => {
        document.body.replaceChildren();
        jest.useRealTimers();
    });

    it('changes English to None without changing audio and closes its menu', async () => {
        expect(await disableCrunchyrollNativeSubtitles(() => current)).toBe(true);
        expect(selected).toBe('None');
        expect(noneClick).toHaveBeenCalledTimes(1);
        expect(audioClick).not.toHaveBeenCalled();
        expect(menu.isConnected).toBe(false);
    });

    it('leaves an already open menu open and does not toggle an already selected None', async () => {
        none.setAttribute('aria-checked', 'true');
        document.body.append(menu);
        expect(await disableCrunchyrollNativeSubtitles(() => current)).toBe(true);
        expect(noneClick).not.toHaveBeenCalled();
        expect(menu.isConnected).toBe(true);
    });

    it('waits for the player controls and subtitle options to become ready', async () => {
        languageButton.remove();
        none.setAttribute('aria-disabled', 'true');
        const operation = disableCrunchyrollNativeSubtitles(() => current);
        await jest.advanceTimersByTimeAsync(500);
        document.body.append(languageButton);
        await jest.advanceTimersByTimeAsync(500);
        expect(noneClick).not.toHaveBeenCalled();
        none.setAttribute('aria-disabled', 'false');
        await jest.advanceTimersByTimeAsync(100);
        expect(await operation).toBe(true);
        expect(selected).toBe('None');
    });

    it('stops without clicking after navigation while controls are loading', async () => {
        languageButton.remove();
        const operation = disableCrunchyrollNativeSubtitles(() => current);
        await jest.advanceTimersByTimeAsync(200);
        current = false;
        document.body.append(languageButton);
        await jest.advanceTimersByTimeAsync(100);
        expect(await operation).toBe(false);
        expect(noneClick).not.toHaveBeenCalled();
        expect(menu.isConnected).toBe(false);
    });

    it('finishes with failure if the player cannot confirm None', async () => {
        none.removeEventListener('click', noneClick);
        const operation = disableCrunchyrollNativeSubtitles(() => current);
        await jest.advanceTimersByTimeAsync(5100);
        expect(await operation).toBe(false);
        expect(menu.isConnected).toBe(false);
    });
});
