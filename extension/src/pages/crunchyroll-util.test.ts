import { describe, expect, it } from '@jest/globals';
import {
    collectCrunchyrollEpisodeMetadata,
    crunchyrollEpisodeIdFromPlaybackUrl,
    crunchyrollEpisodeMetadataFromJsonLd,
    crunchyrollWatchIdFromPath,
} from '@project/extension/src/pages/crunchyroll-util';

describe('crunchyrollWatchIdFromPath', () => {
    it('extracts the episode id from watch paths with and without locale prefixes', () => {
        expect(crunchyrollWatchIdFromPath('/watch/GRDKJZ81Y/the-journeys-end')).toBe('GRDKJZ81Y');
        expect(crunchyrollWatchIdFromPath('/de/watch/GRDKJZ81Y/das-ende-der-reise')).toBe('GRDKJZ81Y');
        expect(crunchyrollWatchIdFromPath('/watch/GRDKJZ81Y')).toBe('GRDKJZ81Y');
        expect(crunchyrollWatchIdFromPath('https://www.crunchyroll.com/watch/GRDKJZ81Y/slug')).toBe('GRDKJZ81Y');
    });

    it('returns undefined for non-watch paths', () => {
        expect(crunchyrollWatchIdFromPath('/series/GG5H5XQ0D/frieren')).toBeUndefined();
        expect(crunchyrollWatchIdFromPath('/')).toBeUndefined();
    });
});

describe('crunchyrollEpisodeIdFromPlaybackUrl', () => {
    it('extracts the episode id from playback urls', () => {
        expect(
            crunchyrollEpisodeIdFromPlaybackUrl(
                'https://cr-play-service.prd.crunchyrollsvc.com/v1/GRDKJZ81Y/web/firefox/play'
            )
        ).toBeUndefined();
        expect(
            crunchyrollEpisodeIdFromPlaybackUrl('https://www.crunchyroll.com/playback/v3/GRDKJZ81Y/web/firefox/play')
        ).toBe('GRDKJZ81Y');
    });
});

describe('collectCrunchyrollEpisodeMetadata', () => {
    it('reads nested episode_metadata from cms object responses', () => {
        const response = {
            total: 1,
            data: [
                {
                    id: 'GRDKJZ81Y',
                    type: 'episode',
                    title: "The Journey's End",
                    episode_metadata: {
                        series_id: 'GG5H5XQ0D',
                        series_title: "Frieren: Beyond Journey's End",
                        season_title: "Frieren: Beyond Journey's End",
                        season_number: 1,
                        episode_number: 1,
                        episode: '1',
                        sequence_number: 1,
                    },
                },
            ],
        };

        expect(collectCrunchyrollEpisodeMetadata(response)).toEqual([
            {
                id: 'GRDKJZ81Y',
                seriesTitle: "Frieren: Beyond Journey's End",
                seasonTitle: "Frieren: Beyond Journey's End",
                seasonNumber: 1,
                episodeNumber: 1,
                episodeTitle: "The Journey's End",
            },
        ]);
    });

    it('reads flattened episode items from season episode listings', () => {
        const response = {
            total: 2,
            data: [
                {
                    id: 'EP1',
                    title: 'One',
                    series_title: 'Show',
                    season_title: 'Show Season 2',
                    season_number: 2,
                    episode_number: 1,
                },
                {
                    id: 'EP2',
                    title: 'Special',
                    series_title: 'Show',
                    season_number: 2,
                    episode_number: null,
                    episode: 'SP1',
                    sequence_number: 2.5,
                },
            ],
        };

        const metadata = collectCrunchyrollEpisodeMetadata(response);

        expect(metadata).toHaveLength(2);
        expect(metadata[0]).toMatchObject({ id: 'EP1', seasonTitle: 'Show Season 2', episodeNumber: 1 });
        expect(metadata[1]).toMatchObject({ id: 'EP2', episodeNumber: 2.5, episodeTitle: 'Special' });
        expect(metadata[1].seasonTitle).toBeUndefined();
    });

    it('reads panel-wrapped items from up_next responses', () => {
        const response = {
            data: [
                {
                    playhead: 0,
                    panel: {
                        id: 'NEXT',
                        title: 'Next Episode',
                        episode_metadata: { series_title: 'Show', episode_number: 6 },
                    },
                },
            ],
        };

        expect(collectCrunchyrollEpisodeMetadata(response)).toEqual([
            { id: 'NEXT', seriesTitle: 'Show', episodeNumber: 6, episodeTitle: 'Next Episode' },
        ]);
    });

    it('ignores unrelated payloads', () => {
        expect(collectCrunchyrollEpisodeMetadata(null)).toEqual([]);
        expect(collectCrunchyrollEpisodeMetadata({ data: 'nope' })).toEqual([]);
        expect(collectCrunchyrollEpisodeMetadata({ data: [{ id: 'X', type: 'series', title: 'No episode' }] })).toEqual(
            []
        );
        expect(collectCrunchyrollEpisodeMetadata({ subtitles: {} })).toEqual([]);
    });
});

