"""Persistent local queue. Capture, Jev ranking and Anki export run independently."""
from collections import deque
from concurrent.futures import ThreadPoolExecutor
import fcntl
import json
import math
import os
from pathlib import Path
import re
import shutil
import socketserver
import threading
import time

from media import Obs, extract, wall_ranges
from pipeline import Pipeline
from sentence_explanation import Explanations
from jev_ranker import should_recover_unparsed

ROOT = Path(__file__).resolve().parent
SOCKET = ROOT / 'bridge.sock'
MAX_MESSAGE = 256 * 1024


def atomic_json(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False))
    temporary.chmod(0o600)
    temporary.replace(path)


def validate_sample(sample, max_age=10):
    if not isinstance(sample, dict) or not re.fullmatch(r'[a-f0-9-]{36}:\d+', sample.get('session', '')):
        raise ValueError('Invalid playback session.')
    for field in ('wall', 'media', 'rate'):
        value = sample.get(field)
        if type(value) not in (int, float) or not math.isfinite(value):
            raise ValueError('Invalid playback timestamp.')
    if abs(sample['wall'] - time.time()) > max_age or sample['media'] < 0 or not 0 < sample['rate'] <= 8:
        raise ValueError('Playback timestamps are stale or out of range.')
    for field in ('visible', 'playing'):
        if type(sample.get(field)) is not bool:
            raise ValueError('Invalid playback state.')
    for field in ('paused', 'seeking'):
        if field in sample and type(sample[field]) is not bool:
            raise ValueError('Invalid playback state.')
    if 'sequence' in sample and (type(sample['sequence']) is not int or not 0 <= sample['sequence'] < 10**12):
        raise ValueError('Invalid playback sequence.')
    if 'event' in sample and sample['event'] not in (
            'sample', 'play', 'playing', 'pause', 'waiting', 'seeking', 'seeked', 'ratechange', 'ended', 'visibilitychange'):
        raise ValueError('Invalid playback event.')


def merge_samples(existing, incoming):
    """Restore browser history and keep distinct DOM transitions in the same millisecond."""
    points = {}
    for sample in [*existing, *incoming]:
        key = (sample['wall'], sample.get('sequence'), sample['media'], sample['playing'],
               sample['rate'], sample.get('seeking', False))
        points[key] = dict(sample)
    return deque(sorted(points.values(), key=lambda point: (point['wall'], point.get('sequence', 0)))[-2000:], maxlen=2000)


