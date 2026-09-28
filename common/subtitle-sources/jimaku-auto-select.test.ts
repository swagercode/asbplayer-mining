import { describe, expect, it, jest } from '@jest/globals';
import {
    JimakuAutoSelectError,
    JimakuAutoSelector,
    episodeInfoFromTitleHint,
    parseIndexResponse,
} from '@project/common/subtitle-sources/jimaku-auto-select';
import type { JimakuEntry, JimakuFile, JimakuResponse } from '@project/common/subtitle-sources/subtitle-sources';

const response = <T>(data: T): JimakuResponse<T> => ({ data, rateLimit: {} });

const entry = (id: number, name: string, extra: Partial<JimakuEntry> = {}): JimakuEntry => ({ id, name, ...extra });

const file = (id: number, name: string): JimakuFile => ({ id, name, url: `https://jimaku.cc/files/${id}/${name}` });

interface FakeJimakuOptions {
    entries?: Record<string, JimakuEntry[]>;
    files?: Record<number, JimakuFile[]>;
    episodeFiles?: Record<string, JimakuFile[]>;
}

const fakeJimaku = ({ entries = {}, files = {}, episodeFiles = {} }: FakeJimakuOptions) => {
    const searchEntries = jest.fn(async (query: string) => response(entries[query] ?? []));
    const getFiles = jest.fn(async (id: number, options?: { episode?: number }) => {
        if (options?.episode !== undefined) {
            return response(episodeFiles[`${id}:${options.episode}`] ?? []);
        }

        return response(files[id] ?? []);
    });
    return { searchEntries, getFiles };
};

describe('parseIndexResponse', () => {
    it('parses a JSON object answer', () => {
        expect(parseIndexResponse('{"index": 2}', 3)).toBe(1);
    });

    it('parses a JSON answer wrapped in prose or code fences', () => {
        expect(parseIndexResponse('Sure!\n```json\n{"index": 3, "reason": "matches"}\n```', 3)).toBe(2);
    });

    it('parses a string index', () => {
        expect(parseIndexResponse('{"index": "1"}', 3)).toBe(0);
    });

    it('returns undefined when the model declines', () => {
        expect(parseIndexResponse('{"index": null}', 3)).toBeUndefined();
        expect(parseIndexResponse('none', 3)).toBeUndefined();
    });

    it('falls back to the first integer in the response', () => {
        expect(parseIndexResponse('The best match is 2.', 3)).toBe(1);
    });

    it('rejects out-of-range indices', () => {
        expect(() => parseIndexResponse('{"index": 0}', 3)).toThrow('out-of-range');
        expect(() => parseIndexResponse('{"index": 4}', 3)).toThrow('out-of-range');
    });

    it('rejects responses without any usable answer', () => {
        expect(() => parseIndexResponse('I am not sure.', 3)).toThrow('Could not understand');
    });
});

describe('episodeInfoFromTitleHint', () => {
    it('extracts series title and episode number from a Crunchyroll-style title', () => {
        expect(episodeInfoFromTitleHint("Frieren: Beyond Journey's End E5 - Killing Magic")).toEqual({
            seriesTitle: "Frieren: Beyond Journey's End",
            episodeNumber: 5,
            episodeTitle: 'Killing Magic',
        });
    });

    it('returns undefined for an empty title', () => {
        expect(episodeInfoFromTitleHint('   ')).toBeUndefined();
    });
});

