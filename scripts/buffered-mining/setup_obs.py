#!/usr/bin/env python3
"""Configure a dedicated Chrome application-audio replay buffer, with no screen capture."""
import json
from pathlib import Path
import time

from media import Obs


def setup(config):
    with Obs(config) as obs:
        for action in ('GetRecordStatus', 'GetStreamStatus'):
            if obs.call(action)['outputActive']:
                raise ValueError('Finish the active OBS output before changing the mining setup.')
        profiles = obs.call('GetProfileList')['profiles']
        if obs.call('GetReplayBufferStatus')['outputActive']:
            # Live migration is safe only for our own profile/collection; preserve its buffer.
            if (obs.call('GetProfileList')['currentProfileName'] != 'asbplayer'
                    or obs.call('GetSceneCollectionList')['currentSceneCollectionName'] != 'asbplayer'):
                raise ValueError('Another OBS replay buffer is active. Finish it before setup.')
        else:
            if 'asbplayer' not in profiles:
                obs.call('CreateProfile', profileName='asbplayer')
            if obs.call('GetProfileList')['currentProfileName'] != 'asbplayer':
                obs.call('SetCurrentProfile', profileName='asbplayer')
            parameters = {'Output': {'Mode': 'Simple'},
                          'SimpleOutput': {'FilePath': config['replay_directory'], 'RecFormat2': 'mkv',
                                           'RecQuality': 'Small', 'RecEncoder': 'x264', 'RecAudioEncoder': 'aac',
                                           'VBitrate': '4000', 'ABitrate': '160', 'Preset': 'veryfast',
                                           'RecRB': 'true', 'RecRBTime': '300', 'RecRBSize': '512',
                                           'RecRBPrefix': 'asbplayer', 'RecTracks': '1'}}
            for category, values in parameters.items():
                for name, value in values.items():
                    obs.call('SetProfileParameter', parameterCategory=category, parameterName=name, parameterValue=value)
            other = next((p for p in profiles if p != 'asbplayer'), None)
            if other:
                obs.call('SetCurrentProfile', profileName=other)
                obs.call('SetCurrentProfile', profileName='asbplayer')
            obs.call('SetVideoSettings', baseWidth=1280, baseHeight=720, outputWidth=1280, outputHeight=720,
                     fpsNumerator=30, fpsDenominator=1)
        collections = obs.call('GetSceneCollectionList')['sceneCollections']
        if 'asbplayer' not in collections:
            obs.call('CreateSceneCollection', sceneCollectionName='asbplayer')
        if obs.call('GetSceneCollectionList')['currentSceneCollectionName'] != 'asbplayer':
            obs.call('SetCurrentSceneCollection', sceneCollectionName='asbplayer')
        if not any(s['sceneName'] == config['obs_scene'] for s in obs.call('GetSceneList')['scenes']):
            obs.call('CreateScene', sceneName=config['obs_scene'])
        inputs = obs.call('GetInputList')['inputs']
        names = {i['inputName'] for i in inputs}
        for name, kind, settings in (
            ('asbplayer Chrome audio', 'sck_audio_capture', {'type': 1, 'application': 'com.google.Chrome'}),
            # OBS requires a video canvas for its replay output. This is a constant color, not a captured image.
            ('asbplayer audio canvas', 'color_source_v3', {'color': 4278190080, 'width': 1280, 'height': 720}),
        ):
            if name not in names:
                obs.call('CreateInput', sceneName=config['obs_scene'], inputName=name,
                         inputKind=kind, inputSettings=settings, sceneItemEnabled=True)
            else:
                current = obs.call('GetInputSettings', inputName=name)
                if any(current['inputSettings'].get(k) != v for k, v in settings.items()):
                    obs.call('SetInputSettings', inputName=name, inputSettings=settings, overlay=True)
                item = obs.call('GetSceneItemId', sceneName=config['obs_scene'], sourceName=name)['sceneItemId']
                obs.call('SetSceneItemEnabled', sceneName=config['obs_scene'], sceneItemId=item, sceneItemEnabled=True)
        # Remove our previous screen-capture source entirely: a hidden SCK source can still keep a stream alive.
        for item in inputs:
            if item['inputName'] == 'asbplayer Chrome' and item['inputKind'] == 'screen_capture':
                obs.call('RemoveInput', inputName=item['inputName'])
            elif item['inputKind'] in ('coreaudio_input_capture', 'coreaudio_output_capture'):
                obs.call('SetInputMute', inputName=item['inputName'], inputMuted=True)
        obs.call('SetInputMute', inputName='asbplayer Chrome audio', inputMuted=False)
        obs.call('SetInputAudioMonitorType', inputName='asbplayer Chrome audio', monitorType='OBS_MONITORING_TYPE_NONE')
        if obs.call('GetCurrentProgramScene')['currentProgramSceneName'] != config['obs_scene']:
            obs.call('SetCurrentProgramScene', sceneName=config['obs_scene'])
        # OBS applies scene mutations on its UI queue.
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if not any(i['inputKind'] == 'screen_capture' for i in obs.call('GetInputList')['inputs']):
                break
            time.sleep(.1)
        obs.ensure_audio_source()
        obs.start()
        print('Chrome application-audio buffer is running. No window or display capture source is used.')


if __name__ == '__main__':
    root = Path.home() / 'Library/Application Support/asbplayer-extension/buffered-mining'
    setup(json.loads((root / 'config.json').read_text()))
