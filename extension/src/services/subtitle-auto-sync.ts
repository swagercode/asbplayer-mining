import type { SerializedSubtitleFile, VideoDataSubtitleTrack } from '@project/common';
import { asbLog, asbWarn } from '@project/common/util';
import { bufferToBase64 } from '@project/common/base64';

export type CueTiming = [number, number];
const maxBytes = 2_000_000;
const stamp = '(?:\\d{1,3}:)?[0-5]\\d:[0-5]\\d[.,]\\d{1,3}';
const timingPattern = () => new RegExp(`^(Dialogue:[^,]*,|[\\t ]*)(${stamp})(,|[\\t ]+-->[\\t ]+)(${stamp})`, 'gm');

const milliseconds = (value: string) => {
    const parts = value.replace(',', '.').split(':').map(Number);
    return Math.round(parts.reduce((time, part) => time * 60 + part, 0) * 1000);
};

export const subtitleTimings = (text: string): CueTiming[] =>
    [...text.matchAll(timingPattern())].map((match) => [milliseconds(match[2]), milliseconds(match[4])]);

const formatTimestamp = (value: number, ass: boolean) => {
    // ASS stores centiseconds, SRT/VTT store milliseconds.
    const precision = ass ? 100 : 1000;
    const total = Math.round(value / (1000 / precision));
    const fraction = String(total % precision).padStart(ass ? 2 : 3, '0');
    const seconds = Math.floor(total / precision);
    return `${String(Math.floor(seconds / 3600)).padStart(ass ? 1 : 2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}${ass ? '.' : ','}${fraction}`;
};

export function retimeSubtitles(text: string, timings: CueTiming[]): string {
    if (subtitleTimings(text).length !== timings.length) throw new Error('Alignment changed the subtitle count.');
    let index = 0;
    return text.replace(timingPattern(), (_whole, prefix: string, start: string, separator: string, end: string) => {
        const cue = timings[index++];
        if (!Array.isArray(cue) || cue.length !== 2 || !cue.every(Number.isFinite) || cue[0] < 0 || cue[1] <= cue[0]) {
            throw new Error('Invalid aligned subtitle timestamps.');
        }
        const ass = prefix.startsWith('Dialogue:');
        const format = (time: number, original: string) => {
            const timestamp = formatTimestamp(time, ass);
            return !ass && original.includes('.') ? timestamp.replace(',', '.') : timestamp;
        };
        return `${prefix}${format(cue[0], start)}${separator}${format(cue[1], end)}`;
    });
}

export const nativeTimingReference = (tracks: VideoDataSubtitleTrack[]) =>
    tracks.find(
        (track) =>
            /^en(?:-|$)/i.test(track.language ?? '') &&
            /^(ass|ssa|srt|vtt)$/i.test(track.extension) &&
            typeof track.url === 'string' &&
            /^https:\/\/(?:[a-z0-9-]+\.)*crunchyrollcdn\.com\//i.test(track.url)
    );

interface AlignmentResponse {
    accepted?: boolean;
    timings?: CueTiming[];
    score?: number;
    cached?: boolean;
    reason?: string;
    error?: string;
}

/** Only the Japanese files are loaded. The native track remains an invisible timing reference. */
export async function autoSynchronizeSubtitles(
    files: SerializedSubtitleFile[],
    tracks: VideoDataSubtitleTrack[],
    durationSeconds: number,
    isStale: () => boolean
): Promise<{ files: SerializedSubtitleFile[]; aligned: boolean }> {
    const original = { files, aligned: false };
    const reference = nativeTimingReference(tracks);
    if (files.length !== 1 || !reference || !Number.isFinite(durationSeconds) || isStale()) return original;
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 8000);
    try {
        if (files[0].base64.length > maxBytes * 1.4) return original;
        const decoder = new TextDecoder('utf-8', { fatal: true });
        const text = decoder.decode(Uint8Array.from(atob(files[0].base64), (char) => char.charCodeAt(0)));
        const source = subtitleTimings(text);
        if (source.length < 30 || source.length > 5000) return original;
        const response = await fetch(reference.url as string, { credentials: 'omit', signal: abort.signal });
        if (!response.ok) throw new Error(`Native subtitle retrieval failed (${response.status}).`);
        if (Number(response.headers?.get('content-length')) > maxBytes)
            throw new Error('Native subtitle file is too large.');
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength > maxBytes) throw new Error('Native subtitle file is too large.');
        const referenceCues = subtitleTimings(decoder.decode(bytes));
        if (isStale()) return original;
        if (referenceCues.length < 30 || referenceCues.length > 5000) return original;
        const result: AlignmentResponse = await browser.runtime.sendMessage({
            sender: 'asbplayer-subtitle-selector',
            action: 'align',
            source,
            reference: referenceCues,
            duration: Math.round(durationSeconds * 1000),
        });
        if (isStale()) return original;
        if (!result?.accepted || !result.timings) {
            asbWarn('video/sync', 'Automatic timing kept the original subtitles:', result?.error ?? result?.reason);
            return original;
        }
        const aligned = retimeSubtitles(text, result.timings);
        asbLog('video/sync', `Subtitle timing aligned locally (agreement ${result.score}, cached ${result.cached}).`);
        return {
            files: [{ ...files[0], base64: bufferToBase64(new TextEncoder().encode(aligned).buffer as ArrayBuffer) }],
            aligned: true,
        };
    } catch (error) {
        if (!isStale()) asbWarn('video/sync', 'Automatic timing kept the original subtitles:', error);
        return original;
    } finally {
        clearTimeout(timeout);
    }
}