describe('JimakuAutoSelector', () => {
    const frieren = { seriesTitle: 'Frieren: Beyond Journey’s End', seasonNumber: 1, episodeNumber: 5 };

    it('skips the model entirely when there is one entry and one episode file', async () => {
        const jimaku = fakeJimaku({
            entries: { [frieren.seriesTitle]: [entry(1, 'Sousou no Frieren')] },
            episodeFiles: { '1:5': [file(10, 'Sousou no Frieren - 05.srt'), file(11, 'Sousou no Frieren - 05.zip')] },
        });
        const model = jest.fn<(system: string, user: string) => Promise<string>>();
        const selector = new JimakuAutoSelector(jimaku, model);

        const result = await selector.select(frieren);

        expect(result.entry).toEqual({ id: 1, name: 'Sousou no Frieren' });
        expect(result.file.name).toBe('Sousou no Frieren - 05.srt');
        expect(result.episodeFiltered).toBe(true);
        expect(model).not.toHaveBeenCalled();
        expect(jimaku.getFiles).toHaveBeenCalledWith(1, { episode: 5 });
    });

    it('chooses the entry and file together in one model request', async () => {
        const jimaku = fakeJimaku({
            entries: {
                [frieren.seriesTitle]: [
                    entry(1, 'Sousou no Frieren', { english_name: 'Frieren: Beyond Journey’s End' }),
                    entry(2, 'Sousou no Frieren 2nd Season'),
                ],
            },
            episodeFiles: {
                '1:5': [file(10, '[CR] Sousou no Frieren - 05.srt'), file(11, '[BD] Sousou no Frieren - 05.ass')],
            },
        });
        const model = jest.fn<(system: string, user: string) => Promise<string>>();
        model.mockResolvedValueOnce('{"index": 1}');
        const selector = new JimakuAutoSelector(jimaku, model);

        const result = await selector.select(frieren);

        expect(model).toHaveBeenCalledTimes(1);
        expect(model.mock.calls[0][1]).toContain('Sousou no Frieren | Frieren: Beyond Journey’s End');
        expect(model.mock.calls[0][1]).toContain('1. [CR] Sousou no Frieren - 05.srt');
        expect(model.mock.calls[0][1]).toContain('Episode number (within this season): 5');
        expect(result.file.name).toBe('[CR] Sousou no Frieren - 05.srt');
        expect(result.candidates).toHaveLength(2);
    });

    it('includes Part 2 episode files even when Crunchyroll calls it Season 1', async () => {
        const info = { seriesTitle: 'Mushoku Tensei: Jobless Reincarnation', seasonNumber: 1, episodeNumber: 23 };
        const jimaku = fakeJimaku({
            entries: {
                [info.seriesTitle]: [
                    entry(1426, 'Mushoku Tensei'),
                    entry(3547, 'Mushoku Tensei Part 2'),
                    entry(2699, 'Mushoku Tensei II Part 2'),
                ],
            },
            episodeFiles: {
                '3547:23': [file(1, 'Mushoku Tensei.S01E23.WEB.ja.srt')],
                '2699:23': [file(2, 'Mushoku Tensei.S02E23.WEB.ja.srt')],
            },
            files: { 1426: [file(3, 'Mushoku Tensei.S01E11.srt')] },
        });
        const model = jest.fn<(s: string, u: string) => Promise<string>>().mockResolvedValue('{"index":1}');
        const result = await new JimakuAutoSelector(jimaku, model).select(info);
        expect(result.entry.id).toBe(3547);
        expect(result.file.name).toBe('Mushoku Tensei.S01E23.WEB.ja.srt');
        expect(model).toHaveBeenCalledTimes(1);
        expect(model.mock.calls[0][1]).toContain('Part 2 does NOT necessarily mean Season 2');
        expect(model.mock.calls[0][1]).toContain('S02E23');
        expect(model.mock.calls[0][1]).not.toContain('S01E11');
    });

    it('falls back to the season title when the series title has no results', async () => {
        const jimaku = fakeJimaku({
            entries: { 'Some Season Title': [entry(3, 'Entry')] },
            episodeFiles: { '3:1': [file(1, 'Entry - 01.srt')] },
        });
        const selector = new JimakuAutoSelector(jimaku, jest.fn<(s: string, u: string) => Promise<string>>());

        const result = await selector.select({
            seriesTitle: 'Some Series',
            seasonTitle: 'Some Season Title',
            episodeNumber: 1,
        });

        expect(result.entry.id).toBe(3);
        expect(jimaku.searchEntries).toHaveBeenCalledTimes(2);
    });

    it('falls back to all files when the episode filter is empty', async () => {
        const jimaku = fakeJimaku({
            entries: { [frieren.seriesTitle]: [entry(1, 'Sousou no Frieren')] },
            files: { 1: [file(10, 'Frieren 04.srt'), file(11, 'Frieren 05.srt')] },
        });
        const model = jest.fn<(system: string, user: string) => Promise<string>>().mockResolvedValue('{"index": 2}');
        const selector = new JimakuAutoSelector(jimaku, model);

        const result = await selector.select(frieren);

        expect(jimaku.getFiles).toHaveBeenCalledTimes(2);
        expect(result.episodeFiltered).toBe(false);
        expect(result.file.name).toBe('Frieren 05.srt');
        expect(model.mock.calls[0][1]).toContain('These are all of the files in the entries');
    });

    it('fails when Jimaku has no entries', async () => {
        const selector = new JimakuAutoSelector(fakeJimaku({}), jest.fn<(s: string, u: string) => Promise<string>>());

        await expect(selector.select(frieren)).rejects.toThrow('Jimaku has no entries matching');
    });

    it('fails when the model declines to pick a subtitle', async () => {
        const jimaku = fakeJimaku({
            entries: { [frieren.seriesTitle]: [entry(1, 'A'), entry(2, 'B')] },
            episodeFiles: { '1:5': [file(1, 'A - 05.srt')], '2:5': [file(2, 'B - 05.srt')] },
        });
        const model = jest.fn<(system: string, user: string) => Promise<string>>().mockResolvedValue('{"index": null}');
        const selector = new JimakuAutoSelector(jimaku, model);

        await expect(selector.select(frieren)).rejects.toThrow('No suitable subtitle file');
    });

    it('exposes episode candidates for manual fallback when the model fails', async () => {
        const jimaku = fakeJimaku({
            entries: { [frieren.seriesTitle]: [entry(1, 'Sousou no Frieren')] },
            episodeFiles: { '1:5': [file(10, 'a - 05.srt'), file(11, 'b - 05.srt')] },
        });
        const model = jest
            .fn<(system: string, user: string) => Promise<string>>()
            .mockRejectedValue(new Error('ChatGPT: usage limit reached'));
        const selector = new JimakuAutoSelector(jimaku, model);

        const error = (await selector.select(frieren).then(
            () => undefined,
            (e) => e
        )) as JimakuAutoSelectError;

        expect(error).toBeInstanceOf(JimakuAutoSelectError);
        expect(error.message).toBe('ChatGPT: usage limit reached');
        expect(error.entry).toEqual({ id: 1, name: 'Sousou no Frieren' });
        expect(error.candidates.map((c) => c.name)).toEqual(['a - 05.srt', 'b - 05.srt']);
    });

    it('prioritizes files mentioning the episode number when truncating the prompt', async () => {
        const files = [];
        for (let i = 1; i <= 20; ++i) {
            files.push(file(i, `Show - ${String(i).padStart(2, '0')}.srt`));
        }
        const jimaku = fakeJimaku({
            entries: { Show: [entry(1, 'Show')] },
            files: { 1: files },
        });
        const model = jest.fn<(system: string, user: string) => Promise<string>>().mockResolvedValue('{"index": 1}');
        const selector = new JimakuAutoSelector(jimaku, model, { maxFilesInPrompt: 5 });

        const result = await selector.select({ seriesTitle: 'Show', episodeNumber: 17 });

        expect(model.mock.calls[0][1]).toContain('1. Show - 17.srt');
        expect(model.mock.calls[0][1]).not.toContain('6. ');
        expect(result.file.name).toBe('Show - 17.srt');
    });
});

