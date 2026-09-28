import { JimakuClient } from '@project/common/subtitle-sources';
import {
    JimakuAutoSelectError,
    JimakuAutoSelector,
    episodeInfoFromTitleHint,
} from '@project/common/subtitle-sources/jimaku-auto-select';
import type { JimakuAutoSelectResult, JimakuEpisodeInfo } from '@project/common/subtitle-sources/jimaku-auto-select';
import { completeSubtitleSelection } from '@/services/chatgpt-subtitle-client';
import { asbLog } from '@project/common/util';
import { fetchSubtitleEndSeconds } from '@project/common/subtitle-sources/subtitle-timing';
import type { CrunchyrollEpisodeMetadata } from '@/pages/crunchyroll-util';
import {
    crunchyrollEpisodeInfoRequestEvent,
    crunchyrollEpisodeInfoResponseEvent,
    crunchyrollWatchIdFromPath,
} from '@/pages/crunchyroll-util';

export interface JimakuAutoSelectRequest {
    // Page title-derived name reported by the page script; used as a fallback when structured metadata is unavailable
    basename: string;
    jimakuApiKey: string;
    durationSeconds?: number;
}

const episodeInfoResponseTimeoutMs = 5000;
const maxCachedResults = 20;

const requestEpisodeInfoFromPage = (): Promise<CrunchyrollEpisodeMetadata | undefined> => {
    return new Promise((resolve) => {
        let settled = false;

        const finish = (metadata: CrunchyrollEpisodeMetadata | undefined) => {
            if (settled) {
                return;
            }

            settled = true;
            clearTimeout(timeout);
            document.removeEventListener(crunchyrollEpisodeInfoResponseEvent, listener, false);
            resolve(metadata);
        };

        const listener = (event: Event) => {
            const detail = (event as CustomEvent).detail as CrunchyrollEpisodeMetadata | undefined;
            finish(detail === null || typeof detail !== 'object' ? undefined : detail);
        };

        // The page script polls for a few seconds itself; this is only a safety net
        const timeout = setTimeout(() => finish(undefined), episodeInfoResponseTimeoutMs);
        document.addEventListener(crunchyrollEpisodeInfoResponseEvent, listener, false);
        document.dispatchEvent(new CustomEvent(crunchyrollEpisodeInfoRequestEvent));
    });
};

export default class JimakuAutoSelectService {
    // Keyed by episode so that soft-navigating back to an episode, or duplicate
    // page events for the same episode, do not trigger duplicate Jimaku/ChatGPT requests.
    private readonly _results = new Map<string, Promise<JimakuAutoSelectResult>>();

    async selectForCurrentEpisode({
        basename,
        jimakuApiKey,
        durationSeconds,
    }: JimakuAutoSelectRequest): Promise<JimakuAutoSelectResult> {
        if (jimakuApiKey.trim().length === 0) {
            throw new JimakuAutoSelectError('Jimaku API key is not configured');
        }

        const metadata = await requestEpisodeInfoFromPage();
        const info: JimakuEpisodeInfo | undefined = metadata ?? episodeInfoFromTitleHint(basename);

        if (info === undefined) {
            throw new JimakuAutoSelectError('Could not determine which episode is playing');
        }

        if (
            info.durationSeconds === undefined &&
            durationSeconds !== undefined &&
            Number.isFinite(durationSeconds) &&
            durationSeconds > 0
        ) {
            info.durationSeconds = durationSeconds;
        }

        const key = this._cacheKey(metadata, info);
        const cached = this._results.get(key);

        if (cached !== undefined) {
            return cached;
        }

        const promise = this._select(info, jimakuApiKey);
        this._results.set(key, promise);
        promise.catch(() => {
            // Failures are not cached so that a later attempt (e.g. after fixing an API key) can succeed
            if (this._results.get(key) === promise) {
                this._results.delete(key);
            }
        });

        while (this._results.size > maxCachedResults) {
            const oldestKey = this._results.keys().next().value;

            if (oldestKey === undefined) {
                break;
            }

            this._results.delete(oldestKey);
        }

        return promise;
    }

    private _cacheKey(metadata: CrunchyrollEpisodeMetadata | undefined, info: JimakuEpisodeInfo) {
        const episodeId = metadata?.id ?? crunchyrollWatchIdFromPath(window.location.pathname);

        if (episodeId !== undefined) {
            return `id:${episodeId}`;
        }

        return `title:${info.seriesTitle}:${info.seasonNumber ?? ''}:${info.episodeNumber ?? ''}`;
    }

    private async _select(info: JimakuEpisodeInfo, jimakuApiKey: string) {
        const jimaku = new JimakuClient({ apiKey: jimakuApiKey });
        const selector = new JimakuAutoSelector(jimaku, completeSubtitleSelection, {
            subtitleEndSeconds: fetchSubtitleEndSeconds,
        });
        asbLog('video/sync', 'Auto-selecting Jimaku subtitle for', info);
        const result = await selector.select(info);
        asbLog('video/sync', `Auto-selected Jimaku subtitle "${result.file.name}" from entry "${result.entry.name}"`);
        return result;
    }
}
