import type { JimakuClient, JimakuEntry, JimakuFile } from '@project/common/subtitle-sources/subtitle-sources';
import { prepareHint } from '@project/common/subtitle-sources/jimaku-episode-patterns';

export interface JimakuEpisodeInfo {
    seriesTitle: string;
    seasonTitle?: string;
    seasonNumber?: number;
    episodeNumber?: number;
    episodeTitle?: string;
    durationSeconds?: number;
}

export interface JimakuSubtitleCandidate {
    name: string;
    url: string;
}

export interface JimakuAutoSelectResult {
    entry: { id: number; name: string };
    file: JimakuSubtitleCandidate;
    // Files that were considered for this episode, useful for manual fallback
    candidates: JimakuSubtitleCandidate[];
    episodeFiltered: boolean;
}

export class JimakuAutoSelectError extends Error {
    readonly entry?: { id: number; name: string };
    readonly candidates: JimakuSubtitleCandidate[];

    constructor(
        message: string,
        options: { entry?: { id: number; name: string }; candidates?: JimakuSubtitleCandidate[] } = {}
    ) {
        super(message);
        this.name = 'JimakuAutoSelectError';
        this.entry = options.entry;
        this.candidates = options.candidates ?? [];
    }
}

// Given a system prompt and a user prompt, returns the model's text response
export type LanguageModel = (systemPrompt: string, userPrompt: string) => Promise<string>;

type JimakuSearchClient = Pick<JimakuClient, 'searchEntries' | 'getFiles'>;

interface JimakuAutoSelectorOptions {
    // Upper bound on the number of file names sent to the model in a single prompt
    maxFilesInPrompt?: number;
    // Inspect cue timing without spending another model request.
    subtitleEndSeconds?: (candidate: JimakuSubtitleCandidate) => Promise<number | undefined>;
}

const supportedExtensions = ['.srt', '.ass'];

