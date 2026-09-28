import type { SubtitleModel } from '@project/common';

export type SentenceExplanationContext = { before: string[]; after: string[] };
const contextCount = 3;
const contextWindowMs = 60000;
const maxTextLength = 5000;

/** Freeze nearby dialogue from the selected cue's track, even when explaining an older mining review. */
export function sentenceExplanationContext(
    subtitles: readonly SubtitleModel[],
    selected: SubtitleModel
): SentenceExplanationContext {
    const selectedText = selected.text.trim();
    const nearby = subtitles
        .filter(
            (subtitle) =>
                (subtitle.track ?? 0) === (selected.track ?? 0) &&
                !subtitle.textImage &&
                subtitle.text.trim() &&
                !(
                    subtitle.start === selected.start &&
                    subtitle.end === selected.end &&
                    subtitle.text.trim() === selectedText
                )
        )
        .slice()
        .sort((a, b) => a.start - b.start || a.end - b.end);
    const text = (subtitle: SubtitleModel) => subtitle.text.trim().slice(0, maxTextLength);
    return {
        before: nearby
            .filter((subtitle) => subtitle.start < selected.start && selected.start - subtitle.end <= contextWindowMs)
            .slice(-contextCount)
            .map(text),
        after: nearby
            .filter((subtitle) => subtitle.start >= selected.start && subtitle.start - selected.end <= contextWindowMs)
            .slice(0, contextCount)
            .map(text),
    };
}

export function isSentenceExplanationContext(value: unknown): value is SentenceExplanationContext {
    if (!value || typeof value !== 'object') return false;
    return ['before', 'after'].every((side) => {
        const lines = (value as Record<string, unknown>)[side];
        return (
            Array.isArray(lines) &&
            lines.length <= contextCount &&
            lines.every((line) => typeof line === 'string' && line.trim().length > 0 && line.length <= maxTextLength)
        );
    });
}
