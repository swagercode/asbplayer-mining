from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock

from pipeline import AlreadyMined, Pipeline, word_tag
from service import Queue


WORD = {'term': '労力', 'reading': 'ろうりょく', 'surface': '労力'}
FORMAT = {'name': 'Expression', 'type': 'term', 'model': 'Senren', 'fields': {
    'word': {'value': '{expression}'}, 'reading': {'value': '{reading}'}}}


def note(term, reading='', **extra):
    return {'noteId': 123, 'tags': [], 'fields': {
        'word': {'value': term}, 'reading': {'value': reading}}, **extra}


class DuplicateTests(unittest.TestCase):
    def pipeline(self, notes):
        pipeline = Pipeline({'card_format': 'Expression'})
        pipeline.yomi = Mock(return_value=[FORMAT])
        pipeline.word_spellings = Mock(return_value={WORD['term']})
        pipeline.build = Mock()
        pipeline.anki = Mock(side_effect=lambda action, **params: (
            [] if action == 'findNotes' and params['query'].startswith('tag:asb_job_') else
            [n['noteId'] for n in notes] if action == 'findNotes' else notes))
        return pipeline

    def test_existing_manual_note_skips_both_card_types_before_media_or_build(self):
        for card_type in ('normal', 'audio'):
            with self.subTest(card_type=card_type):
                pipeline = self.pipeline([note('<b>労力</b>', 'ろうりょく')])
                with self.assertRaises(AlreadyMined) as duplicate:
                    pipeline.export({'id': 'new', 'cardType': card_type}, WORD)
                self.assertEqual(duplicate.exception.note_id, 123)
                pipeline.build.assert_not_called()
                self.assertTrue(all(c.args[0] in ('findNotes', 'notesInfo') for c in pipeline.anki.call_args_list))
                query = pipeline.anki.call_args_list[1].kwargs['query']
                self.assertNotIn('deck:', query)
                self.assertNotIn('note:', query)

    def test_partial_matches_and_different_readings_are_not_duplicates(self):
        pipeline = self.pipeline([note('労力不足', 'ろうりょくぶそく'), note('労力', 'べつのよみ')])
        self.assertIsNone(pipeline.mined_note(WORD))

    def test_readingless_legacy_note_and_furigana_still_match(self):
        for value in (' 労力 ', '<ruby>労力<rt>ろうりょく</rt></ruby>', '労力[ろうりょく]'):
            with self.subTest(value=value):
                self.assertEqual(self.pipeline([note(value)]).mined_note(WORD), 123)

    def test_existing_generated_word_does_not_need_a_dictionary_entry(self):
        word = {'term': '死域', 'reading': 'しいき', 'generatedBy': 'gpt-6-luna'}
        pipeline = self.pipeline([note('死域', 'しいき')])
        self.assertEqual(pipeline.mined_note(word), 123)
        pipeline.word_spellings.assert_not_called()

    def test_word_tag_survives_a_changed_note_type_or_field_names(self):
        pipeline = self.pipeline([{'noteId': 123, 'tags': [word_tag(WORD)], 'fields': {}}])
        self.assertEqual(pipeline.mined_note(WORD), 123)

    def test_spelling_variants_require_shared_dictionary_definitions_not_just_readings(self):
        def entry(term, meaning):
            return {'headwords': [{'index': 0, 'term': term, 'reading': 'いたぶる'}],
                    'definitions': [{'dictionary': 'Dictionary', 'headwordIndices': [0], 'entries': [meaning]}]}
        pipeline = Pipeline({'card_format': 'Expression'})
        pipeline.yomi = Mock(side_effect=lambda action, body: [FORMAT] if action == 'ankiCardFormats' else
                             [{'dictionaryEntries': [entry('甚振る', 'torment')]}]
                             if body['term'] == ['甚振る'] else [{'dictionaryEntries': [
                                 entry('いたぶる', 'torment'), entry('別語', 'unrelated')]}])
        self.assertEqual(pipeline.word_spellings('甚振る', 'いたぶる'), {'甚振る', 'いたぶる'})
        pipeline.anki = Mock(side_effect=[[123], [note('いたぶる', 'いたぶる')]])
        self.assertEqual(pipeline.mined_note({'term': '甚振る', 'reading': 'いたぶる'}), 123)

    def test_anki_lookup_failure_never_creates_a_note(self):
        pipeline = self.pipeline([])
        pipeline.anki.side_effect = [[], ConnectionError('Anki disconnected')]
        with self.assertRaises(ConnectionError):
            pipeline.export({'id': 'new'}, WORD)
        pipeline.build.assert_not_called()

    def test_simultaneous_jobs_for_the_same_word_only_add_one_note(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, 'sentence.mp3').write_bytes(b'audio')
            saved = []
            pipeline = self.pipeline(saved)
            pipeline.build = Mock(return_value=({'fields': {'word': '労力'}, 'tags': [word_tag(WORD)]}, {}))

            def anki(action, **params):
                if action == 'findNotes':
                    return [] if params['query'].startswith('tag:asb_job_') else [n['noteId'] for n in saved]
                if action == 'notesInfo':
                    return saved
                if action == 'addNote':
                    time.sleep(.02)
                    saved.append(note('労力', 'ろうりょく'))
                    return 123
            pipeline.anki.side_effect = anki
            start = threading.Barrier(2)

            def export(job_id):
                start.wait(timeout=2)
                try:
                    return pipeline.export({'id': job_id, 'directory': directory}, WORD)
                except AlreadyMined:
                    return 'skipped'
            with ThreadPoolExecutor(max_workers=2) as pool:
                futures = [pool.submit(export, job_id) for job_id in ('one', 'two')]
                self.assertCountEqual([f.result(timeout=3) for f in futures], [123, 'skipped'])
            self.assertEqual(len(saved), 1)
            self.assertEqual(sum(c.args[0] == 'storeMediaFile' for c in pipeline.anki.call_args_list), 1)

    def test_skipped_job_is_terminal_and_not_a_failed_export_after_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            job_dir = root / 'jobs' / 'test'
            job_dir.mkdir(parents=True)
            replay = job_dir / 'replay.mkv'
            replay.write_bytes(b'replay')
            job = {'id': 'test', 'state': 'ready', 'created': time.time(), 'directory': str(job_dir),
                   'subtitle': {'text': '労力'}, 'selection': WORD, 'hasMedia': True, 'replay': str(replay)}
            (job_dir / 'job.json').write_text(json.dumps(job))
            queue = Queue({'enabled': True}, root, resume=False)
            queue.pipeline.export = Mock(side_effect=AlreadyMined(123))
            try:
                queue.process('test')
                self.assertEqual(queue.jobs['test']['state'], 'already mined')
                self.assertFalse(replay.exists())
                status = queue.handle({'action': 'status'})
                self.assertEqual((status['pending'], status['completed'], status['errorCount']), (0, 0, 0))
                queue.process('test')
                queue.pipeline.export.assert_called_once()
                restored = Queue({'enabled': True}, root)
                try:
                    self.assertEqual(restored.jobs['test']['state'], 'already mined')
                finally:
                    for name in ('capture', 'processing', 'ranking'):
                        getattr(restored, name).shutdown()
            finally:
                for name in ('capture', 'processing', 'ranking'):
                    getattr(queue, name).shutdown()


if __name__ == '__main__':
    unittest.main()
