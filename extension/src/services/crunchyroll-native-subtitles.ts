const languageButtonSelector = 'button[aria-label="Audio and subtitle language options"]';
const noneOptionSelector = '[role="menuitemradio"][aria-label="None"]';

// Select the player's actual subtitle preference so it persists across episodes.
// The menu's position and generated CSS classes change with the available languages.
export const disableCrunchyrollNativeSubtitles = async (isCurrent: () => boolean): Promise<boolean> => {
    const waitFor = async <T>(read: () => T | undefined): Promise<T | undefined> => {
        const deadline = Date.now() + 5000;
        while (isCurrent() && Date.now() < deadline) {
            const result = read();
            if (result !== undefined) return result;
            await new Promise<void>((resolve) => setTimeout(resolve, 100));
        }
        return undefined;
    };
    const noneOption = () => document.querySelector<HTMLElement>(noneOptionSelector) ?? undefined;
    let openedButton: HTMLButtonElement | undefined;

    try {
        const button = await waitFor(() => {
            const candidate = document.querySelector<HTMLButtonElement>(languageButtonSelector);
            return candidate && !candidate.disabled && candidate.getAttribute('aria-disabled') !== 'true'
                ? candidate
                : undefined;
        });
        if (!button || !isCurrent()) return false;

        if (!noneOption()) {
            openedButton = button;
            button.click();
        }

        const option = await waitFor(() => {
            const candidate = noneOption();
            return candidate?.getAttribute('aria-disabled') !== 'true' ? candidate : undefined;
        });
        if (!option || !isCurrent()) return false;
        if (option.getAttribute('aria-checked') !== 'true') option.click();

        return (
            (await waitFor(() => (noneOption()?.getAttribute('aria-checked') === 'true' ? true : undefined))) === true
        );
    } finally {
        // Only close a menu we opened, and never toggle a newer episode's menu.
        if (isCurrent() && openedButton?.isConnected && noneOption()) openedButton.click();
    }
};
