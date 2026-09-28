import { defaultSettings } from '@project/common/settings';
import { observeKeyBindSet } from './key-bind-settings';
import { bindBufferedMiningShortcut } from '@project/extension/src/services/buffered-mining-shortcut';

/** Small controls in the secondary viewer only; never draws over the episode. */
export function bindBufferedMiningViewer() {
    if (window !== window.top) return;
    const mount = () => {
        const host = document.createElement('div');
        host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;';
        const shadow = host.attachShadow({ mode: 'closed' });
        const style = document.createElement('style');
        style.textContent =
            'div{font:13px system-ui;color:#eee;background:#252525;padding:10px;border-radius:8px;max-width:340px}' +
            'button{cursor:pointer;color:white;background:#874477;border:0;border-radius:5px;padding:8px;margin:3px}' +
            'p{margin:4px;overflow-wrap:anywhere}details{max-height:250px;overflow:auto}';
        const panel = document.createElement('div');
        const mine = document.createElement('button');
        mine.textContent = 'Mine with Jev';
        let keys = defaultSettings.keyBindSet;
        const stopSettings = observeKeyBindSet((updated) => {
            keys = updated;
            mine.title =
                [keys.bufferedMiningNormal.keys, keys.bufferedMiningAudio.keys].filter(Boolean).join(' / ') +
                ' · current subtitle, or the previous subtitle during a gap';
        });
        const status = document.createElement('p');
        const details = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = 'Mining queue';
        const jobs = document.createElement('section');
        details.append(summary, jobs);
        panel.append(mine, status, details);
        shadow.append(style, panel);
        document.body.append(host);
        const send = (action: string, payload: object = {}) =>
            browser.runtime.sendMessage({ sender: 'asbplayer-buffered-mining', action, ...payload });
        const queueCard = (cardType: 'normal' | 'audio' = 'normal') => {
            void send('mine', { cardType }).then(
                (result) =>
                    (status.textContent =
                        result?.error ?? (result?.reviewClosed ? 'Resuming playback' : 'Queued for review')),
                () => (status.textContent = 'Reload this viewer to reconnect the extension.')
            );
        };
        mine.onclick = () => queueCard();
        let enabled = false;
        const unbindShortcut = bindBufferedMiningShortcut(
            queueCard,
            () => enabled,
            () => keys.bufferedMiningNormal.keys
        );
        const unbindAudioShortcut = bindBufferedMiningShortcut(
            () => queueCard('audio'),
            () => enabled,
            () => keys.bufferedMiningAudio.keys
        );
        const refresh = async () => {
            try {
                const result = await send('status');
                enabled = result.enabled === true;
                if (result.error) {
                    status.textContent = result.error;
                    return;
                }
                if (!result.enabled) {
                    status.textContent = 'Finish the OBS bridge setup to enable buffered mining.';
                    return;
                }
                status.textContent =
                    result.obsError ||
                    `${result.pending} queued · ${result.completed} saved${result.errorCount ? ` · ${result.errorCount} need attention` : ''}`;
                jobs.replaceChildren();
                for (const job of result.jobs ?? []) {
                    const row = document.createElement('p');
                    row.textContent = `${job.word || job.sentence} — ${job.error || job.state}`;
                    if (job.state === 'failed' && job.hasMedia) {
                        const retry = document.createElement('button');
                        retry.textContent = 'Retry';
                        retry.onclick = () => void send('retry', { id: job.id }).then(refresh);
                        row.append(retry);
                    }
                    jobs.append(row);
                }
            } catch {
                status.textContent = 'Reload this viewer to reconnect the extension.';
            }
        };
        void refresh();
        const timer = setInterval(() => void refresh(), 3000);
        window.addEventListener(
            'pagehide',
            () => {
                clearInterval(timer);
                stopSettings();
                unbindShortcut();
                unbindAudioShortcut();
            },
            { once: true }
        );
    };
    if (document.body) mount();
    else document.addEventListener('DOMContentLoaded', mount, { once: true });
}
