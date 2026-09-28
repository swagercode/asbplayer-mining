import { isSentenceExplanationContext } from './sentence-explanation-context';
import { captureMiningScreenshot, maxMiningScreenshotLength } from './buffered-mining-screenshot';
import type TabRegistry from '@project/extension/src/services/tab-registry';

const hostName = 'com.asbplayer.mining';

export function bindBufferedMiningHost(registry: TabRegistry) {
    let port: Browser.runtime.Port | undefined;
    let sequence = 0;
    const pending = new Map<number, { resolve: (value: any) => void; timer: ReturnType<typeof setTimeout> }>();

    const native = (message: object) =>
        new Promise<any>((resolve) => {
            try {
                if (!port) {
                    port = browser.runtime.connectNative(hostName);
                    port.onMessage.addListener(({ requestId, ...response }) => {
                        const call = pending.get(requestId);
                        if (!call) return;
                        clearTimeout(call.timer);
                        pending.delete(requestId);
                        call.resolve(response);
                    });
                    port.onDisconnect.addListener(() => {
                        void browser.runtime.lastError;
                        port = undefined;
                        for (const call of pending.values()) {
                            clearTimeout(call.timer);
                            call.resolve({ error: 'The buffered mining bridge is unavailable. Run its installer.' });
                        }
                        pending.clear();
                    });
                }
                const requestId = ++sequence;
                const timer = setTimeout(() => {
                    pending.delete(requestId);
                    resolve({ error: 'The buffered mining bridge did not respond.' });
                }, 10000);
                pending.set(requestId, { resolve, timer });
                port.postMessage({ ...message, requestId });
            } catch (error) {
                resolve({ error: String(error) });
            }
        });

    const mine = async (tabId?: number, cardType: 'normal' | 'audio' = 'normal') => {
        const videos = (await registry.activeVideoElements()).filter((v) => v.synced && v.loadedSubtitles);
        const video =
            videos.find((v) => v.id === tabId) ??
            videos.sort((a, b) => (b.syncedTimestamp ?? 0) - (a.syncedTimestamp ?? 0))[0];
        if (!video) return { error: 'Open an episode with subtitles first.' };
        return browser.tabs.sendMessage(video.id, {
            sender: 'asbplayer-extension-to-video',
            src: video.src,
            message: { command: 'mine-buffered-card', cardType },
        });
    };

    browser.runtime.onMessage.addListener((request, sender, respond) => {
        if (request?.sender !== 'asbplayer-buffered-mining' || sender.id !== browser.runtime.id) return;
        const ownUi = sender.url?.startsWith(browser.runtime.getURL('/'));
        const viewer = /^https:\/\/app\.asbplayer\.dev\//.test(sender.url ?? '');
        const content = sender.tab?.id !== undefined && /^https?:\/\//.test(sender.url ?? '');
        if (!ownUi && !content) return;
        let response: Promise<any>;
        if (request.action === 'mine' && (ownUi || viewer)) {
            response = mine(sender.tab?.id, request.cardType === 'audio' ? 'audio' : 'normal');
        } else if (
            ['explain', 'explanation-status'].includes(request.action) &&
            content &&
            !viewer &&
            typeof request.id === 'string' &&
            /^[a-f0-9-]{36}$/.test(request.id)
        ) {
            if (
                request.action === 'explain' &&
                (typeof request.sentence !== 'string' || !request.sentence.trim() || request.sentence.length > 5000)
            )
                return;
            const context = request.context ?? { before: [], after: [] };
            response = isSentenceExplanationContext(context)
                ? native({
                      action: request.action,
                      id: request.id,
                      sentence: request.sentence,
                      context: { before: context.before, after: context.after },
                  })
                : Promise.resolve({ error: 'Invalid surrounding subtitles.' });
        } else if (request.action === 'capture-screenshot' && content && !viewer) {
            response = captureMiningScreenshot(sender.tab!.id!, request.src, request.params).then((screenshot) => ({
                screenshot,
            }));
        } else if (request.action === 'status' && (ownUi || viewer)) {
            response = native({ action: 'status' });
        } else if (
            ['job-status', 'choose', 'cancel-choice', 'confirm-choice'].includes(request.action) &&
            content &&
            !viewer &&
            typeof request.id === 'string' &&
            /^[a-f0-9-]{36}$/.test(request.id)
        ) {
            if (
                request.action === 'choose' &&
                (!Number.isInteger(request.index) || request.index < 0 || request.index >= 300)
            )
                return;
            response = native({
                action: request.action,
                id: request.id,
                index: request.index,
                cardType: request.cardType === 'audio' ? 'audio' : 'normal',
                ...(request.action === 'confirm-choice' &&
                typeof request.screenshot === 'string' &&
                request.screenshot.length <= maxMiningScreenshotLength
                    ? { screenshot: request.screenshot }
                    : {}),
            });
        } else if ((request.action === 'observe' || request.action === 'enqueue') && content && !viewer) {
            response = (async () => {
                const sample = request.action === 'enqueue' ? request.job?.sample : request.sample;
                // Explicitly copy the allowed payload; no arbitrary native filesystem/OBS operations.
                return native(
                    request.action === 'observe'
                        ? { action: 'observe', sample }
                        : {
                              action: 'enqueue',
                              job: { ...request.job, sample, title: sender.tab?.title, url: sender.tab?.url },
                          }
                );
            })();
        } else if (request.action === 'retry' && (ownUi || viewer)) {
            response = native({ action: 'retry', id: request.id });
        } else return;
        void response.then(respond, (error) => respond({ error: String(error) }));
        return true;
    });
}
