import { TextDecoder, TextEncoder } from 'util';
import type { VideoDataSubtitleTrack } from '@project/common';
import {
    autoSynchronizeSubtitles,
    nativeTimingReference,
    retimeSubtitles,
    subtitleTimings,
} from '@project/extension/src/services/subtitle-auto-sync';

jest.mock('@project/common/util', () => ({ asbLog: jest.fn(), asbWarn: jest.fn() }));

const native: VideoDataSubtitleTrack = {
    id: 'en',
    label: 'English',
    language: 'en-US',
    extension: 'ass',
    url: 'https://vod-fy-mod.crunchyrollcdn.com/captions.ass',
};
const text = Array.from(
    { length: 35 },
    (_, i) =>
        `${i + 1}\n00:00:${String(i + 1).padStart(2, '0')},000 --> 00:00:${String(i + 1).padStart(2, '0')},800\n日本語${i}\n`
).join('\n');
const file = { name: 'episode.srt', base64: Buffer.from(text).toString('base64') };

describe('automatic subtitle timing', () => {
    const testGlobal = globalThis as typeof globalThis & { browser: typeof browser };
    const originalFetch = globalThis.fetch;
    const originalBrowser = testGlobal.browser;
    let send: jest.Mock;

    beforeEach(() => {
        Object.assign(globalThis, { TextDecoder, TextEncoder });
        send = jest.fn().mockResolvedValue({
            accepted: true,
            timings: subtitleTimings(text).map(([a, b]) => [a + 1000, b + 1000]),
            score: 0.8,
        });
        testGlobal.browser = { runtime: { sendMessage: send } } as unknown as typeof browser;
        globalThis.fetch = jest
            .fn()
            .mockResolvedValue({ ok: true, arrayBuffer: async () => new TextEncoder().encode(text).buffer });
    });
    afterEach(() => {
        globalThis.fetch = originalFetch;
        testGlobal.browser = originalBrowser;
    });

    it('preserves ASS formatting, dialogue, drawings, and line endings while changing only timing', () => {
        const ass = '[Events]\r\nDialogue: 0,0:00:01.20,0:00:02.34,Default,,0,0,0,,{\\i1}栄誉\\N賢人\r\n';
        expect(subtitleTimings(ass)).toEqual([[1200, 2340]]);
        expect(retimeSubtitles(ass, [[2500, 3640]])).toBe(
            ass.replace('0:00:01.20,0:00:02.34', '0:00:02.50,0:00:03.64')
        );
    });

    it('supports VTT timestamps and keeps cue settings and text intact', () => {
        const vtt = 'WEBVTT\n\n00:01.000 --> 00:02.000 line:90%\n<i>hello</i>\n';
        expect(subtitleTimings(vtt)).toEqual([[1000, 2000]]);
        expect(retimeSubtitles(vtt, [[2500, 3500]])).toContain('00:00:02.500 --> 00:00:03.500 line:90%\n<i>hello</i>');
    });

    it('uses the hidden English CDN track and sends only timestamps to the local host', async () => {
        const result = await autoSynchronizeSubtitles([file], [native], 100, () => false);
        expect(result.aligned).toBe(true);
        expect(result.files[0].name).toBe(file.name);
        expect(Buffer.from(result.files[0].base64, 'base64').toString()).toContain('00:00:02,000');
        expect(send).toHaveBeenCalledWith({
            sender: 'asbplayer-subtitle-selector',
            action: 'align',
            source: subtitleTimings(text),
            reference: subtitleTimings(text),
            duration: 100000,
        });
        expect(JSON.stringify(send.mock.calls)).not.toContain('日本語');
    });

    it('rejects non-native and misleading reference URLs', () => {
        for (const url of [
            'https://jimaku.cc/sub.ass',
            'https://crunchyrollcdn.com.evil.test/sub.ass',
            'https://evil.test/crunchyrollcdn.com/sub.ass',
        ]) {
            expect(nativeTimingReference([{ ...native, url }])).toBeUndefined();
        }
    });

    it.each([{ error: 'Bridge not installed' }, { accepted: true, timings: [[0, 10]] }])(
        'keeps the original file on an unusable response %j',
        async (response) => {
            send.mockResolvedValue(response);
            expect(await autoSynchronizeSubtitles([file], [native], 100, () => false)).toEqual({
                files: [file],
                aligned: false,
            });
        }
    );

    it('allows another release only after a valid timing comparison rejects this file', async () => {
        send.mockResolvedValue({ accepted: false, score: 0.45, reason: 'Timings disagree' });
        expect(await autoSynchronizeSubtitles([file], [native], 100, () => false)).toEqual({
            files: [file],
            aligned: false,
            rejected: true,
        });
        send.mockResolvedValue({ accepted: false, error: 'Bridge unavailable' });
        expect(await autoSynchronizeSubtitles([file], [native], 100, () => false)).toEqual({
            files: [file],
            aligned: false,
        });
    });

    it('discards alignment completed after episode navigation', async () => {
        let stale = false;
        send.mockImplementation(async () => {
            stale = true;
            return { accepted: true, timings: subtitleTimings(text) };
        });
        expect((await autoSynchronizeSubtitles([file], [native], 100, () => stale)).aligned).toBe(false);
    });

    it('keeps the original file if the reference cannot be fetched', async () => {
        (fetch as jest.Mock).mockRejectedValue(new Error('offline'));
        expect((await autoSynchronizeSubtitles([file], [native], 100, () => false)).aligned).toBe(false);
        expect(send).not.toHaveBeenCalled();
    });
});