const combinedPattern = /combined\s+episodes?|double\s+episode|2\s*in\s*1|合本|合併/i;
const editionPattern = /director[’']?s?[ ._-]*cut|新編集版|再編集版/i;
const needsEditionSearch = (info: JimakuEpisodeInfo) =>
    (info.durationSeconds ?? 0) >= 35 * 60 ||
    /\s[\\/]\s/.test(info.episodeTitle ?? '') ||
    combinedPattern.test(`${info.seasonTitle ?? ''} ${info.episodeTitle ?? ''}`) ||
    editionPattern.test(`${info.seriesTitle} ${info.seasonTitle ?? ''}`);

const isSupportedSubtitleFile = (name: string) => supportedExtensions.some((ext) => name.toLowerCase().endsWith(ext));

const toCandidates = (files: JimakuFile[]): JimakuSubtitleCandidate[] =>
    files.filter((file) => isSupportedSubtitleFile(file.name)).map((file) => ({ name: file.name, url: file.url }));

const systemPrompt = [
    'You help a Japanese language learner pick the correct Japanese subtitle file from Jimaku, a Japanese subtitle archive,',
    'for the anime or drama episode they are currently watching on Crunchyroll.',
    'Respond with exactly one JSON object and no other text.',
].join(' ');

const describeEpisode = (info: JimakuEpisodeInfo) => {
    const lines = [`- Series title: ${info.seriesTitle}`];

    if (info.seasonTitle !== undefined && info.seasonTitle !== info.seriesTitle) {
        lines.push(`- Season title: ${info.seasonTitle}`);
    }

    if (info.seasonNumber !== undefined) {
        lines.push(`- Season number: ${info.seasonNumber}`);
    }

    if (info.episodeNumber !== undefined) {
        lines.push(`- Episode number (within this season): ${info.episodeNumber}`);
    }

    if (info.episodeTitle !== undefined && info.episodeTitle.length > 0) {
        lines.push(`- Episode title: ${info.episodeTitle}`);
    }

    if (info.durationSeconds !== undefined) {
        lines.push(
            `- Video runtime: ${Math.round(info.durationSeconds)} seconds (${(info.durationSeconds / 60).toFixed(1)} minutes)`
        );
    }

    return lines.join('\n');
};

interface EntryCandidate extends JimakuSubtitleCandidate {
    entry: JimakuEntry;
    endSeconds?: number;
}

const filePrompt = (info: JimakuEpisodeInfo, candidates: EntryCandidate[], episodeFiltered: boolean) => {
    const list = candidates
        .map((candidate, index) => {
            const entry = candidate.entry;
            const names = [entry.name, entry.english_name, entry.japanese_name].filter(Boolean).join(' | ');
            const timing =
                candidate.endSeconds === undefined
                    ? ''
                    : ` — last subtitle ends at ${Math.round(candidate.endSeconds)} seconds`;
            return `${index + 1}. ${candidate.name} — Jimaku entry: ${names}${timing}`;
        })
        .join('\n');

    return [
        'The viewer is watching:',
        describeEpisode(info),
        '',
        'Subtitle files from the matching Jimaku entries:',
        list,
        '',
        episodeFiltered
            ? `Jimaku filtered these files to episode ${info.episodeNumber}, but this filter can be imprecise.`
            : 'These are all of the files in the entries; most may be for other episodes.',
        'Choose the single best Japanese subtitle file for exactly this show, season AND episode:',
        '- Crunchyroll can combine multiple cours into one season, while Jimaku has separate Part 1 and Part 2 entries. Part 2 does NOT necessarily mean Season 2. Use the actual episode numbers in the files.',
        '- Check the entry titles AND the file names. Ignore sequels, movies, OVAs and spin-offs unless this is the episode being watched.',
        '- Match the edition and the WHOLE video. A title containing two episode titles separated by a slash or backslash can be a combined episode; a long runtime is additional evidence.',
        '- For combined episodes, prefer an explicitly combined file covering both halves. The streaming episode number may differ from the original broadcast or Netflix numbering. Do not choose a single original episode just because its number matches.',
        '- Director’s Cut / 新編集版 alone does not prove a file contains both halves: some services split that edition into individual episodes. Use the subtitle end time, full video runtime and episode titles together. Do not assume a universal 2× episode-number mapping.',
        '- Be careful with absolute vs. per-season numbering; only re-map numbers when the file names make it obvious.',
        '- Prefer complete Japanese dialogue subtitles. Avoid other languages, signs/songs-only tracks, forced tracks, and commentary.',
        '- Prefer versions timed for streaming releases (CR, Crunchyroll, WEB) over Blu-ray timing when both exist.',
        'Answer {"index": <1-based number of the best file>} or {"index": null} if no file is suitable.',
    ].join('\n');
};

// Parses the model's response to an index prompt. Returns the 0-based index, or undefined if the model declined.
export const parseIndexResponse = (response: string, count: number): number | undefined => {
    const toValidIndex = (value: unknown) => {
        const oneBased = typeof value === 'string' ? Number.parseInt(value, 10) : value;

        if (typeof oneBased !== 'number' || !Number.isInteger(oneBased) || oneBased < 1 || oneBased > count) {
            throw new Error(`Model answered with an out-of-range index: ${JSON.stringify(value)}`);
        }

        return oneBased - 1;
    };

    const objectMatch = /\{[\s\S]*?\}/.exec(response);

    if (objectMatch !== null) {
        try {
            const parsed = JSON.parse(objectMatch[0]) as { index?: unknown };

            if ('index' in parsed) {
                if (parsed.index === null) {
                    return undefined;
                }

                return toValidIndex(parsed.index);
            }
        } catch {
            // Fall through to the lenient integer parse below
        }
    }

    if (/\bnull\b|\bnone\b/i.test(response) && !/\d/.test(response)) {
        return undefined;
    }

    const integerMatch = /-?\d+/.exec(response);

    if (integerMatch === null) {
        throw new Error(`Could not understand model response: ${response.substring(0, 200)}`);
    }

    return toValidIndex(Number.parseInt(integerMatch[0], 10));
};

// Builds episode info from a page title such as "Show Name E5 - Episode Title" using
// the same detection used by the manual Jimaku dialog.
export const episodeInfoFromTitleHint = (hint: string): JimakuEpisodeInfo | undefined => {
    const { episode, cleaned } = prepareHint(hint);

    if (cleaned.length === 0) {
        return undefined;
    }

    const separator = hint.indexOf(' - ');
    const episodeTitle = separator < 0 ? undefined : hint.slice(separator + 3).trim() || undefined;
    return { seriesTitle: cleaned, episodeNumber: episode, episodeTitle };
};

const episodeNumberPattern = (episode: number) => new RegExp(`(?:^|\\D)0*${episode}(?:\\D|$)`);

// When too many files exist to send to the model, keep the ones that mention the episode number first.
const prioritizeCandidates = <T extends EntryCandidate>(
    candidates: T[],
    info: JimakuEpisodeInfo,
    limit: number
): T[] => {
    const episode = info.episodeNumber;
    if (needsEditionSearch(info)) {
        // Keep edition alternatives even when a large archive contains hundreds
        // of misleading same-number files. This only orders evidence for the model.
        const score = (candidate: T) => {
            const names = `${candidate.name} ${candidate.entry.name} ${candidate.entry.english_name ?? ''} ${candidate.entry.japanese_name ?? ''}`;
            return (
                (episode !== undefined && episodeNumberPattern(episode).test(candidate.name) ? 4 : 0) +
                (combinedPattern.test(names) ? 3 : 0) +
                (editionPattern.test(names) ? 2 : 0)
            );
        };
        return [...candidates].sort((a, b) => score(b) - score(a)).slice(0, limit);
    }
    if (candidates.length <= limit) {
        return candidates;
    }

    if (episode === undefined) {
        return candidates.slice(0, limit);
    }

    const pattern = episodeNumberPattern(episode);
    const matching = candidates.filter((candidate) => pattern.test(candidate.name));
    const rest = candidates.filter((candidate) => !pattern.test(candidate.name));
    return [...matching, ...rest].slice(0, limit);
};

export class JimakuAutoSelector {
    private readonly _jimaku: JimakuSearchClient;
    private readonly _model: LanguageModel;
    private readonly _maxFilesInPrompt: number;
    private readonly _subtitleEndSeconds?: JimakuAutoSelectorOptions['subtitleEndSeconds'];

    constructor(
        jimaku: JimakuSearchClient,
        model: LanguageModel,
        { maxFilesInPrompt = 300, subtitleEndSeconds }: JimakuAutoSelectorOptions = {}
    ) {
        this._jimaku = jimaku;
        this._model = model;
        this._maxFilesInPrompt = maxFilesInPrompt;
        this._subtitleEndSeconds = subtitleEndSeconds;
    }

    async select(info: JimakuEpisodeInfo): Promise<JimakuAutoSelectResult> {
        const seriesTitle = info.seriesTitle.trim();

        if (seriesTitle.length === 0) {
            throw new JimakuAutoSelectError('Could not determine the title of the current show');
        }

        const normalizedInfo: JimakuEpisodeInfo = { ...info, seriesTitle };
        const entries = await this._searchEntries(normalizedInfo);

        if (entries.length === 0) {
            throw new JimakuAutoSelectError(`Jimaku has no entries matching "${seriesTitle}"`);
        }

        // Inspect the available episodes before asking the model. Choosing an entry
        // from its name alone loses split cours such as Crunchyroll S1E23 in Jimaku Part 2.
        // A joint file/entry decision also uses only one model request per episode.
        if (entries.length > 20) {
            throw new JimakuAutoSelectError(`Jimaku search for "${seriesTitle}" returned too many entries`);
        }

        const candidates: EntryCandidate[] = [];
        const editionSearch = needsEditionSearch(normalizedInfo);
        if (!editionSearch && info.episodeNumber !== undefined) {
            for (const entry of entries) {
                const files = (await this._jimaku.getFiles(entry.id, { episode: info.episodeNumber })).data;
                candidates.push(...toCandidates(files).map((file) => ({ ...file, entry })));
            }
        }

        const episodeFiltered = candidates.length > 0;
        if (!episodeFiltered) {
            for (const entry of entries) {
                const files = (await this._jimaku.getFiles(entry.id)).data;
                candidates.push(...toCandidates(files).map((file) => ({ ...file, entry })));
            }
        }

        if (candidates.length === 0) {
            throw new JimakuAutoSelectError(`Jimaku has no .srt or .ass subtitle files for "${seriesTitle}"`);
        }

        const fallbackCandidates = episodeFiltered ? candidates.map(({ name, url }) => ({ name, url })) : [];
        let promptCandidates = prioritizeCandidates(candidates, normalizedInfo, this._maxFilesInPrompt);
        if (editionSearch && this._subtitleEndSeconds !== undefined) {
            // Bounded, parallel inspection of the most promising files. Checking
            // actual cue timing catches mislabeled short releases before selection.
            const pending = promptCandidates.slice(0, 20);
            await Promise.all(
                Array.from({ length: 4 }, async () => {
                    for (let candidate = pending.shift(); candidate !== undefined; candidate = pending.shift()) {
                        await this._inspect(candidate);
                    }
                })
            );
            promptCandidates = promptCandidates.filter((candidate) => this._runtimeFits(candidate, info));
        }
        let index: number | undefined;

        if (promptCandidates.length === 0) {
            throw new JimakuAutoSelectError('No subtitle file covers the full runtime of this episode');
        } else if (entries.length === 1 && episodeFiltered && candidates.length === 1) {
            index = 0;
        } else {
            try {
                const response = await this._model(
                    systemPrompt,
                    filePrompt(normalizedInfo, promptCandidates, episodeFiltered)
                );
                index = parseIndexResponse(response, promptCandidates.length);
            } catch (e) {
                throw new JimakuAutoSelectError((e as Error).message, {
                    entry: entries.length === 1 ? { id: entries[0].id, name: entries[0].name } : undefined,
                    candidates: fallbackCandidates,
                });
            }
        }

        if (index === undefined) {
            throw new JimakuAutoSelectError(
                `No suitable subtitle file for this episode was found for "${seriesTitle}"`,
                {
                    candidates: fallbackCandidates,
                }
            );
        }

        const chosen = promptCandidates[index];
        if (editionSearch) {
            await this._inspect(chosen);
            if (!this._runtimeFits(chosen, info)) {
                throw new JimakuAutoSelectError(
                    'The selected subtitle does not cover the full runtime of this episode'
                );
            }
        }
        return {
            entry: { id: chosen.entry.id, name: chosen.entry.name },
            file: { name: chosen.name, url: chosen.url },
            candidates: candidates
                .filter((candidate) => candidate.entry.id === chosen.entry.id)
                .map(({ name, url }) => ({ name, url })),
            episodeFiltered,
        };
    }

    private async _inspect(candidate: EntryCandidate) {
        if (candidate.endSeconds !== undefined || this._subtitleEndSeconds === undefined) return;
        try {
            const end = await this._subtitleEndSeconds(candidate);
            if (end !== undefined && Number.isFinite(end) && end > 0) candidate.endSeconds = end;
        } catch {
            // Unavailable timing is not evidence of a wrong file; the model still
            // has filenames and edition metadata, as for ordinary episodes.
        }
    }

    private _runtimeFits(candidate: EntryCandidate, info: JimakuEpisodeInfo) {
        const duration = info.durationSeconds;
        if (duration === undefined || duration < 35 * 60 || candidate.endSeconds === undefined) return true;
        // Allow credits, small cuts and offsets, but reject a single half or a
        // full-season compilation. This is not an exact synchronization check.
        return candidate.endSeconds >= duration * 0.7 && candidate.endSeconds <= duration * 1.15 + 120;
    }

    private async _searchEntries(info: JimakuEpisodeInfo): Promise<JimakuEntry[]> {
        const queries = [info.seriesTitle];

        if (info.seasonTitle !== undefined) {
            const seasonTitle = info.seasonTitle.trim();

            if (seasonTitle.length > 0 && seasonTitle !== info.seriesTitle) {
                queries.push(seasonTitle);
            }
        }

        const entries = new Map<number, JimakuEntry>();
        for (const query of queries) {
            const result = await this._jimaku.searchEntries(query);

            if (result.data.length > 0 && !needsEditionSearch(info)) {
                return result.data;
            }
            for (const entry of result.data) entries.set(entry.id, entry);
        }

        return [...entries.values()];
    }
}
