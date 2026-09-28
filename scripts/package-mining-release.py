#!/usr/bin/env python3
"""Package an already-built Chrome extension and macOS bridges into release ZIPs."""
import hashlib
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / 'extension/.output/chrome-mv3'
OUTPUT = ROOT / 'release'


def archive(name, entries):
    target = OUTPUT / name
    with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as bundle:
        for source, path in sorted(entries, key=lambda item: str(item[1])):
            bundle.write(source, path)
    return target


def main():
    if not (BUILD / 'manifest.json').is_file():
        raise SystemExit('Build first: node .yarn/releases/yarn-3.2.0.cjs workspace @project/extension build')
    OUTPUT.mkdir(exist_ok=True)
    built = [p for p in BUILD.rglob('*') if p.is_file() and not p.name.lower().startswith('readme')]
    license = ROOT / 'LICENSE.md'
    files = [archive('asbplayer-mining-chrome.zip', [(p, p.relative_to(BUILD)) for p in built]
                     + [(license, 'LICENSE.md')])]
    # Preserve installer-relative paths, including the stable Chrome manifest key.
    entries = [(p, p.relative_to(ROOT)) for p in built] + [(license, 'LICENSE.md')]
    for folder in ('buffered-mining', 'chatgpt-subtitle-host'):
        for p in (ROOT / 'scripts' / folder).iterdir():
            if (p.is_file() and p.suffix in ('.py', '.txt') and not p.name.startswith('test_')
                    and not p.name.lower().startswith('readme')):
                entries.append((p, p.relative_to(ROOT)))
    files.append(archive('asbplayer-mining-macos.zip', entries))
    checksums = OUTPUT / 'SHA256SUMS'
    checksums.write_text(''.join(f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n' for p in files))
    for path in [*files, checksums]:
        print(path)


if __name__ == '__main__':
    main()
