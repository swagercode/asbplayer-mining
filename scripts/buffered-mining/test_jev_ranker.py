import io
import json
import unittest
import urllib.error
from unittest.mock import patch

from jev_ranker import (boundary_contexts, options_from, payload_for, rank, respects_reading_guide,
                        should_recover_unparsed, uncovered_kanji_spans)
from pipeline import Pipeline


class RankedJevTests(unittest.TestCase):
    @staticmethod
    def alternatives(raw, words, surfaces, scores=None):
        for i, surface in enumerate(surfaces):
            raw['answers'][f'useful_{i}'] = {'noul': (scores or {}).get(surface, 0)}
            first = next(index for index, word in enumerate(words) if word['surface'] == surface)
            raw['answers'][f'word_{i}'] = {'probabilities': {str(first): 1, '-1': 0}}
        return raw

    def setUp(self):
        self.words = [{'term': word, 'surface': word, 'reading': reading} for word, reading in
                      [('ラム', 'らむ'), ('労力', 'ろうりょく'), ('労力', 'ろうりき'), ('成果', 'せいか')]]
        self.surfaces = ['ラム', '労力', '成果']
        self.raw = {'model': 'jev-1.13.0', 'answers': {
            'selection': {'probabilities': {'0': .4, '1': .3, '2': .2, '3': .05, '-1': .05}},
            'name_0': {'noul': .99}, 'name_1': {'noul': 0}, 'name_2': {'noul': 0},
            'boundary_0': {'noul': .9}, 'boundary_1': {'noul': .9}, 'boundary_2': {'noul': .9}}}
        self.alternatives(self.raw, self.words, self.surfaces)

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
        self.assertEqual(set(sent['questions']), {'selection', 'unparsed', 'name_0', 'name_1', 'name_2',
                                                'boundary_0', 'boundary_1', 'boundary_2',
                                                'word_0', 'word_1', 'word_2', 'useful_0', 'useful_1', 'useful_2'})
        self.assertIn('-2', sent['questions']['selection']['criteria'])
        self.assertEqual(set(sent['questions']['word_1']['criteria']), {'1', '2', '-1'})

    def test_no_hidden_fallback_when_all_scores_are_low(self):
        self.assertEqual(options_from('', self.words, self.raw, self.surfaces, .9), [])

    def test_context_check_rejects_a_rare_boundary_fragment_without_banning_the_spelling(self):
        words = [{'surface': '品性', 'term': '品性', 'reading': 'ひんせい'},
                 {'surface': 'いのう', 'term': 'いのう', 'reading': 'いのう'},
                 {'surface': 'いのう', 'term': '異能', 'reading': 'いのう'}]
        raw = {'answers': {'selection': {'probabilities': {'0': .1, '1': .4, '2': .5}},
                          'name_0': {'noul': 0}, 'name_1': {'noul': 0},
                          'boundary_0': {'noul': .95}, 'boundary_1': {'noul': .35}}}
        self.alternatives(raw, words, ['品性', 'いのう'], {'いのう': .99})
        raw['answers']['word_1']['probabilities'] = {'2': 1, '-1': 0}
        result = options_from('品性にも品がないのう', words, raw, ['品性', 'いのう'], .01)
        self.assertEqual([o['word'] for o in result], ['品性'])
        raw['answers']['boundary_1']['noul'] = .87
        result = options_from('彼のいのう', words, raw, ['品性', 'いのう'], .05)
        self.assertEqual(result[0]['word'], '異能')

    def test_boundary_context_marks_the_actual_surrounding_grammar(self):
        self.assertEqual(boundary_contexts('品がないのう', 'いのう'), ['品がな【いのう】'])
        self.assertEqual(boundary_contexts('（いのう）彼のいのう', 'いのう'), [' 彼の【いのう】'])

    def test_boundary_score_is_not_the_candidate_display_cutoff(self):
        for score in (.35, .5, .55, .6):
            with self.subTest(score=score):
                self.raw['answers']['boundary_1']['noul'] = score
                result = options_from('労力と成果', self.words, self.raw, self.surfaces, .01)
                self.assertEqual([o['word'] for o in result], ['成果'])

    def test_explicit_reading_guide_outranks_a_rarer_dictionary_reading(self):
        words = [{'surface': '輩', 'term': '輩', 'reading': r} for r in ('ともがら', 'やから')]
        sentence = '品性の足りん輩(やから)は'
        payload, surfaces = payload_for(sentence, words)
        self.assertNotIn('0', payload['questions']['selection']['criteria'])
        self.assertIn('1', payload['questions']['selection']['criteria'])
        raw = {'answers': {'selection': {'probabilities': {'0': .9, '1': .1}},
                          'name_0': {'noul': 0}, 'boundary_0': {'noul': .95}}}
        self.alternatives(raw, words, surfaces)
        raw['answers']['word_0']['probabilities'] = {'1': 1, '-1': 0}
        result = options_from(sentence, words, raw, surfaces, .05)
        self.assertEqual([o['reading'] for o in result], ['やから'])
        self.assertTrue(respects_reading_guide('輩（ヤカラ）', words[1]))
        self.assertTrue(respects_reading_guide('輩(ともがら)と輩(やから)', words[0]))
        self.assertTrue(respects_reading_guide('汚(けが)した',
                        {'surface': '汚', 'term': '汚す', 'reading': 'けがす'}))

    def test_strong_alternative_survives_a_dominant_winner_without_adding_every_word(self):
        words = [{'surface': word, 'term': word, 'reading': reading} for word, reading in
                 [('栄誉', 'えいよ'), ('賢人', 'けんじん'), ('皆様', 'みなさま')]]
        surfaces = [word['surface'] for word in words]
        raw = {'answers': {'selection': {'probabilities': {'0': .03, '1': .96, '2': .01}}}}
        for i in range(3):
            raw['answers'][f'name_{i}'] = {'noul': .01}
            raw['answers'][f'boundary_{i}'] = {'noul': .95}
        self.alternatives(raw, words, surfaces, {'栄誉': .88, '賢人': .91, '皆様': .2})
        options = options_from('改めて 栄誉ある 賢人会の皆様に申し上げます', words, raw, surfaces, .05)
        self.assertEqual([(o['word'], o['confidence']) for o in options], [('賢人', .96), ('栄誉', .88)])
        # Rounding the runner-up to zero must not hide a useful alternative.
        raw['answers']['selection']['probabilities']['0'] = 0
        self.assertEqual(len(options_from('', words, raw, surfaces, .05)), 2)
        self.assertEqual([o['word'] for o in options_from('', words, raw, surfaces, .05, .9)], ['賢人'])

    def test_independent_alternative_requires_a_confident_contextual_reading(self):
        self.raw['answers']['selection']['probabilities'] = {'-1': 1}
        self.raw['answers']['useful_1']['noul'] = .95
        for scores in ({'1': .55, '-1': .45}, {'1': .2, '-1': .8}, {'1': .5, '2': .5, '-1': 0}):
            self.raw['answers']['word_1']['probabilities'] = scores
            self.assertEqual(options_from('', self.words, self.raw, self.surfaces, .05), [])
        self.raw['answers']['word_1']['probabilities'] = {'1': .9, '2': .1, '-1': 0}
        options = options_from('', self.words, self.raw, self.surfaces, .05)
        self.assertEqual([(o['reading'], o['confidence']) for o in options], [('ろうりょく', .9)])

    def test_independent_alternatives_do_not_restore_names_or_weak_boundaries(self):
        self.raw['answers']['selection']['probabilities'] = {'-1': 1}
        self.raw['answers']['useful_0']['noul'] = 1
        self.raw['answers']['useful_1']['noul'] = 1
        self.raw['answers']['boundary_1']['noul'] = .55
        self.assertEqual(options_from('ラムの労力', self.words, self.raw, self.surfaces, .05), [])

    def test_independent_scores_reject_malformed_results_and_cross_surface_indices(self):
        for probabilities in ({'3': 1}, {'1': float('nan')}, {}, []):
            with self.subTest(probabilities=probabilities):
                self.raw['answers']['word_1']['probabilities'] = probabilities
                with self.assertRaises(ValueError):
                    options_from('', self.words, self.raw, self.surfaces, .05)
        self.raw['answers']['word_1']['probabilities'] = {'1': 1}
        self.raw['answers']['useful_1']['noul'] = True
        with self.assertRaises(ValueError):
            options_from('', self.words, self.raw, self.surfaces, .05)

    def test_openjev_provider_uses_its_own_endpoint_key_and_model_in_one_request(self):
        response = io.BytesIO(json.dumps(self.raw).encode())
        with patch('jev_ranker.urllib.request.urlopen', return_value=response) as request:
            pipeline = Pipeline({'jev_provider': 'openjev', 'jev_api_key': 'oj_test_placeholder'})
            result = pipeline.rank('ラムの労力と成果', self.words)
        request.assert_called_once()
        sent = request.call_args.args[0]
        self.assertEqual(sent.full_url, 'https://api.openjev.sh/v1/systemone')
        self.assertEqual(sent.get_header('Authorization'), 'Bearer oj_test_placeholder')
        self.assertEqual(json.loads(sent.data)['model'], 'openjev')
        self.assertEqual(result['options'][0]['word'], '労力')

    def test_wrong_provider_cannot_send_openjev_credentials_to_typesafe(self):
        with patch('jev_ranker.urllib.request.urlopen') as request:
            for provider in ('typesafe', 'unknown'):
                with self.subTest(provider=provider), self.assertRaises(ValueError):
                    rank('', self.words, 'oj_test_placeholder', provider=provider)
            request.assert_not_called()

    def test_openjev_failure_never_falls_back_to_paid_provider(self):
        error = urllib.error.HTTPError('https://api.openjev.sh/v1/systemone', 429, 'Limited', {}, None)
        with patch('jev_ranker.urllib.request.urlopen', side_effect=error) as request:
            with self.assertRaisesRegex(ValueError, 'openjev.*429'):
                rank('', self.words, 'oj_test_placeholder', provider='openjev')
        request.assert_called_once()

    def test_openjev_choice_limit_includes_reserved_outcomes(self):
        words = [{'surface': '語', 'term': '語', 'reading': 'ご'}] * 253
        payload, _ = payload_for('語', words, model='openjev')
        self.assertEqual(len(payload['questions']['selection']['criteria']), 255)
        with self.assertRaises(ValueError):
            payload_for('語', [*words, words[0]], model='openjev')

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