describe('combined and extended editions', () => {
    const info = {
        seriesTitle: 'Re:ZERO -Starting Life in Another World-',
        seasonTitle: 'Re:ZERO -Starting Life in Another World- Director’s Cut',
        seasonNumber: 1,
        episodeNumber: 7,
        episodeTitle: 'Return to the Capital \\ Self-Proclaimed Knight Natsuki Subaru',
        durationSeconds: 3159,
    };
    const short = file(
        1,
        'Re_ゼロから始める異世界生活.新編集版.S01E07.ナツキ・スバルのリスタート.WEBRip.Netflix.ja[cc].srt'
    );
    const combined = file(2, 'Re ZERO Directors Cut Episode 07 [Combined Episodes].srt');

    it('broadens discovery despite an E7 match and rejects the real short Netflix release by runtime', async () => {
        const jimaku = fakeJimaku({
            entries: { [info.seriesTitle]: [entry(332, 'Re:Zero kara Hajimeru Isekai Seikatsu')] },
            episodeFiles: { '332:7': [short] },
            files: { 332: [short, combined] },
        });
        const model = jest.fn<(s: string, u: string) => Promise<string>>().mockResolvedValue('{"index":1}');
        const inspect = jest.fn(async (candidate: { name: string }) =>
            candidate.name === combined.name ? 3157.01 : 1605.02
        );
        const result = await new JimakuAutoSelector(jimaku, model, { subtitleEndSeconds: inspect }).select(info);
        expect(result.file.name).toBe(combined.name);
        expect(jimaku.getFiles).toHaveBeenCalledWith(332);
        expect(jimaku.getFiles).not.toHaveBeenCalledWith(332, { episode: 7 });
        expect(model).toHaveBeenCalledTimes(1);
        expect(model.mock.calls[0][1]).toContain('3159 seconds');
        expect(model.mock.calls[0][1]).toContain('last subtitle ends at 3157 seconds');
        expect(model.mock.calls[0][1]).toContain(info.episodeTitle);
        expect(model.mock.calls[0][1]).not.toContain(short.name);
        expect(result.episodeFiltered).toBe(false);
        expect(inspect).toHaveBeenCalledTimes(2);
    });

    it.each([
        { episodeTitle: 'First Story / Second Story' },
        { episodeTitle: 'First Story \\ Second Story' },
        { durationSeconds: 2820 },
        { seasonTitle: "Show Director's Cut" },
        { seasonTitle: 'Show 新編集版' },
    ])('discovers other numbering with edition signal %j', async (signal) => {
        const jimaku = fakeJimaku({
            entries: { Show: [entry(1, 'Show')] },
            episodeFiles: { '1:3': [file(1, 'Show - 03.srt')] },
            files: { 1: [file(2, 'Show Episodes 05-06 Combined Episodes.srt')] },
        });
        const model = jest.fn<(s: string, u: string) => Promise<string>>().mockResolvedValue('{"index":1}');
        const result = await new JimakuAutoSelector(jimaku, model).select({
            seriesTitle: 'Show',
            episodeNumber: 3,
            ...signal,
        });
        expect(result.file.name).toContain('05-06');
        expect(model).toHaveBeenCalledTimes(1);
    });

    it('searches the edition title even when the series search succeeds, deduplicating entries', async () => {
        const original = entry(1, 'Show');
        const jimaku = fakeJimaku({
            entries: { Show: [original], 'Show Directors Cut': [original, entry(2, 'Show Directors Cut')] },
            files: { 1: [file(1, 'Show 07.srt')], 2: [file(2, 'Show 07 Combined Episodes.srt')] },
        });
        const model = jest.fn<(s: string, u: string) => Promise<string>>().mockResolvedValue('{"index":1}');
        const result = await new JimakuAutoSelector(jimaku, model).select({
            seriesTitle: 'Show',
            seasonTitle: 'Show Directors Cut',
            episodeNumber: 7,
        });
        expect(result.entry.id).toBe(2);
        expect(jimaku.searchEntries).toHaveBeenCalledTimes(2);
        expect(jimaku.getFiles).toHaveBeenCalledTimes(2);
    });

    it('keeps combined editions in a bounded prompt despite many same-number originals', async () => {
        const jimaku = fakeJimaku({
            entries: { [info.seriesTitle]: [entry(1, 'Show')] },
            files: { 1: [...Array.from({ length: 30 }, (_, i) => file(i + 10, `Release ${i} E07.srt`)), combined] },
        });
        const model = jest.fn<(s: string, u: string) => Promise<string>>().mockResolvedValue('{"index":1}');
        const result = await new JimakuAutoSelector(jimaku, model, { maxFilesInPrompt: 5 }).select(info);
        expect(result.file.name).toBe(combined.name);
    });

    it('does not accept the only file if it covers just one half', async () => {
        const jimaku = fakeJimaku({
            entries: { [info.seriesTitle]: [entry(1, 'Show')] },
            files: { 1: [short] },
        });
        const model = jest.fn<(s: string, u: string) => Promise<string>>();
        const selector = new JimakuAutoSelector(jimaku, model, { subtitleEndSeconds: async () => 1605 });
        await expect(selector.select(info)).rejects.toThrow('No subtitle file covers the full runtime');
        expect(model).not.toHaveBeenCalled();
    });

    it('validates a selected file outside the timing shortlist before loading it', async () => {
        const files = Array.from({ length: 22 }, (_, i) => file(i + 1, `Show ${i + 1}.srt`));
        const jimaku = fakeJimaku({ entries: { Show: [entry(1, 'Show')] }, files: { 1: files } });
        const model = jest.fn<(s: string, u: string) => Promise<string>>().mockResolvedValue('{"index":22}');
        const inspect = jest.fn(async (candidate: { name: string }) =>
            candidate.name === 'Show 22.srt' ? 1400 : 2800
        );
        const selector = new JimakuAutoSelector(jimaku, model, { subtitleEndSeconds: inspect });
        await expect(selector.select({ seriesTitle: 'Show', durationSeconds: 2900 })).rejects.toThrow(
            'selected subtitle does not cover'
        );
        expect(inspect).toHaveBeenCalledTimes(21);
    });

    it('can use filename evidence if optional timing inspection is unavailable', async () => {
        const jimaku = fakeJimaku({ entries: { [info.seriesTitle]: [entry(1, 'Show')] }, files: { 1: [combined] } });
        const model = jest.fn<(s: string, u: string) => Promise<string>>().mockResolvedValue('{"index":1}');
        const selector = new JimakuAutoSelector(jimaku, model, {
            subtitleEndSeconds: async () => {
                throw new Error('offline');
            },
        });
        expect((await selector.select(info)).file.name).toBe(combined.name);
    });
});
