import base64
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch
import uuid

from media import wall_ranges, extract
from pipeline import Pipeline, frequency_ranks, subtitle_dialogue
from service import Queue, merge_samples


def sample(media, wall, playing=True, visible=True, rate=1, session=None):
    return {'media': media, 'wall': wall, 'playing': playing, 'visible': visible, 'rate': rate,
            'session': session or 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa:1',
            'crop': {'x': 0, 'y': 0, 'width': 1, 'height': 1, 'aspect': 16/9}}


class TimelineTests(unittest.TestCase):
    def test_gap_uses_original_heard_interval(self):
        points = [sample(i, 100+i) for i in range(6)]
        self.assertEqual(wall_ranges(points, 1, 3), [[101, 103]])

    def test_pauses_are_removed_from_audio(self):
        points = [sample(0, 100), sample(1, 101, False), sample(1, 120), sample(2, 121), sample(3, 122)]
        self.assertEqual(wall_ranges(points, .5, 2.5), [[100.5, 101], [120, 121.5]])

    def test_resume_at_low_ready_state_does_not_lose_heard_start(self):
        points = [sample(0, 100), sample(1, 101, False), sample(1, 110, False),
                  sample(1.4, 110.4), sample(2, 111), sample(3, 112)]
        self.assertEqual(wall_ranges(points, .5, 2.5), [[100.5, 101], [110, 111.5]])

    def test_same_millisecond_pause_and_resume_are_both_retained(self):
        points = [dict(sample(0, 100), sequence=1), dict(sample(1, 101, False), sequence=2),
                  dict(sample(1, 101), sequence=3), dict(sample(2, 102), sequence=4)]
        # Include an out-of-order delivery and duplicate restoration from the browser.
        merged = list(merge_samples([points[0], points[2]], [points[1], points[2], points[3]]))
        self.assertEqual([s['sequence'] for s in merged], [1, 2, 3, 4])
        self.assertEqual(wall_ranges(merged, .5, 1.5), [[100.5, 101.5]])

    def test_background_timer_gap_does_not_invalidate_continuous_playback(self):
        self.assertEqual(wall_ranges([sample(0, 100), sample(5, 105)], 1, 4), [[101, 104]])

    def test_multiple_dom_pauses_and_rate_change_stitch_all_played_parts(self):
        points = [sample(0, 100), sample(1, 101, False), sample(1, 110),
                  sample(2, 111, False), sample(2, 115, False), sample(2, 120, rate=2),
                  sample(4, 121, rate=2)]
        self.assertEqual(wall_ranges(points, .5, 3), [[100.5, 101], [110, 111], [120, 120.5]])

    def test_missing_transition_is_not_guessed_as_continuous_audio(self):
        with self.assertRaises(ValueError):
            wall_ranges([sample(0, 100), sample(2, 120)], 0, 2)

    def test_playback_rate_change(self):
        points = [sample(0, 100), sample(1, 101, rate=2), sample(3, 102, rate=2)]
        self.assertEqual(wall_ranges(points, .5, 2), [[100.5, 101.5]])

    def test_seek_cannot_silently_supply_wrong_clip(self):
        with self.assertRaises(ValueError):
            wall_ranges([sample(0, 100), sample(10, 101)], 0, 1)

    def test_audio_continues_when_user_switches_to_subtitle_viewer(self):
        self.assertEqual(wall_ranges([sample(0, 100, visible=False), sample(1, 101)], 0, 1), [[100, 101]])

    def test_missing_beginning_is_not_truncated_silently(self):
        with self.assertRaises(ValueError):
            wall_ranges([sample(2, 102), sample(3, 103)], 1, 3)


class QueueTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.queue = Queue({'enabled': True}, self.root)
        self.queue.last_obs_check = time.monotonic()
        self.queue.capture.shutdown()
        self.queue.processing.shutdown()
        self.queue.ranking.shutdown()
        self.queue.capture = Mock()
        self.queue.processing = Mock()
        self.queue.ranking = Mock()

    def tearDown(self):
        self.temporary.cleanup()

    def incoming(self, text='難しい言葉', at=2.5):
        now = time.time()
        return {'id': str(uuid.uuid4()), 'sample': sample(at, now),
                'subtitle': {'text': text, 'start': 1, 'end': 3}, 'title': 'episode'}

    def test_multiple_presses_are_durable_while_first_card_is_processing(self):
        first = self.incoming()
        self.queue.enqueue(first)
        self.queue.change(first['id'], state='choosing word')
        second = self.incoming('次の難しい言葉')
        self.queue.enqueue(second)
        self.assertEqual(len(self.queue.jobs), 2)
        first['subtitle']['text'] = 'changed later'
        stored = json.loads((self.root/'jobs'/second['id']/'job.json').read_text())
        self.assertEqual(stored['subtitle']['text'], '次の難しい言葉')
        self.assertEqual(self.queue.jobs[first['id']]['subtitle']['text'], '難しい言葉')

    def test_enqueue_retry_does_not_duplicate_job(self):
        incoming = self.incoming()
        self.queue.enqueue(incoming)
        self.queue.enqueue(incoming)
        self.assertEqual(len(self.queue.jobs), 1)

    def ranked_job(self, review=False):
        incoming = {**self.incoming(), 'selectionMode': 'ranked', 'reviewBeforeExport': review}
        self.queue.enqueue(incoming)
        word = {'surface': '労力', 'term': '労力', 'reading': 'ろうりょく'}
        self.queue.pipeline.candidates = Mock(return_value=[word])
        self.queue.pipeline.rank = Mock(return_value={'options': [
            {'index': 0, 'word': '労力', 'reading': 'ろうりょく', 'confidence': .8}], 'seconds': .4, 'model': 'jev'})
        self.queue.pipeline.export = Mock(return_value=123)
        return incoming['id']

    def test_ranking_starts_without_waiting_for_audio_and_never_exports_before_choice(self):
        job_id = self.ranked_job()
        self.queue.ranking.submit.assert_called_once_with(self.queue.rank, job_id)
        self.queue.rank(job_id)
        status = self.queue.handle({'action': 'job-status', 'id': job_id})
        self.assertFalse(status['hasMedia'])
        self.assertEqual(status['options'][0]['word'], '労力')
        self.assertIsNone(status['word'])
        self.queue.change(job_id, hasMedia=True)
        self.queue.process(job_id)
        self.queue.pipeline.export.assert_not_called()
        self.queue.handle({'action': 'choose', 'id': job_id, 'index': 0})
        self.queue.process(job_id)
        self.queue.handle({'action': 'choose', 'id': job_id, 'index': 0})
        self.queue.process(job_id)
        self.queue.pipeline.export.assert_called_once()
        self.queue.pipeline.rank.assert_called_once()

    def test_choice_before_media_is_retained_and_only_advertised_indices_are_allowed(self):
        job_id = self.ranked_job()
        self.queue.rank(job_id)
        for index in (-1, 1, True, '0'):
            with self.assertRaises(ValueError):
                self.queue.choose(job_id, index)
        self.assertEqual(self.queue.choose(job_id, 0)['word'], '労力')
        self.queue.process(job_id)
        self.queue.pipeline.export.assert_not_called()
        self.assertFalse(self.queue.cancel_choice(job_id)['cancelled'])
        self.queue.change(job_id, hasMedia=True)
        self.queue.process(job_id)
        self.queue.pipeline.export.assert_called_once()

    def test_cancelled_job_ignores_late_rank_and_never_exports(self):
        job_id = self.ranked_job()
        self.queue.cancel_choice(job_id)
        self.queue.rank(job_id)
        self.queue.process(job_id)
        self.assertEqual(self.queue.jobs[job_id]['state'], 'cancelled')
        self.assertNotIn('options', self.queue.jobs[job_id])
        self.queue.pipeline.export.assert_not_called()
        self.assertEqual(self.queue.handle({'action': 'status'})['pending'], 0)

    def test_selected_word_waits_for_n_and_b_cancels_it_without_export(self):
        job_id = self.ranked_job(review=True)
        self.queue.rank(job_id)
        self.queue.change(job_id, hasMedia=True)
        self.queue.choose(job_id, 0)
        self.queue.process(job_id)
        self.assertEqual(self.queue.jobs[job_id]['state'], 'awaiting confirmation')
        self.assertTrue(self.queue.cancel_choice(job_id)['cancelled'])
        self.queue.process(job_id)
        self.queue.pipeline.export.assert_not_called()
        with self.assertRaises(ValueError):
            self.queue.confirm_choice(job_id)
        self.assertEqual(self.queue.handle({'action': 'status'})['pending'], 0)

    def test_confirm_before_audio_exports_once_after_capture(self):
        job_id = self.ranked_job(review=True)
        self.queue.rank(job_id)
        self.queue.choose(job_id, 0)
        self.queue.handle({'action': 'confirm-choice', 'id': job_id})
        self.queue.process(job_id)
        self.queue.pipeline.export.assert_not_called()
        self.queue.change(job_id, hasMedia=True)
        self.queue.process(job_id)
        self.queue.confirm_choice(job_id)
        self.queue.process(job_id)
        self.queue.pipeline.export.assert_called_once()
        self.assertFalse(self.queue.cancel_choice(job_id)['cancelled'])

    def test_b_wins_over_a_late_choice(self):
        job_id = self.ranked_job(review=True)
        self.queue.rank(job_id)
        self.queue.cancel_choice(job_id)
        with self.assertRaises(ValueError):
            self.queue.choose(job_id, 0)
        self.queue.process(job_id)
        self.queue.pipeline.export.assert_not_called()

    def test_audio_acceptance_survives_restart_and_conflicting_retries(self):
        job_id = self.ranked_job(review=True)
        self.queue.rank(job_id)
        self.queue.choose(job_id, 0)
        self.queue.handle({'action': 'confirm-choice', 'id': job_id, 'cardType': 'audio'})
        self.queue.confirm_choice(job_id, 'normal')
        self.assertEqual(self.queue.jobs[job_id]['cardType'], 'audio')
        self.queue.change(job_id, hasMedia=True)
        restored = Queue({'enabled': True}, self.root, resume=False)
        try:
            restored.pipeline.export = Mock(return_value=123)
            restored.process(job_id)
            self.assertEqual(restored.pipeline.export.call_args.args[0]['cardType'], 'audio')
            restored.confirm_choice(job_id, 'normal')
            restored.process(job_id)
            restored.pipeline.export.assert_called_once()
            self.assertEqual(restored.jobs[job_id]['cardType'], 'audio')
        finally:
            restored.capture.shutdown()
            restored.processing.shutdown()
            restored.ranking.shutdown()

    def test_invalid_card_type_does_not_accept_or_export(self):
        job_id = self.ranked_job(review=True)
        self.queue.rank(job_id)
        self.queue.choose(job_id, 0)
        with self.assertRaises(ValueError):
            self.queue.handle({'action': 'confirm-choice', 'id': job_id, 'cardType': 'other'})
        self.assertFalse(self.queue.jobs[job_id].get('confirmed'))
        self.queue.pipeline.export.assert_not_called()

    def test_chrome_screenshot_is_saved_only_for_its_confirmed_card(self):
        job_id = self.ranked_job(review=True)
        self.queue.rank(job_id)
        self.queue.choose(job_id, 0)
        image = b'\xff\xd8\xff' + b'chrome screenshot fixture' + b'\xff\xd9'
        self.queue.handle({'action': 'confirm-choice', 'id': job_id, 'cardType': 'audio',
                           'screenshot': base64.b64encode(image).decode()})
        job = self.queue.jobs[job_id]
        path = Path(job['directory'])/'screenshot.jpg'
        self.assertEqual(path.read_bytes(), image)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertTrue(json.loads((Path(job['directory'])/'job.json').read_text())['hasScreenshot'])
        self.queue.confirm_choice(job_id, 'normal', base64.b64encode(b'replacement').decode())
        self.assertEqual(path.read_bytes(), image)
        self.assertEqual(job['cardType'], 'audio')

    def test_bad_picture_does_not_lose_audio_or_block_card_confirmation(self):
        for screenshot in ('not base64!', base64.b64encode(b'not jpeg').decode(), 'a'*2_000_001, {}):
            job_id = self.ranked_job(review=True)
            self.queue.rank(job_id)
            self.queue.choose(job_id, 0)
            self.queue.confirm_choice(job_id, screenshot=screenshot)
            job = self.queue.jobs[job_id]
            self.assertTrue(job['confirmed'])
            self.assertFalse(job.get('hasScreenshot'))
            self.assertTrue(job['screenshotError'])
            self.assertFalse((Path(job['directory'])/'screenshot.jpg').exists())

    def test_restart_does_not_accept_an_unconfirmed_word(self):
        job_id = self.ranked_job(review=True)
        self.queue.rank(job_id)
        self.queue.choose(job_id, 0)
        self.queue.change(job_id, hasMedia=True)
        restored = Queue({'enabled': True}, self.root, resume=False)
        try:
            restored.pipeline.export = Mock()
            restored.process(job_id)
            self.assertEqual(restored.jobs[job_id]['state'], 'awaiting confirmation')
            restored.pipeline.export.assert_not_called()
        finally:
            restored.capture.shutdown()
            restored.processing.shutdown()
            restored.ranking.shutdown()

    def test_jev_failure_retains_capture_and_retry_uses_saved_audio(self):
        job_id = self.ranked_job()
        self.queue.pipeline.rank.side_effect = ValueError('Jev unavailable')
        self.queue.rank(job_id)
        self.assertEqual(self.queue.jobs[job_id]['state'], 'waiting for sentence')
        self.queue.change(job_id, hasMedia=True, state='ready')
        self.queue.process(job_id)
        self.assertEqual(self.queue.jobs[job_id]['state'], 'failed')
        self.queue.handle({'action': 'retry', 'id': job_id})
        self.queue.pipeline.rank.side_effect = None
        self.queue.rank(job_id)
        self.assertEqual(self.queue.jobs[job_id]['state'], 'awaiting choice')
        self.queue.choose(job_id, 0)
        self.queue.process(job_id)
        self.queue.pipeline.export.assert_called_once()
        self.queue.capture.submit.assert_not_called()

    def test_stale_extension_cannot_silently_use_luna(self):
        self.queue.config['word_selector'] = 'jev-ranked'
        with self.assertRaisesRegex(ValueError, 'Reload asbplayer'):
            self.queue.enqueue(self.incoming())
        self.assertEqual(self.queue.jobs, {})

    def test_restart_keeps_saved_audio_waiting_for_manual_choice(self):
        job_id = self.ranked_job()
        self.queue.rank(job_id)
        self.queue.change(job_id, hasMedia=True, state='awaiting choice')
        restored = Queue({'enabled': True}, self.root, resume=False)
        try:
            restored.pipeline.export = Mock()
            restored.process(job_id)
            self.assertEqual(restored.jobs[job_id]['state'], 'awaiting choice')
            self.assertEqual(restored.jobs[job_id]['options'][0]['word'], '労力')
            restored.pipeline.export.assert_not_called()
        finally:
            restored.capture.shutdown()
            restored.processing.shutdown()
            restored.ranking.shutdown()

    def test_review_status_exposes_the_selected_word_before_export_finishes(self):
        incoming = self.incoming()
        self.queue.enqueue(incoming)
        self.queue.change(incoming['id'], hasMedia=True)
        word = {'term': '労力', 'reading': 'ろうりょく', 'surface': '労力'}
        self.queue.pipeline.candidates = Mock(return_value=[word])
        self.queue.pipeline.choose = Mock(return_value=word)
        export_started, release_export = threading.Event(), threading.Event()

        def export(*args):
            export_started.set()
            if not release_export.wait(5):
                raise TimeoutError('Test export was never released.')
            return 123

        self.queue.pipeline.export = Mock(side_effect=export)
        worker = threading.Thread(target=self.queue.process, args=(incoming['id'],))
        worker.start()
        try:
            self.assertTrue(export_started.wait(2))
            # Read status while the actual processing thread is blocked inside Anki export.
            result = self.queue.handle({'action': 'job-status', 'id': incoming['id']})
            self.assertEqual(result, {'id': incoming['id'], 'state': 'creating card', 'error': '',
                                      'hasMedia': True, 'word': '労力', 'reading': 'ろうりょく'})
            self.assertNotIn('noteId', self.queue.jobs[incoming['id']])
            self.queue.pipeline.choose.assert_called_once()
        finally:
            release_export.set()
            worker.join(2)
        self.assertEqual(self.queue.jobs[incoming['id']]['noteId'], 123)

    def test_review_status_rejects_invalid_and_unknown_ids(self):
        for job_id in (None, [], '../config.json', str(uuid.uuid4())):
            with self.assertRaises(ValueError):
                self.queue.handle({'action': 'job-status', 'id': job_id})

    def test_waits_for_natural_sentence_end_then_captures_without_model_call(self):
        incoming = self.incoming()
        now = incoming['sample']['wall']
        self.queue.observe(sample(0, now-2.5))
        self.queue.observe(sample(1, now-1.5))
        self.queue.observe(sample(2, now-.5))
        self.queue.enqueue(incoming)
        self.queue.tick()
        self.queue.capture.submit.assert_not_called()
        self.queue.observe(sample(3, now+.5))
        self.queue.tick()
        self.queue.capture.submit.assert_called_once_with(self.queue.save, incoming['id'])
        self.queue.processing.submit.assert_not_called()

    def test_previous_subtitle_in_gap_captures_its_original_interval_immediately(self):
        incoming = self.incoming(at=5)
        now = incoming['sample']['wall']
        for point in range(5):
            self.queue.observe(sample(point, now - 5 + point))
        self.queue.enqueue(incoming)
        self.queue.tick()
        job = self.queue.jobs[incoming['id']]
        self.assertEqual(job['ranges'], [[now - 4, now - 2]])
        self.queue.capture.submit.assert_called_once_with(self.queue.save, incoming['id'])

    def test_browser_history_restores_pause_stitching_after_bridge_restart(self):
        incoming = self.incoming(at=3.5)
        now = incoming['sample']['wall']
        incoming['history'] = [sample(0, now-15), sample(2, now-13, False),
                               sample(2, now-1.5, False), sample(2.4, now-1.1), sample(3, now-.5)]
        self.queue.enqueue(incoming)
        self.queue.tick()
        job = self.queue.jobs[incoming['id']]
        self.assertEqual(job['state'], 'saving replay')
        self.assertEqual(len(job['ranges']), 2)
        for actual, expected in zip(job['ranges'], [[now-14, now-13], [now-1.5, now-.5]]):
            self.assertAlmostEqual(actual[0], expected[0], places=5)
            self.assertAlmostEqual(actual[1], expected[1], places=5)
        self.assertIn('playbackSamples', job)

    def test_queued_mid_sentence_waits_through_dom_pause_then_stitches(self):
        incoming = self.incoming(at=2)
        now = incoming['sample']['wall']
        incoming['sample']['playing'] = False
        incoming['history'] = [sample(0, now-2), sample(1, now-1)]
        self.queue.enqueue(incoming)
        self.queue.tick()
        self.queue.capture.submit.assert_not_called()
        self.queue.observe(sample(2, now+3, False))
        self.queue.observe(sample(2.3, now+3.3))
        self.queue.observe(sample(3, now+4))
        self.queue.tick()
        job = self.queue.jobs[incoming['id']]
        self.assertEqual(job['state'], 'saving replay')
        self.assertEqual(len(job['ranges']), 2)
        self.assertAlmostEqual(sum(b-a for a,b in job['ranges']), 2, places=5)

    def test_rejects_history_from_another_seek_or_episode(self):
        incoming = self.incoming()
        incoming['history'] = [sample(1, incoming['sample']['wall']-1,
                                      session='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb:2')]
        with self.assertRaisesRegex(ValueError, 'another timeline'):
            self.queue.enqueue(incoming)

    def test_idle_shutdown_does_not_stop_a_buffer_started_by_user(self):
        self.queue.last_playing = time.monotonic() - 301
        self.queue.last_obs_check = 0
        self.queue.tick()
        self.queue.capture.submit.assert_not_called()
        self.queue.started_buffer = True
        self.queue.tick()
        self.queue.capture.submit.assert_called_once_with(self.queue.stop_idle_buffer)

    def test_cleanup_failure_does_not_mark_created_note_failed(self):
        incoming = self.incoming()
        self.queue.enqueue(incoming)
        self.queue.change(incoming['id'], selection={'term': '難しい'}, replay='/unwritable/replay.mkv')
        self.queue.pipeline.export = Mock(return_value=123)
        with patch.object(Path, 'unlink', side_effect=PermissionError):
            self.queue.process(incoming['id'])
        self.assertEqual(self.queue.jobs[incoming['id']]['state'], 'complete')
        self.assertEqual(self.queue.jobs[incoming['id']]['noteId'], 123)

    def test_restart_preserves_failure_and_does_not_create_partial_card(self):
        incoming = self.incoming()
        self.queue.enqueue(incoming)
        restored = Queue({'enabled': True}, self.root, resume=False)
        self.assertEqual(restored.jobs[incoming['id']]['state'], 'failed')
        restored.capture.shutdown()
        restored.processing.shutdown()

    def test_failure_is_retryable_only_once_when_media_exists(self):
        incoming = self.incoming()
        self.queue.enqueue(incoming)
        self.queue.change(incoming['id'], state='failed', hasMedia=True)
        request = {'action': 'retry', 'id': incoming['id']}
        self.assertTrue(self.queue.handle(request)['queued'])
        with self.assertRaises(ValueError):
            self.queue.handle(request)
        self.queue.processing.submit.assert_called_once()


