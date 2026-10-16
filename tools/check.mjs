// Self-check for the pure helpers: node tools/check.mjs
import assert from 'node:assert/strict';
import { pcmToWav } from '../tts.js';
import { speakable } from '../text.js';

const bytes = async b => new Uint8Array(await b.arrayBuffer());
const u32 = (a, o) => new DataView(a.buffer).getUint32(o, true);

// raw PCM pieces -> one WAV
let w = await bytes(pcmToWav([new Uint8Array(100), new Uint8Array(60)]));
assert.equal(String.fromCharCode(...w.slice(0, 4)), 'RIFF');
assert.equal(u32(w, 24), 24000);
assert.equal(u32(w, 40), 160);
assert.equal(w.length, 204);

// streamed WAV (header with unknown sizes) + raw continuation -> header stripped, sizes fixed
const head = new Uint8Array(44);
const hv = new DataView(head.buffer);
[...'RIFF'].forEach((c, i) => (head[i] = c.charCodeAt(0)));
[...'WAVEfmt '].forEach((c, i) => (head[8 + i] = c.charCodeAt(0)));
hv.setUint32(4, 0xffffffff, true); hv.setUint32(16, 16, true); hv.setUint16(20, 1, true); hv.setUint16(22, 1, true);
hv.setUint32(24, 22050, true); hv.setUint16(34, 16, true);
[...'data'].forEach((c, i) => (head[36 + i] = c.charCodeAt(0)));
hv.setUint32(40, 0xffffffff, true);
const first = new Uint8Array(44 + 10); first.set(head);
w = await bytes(pcmToWav([first, new Uint8Array(20)]));
assert.equal(u32(w, 24), 22050);
assert.equal(u32(w, 40), 30);

// translator notes removed, pronunciation applied on word boundaries only
assert.equal(speakable('Welcome home. (T/N: Okaeri means welcome home.)'), 'Welcome home.');
assert.equal(speakable('Rimuru met Rimurus.', { pron: [{ from: 'Rimuru', to: 'Ree-moo-roo' }] }), 'Ree-moo-roo met Rimurus.');
assert.equal(speakable('a [TL note: pun] b', { skipNotes: false }), 'a [TL note: pun] b');

console.log('ok: all checks passed');
