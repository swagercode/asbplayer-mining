const priorityKeydown = 'asbplayer-priority-navigation-keydown';
const priorityKeyup = 'asbplayer-priority-navigation-keyup';

export function isPlainPlaybackKey(event: KeyboardEvent) {
    return !(
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.shiftKey ||
        event.isComposing ||
        event.composedPath().some((target) => {
            if (!(target instanceof Element)) return false;
            // Player sliders/buttons must not disable navigation. Keep text entry and
            // selection controls (including those in shadow DOM) untouched.
            if (target instanceof HTMLInputElement) {
                return !['range', 'button', 'submit', 'reset', 'checkbox', 'radio'].includes(target.type);
            }
            return (
                target.matches('textarea, select, [role="textbox"]') ||
                (target instanceof HTMLElement && target.isContentEditable) ||
                target.matches('[contenteditable]:not([contenteditable="false"])')
            );
        })
    );
}

/** Install at document_start, before a streaming site's own window capture listeners. */
export function bindPriorityNavigationKeys(keys: string[], enabled: () => boolean) {
    const reserved = new Set(keys.map((key) => key.toLowerCase()));
    const claimed = new Set<string>();
    const listener = (event: KeyboardEvent) => {
        const key = event.key.toLowerCase();
        if (!reserved.has(key)) return;
        // A choice can disappear on keydown. Swallow its remaining physical key
        // events too, so a held number cannot become a player percentage seek.
        if (!enabled() && !(claimed.has(key) && (event.type !== 'keydown' || event.repeat))) return;
        if (!(event.type === 'keyup' && claimed.has(key)) && !isPlainPlaybackKey(event)) return;
        // These keys belong exclusively to asbplayer on the player page, even while
        // subtitles/bindings are loading. Do not pass them to Crunchyroll as a fallback.
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.type === 'keypress') return;
        if (event.type === 'keydown') claimed.add(key);
        else claimed.delete(key);
        document.dispatchEvent(
            new KeyboardEvent(event.type === 'keydown' ? priorityKeydown : priorityKeyup, {
                key,
                code: event.code,
                repeat: event.repeat,
                cancelable: true,
            })
        );
    };
    for (const type of ['keydown', 'keypress', 'keyup']) window.addEventListener(type, listener as EventListener, true);
    return () => {
        for (const type of ['keydown', 'keypress', 'keyup'])
            window.removeEventListener(type, listener as EventListener, true);
        claimed.clear();
    };
}

/** Handle a plain playback key before the site's controls, without a global pressed-key set. */
export function bindSingleKeyShortcut(key: string, handler: (event: KeyboardEvent) => boolean) {
    const expected = key.toLowerCase();
    let handled = false;
    const keydown = (event: KeyboardEvent) => {
        if (event.key.toLowerCase() !== expected) return;
        if (!isPlainPlaybackKey(event)) {
            handled = false;
            return;
        }
        handled = handler(event);
    };
    const keyup = (event: KeyboardEvent) => {
        if (event.key.toLowerCase() !== expected || !handled) return;
        handled = false;
        event.preventDefault();
        event.stopImmediatePropagation();
    };
    const reset = () => {
        handled = false;
    };
    window.addEventListener('keydown', keydown, true);
    window.addEventListener('keyup', keyup, true);
    document.addEventListener(priorityKeydown, keydown as EventListener);
    document.addEventListener(priorityKeyup, keyup as EventListener);
    window.addEventListener('blur', reset);
    document.addEventListener('fullscreenchange', reset);
    return () => {
        window.removeEventListener('keydown', keydown, true);
        window.removeEventListener('keyup', keyup, true);
        document.removeEventListener(priorityKeydown, keydown as EventListener);
        document.removeEventListener(priorityKeyup, keyup as EventListener);
        window.removeEventListener('blur', reset);
        document.removeEventListener('fullscreenchange', reset);
    };
}
