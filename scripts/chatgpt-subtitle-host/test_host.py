import io
import json
from pathlib import Path
import struct
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import host


class HostTests(unittest.TestCase):
    def test_rejects_other_commands(self):
        with self.assertRaisesRegex(ValueError, 'Unsupported'):
            host.handle({'action': 'run', 'command': 'anything'})

    def test_rejects_api_key_login(self):
        result = subprocess.CompletedProcess([], 0, '', 'Logged in using an API key')
        with patch.object(host, 'codex_path', return_value='codex'), patch.object(host.subprocess, 'run', return_value=result):
            self.assertFalse(host.login_status())

    def test_caches_identical_prompt_and_keeps_auth_local(self):
        calls = []
        def run(args, **kwargs):
            calls.append(args)
            Path(args[args.index('--output-last-message') + 1]).write_text('{"index":2}')
            self.assertNotIn('OPENAI_API_KEY', kwargs['env'])
            self.assertIn('features.shell_tool=false', args)
            self.assertIn('features.plugins=false', args)
            return subprocess.CompletedProcess(args, 0, '', '')
        with tempfile.TemporaryDirectory() as directory, patch.object(host, 'HOST_DIR', Path(directory)), patch.object(host, 'login_status', return_value=True), patch.object(host, 'codex_path', return_value='codex'), patch.object(host.subprocess, 'run', side_effect=run):
            first = host.complete('Choose episode 23')
            second = host.complete('Choose episode 23')
            self.assertFalse(first['cached'])
            self.assertTrue(second['cached'])
            self.assertEqual(len(calls), 1)
            self.assertEqual(first['text'], second['text'])

    def test_native_message_framing(self):
        request = json.dumps({'action': 'status'}).encode()
        stdin = type('Input', (), {'buffer': io.BytesIO(struct.pack('<I', len(request)) + request)})()
        stdout = type('Output', (), {'buffer': io.BytesIO()})()
        with patch.object(host.sys, 'stdin', stdin), patch.object(host.sys, 'stdout', stdout), patch.object(host, 'login_status', return_value=True):
            host.main()
        data = stdout.buffer.getvalue()
        self.assertEqual(struct.unpack('<I', data[:4])[0], len(data) - 4)
        self.assertTrue(json.loads(data[4:])['connected'])


if __name__ == '__main__':
    unittest.main()
