#!/usr/bin/env python3
"""Install the local macOS browser bridge. No account credentials are copied."""
import argparse
import base64
import binascii
import hashlib
import json
from pathlib import Path
import shlex
import shutil
import sys

SOURCE = Path(__file__).resolve().parent
FIREFOX_ID = '{e4b27483-2e73-4762-b2ec-8d988a143a40}'
HOST_NAME = 'com.asbplayer.chatgpt'


def chrome_extension_id(manifest_path):
    manifest = json.loads(Path(manifest_path).read_text())
    key = manifest.get('key')
    if not isinstance(key, str) or not key:
        raise ValueError('The Chrome manifest needs a stable key. Build the release extension first.')
    try:
        public_key = base64.b64decode(key, validate=True)
    except binascii.Error as error:
        raise ValueError('The Chrome manifest key is not valid base64.') from error
    digest = hashlib.sha256(public_key).hexdigest()[:32]
    return ''.join(chr(ord('a') + int(digit, 16)) for digit in digest)


def host_manifest(launcher, browser, extension_id=None):
    manifest = {'name': HOST_NAME, 'description': 'asbplayer ChatGPT subtitle selector',
                'path': str(launcher), 'type': 'stdio'}
    if browser == 'firefox':
        manifest['allowed_extensions'] = [FIREFOX_ID]
    elif browser == 'chrome' and extension_id and len(extension_id) == 32 and all('a' <= c <= 'p' for c in extension_id):
        manifest['allowed_origins'] = [f'chrome-extension://{extension_id}/']
    else:
        raise ValueError('Unsupported browser or invalid Chrome extension ID.')
    return manifest


def write_if_changed(path, content, mode=0o600):
    """Replace atomically, leaving an identical installed bridge untouched."""
    if not path.exists() or path.read_bytes() != content:
        temporary = path.with_name(path.name + '.tmp')
        temporary.write_bytes(content)
        temporary.chmod(mode)
        temporary.replace(path)
    path.chmod(mode)


def install(browser, chrome_manifest, home=None):
    # Validate before changing the installed host or its registrations.
    chrome_id = chrome_extension_id(chrome_manifest) if browser in ('chrome', 'all') else None
    paths = ['/Applications/ChatGPT.app/Contents/Resources/codex', '/Applications/Codex.app/Contents/Resources/codex', shutil.which('codex')]
    codex = next((p for p in paths if p and Path(p).is_file()), None)
    if codex is None:
        raise ValueError('Install Codex and run codex login first.')
    support = (home or Path.home()) / 'Library/Application Support'
    target = support / 'asbplayer-extension/chatgpt-host'
    target.mkdir(parents=True, exist_ok=True)
    target.chmod(0o700)
    for name in ['host.py', 'instructions.txt']:
        write_if_changed(target / name, (SOURCE / name).read_bytes())
    write_if_changed(target / 'config.json', json.dumps({'codex': codex}).encode())
    launcher = target / 'launch'
    command = '#!/bin/sh\nexec ' + shlex.quote(sys.executable) + ' ' + shlex.quote(str(target / 'host.py')) + '\n'
    write_if_changed(launcher, command.encode(), 0o700)
    browsers = ('firefox', 'chrome') if browser == 'all' else (browser,)
    for selected in browsers:
        directory = 'Mozilla' if selected == 'firefox' else 'Google/Chrome'
        manifest_dir = support / directory / 'NativeMessagingHosts'
        manifest_dir.mkdir(parents=True, exist_ok=True)
        manifest = host_manifest(launcher, selected, chrome_id)
        write_if_changed(manifest_dir / f'{HOST_NAME}.json', json.dumps(manifest, indent=2).encode())
        print(f'Installed {selected} ChatGPT subtitle bridge using {codex}')
    if chrome_id:
        print(f'Allowed Chrome extension: {chrome_id}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--browser', choices=['firefox', 'chrome', 'all'], default='firefox')
    parser.add_argument('--chrome-manifest', type=Path,
                        default=SOURCE.parents[1] / 'extension/.output/chrome-mv3/manifest.json')
    args = parser.parse_args()
    try:
        install(args.browser, args.chrome_manifest)
    except (OSError, ValueError) as error:
        parser.exit(1, f'{error}\n')


if __name__ == '__main__':
    main()
