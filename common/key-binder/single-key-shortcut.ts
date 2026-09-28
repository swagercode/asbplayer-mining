const priorityKeydown = 'asbplayer-priority-navigation-keydown';
const priorityKeyup = 'asbplayer-priority-navigation-keyup';

type Shortcut = string | (() => string);
const aliases: Record<string, string> = {
    space: ' ',
    spacebar: ' ',
    left: 'arrowleft',
    right: 'arrowright',
    up: 'arrowup',
    down: 'arrowdown',
    esc: 'escape',
    return: 'enter',
    del: 'delete',
    plus: '+',
    minus: '-',
    comma: ',',
    period: '.',
};
type ModifierFlag = 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey';
const modifierFlags: ModifierFlag[] = ['ctrlKey', 'shiftKey', 'altKey', 'metaKey'];
const modifiers: Record<string, ModifierFlag> = {
    ctrl: 'ctrlKey',
    control: 'ctrlKey',
    '⌃': 'ctrlKey',
    shift: 'shiftKey',
    '⇧': 'shiftKey',
    alt: 'altKey',
    option: 'altKey',
    '⌥': 'altKey',
    meta: 'metaKey',
    cmd: 'metaKey',
    command: 'metaKey',
    '⌘': 'metaKey',
};
const normalizeKey = (key: string) => aliases[key.toLowerCase()] ?? key.toLowerCase();
const valueOf = (shortcut: Shortcut) => (typeof shortcut === 'function' ? shortcut() : shortcut);

function parse(shortcut: string) {
    if (!shortcut.trim()) return;
    const tokens = shortcut.toLowerCase().split('+');
    if (tokens.at(-1) === '' && tokens.at(-2) === '') tokens.splice(-2, 2, '+');
    const key = tokens.pop()!;
    if (!key || modifiers[key]) return;
    const flags: KeyboardEventInit = { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false };
    for (const token of tokens) {
        const flag = modifiers[token];
        if (!flag) return; // Legacy multi-letter chords still use hotkeys-js.
        flags[flag] = true;
    }
    return { key: normalizeKey(key), flags };
}

export const supportsPlaybackShortcut = (shortcut: string) => parse(shortcut) !== undefined;

function isPlaybackTarget(event: KeyboardEvent) {
    return (
        !event.isComposing &&
        !event.composedPath().some((target) => {
            if (!(target instanceof Element)) return false;
            // Sliders and player buttons do not disable fullscreen shortcuts.
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

export function isPlainPlaybackKey(event: KeyboardEvent) {
    return !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && isPlaybackTarget(event);
}

// Shift and Option can change event.key (Shift+1 becomes !, Option+J becomes ∆).
const codeKeys: Record<string, string> = {
    BracketLeft: '[',
    BracketRight: ']',
    Semicolon: ';',
    Quote: "'",
    Backquote: '`',
    Backslash: '\\',
    Comma: ',',
    Period: '.',
    Slash: '/',
    Minus: '-',
    Equal: '=',
};
function matches(shortcut: string, event: KeyboardEvent) {
    const expected = parse(shortcut);
    return (
        expected !== undefined &&
        (expected.key === normalizeKey(event.key) ||
            ((event.altKey || event.shiftKey) &&
                expected.key ===
                    (codeKeys[event.code] ??
                        /^(?:Key|Digit|Numpad)([A-Z0-9])$/.exec(event.code)?.[1]?.toLowerCase()))) &&
        modifierFlags.every((flag) => expected.flags[flag] === event[flag])
    );
}

const physicalKey = (event: KeyboardEvent) => {
    const letterOrNumber = /^(?:Key|Digit|Numpad)([A-Z0-9])$/.exec(event.code);
    return letterOrNumber ? letterOrNumber[1].toLowerCase() : event.code || normalizeKey(event.key);
};

/** Install synchronously at document_start; read the latest settings without moving the listener. */
export function bindPriorityNavigationKeys(keys: string[] | (() => string[]), enabled: () => boolean) {
    const claimed = new Set<string>();
    const listener = (event: KeyboardEvent) => {
        const physical = physicalKey(event);
        const finishing = claimed.has(physical) && (event.type !== 'keydown' || event.repeat);
        if (
            !finishing &&
            (!enabled() ||
                !isPlaybackTarget(event) ||
                !(typeof keys === 'function' ? keys() : keys).some((key) => matches(key, event)))
        )
            return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.type === 'keypress') return;
        if (event.type === 'keydown') claimed.add(physical);
        else claimed.delete(physical);
        document.dispatchEvent(
            new KeyboardEvent(event.type === 'keydown' ? priorityKeydown : priorityKeyup, {
                key: event.key,
                code: event.code,
                repeat: event.repeat,
                cancelable: true,
                ctrlKey: event.ctrlKey,
                altKey: event.altKey,
                shiftKey: event.shiftKey,
                metaKey: event.metaKey,
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

/** Match configured modifiers directly, without a shared pressed-key set that can get stuck. */
export function bindSingleKeyShortcut(key: Shortcut, handler: (event: KeyboardEvent) => boolean) {
    let handled: string | undefined;
    const keydown = (event: KeyboardEvent) => {
        if (!matches(valueOf(key), event) || !isPlaybackTarget(event)) return;
        if (handler(event)) handled = physicalKey(event);
    };
    const keyup = (event: KeyboardEvent) => {
        if (physicalKey(event) !== handled) return;
        handled = undefined;
        event.preventDefault();
        event.stopImmediatePropagation();
    };
    const reset = () => {
        handled = undefined;
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
