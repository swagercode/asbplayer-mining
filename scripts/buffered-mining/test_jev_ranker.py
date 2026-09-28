import io
import json
import unittest
from unittest.mock import patch

from jev_ranker import options_from, rank


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
        self.assertEqual(set(sent['questions']), {'selection', 'name_0', 'name_1', 'name_2'})

    def test_no_hidden_fallback_when_all_scores_are_low(self):
        self.assertEqual(options_from('', self.words, self.raw, self.surfaces, .9), [])


if __name__ == '__main__':
    unittest.main()