class CardTests(unittest.TestCase):
    def test_v_sets_senren_audio_mode_and_n_clears_it_without_losing_media_or_definition(self):
        config = {'card_format': 'Expression', 'deck': 'Mining',
                  'sentence_field': 'sentence', 'audio_field': 'sentenceAudio', 'image_field': 'picture'}
        fields = {'word': {'value': '{expression}'}, 'definition': {'value': '{glossary}'},
                  'audioCard': {'value': 'stale audio setting'}}
        pipeline = Pipeline(config)
        pipeline.yomi = Mock(side_effect=lambda action, _: (
            [{'name': 'Expression', 'type': 'term', 'model': 'Senren', 'fields': fields}]
            if action == 'ankiCardFormats' else {'fields': [
                {'expression': '労力', 'reading': 'ろうりょく', 'glossary': 'effort'}]}))
        pipeline.anki = Mock(side_effect=lambda action, **_: (
            ['word', 'definition', 'audioCard', 'sentence', 'sentenceAudio', 'picture']
            if action == 'modelFieldNames' else ['Mining']))
        word = {'term': '労力', 'reading': 'ろうりょく', 'surface': '労力'}
        for mode, flag in [('audio', '1'), ('normal', '')]:
            with self.subTest(mode=mode):
                note, _ = pipeline.build({'id': 'test', 'cardType': mode, 'hasScreenshot': True,
                                          'subtitle': {'text': '労力に見合った成果'}}, word)
                self.assertEqual(note['fields']['audioCard'], flag)
                self.assertEqual(note['fields']['sentenceAudio'], '[sound:asb_test.mp3]')
                self.assertEqual(note['fields']['picture'], '<img src="asb_test.jpg">')
                self.assertEqual(note['fields']['definition'], 'effort')
                self.assertEqual(note['fields']['sentence'], '<b>労力</b>に見合った成果')
                self.assertEqual(note['deckName'], 'Mining')

    def test_speaker_names_are_removed_before_frequency_ranking(self):
        pipeline = Pipeline({})
        words = [{'term': term, 'reading': reading} for term, reading in
                 [('ラム', 'ラム'), ('らむ', 'らむ'), ('波長', 'はちょう')]]
        pipeline.yomi = Mock(return_value=[{'content': [
            [{'text': 'ラム', 'headwords': [[words[0]], [words[1]]]}],
            [{'text': '波長', 'headwords': [[words[2]]]}]]}])
        result = pipeline.candidates('（ラム）ラムと波長の合う存在…')
        self.assertEqual([c['term'] for c in result], ['波長'])
        self.assertNotIn('（ラム）', pipeline.yomi.call_args.args[1]['text'])

    def test_annotations_do_not_turn_reading_guides_into_names(self):
        dialogue, speakers = subtitle_dialogue('（ラム・レム）呪いは解呪(かいじゅ)された。（スバルの声）本当か')
        self.assertEqual(speakers, {'らむ・れむ', 'らむ', 'れむ', 'すばる'})
        self.assertIn('解呪 された', dialogue)
        self.assertNotIn('かいじゅ', speakers)

    def test_katakana_vocabulary_is_not_globally_blacklisted(self):
        pipeline = Pipeline({})
        pipeline.yomi = Mock(return_value=[{'content': [[{'text': 'ラム', 'headwords': [
            [{'term': 'ラム', 'reading': 'ラム'}]]}]]}])
        self.assertEqual(pipeline.candidates('ラムを飲んだ。')[0]['term'], 'ラム')

    def test_cached_candidates_cannot_bypass_speaker_filter(self):
        pipeline = Pipeline({'codex': 'codex'})
        candidates = [{'surface': 'ラム', 'term': 'ラム'}, {'surface': '波長', 'term': '波長'}]

        def answer(args, **kwargs):
            sent = json.loads(kwargs['input'])
            self.assertEqual([c['index'] for c in sent['candidates']], [1])
            Path(args[args.index('--output-last-message') + 1]).write_text('{"nameSurfaces":[],"index":0}')
            return Mock(returncode=0)

        with patch('pipeline.subprocess.run', side_effect=answer) as run:
            with self.assertRaisesRegex(ValueError, 'proper noun'):
                pipeline.choose('（ラム）ラムと波長の合う存在…', candidates)
            run.assert_called_once()

    def test_model_classified_name_cannot_be_exported_even_if_selected(self):
        pipeline = Pipeline({'codex': 'codex'})

        def answer(args, **kwargs):
            Path(args[args.index('--output-last-message') + 1]).write_text(
                json.dumps({'nameSurfaces': ['ラム'], 'index': 0}))
            return Mock(returncode=0)

        with patch('pipeline.subprocess.run', side_effect=answer) as run:
            with self.assertRaisesRegex(ValueError, 'proper noun'):
                pipeline.choose('ラムと波長の合う存在…', [{'surface': 'ラム', 'term': 'ラム'}])
            run.assert_called_once()

    def test_name_only_sentence_does_not_force_a_card_or_second_request(self):
        pipeline = Pipeline({'codex': 'codex'})

        def answer(args, **kwargs):
            Path(args[args.index('--output-last-message') + 1]).write_text(
                json.dumps({'nameSurfaces': ['レム'], 'index': -1}))
            return Mock(returncode=0)

        with patch('pipeline.subprocess.run', side_effect=answer) as run:
            with self.assertRaisesRegex(ValueError, 'no suitable vocabulary'):
                pipeline.choose('レム！', [{'surface': 'レム', 'term': 'レム'}])
            run.assert_called_once()

    def test_frequency_uses_common_variant_and_keeps_dictionaries_separate(self):
        def frequency(value, dictionary='JPDB', **kwargs):
            return {'dictionary': dictionary, 'frequencyMode': 'rank-based',
                    'frequency': value, 'hasReading': True, **kwargs}
        self.assertEqual(frequency_ranks([
            frequency(65098), frequency(7216), frequency(8100, 'Other'),
            frequency(2, frequencyMode='occurrence-based'), frequency(-1),
            frequency(float('nan')), frequency(1, frequencyMode=None),
        ]), [{'dictionary': 'JPDB', 'rank': 7216, 'readingSpecific': True},
             {'dictionary': 'Other', 'rank': 8100, 'readingSpecific': True}])

    def test_duplicate_headwords_do_not_discard_later_frequency_data(self):
        pipeline = Pipeline({})
        word = {'term': '労力', 'reading': 'ろうりょく', 'sources': [{'matchSource': 'term'}]}
        ranked = {**word, 'frequencies': [{'dictionary': 'JPDB', 'frequencyMode': 'rank-based',
                                         'frequency': 10818, 'hasReading': True}]}
        pipeline.yomi = Mock(return_value=[{'content': [[{'text': '労力', 'headwords': [[word], [ranked]]}]]}])
        candidates = pipeline.candidates('労力')
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0]['matchSources'], ['term'])
        self.assertEqual(candidates[0]['frequencyRanks'], [
            {'dictionary': 'JPDB', 'rank': 10818, 'readingSpecific': True}])

    def test_model_gets_explicit_indices_and_selection_needs_one_request(self):
        pipeline = Pipeline({'codex': 'codex'})
        candidates = [{'surface': 'が', 'term': '駕', 'reading': 'が'},
                      {'surface': 'お隠れ', 'term': 'お隠れ', 'reading': 'おかくれ'}]

        def answer(args, **kwargs):
            sent = json.loads(kwargs['input'])
            self.assertEqual(args[args.index('--model') + 1], 'gpt-6-luna')
            self.assertIn('service_tier="fast"', args)
            self.assertIn('forced_login_method="chatgpt"', args)
            self.assertEqual([c['index'] for c in sent['candidates']], [0, 1])
            Path(args[args.index('--output-last-message') + 1]).write_text('{"nameSurfaces":[],"index":1}')
            return Mock(returncode=0)

        with patch('pipeline.subprocess.run', side_effect=answer) as run:
            self.assertEqual(pipeline.choose('王がお隠れになった', candidates), candidates[1])
            run.assert_called_once()

    def test_export_needs_only_sentence_audio_and_never_a_screenshot(self):
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / 'sentence.mp3').write_bytes(b'audio fixture')
            pipeline = Pipeline({})
            pipeline.build = Mock(return_value=({'fields': {'picture': ''}}, {}))
            pipeline.anki = Mock(side_effect=[[], 'asb_test.mp3', 123])
            self.assertEqual(pipeline.export({'id': 'test', 'directory': directory}, {}), 123)
            stored = pipeline.anki.call_args_list[1]
            self.assertEqual(stored.args, ('storeMediaFile',))
            self.assertEqual(stored.kwargs['filename'], 'asb_test.mp3')

    def test_export_uploads_chrome_image_and_obs_audio_before_creating_card(self):
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory)/'sentence.mp3').write_bytes(b'audio fixture')
            (Path(directory)/'screenshot.jpg').write_bytes(b'image fixture')
            pipeline = Pipeline({})
            pipeline.build = Mock(return_value=({'fields': {'picture': '<img src="asb_test.jpg">'}}, {}))
            pipeline.anki = Mock(side_effect=[[], 'asb_test.mp3', 'asb_test.jpg', 123])
            self.assertEqual(pipeline.export({'id': 'test', 'directory': directory, 'hasScreenshot': True}, {}), 123)
            calls = pipeline.anki.call_args_list
            self.assertEqual(calls[2].kwargs, {'filename': 'asb_test.jpg',
                                              'data': base64.b64encode(b'image fixture').decode()})
            self.assertEqual(calls[3].args, ('addNote',))

    def test_extraction_accepts_an_audio_only_replay_and_does_not_extract_frames(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch('media.subprocess.run') as run:
                run.return_value.stdout = json.dumps({'format': {'duration': '10'}, 'streams': [{'codec_type': 'audio'}]})
                extract({'ffprobe': 'ffprobe', 'ffmpeg': 'ffmpeg'}, Path('replay.mka'), 110, [[102, 104]], Path(directory))
            self.assertEqual(run.call_count, 2)
            self.assertIn('sentence.mp3', run.call_args.args[0][-1])
            self.assertNotIn('-frames:v', run.call_args.args[0])

    def test_lost_anki_response_does_not_create_another_card_on_retry(self):
        pipeline = Pipeline({})
        pipeline.anki = Mock(return_value=[123])
        pipeline.build = Mock()
        self.assertEqual(pipeline.export({'id': 'a-b'}, {'term': '曖昧'}), 123)
        pipeline.anki.assert_called_once_with('findNotes', query='tag:asb_job_ab')
        pipeline.build.assert_not_called()

    def test_word_must_match_exact_yomitan_reading(self):
        config = {'card_format': 'Expression', 'sentence_field': 'sentence', 'audio_field': 'sentenceAudio',
                  'image_field': 'picture', 'deck': 'Mining'}
        pipeline = Pipeline(config)
        pipeline.yomi = Mock(side_effect=[
            [{'name': 'Expression', 'type': 'term', 'model': 'Senren', 'fields': {'word': {'value': '{expression}'}}}],
            {'fields': [{'expression': '昨日', 'reading': 'さくじつ'}]}])
        with self.assertRaisesRegex(ValueError, 'matching the selected word and reading'):
            pipeline.build({'subtitle': {'text': '昨日のこと'}}, {'term': '昨日', 'surface': '昨日', 'reading': 'きのう'})


if __name__ == '__main__':
    unittest.main()
