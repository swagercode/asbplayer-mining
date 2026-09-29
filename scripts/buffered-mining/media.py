"""OBS replay saves and conversion from the player's clock to replay timestamps."""
import base64
import hashlib
import json
import math
from pathlib import Path
import re
import subprocess
import time
import uuid


class SilentAudioError(ValueError):
    pass


def audio_source_settings(config):
    mode = config.get('obs_audio_capture_mode', 'chrome')
    if mode == 'desktop':
        return {'type': 0}
    if mode == 'chrome':
        return {'type': 1, 'application': 'com.google.Chrome'}
    raise ValueError('Choose chrome or desktop for obs_audio_capture_mode.')


def validate_audio(config, path):
    """Reject digital silence, without rejecting quiet speech or pauses within a clip."""
    result = subprocess.run([config['ffmpeg'], '-hide_banner', '-nostdin', '-i', str(path),
                             '-vn', '-af', 'volumedetect', '-f', 'null', '-'],
                            capture_output=True, text=True, check=True, timeout=30)
    match = re.search(r'max_volume:\s*(-?inf|[-\d.]+) dB', result.stderr)
    if not match:
        raise ValueError('Could not verify the captured sentence audio; no card was created.')
    peak = float(match[1])
    if not math.isfinite(peak) or peak <= -90:
        raise SilentAudioError('OBS captured silence, so no card was created. The OBS audio source '
                               'is being refreshed. Let the sentence play naturally before mining again.')


def wall_ranges(samples, start, end):
    """Return heard intervals, omitting pauses, stalls, and seeks; audio continues in background tabs."""
    ranges = []
    covered = start
    for a, b in zip(samples, samples[1:]):
        if a.get('seeking') or b.get('seeking') or a.get('session') != b.get('session'):
            continue
        delta = b['media'] - a['media']
        elapsed = b['wall'] - a['wall']
        if delta <= 0 or elapsed <= 0:
            continue
        duration = delta / a['rate']
        if duration > elapsed + 0.1:
            continue  # A forward seek or inconsistent clock, not heard audio.
        if a['playing']:
            if b['playing'] and abs(duration - elapsed) > 0.1:
                continue  # Missing stop/resume boundary: do not guess where speech occurred.
            left = a['wall']
            right = min(b['wall'], left + duration)
        elif b['playing']:
            # play can fire at HAVE_CURRENT_DATA before playing fires. Any media-clock
            # advance leading into playing was heard at the end of this wall interval.
            right = b['wall']
            left = max(a['wall'], right - duration)
        else:
            continue
        lo, hi = max(start, a['media']), min(end, b['media'])
        if hi <= lo:
            continue
        if lo > covered + 0.15:
            raise ValueError('Part of this sentence was not captured. Let it play naturally before mining.')
        ratio = (right - left) / delta
        left, right = left + (lo - a['media']) * ratio, left + (hi - a['media']) * ratio
        if ranges and abs(ranges[-1][1] - left) < 0.08:
            ranges[-1][1] = right
        else:
            ranges.append([left, right])
        covered = max(covered, hi)
    if not ranges or covered < end - 0.15:
        raise ValueError('The complete sentence is not in the captured playback history yet.')
    return ranges


