import type { JimakuEpisodeInfo } from '@project/common/subtitle-sources/jimaku-auto-select';

// Episode metadata as exposed by Crunchyroll's content API (/content/v2/...), which is
// considerably more stable than the page's DOM structure.
export interface CrunchyrollEpisodeMetadata extends JimakuEpisodeInfo {
    id: string;
}

// Event names shared between the Crunchyroll page script and the content script
export const crunchyrollEpisodeInfoRequestEvent = 'asbplayer-get-crunchyroll-episode-info';
export const crunchyrollEpisodeInfoResponseEvent = 'asbplayer-crunchyroll-episode-info';

const watchPathRegex = /\/watch\/([A-Za-z0-9]+)(?:[/?#]|$)/;
const playbackUrlIdRegex = /\/playback\/v[0-9]+\/([A-Za-z0-9]+)\//i;

export const crunchyrollWatchIdFromPath = (pathname: string): string | undefined => {
    const match = watchPathRegex.exec(pathname);
    return match?.[1];
};

export const crunchyrollEpisodeIdFromPlaybackUrl = (url: string): string | undefined => {
    const match = playbackUrlIdRegex.exec(url);
    return match?.[1];
};

const recordFromUnknown = (value: unknown): Record<string, unknown> | undefined => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }

    return value as Record<string, unknown>;
};

const stringField = (record: Record<string, unknown> | undefined, key: string): string | undefined => {
    const value = record?.[key];
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
};

const numberField = (record: Record<string, unknown> | undefined, key: string): number | undefined => {
    const value = record?.[key];

    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }

    if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
        return Number.parseInt(value.trim(), 10);
    }

    return undefined;
};

const episodeMetadataFromItem = (item: Record<string, unknown>): CrunchyrollEpisodeMetadata | undefined => {
    const id = stringField(item, 'id');

    if (id === undefined) {
        return undefined;
    }

    // /cms/objects/{id} nests the details under episode_metadata,
    // /cms/seasons/{id}/episodes returns them flattened onto the item.
    const metadata = recordFromUnknown(item.episode_metadata) ?? item;
    const seriesTitle = stringField(metadata, 'series_title');
    const durationMs = numberField(metadata, 'duration_ms') ?? numberField(item, 'duration_ms');

    if (seriesTitle === undefined) {
        return undefined;
    }

    return {
        id,
        seriesTitle,
        seasonTitle: stringField(metadata, 'season_title'),
        seasonNumber: numberField(metadata, 'season_number'),
        episodeNumber:
            numberField(metadata, 'episode_number') ??
            numberField(metadata, 'episode') ??
            numberField(metadata, 'sequence_number'),
        episodeTitle: stringField(item, 'title') ?? stringField(metadata, 'title'),
        durationSeconds: durationMs !== undefined && durationMs > 0 ? durationMs / 1000 : undefined,
    };
};

// Extracts episode metadata from any Crunchyroll content API response
// ({ data: [ {...episode}, { panel: {...episode} }, ... ] }).
export const collectCrunchyrollEpisodeMetadata = (value: unknown): CrunchyrollEpisodeMetadata[] => {
    const root = recordFromUnknown(value);
    const data = root?.data;

    if (!Array.isArray(data)) {
        return [];
    }

    const results: CrunchyrollEpisodeMetadata[] = [];

    for (const rawItem of data) {
        const item = recordFromUnknown(rawItem);

        if (item === undefined) {
            continue;
        }

        const candidates = [item, recordFromUnknown(item.panel)];

        for (const candidate of candidates) {
            if (candidate === undefined) {
                continue;
            }

            const metadata = episodeMetadataFromItem(candidate);

            if (metadata !== undefined) {
                results.push(metadata);
                break;
            }
        }
    }

    return results;
};

// Extracts episode metadata from schema.org TVEpisode JSON-LD embedded in server-rendered watch pages
export const crunchyrollEpisodeMetadataFromJsonLd = (value: unknown): CrunchyrollEpisodeMetadata | undefined => {
    const root = recordFromUnknown(value);

    if (root === undefined) {
        return undefined;
    }

    if (Array.isArray(root['@graph'])) {
        for (const node of root['@graph']) {
            const metadata = crunchyrollEpisodeMetadataFromJsonLd(node);

            if (metadata !== undefined) {
                return metadata;
            }
        }

        return undefined;
    }

    if (root['@type'] !== 'TVEpisode') {
        return undefined;
    }

    const url = stringField(root, 'url') ?? stringField(root, '@id');
    const id = url === undefined ? undefined : crunchyrollWatchIdFromPath(url);
    const series = recordFromUnknown(root.partOfSeries);
    const season = recordFromUnknown(root.partOfSeason);
    const seriesTitle = stringField(series, 'name') ?? stringField(season, 'name');
    const durationMatch = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(
        stringField(root, 'duration') ?? ''
    );
    const durationSeconds =
        durationMatch === null
            ? 0
            : Number(durationMatch[1] ?? 0) * 3600 + Number(durationMatch[2] ?? 0) * 60 + Number(durationMatch[3] ?? 0);

    if (id === undefined || seriesTitle === undefined) {
        return undefined;
    }

    return {
        id,
        seriesTitle,
        seasonTitle: stringField(season, 'name'),
        seasonNumber: numberField(season, 'seasonNumber'),
        episodeNumber: numberField(root, 'episodeNumber'),
        episodeTitle: stringField(root, 'name'),
        durationSeconds: durationSeconds > 0 ? durationSeconds : undefined,
    };
};
