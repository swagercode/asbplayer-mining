import unittest
from unittest.mock import Mock

from pipeline import Pipeline
from jev_ranker import payload_for


def token(surface, term=None, reading=None, **metadata):
    part = {'text': surface}
    if term is not None:
        part['headwords'] = [[{'term': term, 'reading': reading or term, **metadata}]]
    return [part]


class CandidateRecoveryTests(unittest.TestCase):
    def pipeline(self, tokens, rescans):
        pipeline = Pipeline({})

        def yomi(action, body):
            self.assertEqual(action, 'tokenize')
            if isinstance(body['text'], str):
                return [{'index': 0, 'content': tokens}]
            # Array responses are identified by index, not their delivery order.
            return [{'index': i, 'content': rescans.get(text, [token(text)])}
                    for i, text in reversed(list(enumerate(body['text'])))]

        pipeline.yomi = Mock(side_effect=yomi)
        return pipeline

    def test_reading_match_cannot_hide_start_of_a_dictionary_word(self):
        word = token('そっ首', 'そっ首', 'そっくび', sources=[{'matchSource': 'term'}],
                     frequencies=[{'dictionary': 'JPDB', 'frequencyMode': 'rank-based',
                                   'frequency': 95347, 'hasReading': True}])
        pipeline = self.pipeline([
            token('妾', '妾', 'わらわ'), token('がそ', '画素', 'がそ'),
            token('っ'), token('首', '首', 'くび'), token('を', 'を')],
            {'そっ首を': [word, token('を', 'を')]})
        candidates = pipeline.candidates('妾(わらわ)がそっ首を')
        recovered = next(c for c in candidates if c['term'] == 'そっ首')
        self.assertEqual(recovered['surface'], 'そっ首')
        self.assertEqual(recovered['reading'], 'そっくび')
        self.assertEqual(recovered['frequencyRanks'][0]['rank'], 95347)
        self.assertEqual(recovered['matchSources'], ['term'])
        self.assertEqual(pipeline.yomi.call_count, 2)
        self.assertEqual(pipeline.yomi.call_args.args[1]['text'], ['そっ首を'])

    def test_recovery_can_cross_several_greedy_tokens(self):
        pipeline = self.pipeline([
            token('顔', '顔'), token('にか', '二化'), token('さぶ', '寂ぶ'), token('た', 'た')],
            {'かさぶた': [token('かさぶた', '瘡蓋', 'かさぶた')],
             'ぶた': [token('ぶた', '豚', 'ぶた')]})
        candidates = pipeline.candidates('顔にかさぶた')
        self.assertIn(('かさぶた', '瘡蓋'), [(c['surface'], c['term']) for c in candidates])
        self.assertNotIn('豚', [c['term'] for c in candidates])
        self.assertEqual(pipeline.yomi.call_count, 2)

    def test_a_recovered_fragment_can_still_be_a_whole_word_elsewhere(self):
        pipeline = self.pipeline([
            token('にか', '二化'), token('さぶ', '寂ぶ'), token('た'), token(' '),
            token('にぶ', '鈍い'), token('た')],
            {'かさぶた': [token('かさぶた', '瘡蓋', 'かさぶた')],
             'ぶた': [token('ぶた', '豚', 'ぶた')]})
        candidates = pipeline.candidates('にかさぶた にぶた')
        self.assertEqual([c['term'] for c in candidates].count('豚'), 1)
        self.assertIn('瘡蓋', [c['term'] for c in candidates])

    def test_recovery_preserves_deinflection_and_multipart_tokens(self):
        recovered = token('つきまと', '付き纏う', 'つきまとう') + [{'text': 'って'}]
        pipeline = self.pipeline([
            token('予感', '予感'), token('がつ', '月'), token('き', '気'), token('まとって', '纏う')],
            {'つきまとって': [recovered]})
        candidates = pipeline.candidates('予感がつきまとって')
        self.assertIn(('つきまとって', '付き纏う'), [(c['surface'], c['term']) for c in candidates])

    def test_intact_word_components_and_later_probe_tokens_are_not_added(self):
        pipeline = self.pipeline([token('取り返した', '取り返す'), token('物', '物')],
                                 {'返した物': [token('返した', '返す'), token('物', '謎の余分な候補')]})
        self.assertEqual([c['term'] for c in pipeline.candidates('取り返した物')], ['取り返す', '物'])

    def test_probes_do_not_cross_spaces_punctuation_or_sentence_end(self):
        for separator in (' ', '\n', '、', '。', ''):
            text = '画素' + separator
            pipeline = self.pipeline([token('画素', '画素'), token(separator)], {})
            pipeline.candidates(text)
            pipeline.yomi.assert_called_once()
        pipeline = self.pipeline([token('あいうえお')], {})
        self.assertEqual(pipeline.candidates('あいうえお', allow_empty=True), [])
        pipeline.yomi.assert_called_once()

    def test_unaligned_parse_does_not_guess_offsets(self):
        pipeline = self.pipeline([token('がそ', '画素'), token('首', '首')], {})
        pipeline.candidates('がそっ首')
        pipeline.yomi.assert_called_once()

    def test_duplicate_recovered_words_merge_dictionary_metadata(self):
        word = token('そっ首', 'そっ首', 'そっくび')
        ranked = token('そっ首', 'そっ首', 'そっくび', frequencies=[{
            'dictionary': 'JPDB', 'frequencyMode': 'rank-based', 'frequency': 95347}])
        word[0]['headwords'] += ranked[0]['headwords']
        pipeline = self.pipeline([
            token('そっ首', 'そっ首', 'そっくび'), token('がそ', '画素'), token('っ'), token('首', '首')],
            {'そっ首': [word]})
        candidates = pipeline.candidates('そっ首がそっ首')
        recovered = [c for c in candidates if c['term'] == 'そっ首']
        self.assertEqual(len(recovered), 1)
        self.assertEqual(recovered[0]['frequencyRanks'][0]['rank'], 95347)

    def test_recovery_keeps_the_single_request_choice_budget(self):
        original = token('がそ', '画素')
        original[0]['headwords'][0] += [{'term': '語' + str(i), 'reading': 'ご'} for i in range(251)]
        extras = token('そっ首', 'そっ首', 'そっくび')
        extras[0]['headwords'][0] += [{'term': '素首', 'reading': 'そっくび'}]
        pipeline = self.pipeline([original, token('っ首')], {'そっ首': [extras]})
        candidates = pipeline.candidates('がそっ首')
        self.assertEqual(len(candidates), 253)
        self.assertEqual(candidates[-1]['term'], 'そっ首')
        payload, _ = payload_for('がそっ首', candidates, model='openjev')
        self.assertEqual(len(payload['questions']['selection']['criteria']), 255)

    def test_frequency_metadata_is_sent_once_without_losing_candidate_ids(self):
        word = {'surface': 'そっ首', 'term': 'そっ首', 'reading': 'そっくび',
                'frequencyRanks': [{'dictionary': 'JPDB', 'rank': 95347}], 'matchSources': ['term']}
        payload, _ = payload_for('がそっ首', [word], model='openjev')
        self.assertEqual(payload['state']['candidates'], [{**word, 'index': 0}])
        self.assertEqual(payload['questions']['selection']['criteria']['0'],
                         {'surface': 'そっ首', 'word': 'そっ首', 'reading': 'そっくび'})


if __name__ == '__main__':
    unittest.main()
