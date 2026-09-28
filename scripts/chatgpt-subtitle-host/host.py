#!/usr/bin/env python3
"""Firefox native host for subtitle matching through Codex's ChatGPT login."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import time

HOST_DIR = Path(__file__).resolve().parent
MODEL = 'gpt-6-luna'
MAX_MESSAGE = 512 * 1024


def codex_path():
    return json.loads((HOST_DIR / 'config.json').read_text())['codex']


def environment():
    env = os.environ.copy()
    # This integration deliberately uses the saved ChatGPT login, never API billing.
    for name in ('OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'CODEX_THREAD_ID'):
        env.pop(name, None)
    env['RUST_LOG'] = 'off'
    return env


def login_status():
    result = subprocess.run([codex_path(), 'login', 'status'], capture_output=True,
                            text=True, env=environment(), timeout=15)
    return result.returncode == 0 and 'Logged in using ChatGPT' in result.stdout + result.stderr


def complete(prompt):
    if not isinstance(prompt, str) or not 1 <= len(prompt) <= 200000:
        raise ValueError('Invalid subtitle selection request')
    if not login_status():
        raise ValueError('Sign in to ChatGPT with codex login on this computer, then reload the episode.')
    # Native hosts can run concurrently. Serialize and cache identical requests so
    # reloads and duplicate video events do not consume another model request.
    with (HOST_DIR / 'selection.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        cache_path = HOST_DIR / 'selection-cache.json'
        try:
            cache = json.loads(cache_path.read_text())
        except (OSError, ValueError):
            cache = {}
        now = time.time()
        cache = {k: v for k, v in cache.items() if now - v['time'] < 86400}
        key = hashlib.sha256((MODEL + prompt).encode()).hexdigest()
        if key in cache:
            return {'text': cache[key]['text'], 'model': MODEL, 'cached': True}
        with tempfile.TemporaryDirectory(prefix='asbplayer-selection-') as directory:
            work = Path(directory)
            schema = work / 'schema.json'
            schema.write_text(json.dumps({'type': 'object', 'properties': {'index': {'type': ['integer', 'null']}},
                                          'required': ['index'], 'additionalProperties': False}))
            output = work / 'result.json'
            args = [codex_path(), 'exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check',
                    '--sandbox', 'read-only', '--model', MODEL, '--color', 'never', '--json',
                    '--output-schema', str(schema), '--output-last-message', str(output),
                    '-c', 'model_reasoning_effort="low"', '-c', 'service_tier="fast"',
                    '-c', 'web_search="disabled"',
                    '-c', 'forced_login_method="chatgpt"',
                    '-c', 'model_instructions_file=' + json.dumps(str(HOST_DIR / 'instructions.txt'))]
            for feature in ('shell_tool', 'multi_agent', 'apps', 'plugins', 'hooks', 'browser_use',
                            'computer_use', 'image_generation', 'code_mode', 'memories'):
                args += ['-c', 'features.' + feature + '=false']
            args.append('-')
            result = subprocess.run(args, input=prompt, text=True, capture_output=True,
                                    env=environment(), cwd=work, timeout=120)
            if result.returncode != 0 or not output.exists():
                detail = 'ChatGPT subtitle selection failed. Check your Codex login and usage limits.'
                for line in result.stdout.splitlines():
                    try:
                        event = json.loads(line)
                        if event.get('type') == 'turn.failed':
                            detail = str(event.get('error', {}).get('message', detail))[:500]
                    except ValueError:
                        pass
                raise ValueError(detail)
            answer = json.loads(output.read_text())
            index = answer.get('index')
            if index is not None and (type(index) is not int or index < 1):
                raise ValueError('ChatGPT returned an invalid subtitle index')
            text = json.dumps({'index': index})
        if index is not None:
            cache[key] = {'text': text, 'time': now}
            cache = dict(sorted(cache.items(), key=lambda item: item[1]['time'])[-200:])
            cache_path.write_text(json.dumps(cache))
            cache_path.chmod(0o600)
        return {'text': text, 'model': MODEL, 'cached': False}


def handle(message):
    action = message.get('action')
    if action == 'status':
        return {'connected': login_status(), 'model': MODEL}
    if action == 'complete':
        return complete(message.get('prompt'))
    raise ValueError('Unsupported subtitle host action')


def main():
    header = sys.stdin.buffer.read(4)
    if len(header) != 4:
        return
    size = struct.unpack('<I', header)[0]
    if size > MAX_MESSAGE:
        return
    try:
        message = json.loads(sys.stdin.buffer.read(size))
        response = handle(message)
    except subprocess.TimeoutExpired:
        response = {'error': 'ChatGPT subtitle selection timed out. Reload the episode to retry.'}
    except Exception as error:
        response = {'error': str(error)}
    encoded = json.dumps(response).encode()
    sys.stdout.buffer.write(struct.pack('<I', len(encoded)) + encoded)
    sys.stdout.buffer.flush()


if __name__ == '__main__':
    main()
