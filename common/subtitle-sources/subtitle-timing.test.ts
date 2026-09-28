import { describe, expect, it } from '@jest/globals';
import { subtitleEndSeconds } from './subtitle-timing';

describe('subtitle timing', () => {
    it('reads the latest SRT cue, including unsorted cues and fractional seconds', () => {
        expect(
            subtitleEndSeconds('1\n00:52:30,000 --> 00:52:37,010\ntext\n\n2\n00:00:01.0 --> 00:00:02.50\ntext')
        ).toBe(3157.01);
    });
    it('reads ASS Dialogue end times rather than start times or comment timestamps', () => {
        expect(
            subtitleEndSeconds(
                '[Events]\nDialogue: 0,0:47:00.00,0:49:09.93,Default,,0,0,0,,text\nComment: 0,1:00:00.00,1:01:00.00,Default'
            )
        ).toBe(2949.93);
    });
    it('does not infer duration from malformed files or dialogue text', () => {
        expect(subtitleEndSeconds('<html>File not found</html>')).toBeUndefined();
        expect(subtitleEndSeconds('I said 01:00:00,000 --> 02:00:00,000')).toBeUndefined();
        expect(subtitleEndSeconds('00:00:00,000 --> 00:99:99,000')).toBeUndefined();
    });
});
