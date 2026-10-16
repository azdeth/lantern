# Lantern

Read light novels (`.epub`) or have them read aloud, chapter by chapter. Works on PC and phone,
offline, with no account. Live at **https://azdeth.github.io/lantern/**.

## Use
- **Add books:** "Add book", drag-and-drop, or on Android share an `.epub` to Lantern.
- **Install:** iPhone: Safari > Share > Add to Home Screen. Android/PC: browser menu > Install app.
- **Read aloud:** press play. Select any text and tap "Read from here" to start there.
- **Voices:** tap the voice chip next to play. Free device voices work out of the box; for
  audiobook quality add a Qwen key (Alibaba Cloud Model Studio, Singapore region), or OpenAI /
  ElevenLabs. Keys stay on the device.
- **Other devices:** books are stored per device. Settings > Backup moves your place between devices.

## Develop
No build step. `node tools/dev_server.mjs 8767` serves the app plus a fake Qwen endpoint at
`/mock-qwen` (key `test-key`). `node tools/check.mjs` runs the self-checks.
`python tools/make_assets.py` rebuilds the icons and `sample.epub`. Deploy = push to `main`.

Qwen endpoints: `qwen-audio-*` / `cosyvoice-*` use `/api/v1/services/audio/tts/SpeechSynthesizer`;
`qwen3-tts-*` uses `/api/v1/services/aigc/multimodal-generation/generation`. A mismatch returns
"url error, please check url".