class Obs:
    def __init__(self, config):
        self.config = config
        self.ws = None
        self.events = []

    def __enter__(self):
        import websocket
        self.ws = websocket.create_connection('ws://127.0.0.1:' + str(self.config['obs_port']), timeout=15)
        hello = json.loads(self.ws.recv())['d']
        identify = {'rpcVersion': 1, 'eventSubscriptions': 64}
        if 'authentication' in hello:
            auth = hello['authentication']
            password = self.config.get('obs_password', '')
            secret = base64.b64encode(hashlib.sha256((password + auth['salt']).encode()).digest()).decode()
            identify['authentication'] = base64.b64encode(hashlib.sha256((secret + auth['challenge']).encode()).digest()).decode()
        self.ws.send(json.dumps({'op': 1, 'd': identify}))
        if json.loads(self.ws.recv())['op'] != 2:
            raise ValueError('OBS authentication failed.')
        return self

    def __exit__(self, *args):
        if self.ws:
            self.ws.close()

    def call(self, action, **data):
        request_id = str(uuid.uuid4())
        self.ws.send(json.dumps({'op': 6, 'd': {'requestType': action, 'requestId': request_id, 'requestData': data}}))
        while True:
            message = json.loads(self.ws.recv())
            if message['op'] == 5:
                self.events.append(message['d'])
            if message['op'] == 7 and message['d']['requestId'] == request_id:
                result = message['d']
                if not result['requestStatus']['result']:
                    raise ValueError(action + ': ' + result['requestStatus'].get('comment', 'OBS request failed'))
                return result.get('responseData', {})

    def ensure_scene(self):
        scene = self.call('GetCurrentProgramScene')['currentProgramSceneName']
        if scene != self.config['obs_scene']:
            raise ValueError('Select the dedicated asbplayer scene in OBS before mining.')

    def start(self):
        self.ensure_scene()
        if not self.call('GetReplayBufferStatus')['outputActive']:
            self.call('StartReplayBuffer')
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                if self.call('GetReplayBufferStatus')['outputActive']:
                    return True
                time.sleep(.1)
            raise ValueError('OBS did not start its audio buffer. Check its output settings or pending dialog.')
        return False

    def ensure_audio_source(self):
        name = 'asbplayer Chrome audio'
        source = self.call('GetInputSettings', inputName=name)
        expected = audio_source_settings(self.config)
        if (source['inputKind'] != 'sck_audio_capture'
                or any(source['inputSettings'].get(key) != value for key, value in expected.items())):
            raise ValueError('Configure the dedicated OBS audio source for the selected capture mode.')
        inputs = self.call('GetInputList')['inputs']
        if any(i['inputKind'] in ('screen_capture', 'display_capture', 'window_capture') for i in inputs):
            raise ValueError('Remove screen-capture sources from the audio-only asbplayer OBS collection.')
        item = self.call('GetSceneItemId', sceneName=self.config['obs_scene'], sourceName=name)['sceneItemId']
        if not self.call('GetSceneItemEnabled', sceneName=self.config['obs_scene'], sceneItemId=item)['sceneItemEnabled']:
            raise ValueError('Enable the Chrome audio source in OBS.')
        if self.call('GetInputMute', inputName=name)['inputMuted']:
            raise ValueError('Unmute the Chrome audio source in OBS.')

    def refresh_audio_source(self):
        """Recreate only the dedicated audio source and retain its capture mode.

        SetInputSettings alone reuses OBS's cached SCRunningApplication, which can
        point at a Chrome process that has exited. Keep the replay buffer running.
        """
        self.ensure_scene()
        self.ensure_audio_source()
        name = 'asbplayer Chrome audio'
        settings = self.call('GetInputSettings', inputName=name)['inputSettings']
        volume = self.call('GetInputVolume', inputName=name)['inputVolumeMul']
        tracks = self.call('GetInputAudioTracks', inputName=name)['inputAudioTracks']
        # A disabled replacement is created first; failure leaves the old source intact.
        replacement = name + ' refresh ' + str(uuid.uuid4())
        item = self.call('CreateInput', sceneName=self.config['obs_scene'], inputName=replacement,
                         inputKind='sck_audio_capture', inputSettings=settings, sceneItemEnabled=False)
        try:
            self.call('SetInputVolume', inputName=replacement, inputVolumeMul=volume)
            self.call('SetInputAudioTracks', inputName=replacement, inputAudioTracks=tracks)
        except Exception:
            self.call('RemoveInput', inputName=replacement)
            raise
        self.call('RemoveInput', inputName=name)
        # OBS removes sources on its UI queue; the name is not immediately free
        # when RemoveInput acknowledges the request.
        deadline = time.monotonic() + 5
        while any(source['inputName'] == name for source in self.call('GetInputList')['inputs']):
            if time.monotonic() >= deadline:
                raise ValueError('OBS did not release the old Chrome audio source.')
            time.sleep(.05)
        self.call('SetInputName', inputName=replacement, newInputName=name)
        self.call('SetSceneItemEnabled', sceneName=self.config['obs_scene'],
                  sceneItemId=item['sceneItemId'], sceneItemEnabled=True)

    def audio_peak(self, seconds=1):
        """Sample meters in the background; this never controls browser playback."""
        self.ws.send(json.dumps({'op': 3, 'd': {'eventSubscriptions': 64 | 65536}}))
        deadline, peak = time.monotonic() + seconds, 0.0
        while time.monotonic() < deadline:
            message = json.loads(self.ws.recv())
            if message.get('op') != 5:
                continue
            event = message['d']
            if event['eventType'] == 'InputVolumeMeters':
                for source in event['eventData']['inputs']:
                    if source['inputName'] == 'asbplayer Chrome audio':
                        peak = max([peak, *(value for channel in source['inputLevelsMul'] for value in channel)])
            else:
                self.events.append(event)
        return peak

    def save(self):
        self.ensure_scene()
        if not self.call('GetReplayBufferStatus')['outputActive']:
            raise ValueError('OBS replay buffer is not running. Start it before watching the sentence.')
        # Anchor to the capture request, not disk mtime (muxing may finish later).
        captured_at = time.time()
        self.call('SaveReplayBuffer')
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            for event in self.events:
                if event['eventType'] == 'ReplayBufferSaved':
                    return Path(event['eventData']['savedReplayPath']), captured_at
            self.events.clear()
            message = json.loads(self.ws.recv())
            if message['op'] == 5:
                self.events.append(message['d'])
        raise ValueError('OBS did not finish saving this replay.')


def extract(config, replay, captured_at, ranges, directory):
    probe = subprocess.run([config['ffprobe'], '-v', 'error', '-show_format', '-show_streams', '-of', 'json', str(replay)],
                           capture_output=True, text=True, check=True, timeout=20)
    info = json.loads(probe.stdout)
    duration = float(info['format']['duration'])
    if not any(s['codec_type'] == 'audio' for s in info['streams']):
        raise ValueError('OBS replay must contain application audio.')
    origin = captured_at - duration
    clips = [(a - origin, b - origin) for a, b in ranges]
    if clips[0][0] < -0.15 or clips[-1][1] > duration + 0.15:
        raise ValueError('The sentence has expired from the OBS buffer. Increase its duration before watching.')
    clips = [(max(0, a), min(duration, b)) for a, b in clips]
    filters = [f'[0:a:0]atrim=start={a:.4f}:end={b:.4f},asetpts=PTS-STARTPTS[a{i}]' for i, (a, b) in enumerate(clips)]
    filters.append(''.join(f'[a{i}]' for i in range(len(clips))) + f'concat=n={len(clips)}:v=0:a=1[out]')
    subprocess.run([config['ffmpeg'], '-v', 'error', '-nostdin', '-y', '-i', str(replay), '-filter_complex',
                    ';'.join(filters), '-map', '[out]', '-codec:a', 'libmp3lame', '-q:a', '3',
                    str(directory / 'sentence.mp3')], capture_output=True, check=True, timeout=60)
    validate_audio(config, directory / 'sentence.mp3')