describe('crunchyrollEpisodeMetadataFromJsonLd', () => {
    it('reads TVEpisode json-ld', () => {
        const jsonLd = {
            '@context': 'https://schema.org',
            '@type': 'TVEpisode',
            name: "The Journey's End",
            episodeNumber: '1',
            url: 'https://www.crunchyroll.com/watch/GRDKJZ81Y/the-journeys-end',
            partOfSeries: { '@type': 'TVSeries', name: "Frieren: Beyond Journey's End" },
            partOfSeason: { '@type': 'TVSeason', name: "Frieren: Beyond Journey's End", seasonNumber: 1 },
        };

        expect(crunchyrollEpisodeMetadataFromJsonLd(jsonLd)).toEqual({
            id: 'GRDKJZ81Y',
            seriesTitle: "Frieren: Beyond Journey's End",
            seasonTitle: "Frieren: Beyond Journey's End",
            seasonNumber: 1,
            episodeNumber: 1,
            episodeTitle: "The Journey's End",
        });
    });

    it('searches @graph nodes and ignores other types', () => {
        const jsonLd = {
            '@graph': [
                { '@type': 'BreadcrumbList' },
                {
                    '@type': 'TVEpisode',
                    name: 'Ep',
                    episodeNumber: 3,
                    url: '/watch/ABC/ep',
                    partOfSeries: { name: 'Series' },
                },
            ],
        };

        expect(crunchyrollEpisodeMetadataFromJsonLd(jsonLd)).toMatchObject({ id: 'ABC', episodeNumber: 3 });
        expect(crunchyrollEpisodeMetadataFromJsonLd({ '@type': 'TVSeries', name: 'x' })).toBeUndefined();
    });
});

describe('episode duration', () => {
    it('reads duration_ms from nested and flat API episodes', () => {
        const rows = collectCrunchyrollEpisodeMetadata({
            data: [
                { id: 'NESTED', episode_metadata: { series_title: 'Show', duration_ms: 3159000 } },
                { id: 'FLAT', series_title: 'Show', duration_ms: 2940000 },
                { id: 'TOP', duration_ms: 2800000, episode_metadata: { series_title: 'Show' } },
                { id: 'BAD', series_title: 'Show', duration_ms: -100 },
            ],
        });
        expect(rows.map((row) => row.durationSeconds)).toEqual([3159, 2940, 2800, undefined]);
    });
    it.each([
        ['PT52M39S', 3159],
        ['PT1H2M3.5S', 3723.5],
        ['PT2820S', 2820],
        ['PT', undefined],
        ['bad', undefined],
    ])('reads JSON-LD duration %s', (duration, expected) => {
        expect(
            crunchyrollEpisodeMetadataFromJsonLd({
                '@type': 'TVEpisode',
                url: '/watch/EP7/title',
                partOfSeries: { name: 'Show' },
                duration,
            })?.durationSeconds
        ).toBe(expected);
    });
});
