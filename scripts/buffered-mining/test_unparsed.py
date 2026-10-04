import json
from pathlib import Path
import tempfile
import subprocess
import time
import unittest
from unittest.mock import Mock, patch
import uuid

from luna_fallback import generate, validate, REQUEST_TIMEOUT
from pipeline import Pipeline
from service import Queue

SENTENCE = '（ヴィルヘルム）あれは 何度か 死域(しいき)に踏み込んだ者の目です'
CANDIDATES = [{'surface': '死', 'term': '死', 'reading': 'し'},
              {'surface': '域', 'term': '域', 'reading': 'いき'}]
ANSWER = {'eligible': True, 'surface': '死域', 'term': '死域', 'reading': 'しいき',
          'definition': '死の危険が迫る領域。', 'definitionEnglish': 'a realm of mortal danger',
          'sentenceTranslation': 'Those are the eyes of someone who has entered mortal danger several times.'}
WORD = {k: v for k, v in ANSWER.items() if k != 'eligible'} | {'generatedBy': 'gpt-6-luna'}


class LunaFallbackTests(unittest.TestCase):
    def test_context_reading_and_full_missing_word_are_preserved(self):
        self.assertEqual(validate(ANSWER, SENTENCE, CANDIDATES), WORD)
        self.assertIsNone(validate({'eligible': False}, SENTENCE, CANDIDATES))

    def test_rejects_wrong_surface_speaker_existing_candidate_and_invalid_reading(self):
        for changes in ({'surface': '架空語'}, {'surface': 'ヴィルヘルム', 'term': 'ヴィルヘルム'},
                        {'surface': '死', 'term': '死', 'reading': 'し'}, {'reading': '死域'},
                        {'definition': ''}, {'eligible': 1}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                validate(ANSWER | changes, SENTENCE, CANDIDATES)

    def test_one_tool_free_chatgpt_request_supplies_all_fields(self):
        def answer(args, **kwargs):
            self.assertEqual(args[args.index('--model') + 1], 'gpt-6-luna')
            self.assertIn('forced_login_method="chatgpt"', args)
            self.assertIn('service_tier="fast"', args)
            self.assertIn('features.shell_tool=false', args)
            self.assertNotIn('OPENAI_API_KEY', kwargs['env'])
            self.assertEqual(kwargs['timeout'], REQUEST_TIMEOUT)
            self.assertEqual(json.loads(kwargs['input'])['sentence'], SENTENCE)
            Path(args[args.index('--output-last-message') + 1]).write_text(json.dumps(ANSWER))
            return Mock(returncode=0)
        with patch('luna_fallback.subprocess.run', side_effect=answer) as run:
            self.assertEqual(generate({'codex': '/codex'}, SENTENCE, CANDIDATES), WORD)
        run.assert_called_once()

    def test_timeout_has_a_short_message_without_command_or_local_paths(self):
        timeout = subprocess.TimeoutExpired(['/private/bridge/codex', '--private-value', 'secret'], REQUEST_TIMEOUT)
        with patch('luna_fallback.subprocess.run', side_effect=timeout) as run:
            with self.assertRaisesRegex(ValueError, '^Missing-word lookup timed out\\.') as caught:
                generate({'codex': '/private/bridge/codex'}, SENTENCE, CANDIDATES)
        self.assertNotIn('/private', str(caught.exception))
        self.assertNotIn('secret', str(caught.exception))
        self.assertLess(len(str(caught.exception)), 100)
        self.assertIsNone(caught.exception.__cause__)
        run.assert_called_once()

    def test_bridge_start_failure_does_not_expose_the_executable_path(self):
        with patch('luna_fallback.subprocess.run', side_effect=FileNotFoundError('/private/bridge/codex')):
            with self.assertRaisesRegex(ValueError, '^The missing-word lookup could not start\\.') as caught:
                generate({'codex': '/private/bridge/codex'}, SENTENCE, CANDIDATES)
        self.assertNotIn('/private', str(caught.exception))

    def test_generated_card_bypasses_dictionary_lookup_and_escapes_generated_text(self):
        pipeline = Pipeline({'card_format': 'Expression', 'deck': 'Mining',
                             'sentence_field': 'sentence', 'audio_field': 'sentenceAudio'})
        fields = {'word': {'value': '{expression}'}, 'reading': {'value': '{reading}'},
                  'definition': {'value': '{single-glossary-dictionary}'}, 'notes': {'value': ''},
                  'sentenceTranslation': {'value': ''}, 'wordAudio': {'value': '{audio}'},
                  'pitch': {'value': '{pitch-accents}'}, 'frequency': {'value': '{frequencies}'}}
        pipeline.yomi = Mock(return_value=[{'name': 'Expression', 'type': 'term', 'model': 'Senren', 'fields': fields}])
        pipeline.anki = Mock(side_effect=lambda action, **_: (
            [*fields, 'audioCard', 'sentence', 'sentenceAudio'] if action == 'modelFieldNames' else ['Mining']))
        for mode in ('normal', 'audio'):
            note, media = pipeline.build({'id': 'test', 'cardType': mode, 'requiresChoice': True,
                                          'subtitle': {'text': SENTENCE}}, WORD | {'definition': '<img src=x>'})
            self.assertEqual(note['fields']['word'], '死域')
            self.assertIn('&lt;img src=x&gt;', note['fields']['definition'])
            self.assertEqual(note['fields']['reading'], 'しいき')
            self.assertEqual(note['fields']['audioCard'], '1' if mode == 'audio' else '')
            self.assertEqual(note['fields']['sentenceAudio'], '[sound:asb_test.mp3]')
            self.assertEqual(note['fields']['sentenceTranslation'], WORD['sentenceTranslation'])
            self.assertEqual([note['fields'][k] for k in ('wordAudio', 'pitch', 'frequency')], ['', '', ''])
            self.assertIn('luna_generated', note['tags'])
            self.assertEqual(media, {})
        self.assertTrue(all(call.args[0] == 'ankiCardFormats' for call in pipeline.yomi.call_args_list))


class UnparsedQueueTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.queue = Queue({'enabled': True}, Path(self.temp.name))
        for name in ('capture', 'processing', 'ranking'):
            getattr(self.queue, name).shutdown()
            setattr(self.queue, name, Mock())
        self.queue.last_obs_check = time.monotonic()
        self.queue.pipeline.candidates = Mock(return_value=CANDIDATES)
        self.queue.pipeline.rank = Mock(return_value={'options': [], 'unparsedConfidence': .8, 'seconds': .4, 'model': 'jev'})
        self.queue.pipeline.recover_unparsed = Mock(return_value=WORD)
        self.queue.pipeline.export = Mock(return_value=123)
        self.id = str(uuid.uuid4())
        self.queue.enqueue({'id': self.id, 'selectionMode': 'ranked', 'reviewBeforeExport': True,
                            'subtitle': {'text': SENTENCE, 'start': 1, 'end': 3},
                            'sample': {'session': str(uuid.uuid4()) + ':1', 'media': 2, 'wall': time.time(),
                                       'playing': True, 'visible': True, 'rate': 1}})

    def tearDown(self):
        self.temp.cleanup()

    def test_missing_word_gets_one_luna_proposal_and_still_requires_acceptance(self):
        self.queue.rank(self.id)
        option = self.queue.handle({'action': 'job-status', 'id': self.id})['options'][0]
        self.assertEqual(option['word'], '死域')
        self.assertIn(WORD['definition'], option['definition'])
        selected = self.queue.choose(self.id, option['index'])
        self.assertIn(WORD['definition'], selected['definition'])
        self.queue.change(self.id, hasMedia=True)
        self.queue.process(self.id)
        self.queue.pipeline.export.assert_not_called()
        self.queue.confirm_choice(self.id, 'audio')
        self.queue.process(self.id)
        self.queue.pipeline.export.assert_called_once()
        self.assertEqual(self.queue.pipeline.export.call_args.args[1], WORD)
        self.queue.pipeline.rank.assert_called_once()
        self.queue.pipeline.recover_unparsed.assert_called_once()

    def test_low_unparsed_score_never_calls_luna(self):
        for confidence in (.01, .07, .45, .5, .59, .69):
            with self.subTest(confidence=confidence):
                # Even a very permissive display cutoff must not lower the
                # threshold for spending a Luna call and generating definitions.
                self.queue.config['jev_confidence_threshold'] = .01
                result = {'options': [{'index': 0, 'word': '死', 'reading': 'し', 'confidence': .12}],
                          'unparsedConfidence': confidence, 'seconds': .4, 'model': 'jev'}
                self.queue.change(self.id, rankedResult=result)
                self.queue.rank(self.id)
                self.queue.pipeline.recover_unparsed.assert_not_called()
                self.assertEqual(self.queue.jobs[self.id]['options'], result['options'])

    def test_high_unparsed_score_is_independent_of_dictionary_display_cutoff(self):
        self.queue.config['jev_confidence_threshold'] = .95
        self.queue.pipeline.rank.return_value['unparsedConfidence'] = .82
        self.queue.rank(self.id)
        self.queue.pipeline.recover_unparsed.assert_called_once()
        self.assertEqual(self.queue.jobs[self.id]['options'][0]['word'], '死域')

    def test_repeated_ranking_reuses_the_proposal_and_replaces_component_choices(self):
        self.queue.pipeline.rank.return_value['options'] = [
            {'index': 0, 'word': '死', 'reading': 'し', 'confidence': .1},
            {'index': 1, 'word': '域', 'reading': 'いき', 'confidence': .6}]
        self.queue.rank(self.id)
        self.queue.rank(self.id)
        job = self.queue.jobs[self.id]
        self.assertEqual([(o['index'], o['word']) for o in job['options']], [(2, '死域')])
        self.assertEqual(len(job['selectionCandidates']), 3)
        self.queue.pipeline.rank.assert_called_once()
        self.queue.pipeline.recover_unparsed.assert_called_once()

    def test_empty_dictionary_results_can_still_recover_vocabulary(self):
        self.queue.pipeline.candidates.return_value = []
        self.queue.rank(self.id)
        self.assertEqual(self.queue.jobs[self.id]['options'][0]['index'], 0)

    def test_b_cancels_a_running_fallback_without_late_choices_or_export(self):
        def recover(*_):
            self.queue.cancel_choice(self.id)
            return WORD
        self.queue.pipeline.recover_unparsed.side_effect = recover
        self.queue.rank(self.id)
        self.queue.process(self.id)
        self.assertEqual(self.queue.jobs[self.id]['state'], 'cancelled')
        self.assertNotIn('options', self.queue.jobs[self.id])
        self.queue.pipeline.export.assert_not_called()

    def test_explicit_retry_after_luna_failure_reuses_jev_and_saved_audio(self):
        self.queue.change(self.id, hasMedia=True)
        self.queue.pipeline.recover_unparsed.side_effect = [ValueError('unavailable'), WORD]
        self.queue.rank(self.id)
        self.assertEqual(self.queue.jobs[self.id]['state'], 'failed')
        self.queue.handle({'action': 'retry', 'id': self.id})
        self.queue.rank(self.id)
        self.assertEqual(self.queue.jobs[self.id]['options'][0]['word'], '死域')
        self.queue.pipeline.rank.assert_called_once()
        self.assertEqual(self.queue.pipeline.recover_unparsed.call_count, 2)
        self.queue.pipeline.export.assert_not_called()

    def test_fallback_failure_keeps_dictionary_choices_and_does_not_repeat_requests(self):
        option = {'index': 0, 'word': '死', 'reading': 'し', 'confidence': .8}
        self.queue.pipeline.rank.return_value['options'] = [option]
        self.queue.pipeline.recover_unparsed.side_effect = ValueError('Missing-word lookup timed out.')
        self.queue.change(self.id, hasMedia=True)
        self.queue.rank(self.id)
        result = self.queue.handle({'action': 'job-status', 'id': self.id})
        self.assertEqual(result['state'], 'awaiting choice')
        self.assertEqual(result['options'], [option])
        self.assertEqual(result['error'], '')
        self.assertEqual(self.queue.jobs[self.id]['recoveryWarning'], 'Missing-word lookup timed out.')
        self.assertIsNone(self.queue.jobs[self.id]['recoveredVocabulary'])
        self.queue.rank(self.id)
        self.queue.pipeline.rank.assert_called_once()
        self.queue.pipeline.recover_unparsed.assert_called_once()
        self.queue.pipeline.export.assert_not_called()

    def test_cancel_during_fallback_failure_stays_cancelled(self):
        self.queue.pipeline.rank.return_value['options'] = [{'index': 0, 'word': '死', 'confidence': .8}]
        def recover(*_):
            self.queue.cancel_choice(self.id)
            raise ValueError('Missing-word lookup timed out.')
        self.queue.pipeline.recover_unparsed.side_effect = recover
        self.queue.rank(self.id)
        self.assertEqual(self.queue.jobs[self.id]['state'], 'cancelled')
        self.assertNotIn('options', self.queue.jobs[self.id])
        self.queue.pipeline.export.assert_not_called()


if __name__ == '__main__':
    unittest.main()
