# Lantern — light novel reader + audiobook

**Goal:** load `.epub` light novels, read them yourself or have a TTS voice read them aloud
chapter by chapter, on PC and phone. Hosted free on GitHub Pages (account `azdeth`).

## Decisions
- **Static PWA, no server, no build step.** Vanilla ES modules. DashScope answers CORS
  preflights (tested 15 Oct 2026), so the browser calls TTS APIs directly; API keys stay in
  the device's IndexedDB and are only sent to the provider they belong to.
- **No libraries.** EPUB zip is read with the native `DecompressionStream('deflate-raw')`;
  sentences with `Intl.Segmenter`; highlighting with the CSS Custom Highlight API.
- **Storage:** IndexedDB per device (books, progress, settings, audio cache). PC<->phone
  sync is export/import of a progress file (auto sync needs an account backend: later).
- **claude.ai artifact rejected:** its CSP blocks all fetches to outside hosts.

## Features
Library: import (picker, drag-drop, Android share target, desktop "open with"), covers,
% read, last opened, delete.

Reader: scroll or paged layout; themes light / sepia / dark / black; font, size, line
height, width, justify; ruby (furigana) kept; illustrations; table of contents; prev/next
chapter; bookmarks; search in book; position auto-saved.

Listen:
- Providers: Qwen (DashScope, Singapore or Beijing region; qwen-audio-3.1-tts-flash,
  qwen-audio-3.0-tts-plus, qwen-audio-3.0-tts-flash, qwen3-tts-flash; any voice id incl.
  cloned/base voices), OpenAI TTS, ElevenLabs, free device voices (Web Speech).
- Text chunked at sentence ends (<=600 chars API limit); 3 chunks prefetched; gapless.
- Current chunk highlighted, page follows; double-tap a sentence to read from there.
- Separate dialogue voice (text inside 「」『』“” "") — optional.
- Style instruction (Qwen `input.instruction`, OpenAI `instructions`).
- Speed 0.5–3x (pitch preserved), auto-advance chapters, sleep timer (minutes / end of
  chapter), lock-screen controls (Media Session), background playback.
- Audio cache in IndexedDB (replays free); "download chapter audio" for offline listening.
- Pronunciation list (find -> say as); skip translator notes / footnote markers.
- Character counter per provider.

Install: manifest + service worker (offline app shell), installable on PC and phone.

## Qwen request (HTTP, SSE)
`POST {base}/api/v1/services/aigc/multimodal-generation/generation`, headers
`Authorization: Bearer KEY`, `X-DashScope-SSE: enable`; body
`{model, input:{text, voice, language_type?, instruction?}}`. SSE events carry
`output.audio.data` (base64; PCM 16-bit mono 24 kHz, or a WAV if it starts with RIFF);
final event may carry `output.audio.url`. Bases: `https://dashscope-intl.aliyuncs.com`
(Singapore), `https://dashscope.aliyuncs.com` (Beijing). Keys are region-specific.
