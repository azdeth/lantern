// Local test server: serves the app and a fake Qwen TTS endpoint at /mock-qwen
// (SSE with base64 PCM16 24 kHz tones) so the voice pipeline can be tested without a key.
// Run: node tools/dev_server.mjs [port]
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const port = +process.argv[2] || 8765;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.epub': 'application/epub+zip', '.json': 'application/json' };

function tonePcm(seconds, freq) {
  const n = Math.round(24000 * seconds), b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i / 24000 * 2 * Math.PI * freq) * 3000 * Math.min(1, i / 600, (n - i) / 600)), i * 2);
  return b;
}

function wavHeader() { // streaming WAV: sizes unknown (0xFFFFFFFF)
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(0xFFFFFFFF, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(24000, 24); h.writeUInt32LE(48000, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(0xFFFFFFFF, 40);
  return h;
}

http.createServer(async (req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization,content-type,x-dashscope-sse' };
  if (req.url.startsWith('/mock-qwen')) {
    if (req.method === 'OPTIONS') { res.writeHead(200, cors); return res.end(); }
    let body = '';
    for await (const c of req) body += c;
    const { model, input } = JSON.parse(body);
    if (req.headers.authorization !== 'Bearer test-key') {
      res.writeHead(401, { ...cors, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ code: 'InvalidApiKey', message: 'Invalid API-key provided.' }));
    }
    // like DashScope: Qwen-Audio/CosyVoice only on SpeechSynthesizer, Qwen3-TTS only on multimodal-generation
    const speechApi = req.url.includes('/audio/tts/SpeechSynthesizer');
    if (speechApi !== /^(qwen-audio|cosyvoice)/.test(model)) {
      res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ code: 'InvalidParameter', message: 'url error, please check url！' }));
    }
    console.log('TTS', model, input.voice, JSON.stringify(input.text).slice(0, 70), input.instruction ? '+instr' : '');
    res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream' });
    const pcm = tonePcm(Math.min(4, 0.4 + input.text.length / 40), input.voice.includes('Eric') ? 330 : 520);
    for (let o = 0; o < pcm.length; o += 9600) {
      let piece = pcm.subarray(o, o + 9600);
      if (o === 0 && speechApi) piece = Buffer.concat([wavHeader(), piece]); // format: wav streams a header first
      res.write(`id:1\nevent:result\ndata:${JSON.stringify({ output: { finish_reason: null, audio: { data: piece.toString('base64') } } })}\n\n`);
      await new Promise(r => setTimeout(r, 30));
    }
    res.end(`id:2\nevent:result\ndata:${JSON.stringify({ output: { finish_reason: 'stop', audio: { url: '', data: '' } }, usage: { characters: input.text.length } })}\n\n`);
    return;
  }
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([\\/])+/, '') || 'index.html';
  const file = join(root, path.endsWith('\\') || path.endsWith('/') ? path + 'index.html' : path);
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
}).listen(port, () => console.log(`Lantern dev server on http://localhost:${port}`));