class Queue:
    def __init__(self, config, root=ROOT, resume=True):
        self.config, self.root = config, root
        self.explanations = Explanations(config)
        self.jobs = {}
        self.history = {}
        self.lock = threading.RLock()
        self.active_rankings = set()
        self.capture = ThreadPoolExecutor(max_workers=1, thread_name_prefix='obs-capture')
        self.processing = ThreadPoolExecutor(max_workers=2, thread_name_prefix='card-mining')
        self.ranking = ThreadPoolExecutor(max_workers=2, thread_name_prefix='jev-ranking')
        self.obs_check_pending = False
        self.last_obs_check = 0
        self.last_playing = time.monotonic()
        self.started_buffer = False
        self.obs_error = ''
        self.pipeline = Pipeline(config)
        (root / 'jobs').mkdir(mode=0o700, exist_ok=True)
        for path in (root / 'jobs').glob('*/job.json'):
            job = json.loads(path.read_text())
            self.jobs[job['id']] = job
            if job['state'] not in ('complete', 'failed', 'cancelled'):
                job.pop('exportStarted', None)
                if job.get('hasMedia'):
                    job['state'] = 'ready'
                    if resume:
                        if job.get('requiresChoice') and not job.get('selection') and 'options' not in job:
                            self.ranking.submit(self.rank, job['id'])
                        else:
                            self.processing.submit(self.process, job['id'])
                else:
                    job.update(state='failed', error='Playback capture was interrupted. No Anki card was created.')
                    self.persist(job)

    def persist(self, job):
        atomic_json(Path(job['directory']) / 'job.json', job)

    def change(self, job_id, **updates):
        with self.lock:
            job = self.jobs[job_id]
            job.update(updates)
            self.persist(job)

    def observe(self, sample, history=()):
        validate_sample(sample)
        if not isinstance(history, (list, tuple)) or len(history) > 600:
            raise ValueError('Invalid playback history.')
        for point in history:
            validate_sample(point, max_age=340)
            if point['session'] != sample['session'] or point['wall'] > sample['wall']:
                raise ValueError('Playback history belongs to another timeline.')
        with self.lock:
            self.history[sample['session']] = merge_samples(
                self.history.get(sample['session'], ()), [*history, sample])
            self.history = {key: value for key, value in self.history.items()
                            if value and time.time() - value[-1]['wall'] < 600}
            if sample['playing']:
                self.last_playing = time.monotonic()
            if (self.config.get('enabled') and sample['playing']
                    and time.monotonic() - self.last_obs_check > 10 and not self.obs_check_pending):
                self.obs_check_pending = True
                self.capture.submit(self.ensure_obs)

    def ensure_obs(self):
        try:
            with Obs(self.config) as obs:
                obs.ensure_scene()
                obs.ensure_audio_source()
                self.started_buffer = obs.start() or self.started_buffer
            self.obs_error = ''
        except Exception as error:
            self.obs_error = str(error)
        finally:
            self.last_obs_check = time.monotonic()
            self.obs_check_pending = False

    def stop_idle_buffer(self):
        try:
            with Obs(self.config) as obs:
                obs.ensure_scene()
                if obs.call('GetReplayBufferStatus')['outputActive']:
                    obs.call('StopReplayBuffer')
            self.started_buffer = False
        except Exception as error:
            self.obs_error = str(error)
        finally:
            self.last_obs_check = time.monotonic()
            self.obs_check_pending = False

    def enqueue(self, incoming):
        if not self.config.get('enabled'):
            raise ValueError('Buffered mining is not enabled. Finish the OBS bridge setup first.')
        if not isinstance(incoming, dict) or not re.fullmatch(r'[a-f0-9-]{36}', incoming.get('id', '')):
            raise ValueError('Invalid mining job.')
        if self.config.get('word_selector') == 'jev-ranked' and incoming.get('selectionMode') != 'ranked':
            raise ValueError('Reload asbplayer and refresh the episode to use numbered Jev choices.')
        validate_sample(incoming.get('sample'))
        subtitle = incoming.get('subtitle', {})
        if not isinstance(subtitle.get('text'), str) or not 1 <= len(subtitle['text'].strip()) <= 5000:
            raise ValueError('Invalid subtitle text.')
        start, end = subtitle.get('start'), subtitle.get('end')
        if any(type(x) not in (int, float) or not math.isfinite(x) for x in (start, end)):
            raise ValueError('Invalid subtitle timing.')
        if not 0 <= start < end or end - start > 120 or start > incoming['sample']['media']:
            raise ValueError('The subtitle timing is out of range.')
        self.observe(incoming['sample'], incoming.get('history', ()))
        with self.lock:
            if incoming['id'] in self.jobs:
                return {'queued': True, 'id': incoming['id']}
            if sum(j['state'] not in ('complete', 'failed', 'cancelled') for j in self.jobs.values()) >= 100:
                raise ValueError('100 cards are queued. Check the queue before adding more.')
            directory = self.root / 'jobs' / incoming['id']
            directory.mkdir(mode=0o700)
            job = {'id': incoming['id'], 'sample': incoming['sample'], 'subtitle': dict(subtitle),
                   'title': str(incoming.get('title', ''))[:1000], 'url': str(incoming.get('url', ''))[:3000],
                   'directory': str(directory), 'state': 'waiting for sentence', 'created': time.time(),
                   'hasMedia': False, 'error': '', 'requiresChoice': incoming.get('selectionMode') == 'ranked',
                   'requiresConfirmation': incoming.get('selectionMode') == 'ranked'
                   and incoming.get('reviewBeforeExport') is True, 'confirmed': False}
            self.jobs[job['id']] = job
            self.persist(job)
            if job['requiresChoice']:
                self.ranking.submit(self.rank, job['id'])
            return {'queued': True, 'id': job['id']}

    def rank(self, job_id):
        job = self.jobs[job_id]
        with self.lock:
            if job_id in self.active_rankings or job['state'] in ('cancelled', 'failed'):
                return
            self.active_rankings.add(job_id)
        try:
            candidates = job.get('dictionaryCandidates', job.get('selectionCandidates'))
            if candidates is None:
                candidates = self.pipeline.candidates(job['subtitle']['text'], allow_empty=True)
            result = job.get('rankedResult')
            if result is None:
                result = self.pipeline.rank(job['subtitle']['text'], candidates)
                with self.lock:
                    if job['state'] in ('cancelled', 'failed'):
                        return
                    # Retry a failed fallback without spending another Jev request.
                    self.change(job_id, dictionaryCandidates=candidates, selectionCandidates=candidates, rankedResult=result)
            options = list(result['options'])
            confidence = result.get('unparsedConfidence', 0)
            if should_recover_unparsed(job['subtitle']['text'], candidates, result):
                with self.lock:
                    if job['state'] in ('cancelled', 'failed'):
                        return
                if 'recoveredVocabulary' not in job:
                    recovered = self.pipeline.recover_unparsed(job['subtitle']['text'], candidates)
                    with self.lock:
                        if job['state'] in ('cancelled', 'failed'):
                            return
                        self.change(job_id, recoveredVocabulary=recovered)
                recovered = job['recoveredVocabulary']
                if recovered:
                    # A recovered whole word replaces its misleading fragments.
                    options = [option for option in options if not (
                        candidates[option['index']]['surface'] != recovered['surface']
                        and candidates[option['index']]['surface'] in recovered['surface'])]
                    options.append({'index': len(candidates), 'word': recovered['term'],
                                    'reading': recovered['reading'], 'confidence': confidence,
                                    'definition': recovered['definition'] + '\n' + recovered['definitionEnglish']})
                    candidates = [*candidates, recovered]
                    options.sort(key=lambda option: (-option['confidence'], option['index']))
                    options = options[:9]
            with self.lock:
                if job['state'] in ('cancelled', 'failed'):
                    return
                self.change(job_id, selectionCandidates=candidates, options=options,
                            rankingSeconds=result['seconds'], rankingModel=result['model'],
                            rankingResult=result.get('raw'), selectionError='' if options else
                            'No word meets the confidence threshold. Use the skip shortcut to resume.')
                if job['hasMedia']:
                    self.change(job_id, state='awaiting choice' if options else 'failed',
                                error=job.get('selectionError', ''))
        except Exception as error:
            with self.lock:
                if job['state'] != 'cancelled':
                    self.change(job_id, selectionError=str(error))
                    if job['hasMedia']:
                        self.change(job_id, state='failed', error=str(error))
        finally:
            with self.lock:
                self.active_rankings.discard(job_id)

    @staticmethod
    def selected_word(word):
        result = {'word': word['term'], 'reading': word['reading']}
        if word.get('generatedBy'):
            result['definition'] = word['definition'] + '\n' + word['definitionEnglish']
        return result

    def choose(self, job_id, index):
        with self.lock:
            job = self.jobs.get(job_id)
            if not job or not job.get('requiresChoice') or job['state'] in ('failed', 'cancelled'):
                raise ValueError('This word choice is no longer available.')
            if type(index) is not int or not any(o['index'] == index for o in job.get('options', [])):
                raise ValueError('Choose one of the displayed words.')
            if job.get('selection'):
                if job.get('chosenIndex') != index:
                    raise ValueError('A word has already been chosen for this sentence.')
                return self.selected_word(job['selection'])
            word = job['selectionCandidates'][index]
            self.change(job_id, selection=word, chosenIndex=index, word=word['term'])
            if job['hasMedia']:
                self.processing.submit(self.process, job_id)
            return self.selected_word(word)

    def confirm_choice(self, job_id, card_type='normal'):
        if card_type not in ('normal', 'audio'):
            raise ValueError('Choose a normal or audio card.')
        with self.lock:
            job = self.jobs.get(job_id)
            if (not job or not job.get('requiresConfirmation') or not job.get('selection')
                    or job['state'] in ('cancelled', 'failed')):
                raise ValueError('This word is no longer available to mine.')
            # The first acceptance is final, including retries racing with export.
            if job.get('confirmed'):
                return {'confirmed': True, 'cardType': job.get('cardType', 'normal')}
            self.change(job_id, confirmed=True, cardType=card_type)
            if job['hasMedia']:
                self.processing.submit(self.process, job_id)
            return {'confirmed': True, 'cardType': card_type}

    def cancel_choice(self, job_id):
        with self.lock:
            job = self.jobs.get(job_id)
            if (job and job.get('requiresChoice') and not job.get('exportStarted')
                    and job['state'] != 'complete' and not job.get('confirmed')
                    and (not job.get('selection') or job.get('requiresConfirmation'))):
                self.change(job_id, state='cancelled')
            return {'cancelled': bool(job and job['state'] == 'cancelled')}

    def tick(self):
        with self.lock:
            # Keep the last sentence during a pause. Release our buffer after its five-minute window,
            # without stopping a replay buffer that the user started independently.
            if (self.started_buffer and time.monotonic() - self.last_playing > 300
                    and not self.obs_check_pending and time.monotonic() - self.last_obs_check > 10
                    and not any(j['state'] in ('waiting for sentence', 'saving replay') for j in self.jobs.values())):
                self.obs_check_pending = True
                self.capture.submit(self.stop_idle_buffer)
            for job in self.jobs.values():
                if job['state'] != 'waiting for sentence':
                    continue
                samples = list(self.history.get(job['sample']['session'], []))
                if time.time() - job['created'] > 240:
                    self.change(job['id'], state='failed', error='The sentence did not finish before the buffer expired.')
                    continue
                if not samples or samples[-1]['media'] < job['subtitle']['end']:
                    continue
                try:
                    ranges = wall_ranges(samples, job['subtitle']['start'], job['subtitle']['end'])
                except ValueError as error:
                    self.change(job['id'], state='failed', error=str(error), playbackSamples=samples)
                    continue
                # Freeze this independently of later playback, seeks, or subtitle changes.
                job.update(ranges=ranges, state='saving replay', playbackSamples=samples)
                self.persist(job)
                self.capture.submit(self.save, job['id'])

    def save(self, job_id):
        job = self.jobs[job_id]
        try:
            if job['state'] == 'cancelled':
                return
            with Obs(self.config) as obs:
                replay, captured_at = obs.save()
            allowed = Path(self.config['replay_directory']).resolve()
            if not replay.resolve().is_relative_to(allowed):
                raise ValueError('OBS replay path is outside the configured recording directory.')
            target = Path(job['directory']) / ('replay' + replay.suffix)
            # Move only this newly saved private replay; never delete a user's existing recording.
            shutil.move(str(replay), str(target))
            with self.lock:
                if job['state'] == 'cancelled':
                    target.unlink(missing_ok=True)
                    return
                self.change(job_id, replay=str(target), capturedAt=captured_at, state='extracting media')
            # Extraction runs separately, so ffmpeg cannot hold up the next OBS save.
            self.processing.submit(self.finish_capture, job_id)
        except Exception as error:
            with self.lock:
                if job['state'] != 'cancelled':
                    self.change(job_id, state='failed', error=str(error))

    def finish_capture(self, job_id):
        job = self.jobs[job_id]
        try:
            if job['state'] == 'cancelled':
                return
            extract(self.config, Path(job['replay']), job['capturedAt'], job['ranges'],
                    Path(job['directory']))
            with self.lock:
                if job['state'] == 'cancelled':
                    return
                self.change(job_id, hasMedia=True, state='ready')
            self.process(job_id)
        except Exception as error:
            with self.lock:
                if job['state'] != 'cancelled':
                    self.change(job_id, state='failed', error=str(error))

    def process(self, job_id):
        job = self.jobs[job_id]
        with self.lock:
            if job['state'] == 'cancelled' or job.get('exportStarted'):
                return
            if job.get('requiresChoice') and (not job.get('selection') or not job['hasMedia']):
                if job['hasMedia']:
                    self.change(job_id, state='failed' if job.get('selectionError') else 'awaiting choice',
                                error=job.get('selectionError', ''))
                return
            if job.get('requiresConfirmation') and not job.get('confirmed'):
                self.change(job_id, state='awaiting confirmation')
                return
            job['exportStarted'] = True
        try:
            self.change(job_id, state='choosing word', error='')
            word = job.get('selection')
            if word is None:
                candidates = self.pipeline.candidates(job['subtitle']['text'])
                self.change(job_id, selectionCandidates=candidates)
                word = self.pipeline.choose(job['subtitle']['text'], candidates)
                self.change(job_id, selection=word, word=word['term'])
            self.change(job_id, state='creating card')
            note_id = self.pipeline.export(job, word)
            self.change(job_id, state='complete', noteId=note_id)
            # Retain small mined assets and the receipt; release the large replay only after success.
            if job.get('replay'):
                try:
                    Path(job['replay']).unlink(missing_ok=True)
                except OSError:
                    pass  # A cleanup failure must not turn a successfully created card into a failed job.
        except Exception as error:
            self.change(job_id, state='failed', error=str(error), exportStarted=False)

    def handle(self, request):
        if request.get('action') in ('explain', 'explanation-status'):
            return self.explanations.handle(request)
        action = request.get('action')
        if action == 'observe':
            self.observe(request['sample'])
            return {'observed': True}
        if action == 'enqueue':
            return self.enqueue(request.get('job'))
        if action in ('choose', 'cancel-choice', 'confirm-choice'):
            job_id = request.get('id')
            if not isinstance(job_id, str) or not re.fullmatch(r'[a-f0-9-]{36}', job_id):
                raise ValueError('Invalid mining job ID.')
            if action == 'choose':
                return self.choose(job_id, request.get('index'))
            return (self.confirm_choice(job_id, request.get('cardType', 'normal'))
                    if action == 'confirm-choice' else self.cancel_choice(job_id))
        with self.lock:
            if action == 'job-status':
                job_id = request.get('id')
                if not isinstance(job_id, str) or not re.fullmatch(r'[a-f0-9-]{36}', job_id):
                    raise ValueError('Invalid mining job ID.')
                job = self.jobs.get(job_id)
                if not job:
                    raise ValueError('The mining job was not found.')
                selection = job.get('selection') or {}
                result = {key: job.get(key) for key in ('id', 'state', 'error', 'hasMedia')} | {
                    'word': selection.get('term'), 'reading': selection.get('reading')}
                if selection:
                    result.update(self.selected_word(selection))
                if job.get('requiresChoice'):
                    result.update(options=job.get('options', []), error=job.get('error') or job.get('selectionError', ''))
                return result
            if action == 'status':
                recent = sorted(self.jobs.values(), key=lambda j: j['created'], reverse=True)
                return {'enabled': self.config.get('enabled', False), 'obsError': self.obs_error,
                        'pending': sum(j['state'] not in ('complete', 'failed', 'cancelled') for j in recent),
                        'completed': sum(j['state'] == 'complete' for j in recent),
                        'errorCount': sum(j['state'] == 'failed' for j in recent),
                        'jobs': [{k: j.get(k) for k in ('id', 'state', 'word', 'error', 'hasMedia', 'noteId')}
                                 | {'sentence': j['subtitle']['text'][:80]} for j in recent[:25]]}
            if action == 'retry':
                job = self.jobs.get(request.get('id'))
                if not job or job['state'] != 'failed' or not job['hasMedia']:
                    raise ValueError('Only a failed card with saved media can be retried.')
                self.change(job['id'], state='ready', error='', selectionError='')
                if job.get('requiresChoice') and not job.get('selection') and not job.get('options'):
                    self.ranking.submit(self.rank, job['id'])
                self.processing.submit(self.process, job['id'])
                return {'queued': True}
        raise ValueError('Unsupported buffered mining action.')


def main():
    os.umask(0o077)
    with (ROOT / 'service.lock').open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        queue = Queue(json.loads((ROOT / 'config.json').read_text()))
        SOCKET.unlink(missing_ok=True)

        class Handler(socketserver.StreamRequestHandler):
            def handle(self):
                try:
                    raw = self.rfile.readline(MAX_MESSAGE + 1)
                    if len(raw) > MAX_MESSAGE:
                        raise ValueError('Request too large.')
                    result = queue.handle(json.loads(raw))
                except Exception as error:
                    result = {'error': str(error)}
                self.wfile.write(json.dumps(result, ensure_ascii=False).encode() + b'\n')

        def tick():
            while True:
                try:
                    queue.tick()
                except Exception:
                    import traceback
                    traceback.print_exc()
                time.sleep(0.25)

        threading.Thread(target=tick, daemon=True).start()
        with socketserver.ThreadingUnixStreamServer(str(SOCKET), Handler) as server:
            server.serve_forever()


if __name__ == '__main__':
    main()
