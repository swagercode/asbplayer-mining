import math
from pathlib import Path
import random
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from subtitle_sync import align, validate, quality


def sequence(seed=13):
    rng = random.Random(seed)
    cursor, cues = 10000, []
    for _ in range(240):
        cursor += rng.randrange(200, 3500)
        duration = rng.randrange(700, 3800)
        cues.append([cursor, cursor+duration])
        cursor += duration
    return cues


class ValidationTests(unittest.TestCase):
    def test_rejects_bad_or_unbounded_timestamps(self):
        for value in ([], 'file path', [[0, math.nan]]*30, [[1, 0]]*30, [[0, 50000000]]*30, [[0, .01]]*30):
            with self.assertRaises(ValueError):
                validate(value)

    def test_missing_second_half_does_not_pass_quality_gate(self):
        ref = sequence()
        self.assertFalse(quality(ref, ref, ref[:120], ref[-1][1]+10000)['accepted'])

    def test_one_language_only_music_does_not_reject_matching_dialogue(self):
        # Independent timelines: one release translates songs, the other does not.
        dialogue = [[a, b] for a, b in sequence() if b < 930000 and (b < 210000 or a > 305000)]
        end = dialogue[-1][1]
        lyrics = [[a, a+2800] for a in range(215000, 300000, 3000)]
        lyrics += [[a, a+2800] for a in range(end+5000, end+90000, 3000)]
        for reference, source in ((dialogue+lyrics, dialogue), (dialogue, dialogue+lyrics)):
            result = quality(reference, source, source, end+95000)
            self.assertTrue(result['accepted'], result)
            self.assertGreater(result['ignoredGapMs'], 150000)

    def test_many_missing_sections_cannot_be_excused_as_music(self):
        ref = sequence()
        incomplete = [[a, b] for a, b in ref
                      if not any(start < a < start+100000 for start in (100000, 300000, 500000, 700000))]
        result = quality(ref, incomplete, incomplete, ref[-1][1]+10000)
        self.assertFalse(result['accepted'], result)
        self.assertEqual(result['ignoredGapMs'], 0)

    def test_matching_music_does_not_hide_wrong_dialogue(self):
        music = [[a, a+2800] for a in range(210000, 300000, 3000)]
        source = sequence(81)+music
        result = quality(sequence()+music, source, source, max(b for _, b in source)+10000)
        self.assertFalse(result['accepted'], result)


@unittest.skipUnless(shutil.which('alass-cli'), 'ALASS is required')
class AlignmentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.reference = sequence()
        self.duration = self.reference[-1][1]+10000

    def tearDown(self):
        self.temp.cleanup()

    def align(self, source, reference=None):
        return align({'source': source, 'reference': reference or self.reference,
                      'duration': self.duration}, self.root)

    def assertAligned(self, result):
        self.assertTrue(result['accepted'], result)
        self.assertEqual(len(result['timings']), len(self.reference))
        self.assertLess(max(abs(a-x) for cue, expected in zip(result['timings'], self.reference)
                            for a, x in zip(cue, expected)), 110)

    def test_constant_offset_and_cached_result(self):
        source = [[a+3000, b+3000] for a, b in self.reference]
        result = self.align(source)
        self.assertAligned(result)
        self.assertFalse(result['cached'])
        with patch('subtitle_sync.subprocess.run', side_effect=AssertionError('Cached alignment reran')):
            self.assertTrue(self.align(source)['cached'])
        self.assertFalse(self.align([[a+2000, b+2000] for a, b in self.reference])['cached'])

    def test_combined_episode_with_a_different_second_half_offset(self):
        source = [[a+(3000 if i < 120 else 62000), b+(3000 if i < 120 else 62000)]
                  for i, (a, b) in enumerate(self.reference)]
        self.assertAligned(self.align(source))

    def test_frame_rate_drift(self):
        source = [[round(a*25/24), round(b*25/24)] for a, b in self.reference]
        self.assertAligned(self.align(source))

    def test_unrelated_episode_is_not_returned_as_a_correction(self):
        result = self.align(sequence(81))
        self.assertFalse(result['accepted'])
        self.assertNotIn('timings', result)

    def test_aligner_timeout_is_bounded_and_does_not_cache_a_result(self):
        with patch('subtitle_sync.subprocess.run', side_effect=subprocess.TimeoutExpired('alass', 15)):
            with self.assertRaises(subprocess.TimeoutExpired):
                self.align(self.reference)
        self.assertFalse((self.root/'subtitle-sync-cache.json').exists())


if __name__ == '__main__':
    unittest.main()
