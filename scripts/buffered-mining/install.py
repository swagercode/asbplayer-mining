#!/usr/bin/env python3
"""Install the private macOS OBS/Luna/Yomitan queue without changing browser playback."""
import argparse
import importlib.util
import json
from pathlib import Path
import shlex
import shutil
import subprocess
import sys

SOURCE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('subtitle_installer', SOURCE.parent / 'chatgpt-subtitle-host/install.py')
subtitle_installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(subtitle_installer)


def install(args):
    home = Path.home()
    python = args.python or home / '.config/gamesentenceminer/python_venv/bin/python'
    subprocess.run([str(python), '-c', 'import websocket'], check=True, capture_output=True)
    support = home / 'Library/Application Support'
    root = support / 'asbplayer-extension/buffered-mining'
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    root.chmod(0o700)
    for name in ('host.py', 'service.py', 'pipeline.py', 'jev_ranker.py', 'luna_fallback.py', 'sentence_explanation.py', 'media.py', 'word-instructions.txt'):
        subtitle_installer.write_if_changed(root / name, (SOURCE / name).read_bytes())
    config_path = root / 'config.json'
    if config_path.exists():
        config = json.loads(config_path.read_text())
    else:
        obs_path = support / 'obs-studio/plugin_config/obs-websocket/config.json'
        obs = json.loads(obs_path.read_text()) if obs_path.exists() else {}
        config = {'enabled': False, 'obs_port': obs.get('server_port', 4455),
                  'obs_password': obs.get('server_password', '') if obs.get('auth_required') else '',
                  'obs_scene': 'asbplayer', 'replay_directory': str(root / 'replays'),
                  'anki_url': 'http://127.0.0.1:8765', 'yomitan_url': 'http://127.0.0.1:19633',
                  'deck': 'Mining', 'card_format': 'Expression', 'sentence_field': 'sentence',
                  'audio_field': 'sentenceAudio', 'image_field': 'picture', 'source_field': 'miscInfo',
                  'ffmpeg': shutil.which('ffmpeg'), 'ffprobe': shutil.which('ffprobe'),
                  'codex': '/Applications/ChatGPT.app/Contents/Resources/codex'}
    config.setdefault('word_selector', 'jev-ranked')
    config.setdefault('jev_confidence_threshold', .05)
    config.setdefault('jev_alternative_confidence_threshold', .7)
    if args.enable:
        config['enabled'] = True
    if not all(config.get(name) and Path(config[name]).is_file() for name in ('ffmpeg', 'ffprobe', 'codex')):
        raise ValueError('Install ffmpeg, ffprobe, and Codex before using the mining bridge.')
    Path(config['replay_directory']).mkdir(mode=0o700, parents=True, exist_ok=True)
    subtitle_installer.write_if_changed(config_path, json.dumps(config, indent=2).encode())
    launch = root / 'launch'
    subtitle_installer.write_if_changed(launch, ('#!/bin/sh\nexec ' + shlex.quote(str(python)) + ' ' +
                                                shlex.quote(str(root / 'host.py')) + '\n').encode(), 0o700)
    extension_id = subtitle_installer.chrome_extension_id(args.chrome_manifest)
    manifest = {'name': 'com.asbplayer.mining', 'description': 'asbplayer buffered sentence mining',
                'path': str(launch), 'type': 'stdio',
                'allowed_origins': ['chrome-extension://' + extension_id + '/']}
    target = support / 'Google/Chrome/NativeMessagingHosts/com.asbplayer.mining.json'
    target.parent.mkdir(parents=True, exist_ok=True)
    subtitle_installer.write_if_changed(target, json.dumps(manifest, indent=2).encode())
    print('Installed buffered mining bridge:', root)
    print('Enabled:', config['enabled'], '| Deck:', config['deck'], '| OBS scene:', config['obs_scene'])


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--python', type=Path)
    parser.add_argument('--enable', action='store_true')
    parser.add_argument('--chrome-manifest', type=Path,
                        default=SOURCE.parents[1] / 'extension/.output/chrome-mv3/manifest.json')
    install(parser.parse_args())
