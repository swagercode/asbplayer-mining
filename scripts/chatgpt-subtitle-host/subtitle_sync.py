"""Align cue timings locally. No dialogue, account login, or audio is needed."""
import fcntl
import hashlib
import json
import math
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

VERSION = 1
MAX_CUES = 5000
MAX_TIME = 12 * 60 * 60 * 1000


def validate(cues):
    if not isinstance(cues, list) or not 30 <= len(cues) <= MAX_CUES:
        raise ValueError('Subtitle alignment needs 30 to 5000 timed cues.')
    for cue in cues:
        if (not isinstance(cue, list) or len(cue) != 2
                or any(type(t) not in (int, float) or not math.isfinite(t) for t in cue)
                or not 0 <= cue[0] < cue[1] <= MAX_TIME
                or round(cue[0]) >= round(cue[1])):
            raise ValueError('Invalid subtitle alignment timestamps.')
    return [[round(a), round(b)] for a, b in cues]


def timestamp(ms):
    seconds, millis = divmod(ms, 1000)
    minutes, seconds = divmod(seconds, 60)
    hours, minutes = divmod(minutes, 60)
    return f'{hours:02}:{minutes:02}:{seconds:02},{millis:03}'


def write_srt(path, cues):
    path.write_text('\n\n'.join(f'{i+1}\n{timestamp(a)} --> {timestamp(b)}\n{i}'
                               for i, (a, b) in enumerate(cues)), encoding='utf-8')


def read_result(path, count):
    cues = [None] * count
    pattern = re.compile(r'(?m)^\d+\s*\n(\d+):(\d+):(\d+),(\d+) --> '
                         r'(\d+):(\d+):(\d+),(\d+)\s*\n(\d+)\s*$')
    for match in pattern.finditer(path.read_text(encoding='utf-8')):
        h, m, s, ms, eh, em, es, ems, i = map(int, match.groups())
        if i >= count or cues[i] is not None:
            raise ValueError('Alignment changed subtitle identities.')
        cues[i] = [((h*60+m)*60+s)*1000+ms, ((eh*60+em)*60+es)*1000+ems]
    return validate(cues)


def activity(cues, count):
    mask = bytearray(count)
    for start, end in cues:
        if end-start > 20000:
            continue  # Static signs/credits are not useful dialogue evidence.
        a, b = max(0, round(start/100)), min(count, round(end/100))
        if b > a:
            mask[a:b] = b'\1' * (b-a)
    return mask


def correlation(a, b):
    n, na, nb = len(a), sum(a), sum(b)
    denominator = math.sqrt(na * nb * (n-na) * (n-nb))
    if denominator == 0:
        return 0.0
    overlap = sum(x & y for x, y in zip(a, b))
    # Chance-corrected speech/silence agreement: dense dialogue in unrelated
    # episodes must not pass just because most timestamps contain speech.
    return (n*overlap-na*nb)/denominator


def quality(reference, source, aligned, duration):
    count = max(1, math.ceil(duration/100))
    ref, before, after = (activity(cues, count) for cues in (reference, source, aligned))
    score, previous = correlation(ref, after), correlation(ref, before)
    windows = []
    for i in range(0, count, 3000):
        a, b = ref[i:i+3000], after[i:i+3000]
        if len(a) >= 600 and sum(a) >= 100:
            windows.append(correlation(a, b))
    accepted = score >= .5 and score >= previous-.02 and bool(windows) and min(windows) >= .25
    return {'accepted': accepted, 'score': round(score, 4), 'previousScore': round(previous, 4),
            'lowestWindowScore': round(min(windows, default=0), 4)}


def align(message, root):
    source, reference = validate(message.get('source')), validate(message.get('reference'))
    duration = message.get('duration')
    if type(duration) not in (float, int) or not math.isfinite(duration) or not 90000 <= duration <= MAX_TIME:
        raise ValueError('Invalid episode duration for subtitle alignment.')
    if max(b for _, b in reference) > duration + 30000:
        raise ValueError('Reference subtitles extend beyond this episode.')
    executable = next((p for p in (shutil.which('alass-cli'), '/opt/homebrew/bin/alass-cli',
                                  '/usr/local/bin/alass-cli') if p and Path(p).is_file()), None)
    if executable is None:
        raise ValueError('Install alass with brew install alass to enable automatic subtitle timing.')
    root = Path(root)
    key = hashlib.sha256(json.dumps([VERSION, source, reference, duration], separators=(',', ':')).encode()).hexdigest()
    with (root/'subtitle-sync.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        cache_file = root/'subtitle-sync-cache.json'
        try:
            cache = json.loads(cache_file.read_text())
        except (OSError, ValueError):
            cache = {}
        if not isinstance(cache, dict):
            cache = {}
        if key in cache:
            return {**cache[key], 'cached': True}
        with tempfile.TemporaryDirectory(prefix='asbplayer-sync-') as directory:
            work = Path(directory)
            write_srt(work/'reference.srt', reference)
            write_srt(work/'source.srt', source)
            subprocess.run([executable, '--interval', '10', '--split-penalty', '15',
                            str(work/'reference.srt'), str(work/'source.srt'), str(work/'aligned.srt')],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=15)
            aligned = read_result(work/'aligned.srt', len(source))
        result = quality(reference, source, aligned, duration)
        if max(b for _, b in aligned) > duration + 30000:
            result['accepted'] = False
        if result['accepted']:
            result['timings'] = aligned
        else:
            result['reason'] = 'The native and Japanese subtitle timings do not match confidently.'
        cache[key] = result
        cache = dict(list(cache.items())[-32:])
        temporary = cache_file.with_suffix('.tmp')
        temporary.write_text(json.dumps(cache))
        temporary.chmod(0o600)
        temporary.replace(cache_file)
        return {**result, 'cached': False}
