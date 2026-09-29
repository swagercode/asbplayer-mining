"""Audio regression checks using real ffmpeg, plus dictionary spelling identity."""
import shutil
import subprocess
import tempfile
from pathlib import Path
import unittest
from unittest.mock import Mock

from media import Obs, SilentAudioError, extract, audio_source_settings
from pipeline import Pipeline


@unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'ffmpeg is required')
class CapturedAudioTests(unittest.TestCase):
    def test_capture_is_isolated_to_chrome_and_rejects_desktop_mix(self):
        self.assertEqual(audio_source_settings({}), {'type': 1, 'application': 'com.google.Chrome'})
        self.assertEqual(audio_source_settings({'obs_audio_capture_mode': 'chrome'}),
                         {'type': 1, 'application': 'com.google.Chrome'})
        for mode in ('desktop', 'unknown'):
            with self.assertRaises(ValueError):
                audio_source_settings({'obs_audio_capture_mode': mode})

    def test_desktop_source_is_rejected_before_a_replay_can_be_saved(self):
        obs = Obs({'obs_scene': 'asbplayer'})
        obs.ensure_scene = Mock()
        obs.call = Mock(return_value={'inputKind': 'sck_audio_capture',
                                      'inputSettings': {'type': 0}})
        with self.assertRaisesRegex(ValueError, 'only Google Chrome'):
            obs.save()
        self.assertEqual([call.args[0] for call in obs.call.call_args_list], ['GetInputSettings'])

    def test_silence_rejected_and_quiet_stitched_audio_accepted(self):
        config = {'ffmpeg': shutil.which('ffmpeg'), 'ffprobe': shutil.which('ffprobe')}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name, source in [('silent', 'anullsrc=r=48000:cl=stereo'),
                                 ('quiet', 'sine=frequency=440:sample_rate=48000,volume=0.001')]:
                replay = root/(name + '.mka')
                subprocess.run([config['ffmpeg'], '-v', 'error', '-nostdin', '-f', 'lavfi', '-i', source,
                                '-t', '2', '-c:a', 'pcm_s16le', str(replay)], check=True, capture_output=True)
                if name == 'silent':
                    with self.assertRaises(SilentAudioError):
                        extract(config, replay, 102, [[100, 100.5], [101, 101.5]], root)
                else:
                    extract(config, replay, 102, [[100, 100.5], [101, 101.5]], root)
                    self.assertGreater((root/'sentence.mp3').stat().st_size, 100)

    def test_source_refresh_preserves_old_input_until_replacement_is_configured(self):
        obs = Obs({'obs_scene': 'asbplayer'})
        obs.ensure_scene = Mock()
        obs.ensure_audio_source = Mock()
        def response(action, **data):
            return {'GetInputSettings': {'inputSettings': {'type': 1, 'application': 'com.google.Chrome'}},
                    'GetInputVolume': {'inputVolumeMul': .5},
                    'GetInputAudioTracks': {'inputAudioTracks': {'1': True}},
                    'GetInputList': {'inputs': []},
                    'CreateInput': {'sceneItemId': 77}}.get(action, {})
        obs.call = Mock(side_effect=response)
        obs.refresh_audio_source()
        actions = [call.args[0] for call in obs.call.call_args_list]
        self.assertLess(actions.index('CreateInput'), actions.index('RemoveInput'))
        self.assertLess(actions.index('SetInputAudioTracks'), actions.index('RemoveInput'))
        self.assertNotIn('StopReplayBuffer', actions)
        obs.call.assert_any_call('SetSceneItemEnabled', sceneName='asbplayer', sceneItemId=77, sceneItemEnabled=True)


class KanjiPreferenceTests(unittest.TestCase):
    @staticmethod
    def word(term, reading='いたぶる', surface='いたぶられる'):
        return {'term': term, 'reading': reading, 'surface': surface}

    @staticmethod
    def entry(term, reading, gloss, dictionary='Dictionary'):
        return [{'dictionaryEntries': [{'headwords': [{'index': 0, 'term': term, 'reading': reading}],
                 'definitions': [{'headwordIndices': [0], 'dictionary': dictionary, 'entries': [gloss]}]}]}]

    def test_kanji_variant_uses_same_definition_and_preserves_candidate_index(self):
        pipeline = Pipeline({})
        words = [self.word('いたぶる'), self.word('甚振る')]
        pipeline.yomi = Mock(side_effect=[self.entry(w['term'], w['reading'], 'torment') for w in words])
        options = [{'index': 0, 'word': 'いたぶる', 'reading': 'いたぶる', 'confidence': .8},
                   {'index': 1, 'word': '甚振る', 'reading': 'いたぶる', 'confidence': .1}]
        expected = [{'index': 1, 'word': '甚振る', 'reading': 'いたぶる', 'confidence': .8}]
        self.assertEqual(pipeline.prefer_kanji(options, words), expected)
        self.assertEqual(pipeline.prefer_kanji(options, words), expected)
        self.assertEqual(pipeline.yomi.call_count, 2)  # cached dictionary evidence

    def test_reading_match_cannot_turn_chopsticks_into_a_bridge(self):
        pipeline = Pipeline({})
        words = [self.word('はし', 'はし', 'はし'), self.word('橋', 'はし', 'はし'),
                 self.word('箸', 'はし', 'はし')]
        pipeline.yomi = Mock(side_effect=[self.entry('はし', 'はし', 'chopsticks'),
                                         self.entry('橋', 'はし', 'bridge'),
                                         self.entry('箸', 'はし', 'chopsticks')])
        result = pipeline.prefer_kanji([{'index': 0, 'word': 'はし', 'reading': 'はし', 'confidence': .8}], words)
        self.assertEqual(result[0]['word'], '箸')

    def test_unproven_variant_or_dictionary_outage_preserves_original(self):
        words = [self.word('いる', 'いる', 'いる'), self.word('射る', 'いる', 'いる')]
        options = [{'index': 0, 'word': 'いる', 'reading': 'いる', 'confidence': .8}]
        for responses in ([self.entry('いる', 'いる', 'exist'), self.entry('射る', 'いる', 'shoot')],
                          RuntimeError('Yomitan unavailable')):
            pipeline = Pipeline({})
            pipeline.yomi = Mock(side_effect=responses)
            self.assertEqual(pipeline.prefer_kanji(options, words), options)


if __name__ == '__main__':
    unittest.main()
