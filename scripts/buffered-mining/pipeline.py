"""Dictionary-backed word selection and idempotent Anki export. No playback controls."""
import base64
from functools import lru_cache
import hashlib
import html
import json
import math
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unicodedata
import urllib.request


def post(url, body, timeout=60):
    request = urllib.request.Request(url, json.dumps(body).encode(), {'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def frequency_ranks(frequencies):
    """Keep each dictionary separate; a rare spelling must not inflate a word's difficulty."""
    ranks = {}
    for frequency in frequencies:
        rank = frequency.get('frequency')
        dictionary = frequency.get('dictionary')
        if (not dictionary or frequency.get('frequencyMode') != 'rank-based'
                or type(rank) not in (int, float) or not math.isfinite(rank) or rank <= 0):
            continue
        if dictionary not in ranks or rank < ranks[dictionary]['rank']:
            ranks[dictionary] = {'dictionary': dictionary, 'rank': rank,
                                 'readingSpecific': frequency.get('hasReading', False)}
    return list(ranks.values())


def normalized_surface(text):
    text = unicodedata.normalize('NFKC', text).strip()
    return ''.join(chr(ord(c) - 0x60) if '\u30a1' <= c <= '\u30f6' else c for c in text)


def subtitle_dialogue(sentence):
    """Separate non-spoken annotations and explicit speaker identities from dialogue."""
    speakers = set()

    def annotation(match):
        label = match[1].strip()
        # All-hiragana parentheses can be pronunciation guides, not speakers.
        if not re.fullmatch('[ぁ-ゖー\\s]+', label):
            label = re.sub('の声$', '', label)
            speakers.add(normalized_surface(label))
            speakers.update(normalized_surface(name) for name in re.split('[・･＆&、,]', label) if name.strip())
        return ' '

    dialogue = re.sub(r'[（(]([^（）()\n]{1,80})[）)]', annotation, sentence)
    return dialogue, speakers


class Pipeline:
    def __init__(self, config):
        self.config = config

    def yomi(self, action, body):
        return post(self.config['yomitan_url'].rstrip('/') + '/' + action, body)

    def anki(self, action, **params):
        result = post(self.config['anki_url'], {'action': action, 'version': 6, 'params': params})
        if result.get('error'):
            raise ValueError(result['error'])
        return result['result']

    def candidates(self, sentence, allow_empty=False):
        dialogue, speakers = subtitle_dialogue(sentence)
        parsed = self.yomi('tokenize', {'text': dialogue, 'scanLength': 30, 'parser': 'scanning-parser'})
        candidates = {}
        for line in parsed:
            for parts in line['content']:
                surface = ''.join(part['text'] for part in parts)
                if normalized_surface(surface) in speakers:
                    continue
                for part in parts:
                    for group in part.get('headwords', []):
                        for word in group:
                            key = (surface, word['term'], word['reading'])
                            if not re.search('[一-龯ぁ-んァ-ヶ]', word['term']):
                                continue
                            candidate = candidates.setdefault(key, {
                                'surface': surface, 'term': word['term'], 'reading': word['reading'],
                                'matchSources': [], '_frequencies': []})
                            candidate['_frequencies'].extend(word.get('frequencies', []))
                            for source in word.get('sources', []):
                                match = source.get('matchSource')
                                if match in ('term', 'reading') and match not in candidate['matchSources']:
                                    candidate['matchSources'].append(match)
        if not candidates and not allow_empty:
            raise ValueError('Yomitan could not find a word in this subtitle.')
        result = list(candidates.values())[:300]
        for candidate in result:
            candidate['frequencyRanks'] = frequency_ranks(candidate.pop('_frequencies'))
        return result

    def choose(self, sentence, candidates):
        # Enforce this again for restored/cached candidates and direct callers.
        _, speakers = subtitle_dialogue(sentence)
        eligible = [(index, candidate) for index, candidate in enumerate(candidates)
                    if normalized_surface(candidate['surface']) not in speakers]
        if not eligible:
            raise ValueError('No mineable vocabulary remains after excluding names and subtitle annotations.')
        env = os.environ.copy()
        for name in ('OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'CODEX_THREAD_ID',
                     'OPENAI_FEDERATION_RULE_ID', 'OPENAI_IDENTITY_TOKEN_FILE', 'OPENAI_WORKLOAD_IDENTITY_CONTEXT'):
            env.pop(name, None)
        env['RUST_LOG'] = 'off'
        with tempfile.TemporaryDirectory(prefix='asbplayer-word-') as directory:
            work = Path(directory)
            schema = work / 'schema.json'
            schema.write_text(json.dumps({'type': 'object', 'properties': {
                'nameSurfaces': {'type': 'array', 'items': {'type': 'string'}},
                'index': {'type': 'integer', 'minimum': -1, 'maximum': len(candidates) - 1}},
                'required': ['nameSurfaces', 'index'], 'additionalProperties': False}))
            output = work / 'result.json'
            instructions = Path(__file__).with_name('word-instructions.txt')
            args = [self.config['codex'], 'exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check',
                    '--sandbox', 'read-only', '--model', 'gpt-6-luna', '--color', 'never', '--json',
                    '--output-schema', str(schema), '--output-last-message', str(output),
                    '-c', 'model_reasoning_effort="low"', '-c', 'service_tier="fast"',
                    '-c', 'forced_login_method="chatgpt"',
                    '-c', 'web_search="disabled"', '-c', 'model_instructions_file=' + json.dumps(str(instructions))]
            for feature in ('shell_tool', 'multi_agent', 'apps', 'plugins', 'hooks', 'browser_use',
                            'computer_use', 'image_generation', 'code_mode', 'memories'):
                args += ['-c', 'features.' + feature + '=false']
            args.append('-')
            # Give the model explicit IDs; counting a long JSON array can select an adjacent homophone.
            prompt = json.dumps({'sentence': sentence, 'speakerNames': sorted(speakers), 'candidates': [
                {**candidate, 'index': index} for index, candidate in eligible
            ]}, ensure_ascii=False)
            result = subprocess.run(args, input=prompt, text=True, capture_output=True, env=env, cwd=work, timeout=120)
            if result.returncode or not output.exists():
                raise ValueError('Luna word selection failed. Check ChatGPT login/usage, then retry this queued card.')
            selection = json.loads(output.read_text())
            index, names = selection.get('index'), selection.get('nameSurfaces')
            if not isinstance(names, list) or any(not isinstance(name, str) for name in names):
                raise ValueError('Luna returned an invalid name classification.')
            if type(index) is int and index == -1:
                raise ValueError('This subtitle has no suitable vocabulary to mine after excluding names.')
            if type(index) is not int or not 0 <= index < len(candidates):
                raise ValueError('Luna returned an invalid dictionary candidate.')
            excluded = speakers | {normalized_surface(name) for name in names}
            if normalized_surface(candidates[index]['surface']) in excluded:
                raise ValueError('The selected item is a character name or another proper noun; no card was created.')
            return candidates[index]

    def rank(self, sentence, candidates):
        from jev_ranker import rank
        result = rank(sentence, candidates, self.config.get('jev_api_key'),
                      self.config.get('jev_confidence_threshold', .05),
                      provider=self.config.get('jev_provider', 'typesafe'),
                      alternative_threshold=self.config.get('jev_alternative_confidence_threshold', .7))
        result['options'] = self.prefer_kanji(result['options'], candidates)
        return result

    @lru_cache(maxsize=512)
    def dictionary_senses(self, term, reading):
        """Dictionary content establishes spelling variants; reading alone cannot."""
        senses = set()
        for result in self.yomi('termEntries', {'term': [term]}):
            for entry in result['dictionaryEntries']:
                indices = {h['index'] for h in entry['headwords']
                           if h['term'] == term and h['reading'] == reading}
                for definition in entry['definitions']:
                    if indices.intersection(definition['headwordIndices']) and definition.get('entries'):
                        content = json.dumps(definition['entries'], sort_keys=True, ensure_ascii=False).encode()
                        senses.add((definition['dictionary'], hashlib.sha256(content).digest()))
        return frozenset(senses)

    def prefer_kanji(self, options, candidates):
        preferred = []
        for option in options:
            word = candidates[option['index']]
            variants = [(i, c) for i, c in enumerate(candidates)
                        if c['surface'] == word['surface'] and c['reading'] == word['reading']
                        and re.search('[一-龯々]', c['term'])]
            if not re.search('[一-龯々]', word['term']) and variants:
                try:
                    senses = self.dictionary_senses(word['term'], word['reading'])
                    for index, variant in variants:
                        if senses & self.dictionary_senses(variant['term'], variant['reading']):
                            option = {**option, 'index': index, 'word': variant['term']}
                            break
                except Exception:
                    # A lookup outage must not replace a validated contextual choice.
                    pass
            preferred.append(option)
        merged = {}
        for option in preferred:
            key = (option['word'], option['reading'])
            if key not in merged or option['confidence'] > merged[key]['confidence']:
                merged[key] = option
        return sorted(merged.values(), key=lambda option: (-option['confidence'], option['index']))

    def recover_unparsed(self, sentence, candidates):
        from luna_fallback import generate
        return generate(self.config, sentence, candidates)

    def build(self, job, word):
        formats = self.yomi('ankiCardFormats', {})
        card_format = next((f for f in formats if f['name'] == self.config['card_format']), None)
        if not card_format or card_format.get('type') != 'term':
            raise ValueError('The configured Yomitan term card format is unavailable.')
        markers = {'expression', 'reading', 'glossary'}
        for field in card_format['fields'].values():
            markers.update(re.findall(r'\{([^{}]+)\}', field['value']))
        # Yomitan API has no sentence context; fill these from the frozen job below.
        context_markers = {'sentence', 'cloze-prefix', 'cloze-body', 'cloze-suffix', 'document-title', 'url',
                           'popup-selection-text', 'clipboard-text', 'clipboard-image', 'screenshot'}
        generated = word.get('generatedBy') == 'gpt-6-luna'
        if generated:
            definition = html.escape(word['definition']) + '<br>' + html.escape(word['definitionEnglish'])
            values = {marker: definition for marker in markers
                      if marker == 'glossary' or marker.startswith(('single-glossary-', 'glossary-'))}
            values.update(expression=html.escape(word['term']), reading=html.escape(word['reading']))
            values['furigana'] = ('<ruby>' + values['expression'] + '<rt>' + values['reading'] + '</rt></ruby>')
            values['furigana-plain'] = values['expression'] + '[' + values['reading'] + ']'
            result = {}
        else:
            result = self.yomi('ankiFields', {'text': word['term'], 'type': 'term',
                                         'markers': sorted(markers - context_markers),
                                         'maxEntries': 100, 'includeMedia': True})
            plain = lambda value: html.unescape(re.sub('<[^>]*>', '', value))
            values = next((dict(f) for f in result['fields']
                       if plain(f.get('expression', '')) == word['term']
                       and plain(f.get('reading', '')) == word['reading']), None)
        if values is None:
            raise ValueError('Yomitan has no card entry matching the selected word and reading.')
        sentence = job['subtitle']['text']
        position = sentence.find(word['surface'])
        if position < 0:
            raise ValueError('The chosen word is not in the frozen subtitle.')
        screenshot = '<img src="asb_' + job['id'] + '.jpg">' if job.get('hasScreenshot') else ''
        values.update({'sentence': html.escape(sentence), 'cloze-prefix': html.escape(sentence[:position]),
                       'cloze-body': html.escape(word['surface']),
                       'cloze-suffix': html.escape(sentence[position + len(word['surface']):]),
                       'document-title': html.escape(job.get('title', '')), 'url': html.escape(job.get('url', '')),
                       'popup-selection-text': '', 'clipboard-text': '', 'clipboard-image': '', 'screenshot': screenshot})
        fields = {name: re.sub(r'\{([^{}]+)\}', lambda m: values.get(m[1], ''), spec['value'])
                  for name, spec in card_format['fields'].items()}
        # Chrome supplies the still image; OBS supplies only sentence audio.
        fields[self.config['sentence_field']] = (
            values['cloze-prefix'] + '<b>' + values['cloze-body'] + '</b>' + values['cloze-suffix'])
        fields[self.config['audio_field']] = '[sound:asb_' + job['id'] + '.mp3]'
        if self.config.get('image_field'):
            fields[self.config['image_field']] = screenshot
        if self.config.get('source_field'):
            fields[self.config['source_field']] = html.escape(job.get('title', ''))
        if generated:
            if 'sentenceTranslation' in fields:
                fields['sentenceTranslation'] = html.escape(word['sentenceTranslation'])
            if 'notes' in fields:
                fields['notes'] = 'Definition and reading generated by GPT-6 Luna (unparsed vocabulary).'
        model_fields = self.anki('modelFieldNames', modelName=card_format['model'])
        audio_card_field = self.config.get('audio_card_field', 'audioCard')
        if job.get('cardType') == 'audio' and audio_card_field not in model_fields:
            raise ValueError('The Anki note type has no audio-card field: ' + audio_card_field)
        if audio_card_field in model_fields:
            fields[audio_card_field] = '1' if job.get('cardType') == 'audio' else ''
        if not set(fields).issubset(model_fields):
            raise ValueError('Yomitan card fields do not match the Anki note type.')
        if self.config['deck'] not in self.anki('deckNames'):
            raise ValueError('The configured mining deck does not exist in Anki.')
        return {'deckName': self.config['deck'], 'modelName': card_format['model'], 'fields': fields,
                'tags': ['asbplayer', 'jev' if job.get('requiresChoice') else 'luna',
                         *(['luna_generated'] if generated else []),
                         'asb_job_' + job['id'].replace('-', '')],
                'options': {'allowDuplicate': False}}, result

    def export(self, job, word):
        # The stable tag recovers a successful addNote even if its response was lost.
        tag = 'asb_job_' + job['id'].replace('-', '')
        existing = self.anki('findNotes', query='tag:' + tag)
        if existing:
            return existing[0]
        note, media = self.build(job, word)
        for item in media.get('dictionaryMedia', []) + media.get('audioMedia', []):
            self.anki('storeMediaFile', filename=item['ankiFilename'], data=item['content'])
        for extension in ('mp3',):
            path = Path(job['directory']) / ('sentence.' + extension)
            self.anki('storeMediaFile', filename='asb_' + job['id'] + '.' + extension,
                      data=base64.b64encode(path.read_bytes()).decode())
        if job.get('hasScreenshot'):
            image = Path(job['directory']) / 'screenshot.jpg'
            self.anki('storeMediaFile', filename='asb_' + job['id'] + '.jpg',
                      data=base64.b64encode(image.read_bytes()).decode())
        return self.anki('addNote', note=note)
