import json
from pathlib import Path
import threading
import unittest
from unittest.mock import patch

from sentence_explanation import Explanations, generate


class SentenceExplanationTests(unittest.TestCase):
    def test_uses_sol_light_chatgpt_fast_and_plain_text_schema(self):
        def run(args, **kwargs):
            self.assertEqual(args[args.index('--model') + 1], 'gpt-6-sol')
            for setting in ('model_reasoning_effort="low"', 'service_tier="fast"',
                            'forced_login_method="chatgpt"', 'features.shell_tool=false'):
                self.assertIn(setting, args)
            self.assertNotIn('OPENAI_API_KEY', kwargs['env'])
            self.assertEqual(json.loads(kwargs['input']), {'sentence': '品がないのう'})
            instructions = json.loads(next(x.split('=', 1)[1] for x in args if x.startswith('model_instructions_file=')))
            self.assertIn('Do not think at length', Path(instructions).read_text())
            Path(args[args.index('--output-last-message') + 1]).write_text(json.dumps({'text': 'Explanation'}))
            return type('Result', (), {'returncode': 0})()
        with patch('sentence_explanation.subprocess.run', side_effect=run), patch.dict('os.environ', {'OPENAI_API_KEY': 'unused'}):
            self.assertEqual(generate({'codex': '/test/codex'}, '品がないのう'),
                             {'text': 'Explanation', 'model': 'gpt-6-sol'})

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


if __name__ == '__main__': unittest.main()
