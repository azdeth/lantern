import * as db from './db.js';

// ---------- voice catalogues (any voice id can also be typed in) ----------
const EN31 = 'Emily Luna Eric Luca Abby Annie Ava Beth Betty Cally Cindy Donna Andy Brian David'.split(' ');
export const QWEN_MODELS = {
  'qwen-audio-3.1-tts-flash': [
    ...EN31.map(n => [`${n}_v3.1`, `${n} (English)`]),
    ['longanhuan_v3.1', 'An Huan (multilingual, F)'], ['longanlingxin_v3.1', 'An Lingxin (multilingual, F)'],
    ['longanfengyue_v3.1', 'An Fengyue (multilingual, F)'], ['xunanchuan_v3.1', 'Xu Nanchuan (multilingual, M)'],
    ['longyingtao_v3.1', 'Yingtao (gentle, calm F)'], ['longyuan_v3.1', 'Yuan (warm, soothing F)'],
    ['longsanshu_v3.1', 'Sanshu (steady, textured M)'], ['longanzhi_v3.1', 'An Zhi (wise young M)'],
    ['longhan_v3.1', 'Han (warm M)'], ['longanyang_v3.1', 'An Yang (cheerful young M)'],
    ['longanlingxi_v3.1', 'An Lingxi (cute, sweet F)'], ['longhuohuo_v3.1', 'Huohuo (mischievous teen M)'],
  ],
  'qwen-audio-3.0-tts-plus': [['longanlingxin', 'An Lingxin (warm F)'], ['longanlufeng', 'An Lufeng (bright M)']],
  'qwen-audio-3.0-tts-flash': [
    ['loongeva_v3.6', 'Eva (American F)'], ['loongjohn', 'John (American M)'], ['loongmary', 'Mary (British F)'],
    ['longanfengyue', 'An Fengyue (natural F)'], ['longanyuanfei', 'An Yuanfei (regal F)'],
    ['longanlingxi', 'An Lingxi (sweet F)'], ['longanxiaoxin', 'An Xiaoxin (lively F)'],
  ],
  'qwen3-tts-flash': [['Cherry', 'Cherry (F)'], ['Ethan', 'Ethan (M)'], ['Serena', 'Serena (F)'], ['Chelsie', 'Chelsie (F)']],
};
export const OPENAI_MODELS = ['gpt-4o-mini-tts', 'tts-1-hd', 'tts-1'];
export const OPENAI_VOICES = 'marin cedar coral nova sage shimmer alloy ash ballad echo fable onyx verse'.split(' ');
export const ELEVEN_MODELS = ['eleven_v3', 'eleven_multilingual_v2', 'eleven_flash_v2_5', 'eleven_turbo_v2_5'];
export const QWEN_REGIONS = [['https://dashscope-intl.aliyuncs.com', 'Singapore (international)'], ['https://dashscope.aliyuncs.com', 'Beijing (China)']];

async function apiError(r, who) {
  let msg = '';
  try { const j = await r.json(); msg = j.message || j.error?.message || j.detail?.message || j.detail || j.code || ''; } catch {}
  if (r.status === 401 || r.status === 403) return `${who} rejected the API key (${r.status}). Check the key and region in Voice settings.`;
  if (r.status === 429) return `${who} rate limit or quota reached (429). ${msg}`;
  return `${who} error ${r.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`;
}

// ---------- providers: text -> audio Blob ----------
const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

// Qwen streams base64 audio over SSE: raw PCM16 mono 24 kHz, or WAV pieces.
export function pcmToWav(parts) {
  let rate = 24000, ch = 1;
  const pcm = parts.map(p => {
    if (p[0] === 82 && p[1] === 73 && p[2] === 70 && p[3] === 70) { // RIFF
      const v = new DataView(p.buffer, p.byteOffset);
      ch = v.getUint16(22, true); rate = v.getUint32(24, true);
      for (let i = 12; i + 8 <= p.length;) {
        const id = String.fromCharCode(...p.subarray(i, i + 4)), len = v.getUint32(i + 4, true);
        if (id === 'data') return p.subarray(i + 8, Math.min(p.length, i + 8 + len));
        i += 8 + len + (len & 1);
      }
      return p.subarray(44);
    }
    return p;
  });
  const size = pcm.reduce((a, p) => a + p.length, 0);
  const h = new DataView(new ArrayBuffer(44));
  const str = (o, s) => [...s].forEach((c, i) => h.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); h.setUint32(4, 36 + size, true); str(8, 'WAVE'); str(12, 'fmt ');
  h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, ch, true); h.setUint32(24, rate, true);
  h.setUint32(28, rate * ch * 2, true); h.setUint16(32, ch * 2, true); h.setUint16(34, 16, true);
  str(36, 'data'); h.setUint32(40, size, true);
  return new Blob([h, ...pcm], { type: 'audio/wav' });
}

