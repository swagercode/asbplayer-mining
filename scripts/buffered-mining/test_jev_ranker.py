import io
import json
import unittest
from unittest.mock import patch

from jev_ranker import options_from, rank, should_recover_unparsed, uncovered_kanji_spans


class RankedJevTests(unittest.TestCase):
    def setUp(self):
        self.words = [{'term': word, 'surface': word, 'reading': reading} for word, reading in
                      [('ラム', 'らむ'), ('労力', 'ろうりょく'), ('労力', 'ろうりき'), ('成果', 'せいか')]]
        self.surfaces = ['ラム', '労力', '成果']
        self.raw = {'model': 'jev-1.13.0', 'answers': {
            'selection': {'probabilities': {'0': .4, '1': .3, '2': .2, '3': .05, '-1': .05}},
            'name_0': {'noul': .99}, 'name_1': {'noul': 0}, 'name_2': {'noul': 0}}}

    def test_filters_names_and_threshold_and_keeps_highest_scored_reading(self):
        options = options_from('ラムの労力と成果', self.words, self.raw, self.surfaces, .05)
        self.assertEqual([(o['index'], o['confidence']) for o in options], [(1, .3), (3, .05)])
        self.assertEqual(options_from('', self.words, self.raw, self.surfaces, .31), [])

    def test_invalid_remote_scores_and_indices_fail_closed(self):
        for value in (float('nan'), -1, 1.1, True, '0.8'):
            self.raw['answers']['selection']['probabilities'] = {'1': value}
            with self.assertRaises(ValueError):
                options_from('', self.words, self.raw, self.surfaces, .05)
        self.raw['answers']['selection']['probabilities'] = {'1234': .8}
        with self.assertRaises(ValueError):
            options_from('', self.words, self.raw, self.surfaces, .05)

    def test_rank_makes_one_request_and_does_not_invent_probabilities(self):
        response = io.BytesIO(json.dumps(self.raw).encode())
        with patch('jev_ranker.urllib.request.urlopen', return_value=response) as request:
            result = rank('ラムの労力と成果', self.words, 'placeholder', .05)
        request.assert_called_once()
        self.assertEqual(result['options'][0]['confidence'], .3)
        sent = json.loads(request.call_args.args[0].data)
        self.assertEqual(sent['model'], 'jev-1.13.0')
        self.assertEqual(set(sent['questions']), {'selection', 'unparsed', 'name_0', 'name_1', 'name_2'})
        self.assertIn('-2', sent['questions']['selection']['criteria'])

    def test_no_hidden_fallback_when_all_scores_are_low(self):
        self.assertEqual(options_from('', self.words, self.raw, self.surfaces, .9), [])

    def test_not_parsed_is_a_separate_result_not_a_negative_dictionary_index(self):
        self.raw['answers']['selection']['probabilities']['-2'] = .7
        with patch('jev_ranker.urllib.request.urlopen', return_value=io.BytesIO(json.dumps(self.raw).encode())):
            result = rank('未知の複合語', self.words, 'placeholder')
        self.assertEqual(result['unparsedConfidence'], .7)
        self.assertTrue(all(option['index'] >= 0 for option in result['options']))

    def test_low_missing_choice_does_not_amplify_an_uncertain_parser_check(self):
        self.raw['answers']['selection']['probabilities']['-2'] = .07
        self.raw['answers']['unparsed'] = {'noul': .45}
        with patch('jev_ranker.urllib.request.urlopen', return_value=io.BytesIO(json.dumps(self.raw).encode())):
            result = rank('きっと 平たんな道は歩けないよね あの子…', self.words, 'placeholder')
        self.assertEqual(result['unparsedConfidence'], .45)

    def test_fallback_requires_strong_evidence_independent_of_display_threshold(self):
        # An uncertain missing-word choice, even with an actual split, stays on
        # the dictionary path. A strong binary score also needs a concrete gap.
        result = {'unparsedConfidence': .45, 'raw': {
            'answers': {'selection': {'probabilities': {'-2': .07}}}}}
        self.assertFalse(should_recover_unparsed('死域', [], result))
        self.assertFalse(should_recover_unparsed('平たんな道', [{'surface': '道'}], result))
        result['unparsedConfidence'] = .9
        self.assertFalse(should_recover_unparsed('平たんな道', [{'surface': '道'}], result))
        result['unparsedConfidence'] = .75
        self.assertTrue(should_recover_unparsed('死域', [{'surface': '死'}, {'surface': '域'}], result))

    def test_covered_words_and_speaker_labels_are_not_split_compound_evidence(self):
        self.assertEqual(uncovered_kanji_spans('（大将）死域に踏み込んだ', [
            {'surface': '死域'}, {'surface': '踏み込んだ'}]), [])
        self.assertEqual(uncovered_kanji_spans('（大将）死域に踏み込んだ', [
            {'surface': '死'}, {'surface': '域'}, {'surface': '踏み込んだ'}]), ['死域'])

    def test_strong_explicit_missing_choice_can_cover_non_kanji_vocabulary(self):
        result = {'unparsedConfidence': .9, 'raw': {
            'answers': {'selection': {'probabilities': {'-2': .9}}}}}
        self.assertTrue(should_recover_unparsed('カタカナの未知語', [{'surface': '未知語'}], result))


if __name__ == '__main__':
    unittest.main()
