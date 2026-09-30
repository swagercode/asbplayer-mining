import json
from pathlib import Path
import threading
import unittest
from unittest.mock import patch

from sentence_explanation import Explanations, generate, normalize_context


class SentenceExplanationTests(unittest.TestCase):
    def test_uses_sol_light_chatgpt_fast_and_plain_text_schema(self):
        def run(args, **kwargs):
            self.assertEqual(args[args.index('--model') + 1], 'gpt-6.1-sol')
            for setting in ('model_reasoning_effort="low"', 'service_tier="fast"',
                            'forced_login_method="chatgpt"', 'features.shell_tool=false'):
                self.assertIn(setting, args)
            self.assertNotIn('OPENAI_API_KEY', kwargs['env'])
            self.assertEqual(json.loads(kwargs['input']), {
                'sentence': '品がないのう', 'context': {'before': ['言いがかりか'], 'after': ['まったくじゃ']}})
            instructions = json.loads(next(x.split('=', 1)[1] for x in args if x.startswith('model_instructions_file=')))
            prompt = Path(instructions).read_text()
            self.assertIn('Do not think at length', prompt)
            self.assertIn('entirely in Japanese', prompt)
            self.assertIn('Do not translate into English', prompt)
            Path(args[args.index('--output-last-message') + 1]).write_text(json.dumps({'text': 'Explanation'}))
            return type('Result', (), {'returncode': 0})()
        with patch('sentence_explanation.subprocess.run', side_effect=run), patch.dict('os.environ', {'OPENAI_API_KEY': 'unused'}):
            self.assertEqual(generate({'codex': '/test/codex'}, '品がないのう',
                                      {'before': ['言いがかりか'], 'after': ['まったくじゃ']}),
                             {'text': 'Explanation', 'model': 'gpt-6.1-sol'})

    def test_pending_work_is_deduplicated_and_does_not_block_status(self):
        queue = Explanations({})
        started, finish = threading.Event(), threading.Event()
        def generate_mock(*args):
            started.set()
            finish.wait(2)
            return {'text': 'Done'}
        first, second = 'a' * 36, 'b' * 36
        try:
            with patch('sentence_explanation.generate', side_effect=generate_mock) as run:
                self.assertEqual(queue.handle({'action': 'explain', 'id': first, 'sentence': '文'}), {'pending': True})
                self.assertTrue(started.wait(1))
                self.assertEqual(queue.handle({'action': 'explain', 'id': second, 'sentence': '文'}), {'pending': True})
                self.assertEqual(queue.handle({'action': 'explanation-status', 'id': first}), {'pending': True})
                finish.set()
                queue.pool.shutdown(wait=True)
                self.assertEqual(queue.handle({'action': 'explanation-status', 'id': second}), {'text': 'Done'})
                self.assertEqual(queue.handle({'action': 'explain', 'id': 'c' * 36, 'sentence': '文'}), {'text': 'Done'})
                self.assertEqual(run.call_count, 1)
        finally:
            finish.set()
            queue.pool.shutdown(wait=True)

    def test_validates_requests_and_retries_failures(self):
        queue = Explanations({})
        try:
            for request in ({'id': 'bad', 'sentence': '文'}, {'id': 'a' * 36, 'sentence': ''},
                            {'id': 'a' * 36, 'sentence': '字' * 5001}):
                with self.assertRaises(ValueError): queue.handle({'action': 'explain', **request})
            with patch.object(queue.pool, 'submit') as submit:
                queue.handle({'action': 'explain', 'id': 'a' * 36, 'sentence': '文'})
                queue.jobs['a' * 36]['result'] = {'error': 'Unavailable'}
                queue.handle({'action': 'explain', 'id': 'b' * 36, 'sentence': '文'})
                self.assertEqual(submit.call_count, 2)
                for i in range(100):
                    queue.handle({'action': 'explain', 'id': f'{i:036x}', 'sentence': '文'})
                self.assertLessEqual(len(queue.jobs), 64)
            self.assertIn('error', queue.handle({'action': 'explanation-status', 'id': 'f' * 36}))
        finally: queue.pool.shutdown(wait=True)


    def test_context_is_validated_and_copied(self):
        self.assertEqual(normalize_context(None), {'before': [], 'after': []})
        for context in ([], {}, {'before': ['a'] * 4, 'after': []},
                        {'before': [None], 'after': []}, {'before': [], 'after': ['字' * 5001]},
                        {'before': [], 'after': [' ']}):
            with self.assertRaises(ValueError): normalize_context(context)
        original = {'before': [' 前の文 '], 'after': ['次の文']}
        normalized = normalize_context(original)
        original['before'][0] = '変更後'
        self.assertEqual(normalized, {'before': ['前の文'], 'after': ['次の文']})

    def test_cache_and_request_identity_include_both_sides_of_the_context(self):
        queue = Explanations({})
        before = {'before': ['彼の話'], 'after': []}
        after = {'before': ['彼女の話'], 'after': ['続き']}
        try:
            with patch.object(queue.pool, 'submit') as submit:
                first = {'action': 'explain', 'id': 'a' * 36, 'sentence': 'そうなんだ', 'context': before}
                queue.handle(first)
                queue.jobs['a' * 36]['result'] = {'text': '前の文に基づく説明'}
                self.assertEqual(queue.handle({**first, 'id': 'b' * 36}), {'text': '前の文に基づく説明'})
                self.assertEqual(queue.handle({**first, 'id': 'c' * 36, 'context': after}), {'pending': True})
                self.assertEqual(submit.call_count, 2)
                with self.assertRaises(ValueError): queue.handle({**first, 'context': after})
                queue.handle({**first, 'id': 'd' * 36, 'context': {**before, 'after': ['新しい続き']}})
                self.assertEqual(submit.call_count, 3)
        finally: queue.pool.shutdown(wait=True)


if __name__ == '__main__': unittest.main()
