import type { ImageCaptureParams } from '@project/common';
import { captureVisibleTab } from './capture-visible-tab';

export const maxMiningScreenshotLength = 2_000_000;

/** Use Chrome's existing tab capture and asbplayer's iframe-aware crop path. */
export async function captureMiningScreenshot(tabId: number, src: string, params: ImageCaptureParams) {
    if (
        typeof src !== 'string' ||
        !params?.rect ||
        ![params.rect.left, params.rect.top, params.rect.width, params.rect.height].every(Number.isFinite) ||
        params.rect.width <= 0 ||
        params.rect.width > 16384 ||
        params.rect.height <= 0 ||
        params.rect.height > 16384 ||
        Math.abs(params.rect.left) > 32768 ||
        Math.abs(params.rect.top) > 32768
    )
        throw new Error('Invalid screenshot bounds.');
    const before = await browser.tabs.get(tabId);
    if (!before.active) throw new Error('The episode tab is not visible.');
    const dataUrl = await captureVisibleTab(tabId);
    const after = await browser.tabs.get(tabId);
    if (!after.active || after.windowId !== before.windowId || after.url !== before.url) {
        throw new Error('The episode tab changed during capture.');
    }
    const response = await browser.tabs.sendMessage(tabId, {
        sender: 'asbplayer-extension-to-video',
        src,
        message: {
            command: 'crop-and-resize',
            dataUrl,
            rect: params.rect,
            frameId: params.frameId,
            maxWidth: params.maxWidth > 0 ? Math.min(params.maxWidth, 1280) : 1280,
            maxHeight: params.maxHeight > 0 ? Math.min(params.maxHeight, 720) : 720,
        },
    });
    if (typeof response?.dataUrl !== 'string' || !response.dataUrl.startsWith('data:image/jpeg;base64,')) {
        throw new Error('Chrome did not return a JPEG screenshot.');
    }
    const screenshot = response.dataUrl.slice('data:image/jpeg;base64,'.length);
    if (!screenshot || screenshot.length > maxMiningScreenshotLength) throw new Error('Screenshot is too large.');
    return screenshot;
}

/** Clean only the initial capture; ready choices must never wait for a picture. */
export async function cleanMiningScreenshot(capture: () => Promise<string | undefined>) {
    if (document.visibilityState !== 'visible') return;
    const style = document.createElement('style');
    style.textContent = `
        html body [data-asbplayer-mining-review]:not([data-asbplayer-mining-choices]):not([data-asbplayer-mining-word]),
        html body .asbplayer-subtitles-container-top, html body .asbplayer-subtitles-container-bottom,
        html body .asbplayer-notification-container-top, html body .asbplayer-notification-container-bottom,
        html body [data-testid="top-controls-autohide"], html body [data-testid="bottom-controls-autohide"],
        html body [data-testid="top-gradient-background"], html body [data-testid="menu-background"] {
            visibility: hidden !important; opacity: 0 !important; transition: none !important;
        }`;
    document.documentElement.append(style);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let frame: number | undefined;
    let expired = false;
    try {
        const screenshot = await Promise.race([
            new Promise<string | undefined>((resolve) => {
                frame = requestAnimationFrame(() => {
                    void capture().then(resolve, () => resolve(undefined));
                });
            }),
            new Promise<undefined>((resolve) => {
                timer = setTimeout(() => {
                    expired = true;
                    resolve(undefined);
                }, 750);
            }),
        ]);
        // If the dictionary UI won the race, never save a picture of its popup.
        if (
            expired ||
            document.visibilityState !== 'visible' ||
            document.querySelector('[data-asbplayer-mining-choices], [data-asbplayer-mining-word]')
        )
            return;
        return screenshot;
    } finally {
        clearTimeout(timer);
        if (frame !== undefined) cancelAnimationFrame(frame);
        style.remove();
    }
}