async function qwen(text, voice, S) {
  const q = S.qwen;
  if (!q.key) throw new Error('Add your Qwen (DashScope) API key in Voice settings.');
  const input = { text, voice };
  if (q.lang && q.lang !== 'Auto') input.language_type = q.lang;
  if (S.instruction.trim() && q.model.startsWith('qwen-audio')) input.instruction = S.instruction.trim();
  const r = await fetch(`${q.base}/api/v1/services/aigc/multimodal-generation/generation`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${q.key}`, 'Content-Type': 'application/json', 'X-DashScope-SSE': 'enable' },
    body: JSON.stringify({ model: q.model, input }),
  });
  if (!r.ok) throw new Error(await apiError(r, 'Qwen'));
  const parts = [];
  let url = '', buf = '';
  const handle = line => {
    if (!line.startsWith('data:')) return;
    const j = JSON.parse(line.slice(5));
    if (j.code && !j.output) throw new Error(`Qwen: ${j.message || j.code}`);
    const a = j.output?.audio;
    if (a?.data) parts.push(b64(a.data));
    if (a?.url) url = a.url;
  };
  const rd = r.body.pipeThrough(new TextDecoderStream()).getReader();
  for (;;) {
    const { value, done } = await rd.read();
    if (done) break;
    buf += value;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i).trim()); buf = buf.slice(i + 1); }
  }
  handle(buf.trim());
  if (parts.length) return pcmToWav(parts);
  if (url) return (await fetch(url)).blob();
  throw new Error('Qwen returned no audio for this text.');
}

async function openai(text, voice, S) {
  const o = S.openai;
  if (!o.key) throw new Error('Add your OpenAI API key in Voice settings.');
  const body = { model: o.model, voice, input: text, response_format: 'mp3' };
  if (S.instruction.trim() && o.model.startsWith('gpt-')) body.instructions = S.instruction.trim();
  const r = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST', headers: { Authorization: `Bearer ${o.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await apiError(r, 'OpenAI'));
  return r.blob();
}

async function eleven(text, voice, S) {
  const e = S.eleven;
  if (!e.key) throw new Error('Add your ElevenLabs API key in Voice settings.');
  if (!voice) throw new Error('Pick an ElevenLabs voice in Voice settings.');
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`, {
    method: 'POST', headers: { 'xi-api-key': e.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: e.model }),
  });
  if (!r.ok) throw new Error(await apiError(r, 'ElevenLabs'));
  return r.blob();
}

export async function elevenVoices(key) {
  const r = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': key } });
  if (!r.ok) throw new Error(await apiError(r, 'ElevenLabs'));
  return (await r.json()).voices.map(v => [v.voice_id, v.name]);
}

const SYNTH = { qwen, openai, eleven };

export function voiceFor(S, dialogue) {
  const p = S[S.provider];
  return (dialogue && S.dialogueVoice && p.voice2) || p.voice;
}

async function sha(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Cached synthesis. Returns a Blob.
export async function synth(text, dialogue, S) {
  const p = S.provider, voice = voiceFor(S, dialogue), cfg = S[p];
  const key = await sha(JSON.stringify([p, cfg.model, voice, cfg.lang || '', S.instruction, text]));
  const hit = await db.get('audio', key).catch(() => null);
  if (hit) return hit;
  const blob = await SYNTH[p](text, voice, S);
  S.usage[p] = (S.usage[p] || 0) + text.length;
  db.set('audio', key, blob).catch(() => {});
  return blob;
}

// ---------- player ----------
export class Player {
  // hooks: settings() -> S, text(i) -> string, onChunk(i), onEnd(), onState(), onError(err)
  constructor(hooks) {
    this.h = hooks;
    this.chunks = [];
    this.idx = 0;
    this.playing = false;
    this.gen = 0;
    this.pending = new Map();
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.audio.addEventListener('ended', () => this.playing && this.advance(this.gen));
    this.audio.addEventListener('error', () => {
      if (this.playing && this.audio.src) this.fail(new Error('This audio clip could not be played.'));
    });
    const ms = navigator.mediaSession;
    if (ms) {
      const on = (a, f) => { try { ms.setActionHandler(a, f); } catch {} };
      on('play', () => this.play());
      on('pause', () => this.pause());
      on('previoustrack', () => this.skip(-1));
      on('nexttrack', () => this.skip(1));
      on('seekbackward', () => this.skip(-1));
      on('seekforward', () => this.skip(1));
    }
  }

  get S() { return this.h.settings(); }

  setChunks(chunks) {
    this.stopAudio();
    this.chunks = chunks;
    this.idx = 0;
    this.pending.clear();
  }

  // Forget prepared audio (voice or text settings changed).
  reset() { this.pending.clear(); }

  get(i) {
    if (i < 0 || i >= this.chunks.length) return Promise.resolve(null);
    if (!this.pending.has(i)) {
      const p = synth(this.h.text(i), this.chunks[i].dialogue, this.S);
      p.catch(() => this.pending.get(i) === p && this.pending.delete(i));
      this.pending.set(i, p);
    }
    return this.pending.get(i);
  }

  async playAt(i) {
    const g = ++this.gen;
    this.stopAudio(false);
    this.idx = i;
    if (i >= this.chunks.length) { this.playing = false; this.state(); return this.h.onEnd(); }
    this.playing = true;
    this.state();
    this.h.onChunk(i);
    const text = this.h.text(i);
    if (!text) return this.advance(g);
    if (this.S.provider === 'device') return this.speak(text, g);
    for (const k of this.pending.keys()) if (k < i - 1 || k > i + 8) this.pending.delete(k);
    let blob;
    try { blob = await this.get(i); } catch (e) { if (g === this.gen) this.fail(e); return; }
    if (g !== this.gen) return;
    for (let k = 1; k <= 3; k++) this.get(i + k).catch(() => {});
    URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(blob);
    this.audio.src = this.url;
    this.audio.defaultPlaybackRate = this.audio.playbackRate = this.S.speed;
    this.audio.preservesPitch = true;
    try { await this.audio.play(); } catch (e) {
      if (g === this.gen) { this.playing = false; this.state(); if (e.name !== 'AbortError') this.h.onError(new Error('Tap play to start audio.')); }
    }
  }

  speak(text, g) {
    const S = this.S, u = new SpeechSynthesisUtterance(text);
    const name = voiceFor(S, this.chunks[this.idx].dialogue);
    u.voice = speechSynthesis.getVoices().find(v => v.voiceURI === name || v.name === name) || null;
    if (!u.voice) u.lang = this.h.lang?.() || 'en';
    u.rate = S.speed;
    u.onend = () => g === this.gen && this.playing && this.advance(g);
    u.onerror = e => { if (g === this.gen && !/interrupted|canceled/.test(e.error)) this.fail(new Error(`Device voice error: ${e.error}`)); };
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  }

  advance(g) {
    if (g !== this.gen) return;
    if (this.h.sleepDue?.()) { this.idx++; this.pause(); return; }
    this.playAt(this.idx + 1);
  }

  play() {
    if (this.playing) return;
    const resumable = this.S.provider !== 'device' && this.audio.src && !this.audio.ended && this.audio.currentTime > 0;
    if (resumable) {
      this.playing = true;
      this.audio.playbackRate = this.S.speed;
      this.audio.play().catch(() => {});
      this.state();
    } else this.playAt(this.idx);
  }

  pause() {
    this.playing = false;
    this.gen++;
    if (this.S.provider === 'device') speechSynthesis.cancel(); else this.audio.pause();
    this.state();
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  skip(d) { this.playAt(Math.max(0, Math.min(this.chunks.length - 1, this.idx + d))); }

  setSpeed(v) { this.audio.playbackRate = v; }

  stopAudio(clearSrc = true) {
    try { speechSynthesis.cancel(); } catch {}
    this.audio.pause();
    if (clearSrc) { this.gen++; this.playing = false; this.audio.removeAttribute('src'); }
  }

  fail(e) {
    this.playing = false;
    this.gen++;
    this.audio.pause();
    this.state();
    this.h.onError(e);
  }

  state() {
    if (navigator.mediaSession) navigator.mediaSession.playbackState = this.playing ? 'playing' : 'paused';
    this.h.onState();
  }
}
