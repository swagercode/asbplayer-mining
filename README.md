# asbplayer-mining

A fork of [asbplayer](https://github.com/asbplayer/asbplayer) for mining Japanese words while watching Crunchyroll.

Press **N** when you hear a word you don't know. Jev ranks the words in the current sentence, you pick one with a number key, and its Yomitan definition opens inside the player. Press **N** again to save the card and continue watching from the beginning of that sentence. **V** saves an audio card instead; **B** skips it.

## What it does

- Finds Japanese subtitles on Jimaku, including combined episodes, and opens them in a separate viewer.
- Syncs them locally against Crunchyroll's hidden English subtitle timings using ALASS. Uncertain matches keep their original timing.
- Turns off captions on the video.
- Shows word choices as soon as they're ready. One choice goes straight to the definition; gaps use the last subtitle.
- Makes Anki cards from Yomitan entries, with sentence audio from an OBS buffer. No replaying to record, and pauses are cut out.
- Queues exports so you can keep mining while earlier cards finish.
- Skips normal cards for words you've already mined, including matching kana and kanji spellings. Audio cards can repeat a word for practice in different sentences.
- Explains sentences in Japanese with the surrounding subtitles for context.

Screenshots use Chrome's capture API when available. If the dictionary parser misses a word, Jev can flag it for Luna to generate an entry.

## Controls

| Key | Action |
| --- | --- |
| N | Start mining; accept a selected word as a normal card |
| V | Start mining; accept a selected word as an audio card |
| 1–9 | Choose a word |
| B | Cancel without making a card |
| W | Seek to the beginning of the current subtitle |
| S | Seek to the previous subtitle |
| F | Open or close the sentence explanation |

These can all be changed under **Settings → Keyboard Shortcuts**. The mining controls work in fullscreen.

The existing 8BitDo Micro layout now keeps those keyboard shortcuts alongside its button mappings. Both bindings are editable in settings, and the chooser still shows D-pad arrows. The Micro sends keyboard letters, so its right D-pad and the keyboard's **F** share a key: while choices are visible, F picks the second word. Outside the chooser, F explains the sentence; **R2** can explain in either case.

## Setup

Tested on **macOS with Chrome**. You'll need:

- Yomitan, Japanese dictionaries, and its local API enabled.
- Anki, AnkiConnect, and a Yomitan card format. Defaults match Senren; audio cards need an `audioCard` field and a template that uses it.
- OBS with its WebSocket server enabled, plus `ffmpeg` and `alass`.
- A Jimaku API key and a Jev or OpenJEV key.
- Codex signed in with a ChatGPT account for subtitle selection, sentence explanations, and the missing-word fallback.
- Node.js and Python 3.

Build the extension from the repository root:

```sh
node .yarn/releases/yarn-3.2.0.cjs install
node .yarn/releases/yarn-3.2.0.cjs workspace @project/extension build
```

Open `chrome://extensions`, enable Developer mode, and load `extension/.output/chrome-mv3` with **Load unpacked**.

The installers look for Codex inside the ChatGPT or Codex app, then on your PATH. Reinstalling repairs a missing Codex path while keeping a working custom path.

Install the local bridges:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install websocket-client
python3 scripts/chatgpt-subtitle-host/install.py --browser chrome
python3 scripts/buffered-mining/install.py --python "$PWD/.venv/bin/python"
```

Edit `~/Library/Application Support/asbplayer-extension/buffered-mining/config.json`: set `jev_provider` to `openjev` or `typesafe`, add `jev_api_key`, and check the OBS connection, deck, card format, and field names.

With OBS running and other recording/streaming outputs stopped:

```sh
.venv/bin/python scripts/buffered-mining/setup_obs.py
python3 scripts/buffered-mining/install.py --python "$PWD/.venv/bin/python" --enable
```

In asbplayer's online subtitle settings, add your Jimaku key and enable automatic Japanese subtitles for Crunchyroll. Set the subtitle list to the separate app and turn off subtitles on the video. Reload the extension and episode after setup.

Keep Anki, Yomitan's API, and OBS running. OBS captures Chrome audio, so avoid playing another Chrome video at the same time. Its black canvas is intentional; this scene records audio only.

Word ranking sends the sentence and dictionary candidates to your Jev provider. Explanations and the missing-word fallback use your ChatGPT account. Private configuration and recordings live in the local bridge folders, outside this repository.
