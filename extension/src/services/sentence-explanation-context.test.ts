import type { SubtitleModel } from '@project/common';
import { isSentenceExplanationContext, sentenceExplanationContext } from './sentence-explanation-context';

const cue = (text: string, start: number, track = 0): SubtitleModel => ({
    text,
    start,
    end: start + 1000,
    originalStart: start,
    originalEnd: start + 1000,
    track,
});

it('selects the three closest cues on either side in chronological order without changing the source', () => {
    const subtitles = Array.from({ length: 9 }, (_, i) => cue(String(i), i * 2000)).reverse();
    const original = subtitles.slice();
    expect(sentenceExplanationContext(subtitles, { ...cue('4', 8000) })).toEqual({
        before: ['1', '2', '3'],
        after: ['5', '6', '7'],
    });
    expect(subtitles).toEqual(original);
});

it('excludes other tracks, empty/image cues, duplicate copies of the target, and distant scenes', () => {
    const selected = cue('対象', 100000);
    const subtitles = [
        cue('別の場面', 0),
        cue('前の文', 98000),
        cue('Translation', 99000, 1),
        cue(' ', 99000),
        { ...cue('image', 99000), textImage: {} as any },
        selected,
        { ...selected },
        cue('次の文', 102000),
        cue('遠い先の場面', 200000),
    ];
    expect(sentenceExplanationContext(subtitles, selected)).toEqual({ before: ['前の文'], after: ['次の文'] });
});

it('keeps repeated dialogue at other times and handles the beginning and end of the file', () => {
    const subtitles = [cue('はい', 0), cue('はい', 2000), cue('はい', 4000)];
    expect(sentenceExplanationContext(subtitles, subtitles[0])).toEqual({ before: [], after: ['はい', 'はい'] });
    expect(sentenceExplanationContext(subtitles, subtitles[2])).toEqual({ before: ['はい', 'はい'], after: [] });
});

it('bounds cue length before crossing the native bridge', () => {
    const target = cue('対象', 0);
    const context = sentenceExplanationContext([target, cue('字'.repeat(5001), 2000)], target);
    expect(context.after[0]).toHaveLength(5000);
    expect(isSentenceExplanationContext(context)).toBe(true);
    for (const invalid of [
        null,
        [],
        {},
        { before: ['a', 'b', 'c', 'd'], after: [] },
        { before: [], after: [' '] },
        { before: [4], after: [] },
        { before: [], after: ['字'.repeat(5001)] },
    ]) {
        expect(isSentenceExplanationContext(invalid)).toBe(false);
    }
});
