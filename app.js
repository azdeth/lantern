import * as db from './db.js';
import { parseEpub, loadChapter, chapterText } from './epub.js';
import { buildChunks, chunkRange, speakable } from './text.js';
import {
  Player, synth, elevenVoices, voiceFor,
  QWEN_MODELS, QWEN_REGIONS, OPENAI_MODELS, OPENAI_VOICES, ELEVEN_MODELS,
} from './tts.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---------------- settings ----------------
const DEFAULTS = {
  theme: 'auto', font: 'serif', size: 19, line: 1.7, width: 36, justify: false, layout: 'scroll',
  provider: 'device',
  qwen: { key: '', base: QWEN_REGIONS[0][0], model: 'qwen-audio-3.1-tts-flash', voice: 'Emily_v3.1', voice2: 'Eric_v3.1', lang: 'Auto' },
  openai: { key: '', model: 'gpt-4o-mini-tts', voice: 'marin', voice2: 'cedar' },
  eleven: { key: '', model: 'eleven_multilingual_v2', voice: '', voice2: '', voices: [] },
  device: { voice: '', voice2: '' },
  instruction: 'Read like an audiobook narrator: warm, expressive, natural pace.',
  dialogueVoice: false, speed: 1, skipNotes: true, pron: [], usage: {},
};
let S = structuredClone(DEFAULTS);
async function loadSettings() {
  let saved = null;
  try { saved = await db.get('kv', 'settings'); } catch {}
  for (const [k, v] of Object.entries(saved || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && DEFAULTS[k] && typeof DEFAULTS[k] === 'object' && !Array.isArray(DEFAULTS[k])) Object.assign(S[k], v);
    else if (k in DEFAULTS) S[k] = v;
  }
}
let saveT;
function saveSettings() { clearTimeout(saveT); saveT = setTimeout(() => db.set('kv', 'settings', S).catch(() => {}), 250); }

function applyDisplay() {
  const r = document.documentElement;
  if (S.theme === 'auto') delete r.dataset.theme; else r.dataset.theme = S.theme;
  r.style.setProperty('--fs', S.size + 'px');
  r.style.setProperty('--lh', S.line);
  r.style.setProperty('--measure', S.width);
  r.style.setProperty('--font-read', S.font === 'sans' ? 'var(--font-ui)' : 'var(--font-serif)');
  $('#chapter').classList.toggle('justify', S.justify);
  const bg = getComputedStyle(r).getPropertyValue('--bg').trim();
  document.querySelector('meta[name="theme-color"]').content = bg || '#14162a';
  if (R.id) relayout();
}

// ---------------- toast / status ----------------
let toastT;
function toast(msg, ms = 3200) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), ms);
}
function status(msg) { const s = $('#status'); s.textContent = msg || ''; s.hidden = !msg; }

// ---------------- library ----------------
const coverUrls = new Map();
async function bookId(title, author) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${title}\n${author}`.toLowerCase()));
  return [...new Uint8Array(d).slice(0, 8)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function thumb(bytes, type) {
  const blob = new Blob([bytes], { type });
  try {
    const bmp = await createImageBitmap(blob);
    const w = Math.min(360, bmp.width), h = Math.round(bmp.height * w / bmp.width);
    const c = new OffscreenCanvas(w, h);
    c.getContext('2d').drawImage(bmp, 0, 0, w, h);
    return await c.convertToBlob({ type: 'image/jpeg', quality: 0.86 });
  } catch { return blob; }
}

async function importFiles(files) {
  let added = 0, lastId = null;
  for (const f of files) {
    if (!/\.epub$/i.test(f.name) && f.type !== 'application/epub+zip') { toast(`${f.name} is not an .epub file.`); continue; }
    try {
      const buf = await f.arrayBuffer();
      const book = await parseEpub(buf);
      const id = await bookId(book.title, book.author);
      if (await db.get('books', id)) { toast(`“${book.title}” is already on your shelf.`); lastId = id; continue; }
      const cover = book.cover ? await thumb(await book.zip.read(book.cover.path), book.cover.type) : null;
      await db.set('files', id, new Blob([buf], { type: 'application/epub+zip' }));
      await db.set('books', id, { id, title: book.title, author: book.author, lang: book.lang, cover, added: Date.now(), opened: 0, chapters: book.spine.length });
      added++; lastId = id;
    } catch (e) {
      toast(`Couldn't add ${f.name}: ${e.message}`, 6000);
    }
  }
  if (added) {
    toast(added === 1 ? 'Added to your shelf.' : `Added ${added} books.`);
    navigator.storage?.persist?.().catch(() => {});
  }
  await renderShelf();
  return lastId;
}

async function renderShelf() {
  const [books, progress] = await Promise.all([db.all('books').catch(() => []), db.all('progress').catch(() => [])]);
  const prog = new Map(progress.map(p => [p.id, p]));
  books.sort((a, b) => (b.opened || b.added) - (a.opened || a.added));
  $('#emptyShelf').hidden = books.length > 0;
  $('#shelf').replaceChildren(...books.map(b => {
    const p = prog.get(b.id), pct = Math.round((p?.pct || 0) * 100);
    if (b.cover && !coverUrls.has(b.id)) coverUrls.set(b.id, URL.createObjectURL(b.cover));
    const el = document.createElement('div');
    el.className = 'book';
    el.innerHTML = `
      <button class="book-open" aria-label="Open ${esc(b.title)}">
        ${b.cover ? `<div class="cover"><img src="${coverUrls.get(b.id)}" alt=""></div>` : `<div class="cover blank">${esc(b.title)}</div>`}
        <div class="book-title">${esc(b.title)}</div>
      </button>
      <div class="book-meta"><span>${esc(b.author || 'Unknown author')}</span><span class="num">${p ? pct + '%' : 'New'}</span></div>
      <div class="bar-progress"><i style="width:${pct}%"></i></div>
      <button class="book-del" aria-label="Remove ${esc(b.title)}"><svg class="i"><use href="#i-trash"/></svg></button>`;
    el.querySelector('.book-open').onclick = () => openBook(b.id);
    el.querySelector('.book-del').onclick = () => {
      const c = document.createElement('div');
      c.className = 'confirm';
      c.innerHTML = `<span>Remove this book and its saved audio position?</span><div class="row"><button class="btn small primary">Remove</button><button class="btn small">Keep</button></div>`;
      const [yes, no] = c.querySelectorAll('button');
      yes.onclick = async () => { await Promise.all([db.del('books', b.id), db.del('files', b.id), db.del('progress', b.id), db.del('kv', 'bm:' + b.id)]); renderShelf(); };
      no.onclick = () => c.remove();
      el.append(c);
      yes.focus();
    };
    return el;
  }));
}

// ---------------- reader state ----------------
const R = { id: null, meta: null, book: null, ch: 0, blocks: [], chunks: [], titles: [], page: 0, pages: 1, W: 0, anchor: 0, bookmarks: [], sleep: null };
const els = { viewport: $('#viewport'), chapter: $('#chapter') };

const player = new Player({
  settings: () => S,
  text: i => speakable(R.chunks[i]?.raw || '', S),
  lang: () => R.book?.lang,
  onChunk: i => showChunk(i),
  onEnd: () => chapterFinished(),
  onState: () => updatePlayUI(),
  onError: e => { status(e.message); updatePlayUI(); },
  sleepDue: () => {
    if (R.sleep?.until && Date.now() >= R.sleep.until) { R.sleep = null; updateSleepUI(); toast('Sleep timer: paused.'); return true; }
    return false;
  },
});

async function openBook(id) {
  const [meta, file, prog, bms] = await Promise.all([db.get('books', id), db.get('files', id), db.get('progress', id), db.get('kv', 'bm:' + id)]);
  if (!meta || !file) { toast('That book is missing. Try adding it again.'); return; }
  let book;
  try { book = await parseEpub(await file.arrayBuffer()); } catch (e) { toast(`Couldn't open the book: ${e.message}`); return; }
  closeBook(false);
  Object.assign(R, { id, meta, book, bookmarks: bms || [], titles: [] });
  for (const t of book.toc) R.titles[t.ch] ??= t.title;
  meta.opened = Date.now();
  db.set('books', id, meta).catch(() => {});
  $('#rBook').textContent = meta.title;
  $('#library').hidden = true;
  $('#reader').hidden = false;
  status('');
  await renderChapter(clamp(prog?.ch || 0, 0, book.spine.length - 1), { block: prog?.block || 0 });
}

function closeBook(show = true) {
  player.setChunks([]);
  updatePlayUI();
  if (R.book?.urls) for (const u of R.book.urls.values()) URL.revokeObjectURL(u);
  CSS.highlights?.clear();
  R.id = null; R.book = null;
  els.chapter.replaceChildren();
  if (show) { $('#reader').hidden = true; $('#library').hidden = false; renderShelf(); }
}

function chapterTitle(i) {
  if (R.titles[i]) return R.titles[i];
  if (i === R.ch) {
    const h = els.chapter.querySelector('h1,h2,h3');
    if (h?.textContent.trim()) return h.textContent.trim().slice(0, 80);
  }
  for (let k = i - 1; k >= 0; k--) if (R.titles[k]) return R.titles[k];
  return `Section ${i + 1}`;
}

async function renderChapter(i, { block = 0, frag = '', last = false } = {}) {
  R.ch = i;
  const root = await loadChapter(R.book, i);
  els.chapter.replaceChildren(...root.childNodes);
  els.chapter.lang = R.book.lang;
  rebuildChunks();
  $('#rChapter').textContent = chapterTitle(i);
  $('#prevChap').disabled = i === 0;
  $('#nextChap').disabled = i >= R.book.spine.length - 1;
  layout();
  if (frag) { const t = els.chapter.querySelector('#' + CSS.escape(frag)); if (t) block = blockOf(t); }
  if (last && S.layout === 'paged') goToPage(R.pages - 1); else goToBlock(block);
  for (const img of els.chapter.querySelectorAll('img')) if (!img.complete) img.addEventListener('load', relayout, { once: true });
  updateMedia();
  updateBookmarkUI();
}

function rebuildChunks() {
  const { blocks, chunks } = buildChunks(els.chapter, { lang: R.book.lang, skipNotes: S.skipNotes, splitDialogue: S.dialogueVoice });
  R.blocks = blocks; R.chunks = chunks;
  player.setChunks(chunks);
  CSS.highlights?.delete('tts');
  $('#seek').max = Math.max(0, blocks.length - 1);
}

function blockOf(node) {
  const i = R.blocks.findIndex(b => b.el === node || node.contains(b.el) || b.el.contains(node) ||
    (node.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING));
  return i < 0 ? Math.max(0, R.blocks.length - 1) : i;
}

// ---------------- layout: scroll or paged ----------------
function layout() {
  const paged = S.layout === 'paged', ch = els.chapter, vp = els.viewport;
  vp.classList.toggle('paged', paged);
  ch.style.cssText = '';
  if (!paged) return;
  vp.scrollTop = 0;
  const W = vp.clientWidth, H = vp.clientHeight - 2 * parseFloat(getComputedStyle(vp).paddingTop);
  const measure = parseFloat(getComputedStyle(ch).fontSize) * S.width;
  const m = Math.max(20, (W - measure) / 2);
  Object.assign(ch.style, { height: H + 'px', width: W - 2 * m + 'px', marginLeft: m + 'px', columnWidth: W - 2 * m + 'px', columnGap: 2 * m + 'px', columnFill: 'auto' });
  R.W = W;
  R.pages = Math.max(1, Math.round((ch.scrollWidth + 2 * m) / W));
}

function relayout() {
  if (!R.id) return;
  const a = R.anchor;
  layout();
  goToBlock(a);
}

const firstRect = el => (el.getClientRects?.()[0]) || el.getBoundingClientRect();
// page of a box = page holding its centre (robust to negative margins and column gaps)
function pageOf(rect) { return clamp(Math.floor((rect.left + Math.min(rect.width, R.W) / 2 - els.chapter.getBoundingClientRect().left) / R.W), 0, R.pages - 1); }

function goToPage(p) {
  R.page = clamp(p, 0, R.pages - 1);
  els.chapter.style.transform = `translateX(${-R.page * R.W}px)`;
  // anchor = first block that starts on this page (or the one running into it)
  let a = R.blocks.length - 1;
  for (let k = 0; k < R.blocks.length; k++) {
    const pg = pageOf(firstRect(R.blocks[k].el));
    if (pg >= R.page) { a = pg > R.page ? Math.max(0, k - 1) : k; break; }
  }
  setAnchor(Math.max(0, a));
}

function goToBlock(i) {
  i = clamp(i, 0, Math.max(0, R.blocks.length - 1));
  const b = R.blocks[i];
  if (S.layout === 'paged') {
    if (!b) return goToPage(0);
    const p = pageOf(firstRect(b.el));
    R.page = p;
    els.chapter.style.transform = `translateX(${-p * R.W}px)`;
    setAnchor(i);
  } else {
    const vp = els.viewport;
    vp.scrollTop = b && i > 0 ? b.el.getBoundingClientRect().top - vp.getBoundingClientRect().top + vp.scrollTop - 12 : 0;
    setAnchor(i);
  }
}

function setAnchor(i) {
  R.anchor = i;
  $('#seek').value = i;
  const n = R.book.spine.length, frac = R.blocks.length ? i / R.blocks.length : 0;
  $('#chapPos').textContent = S.layout === 'paged' ? `${R.page + 1} / ${R.pages}` : `${R.ch + 1} / ${n}`;
  $('#bookPct').textContent = Math.round(((R.ch + frac) / n) * 100) + '%';
  saveProgress();
  updateBookmarkUI();
}

let progT;
function saveProgress() {
  clearTimeout(progT);
  const id = R.id, ch = R.ch, block = R.anchor, pct = (R.ch + (R.blocks.length ? R.anchor / R.blocks.length : 0)) / R.book.spine.length;
  progT = setTimeout(() => db.set('progress', id, { id, ch, block, pct, at: Date.now() }).catch(() => {}), 400);
}

// scroll mode: anchor = first block whose bottom is below the top edge (binary search)
let scrollRaf;
els.viewport.addEventListener('scroll', () => {
  if (S.layout === 'paged' || !R.id) return;
  cancelAnimationFrame(scrollRaf);
  scrollRaf = requestAnimationFrame(() => {
    const top = els.viewport.getBoundingClientRect().top + 4;
    let lo = 0, hi = R.blocks.length - 1, ans = hi;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (R.blocks[mid].el.getBoundingClientRect().bottom > top) { ans = mid; hi = mid - 1; } else lo = mid + 1;
    }
    if (ans >= 0 && ans !== R.anchor) setAnchor(ans);
  });
}, { passive: true });

// keep the reading position when the window size changes (width only in scroll mode,
// so a phone's URL bar showing/hiding does not jump the text)
let lastW = 0;
new ResizeObserver(() => {
  const w = els.viewport.clientWidth;
  if (S.layout === 'paged' || w !== lastW) relayout();
  lastW = w;
}).observe(els.viewport);

function turn(d) {
  if (S.layout !== 'paged') return;
  const p = R.page + d;
  if (p < 0) { if (R.ch > 0) renderChapter(R.ch - 1, { last: true }); }
  else if (p >= R.pages) { if (R.ch < R.book.spine.length - 1) renderChapter(R.ch + 1); }
  else goToPage(p);
}

// taps: paged = left/right thirds turn pages, centre toggles bars; scroll = tap toggles bars
let down = null;
els.viewport.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY, t: Date.now() }; });
els.viewport.addEventListener('pointerup', e => {
  if (!down) return;
  const dx = e.clientX - down.x, dy = e.clientY - down.y, quick = Date.now() - down.t < 600;
  down = null;
  if (!getSelection().isCollapsed || e.target.closest('a,button')) return;
  if (S.layout === 'paged' && Math.abs(dx) > 45 && Math.abs(dy) < 80) return turn(dx < 0 ? 1 : -1);
  if (Math.abs(dx) > 8 || Math.abs(dy) > 8 || !quick) return;
  const r = els.viewport.getBoundingClientRect(), x = (e.clientX - r.left) / r.width;
  if (S.layout === 'paged' && x < 0.3) turn(-1);
  else if (S.layout === 'paged' && x > 0.7) turn(1);
  else $('#reader').classList.toggle('immersive');
});

els.chapter.addEventListener('click', e => {
  const a = e.target.closest('a[data-ch]');
  if (!a) return;
  e.preventDefault();
  const ch = +a.dataset.ch, frag = a.dataset.frag;
  if (ch < 0) return;
  if (ch === R.ch && frag) { const t = els.chapter.querySelector('#' + CSS.escape(frag)); if (t) goToBlock(blockOf(t)); }
  else renderChapter(ch, { frag });
});

$('#seek').addEventListener('input', e => goToBlock(+e.target.value));
$('#prevChap').onclick = () => R.ch > 0 && renderChapter(R.ch - 1);
$('#nextChap').onclick = () => R.ch < R.book.spine.length - 1 && renderChapter(R.ch + 1);
$('#backBtn').onclick = () => closeBook();

document.addEventListener('keydown', e => {
  if (!R.id || $('#sheet').open || e.target.closest('input,textarea,select')) return;
  if (e.key === ' ' || e.key === 'k') { e.preventDefault(); togglePlay(); }
  else if (S.layout === 'paged' && ['ArrowRight', 'PageDown'].includes(e.key)) turn(1);
  else if (S.layout === 'paged' && ['ArrowLeft', 'PageUp'].includes(e.key)) turn(-1);
  else if (e.key === 'Escape') $('#reader').classList.remove('immersive');
});

// ---------------- read-aloud ----------------
function chunkVisible(i) {
  const c = R.chunks[i];
  if (!c) return false;
  const rect = firstRect(chunkRange(R.blocks, c)), vp = els.viewport.getBoundingClientRect();
  if (S.layout === 'paged') return pageOf(rect) === R.page;
  return rect.bottom > vp.top && rect.top < vp.bottom;
}

function togglePlay() {
  if (player.playing) return player.pause();
  status('');
  if (!R.chunks.length) { toast('Nothing to read aloud in this section.'); return; }
  if (chunkVisible(player.idx)) return player.play();
  let k = R.chunks.findIndex(c => c.block >= R.anchor);
  if (k < 0) k = 0;
  player.playAt(k);
}

let speakingEl;
function showChunk(i) {
  const c = R.chunks[i];
  if (!c) return;
  const range = chunkRange(R.blocks, c);
  if (window.Highlight && CSS.highlights) CSS.highlights.set('tts', new Highlight(range));
  speakingEl?.classList.remove('speaking');
  speakingEl = R.blocks[c.block].el;
  if (speakingEl !== els.chapter) speakingEl.classList.add('speaking');
  const rect = firstRect(range);
  if (S.layout === 'paged') {
    const p = pageOf(rect);
    if (p !== R.page) goToPage(p);
  } else {
    const vp = els.viewport.getBoundingClientRect();
    if (rect.top < vp.top + 40 || rect.bottom > vp.bottom - 40) {
      els.viewport.scrollBy({ top: rect.top - vp.top - vp.height * 0.28, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }
  }
  if (c.block !== R.anchor && S.layout !== 'paged') setAnchor(c.block);
}

async function chapterFinished() {
  CSS.highlights?.delete('tts');
  speakingEl?.classList.remove('speaking');
  if (R.sleep?.chapter) { R.sleep = null; updateSleepUI(); toast('Sleep timer: stopped at the end of the chapter.'); return; }
  if (R.ch >= R.book.spine.length - 1) { toast('You reached the end of the book.'); return; }
  await renderChapter(R.ch + 1);
  player.playAt(0);
}

function updatePlayUI() {
  const b = $('#playBtn');
  b.querySelector('use').setAttribute('href', player.playing ? '#i-pause' : '#i-play');
  b.setAttribute('aria-label', player.playing ? 'Pause' : 'Read aloud');
  $('#speedBtn').textContent = S.speed.toFixed(S.speed % 0.1 ? 2 : 1) + '×';
  const names = { device: 'Device voice', qwen: 'Qwen', openai: 'OpenAI', eleven: 'ElevenLabs' };
  const voice = S.provider === 'device'
    ? (S.device.voice ? S.device.voice.replace(/^Microsoft |\s*-.*$| Online.*$/g, '') : 'Device voice')
    : String(voiceFor(S, false) || 'Pick a voice').replace(/_v3\.\d$/, '');
  const eleven = S.provider === 'eleven' && S.eleven.voices.find(([id]) => id === voice)?.[1];
  $('#voiceName').textContent = eleven || voice;
  $('#voiceBtn').title = `${names[S.provider]}: ${eleven || voice}`;
}

function updateMedia() {
  const ms = navigator.mediaSession;
  if (!ms || !window.MediaMetadata) return;
  const art = coverUrls.get(R.id) || (R.meta.cover && (coverUrls.set(R.id, URL.createObjectURL(R.meta.cover)), coverUrls.get(R.id)));
  ms.metadata = new MediaMetadata({ title: chapterTitle(R.ch), artist: R.meta.author || '', album: R.meta.title, artwork: art ? [{ src: art, sizes: '360x540', type: 'image/jpeg' }] : [] });
}

$('#playBtn').onclick = togglePlay;
$('#prevBtn').onclick = () => { status(''); player.skip(-1); };
$('#nextBtn').onclick = () => { status(''); player.skip(1); };

// "Read from here": appears when text is selected in the chapter
const readHere = $('#readHere');
document.addEventListener('selectionchange', () => {
  const sel = getSelection();
  if (!R.id || sel.isCollapsed || !sel.rangeCount || !els.chapter.contains(sel.anchorNode)) { readHere.hidden = true; return; }
  const r = sel.getRangeAt(0).getBoundingClientRect();
  readHere.style.left = clamp(r.left + r.width / 2, 90, innerWidth - 90) + 'px';
  readHere.style.top = (r.bottom + 54 > innerHeight - 130 ? r.top - 46 : r.bottom + 10) + 'px';
  readHere.hidden = false;
});
readHere.addEventListener('pointerdown', e => e.preventDefault());
readHere.onclick = () => {
  const sel = getSelection();
  if (!sel.rangeCount) return;
  const r = sel.getRangeAt(0);
  // first chunk that contains the selection start or comes after it
  let k = R.chunks.findIndex(c => chunkRange(R.blocks, c).comparePoint(r.startContainer, r.startOffset) <= 0);
  if (k < 0) k = R.chunks.length - 1;
  sel.removeAllRanges();
  readHere.hidden = true;
  status('');
  player.playAt(k);
};

// ---------------- sleep timer & speed ----------------
function updateSleepUI() {
  const l = $('#sleepLabel'), b = $('#sleepBtn');
  if (R.sleep?.until) l.textContent = Math.max(1, Math.round((R.sleep.until - Date.now()) / 60000)) + 'm';
  else l.textContent = R.sleep?.chapter ? 'Ch' : '';
  b.style.color = R.sleep ? 'var(--accent)' : '';
}
setInterval(updateSleepUI, 20000);

$('#sleepBtn').onclick = () => openSheet('Sleep timer', `
  <div class="seg" id="sleepSeg">
    ${[0, 10, 15, 30, 45, 60, 90].map(m => `<button data-m="${m}" aria-pressed="${(m === 0 && !R.sleep) || (R.sleep?.mins === m)}">${m ? m + ' min' : 'Off'}</button>`).join('')}
    <button data-m="ch" aria-pressed="${!!R.sleep?.chapter}">End of chapter</button>
  </div>
  <p class="hint">Reading pauses when the time is up, at the end of the sentence being read.</p>`, body => {
  body.querySelector('#sleepSeg').onclick = e => {
    const m = e.target.dataset.m;
    if (m === undefined) return;
    R.sleep = m === '0' ? null : m === 'ch' ? { chapter: true } : { until: Date.now() + m * 60000, mins: +m };
    updateSleepUI();
    closeSheet();
    toast(R.sleep ? 'Sleep timer set.' : 'Sleep timer off.');
  };
});

$('#speedBtn').onclick = () => openSheet('Reading speed', `
  <div class="seg" id="speedSeg">${[0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5].map(v => `<button data-v="${v}" aria-pressed="${S.speed === v}">${v}×</button>`).join('')}</div>
  <div class="field"><label for="speedRange">Fine tune <span id="speedVal" class="num">${S.speed.toFixed(2)}×</span></label>
  <input type="range" id="speedRange" min="0.5" max="3" step="0.05" value="${S.speed}"></div>
  <p class="hint">Speed changes keep the voice's natural pitch.</p>`, body => {
  const set = v => {
    S.speed = +v; saveSettings(); player.setSpeed(S.speed); updatePlayUI();
    body.querySelector('#speedVal').textContent = S.speed.toFixed(2) + '×';
    body.querySelectorAll('#speedSeg button').forEach(b => b.setAttribute('aria-pressed', +b.dataset.v === S.speed));
  };
  body.querySelector('#speedSeg').onclick = e => e.target.dataset.v && (set(e.target.dataset.v), body.querySelector('#speedRange').value = S.speed);
  body.querySelector('#speedRange').oninput = e => set(e.target.value);
});

// ---------------- bookmarks, contents, search ----------------
function currentBookmark() { return R.bookmarks.findIndex(b => b.ch === R.ch && b.block === R.anchor); }
function updateBookmarkUI() { $('#bookmarkBtn').setAttribute('aria-pressed', currentBookmark() >= 0); }
$('#bookmarkBtn').onclick = () => {
  const i = currentBookmark();
  if (i >= 0) { R.bookmarks.splice(i, 1); toast('Bookmark removed.'); }
  else {
    const text = R.blocks[R.anchor]?.text.replace(/\s+/g, ' ').trim().slice(0, 90) || '';
    R.bookmarks.push({ ch: R.ch, block: R.anchor, text, at: Date.now() });
    R.bookmarks.sort((a, b) => a.ch - b.ch || a.block - b.block);
    toast('Bookmarked.');
  }
  db.set('kv', 'bm:' + R.id, R.bookmarks).catch(() => {});
  updateBookmarkUI();
};

$('#tocBtn').onclick = () => {
  const toc = R.book.toc.length ? R.book.toc : R.book.spine.map((_, i) => ({ title: chapterTitle(i), ch: i, frag: '', depth: 0 }));
  let cur = -1;
  toc.forEach((t, i) => { if (t.ch <= R.ch) cur = i; });
  const tocHtml = toc.map((t, i) => `<button data-i="${i}" class="${i === cur ? 'current' : ''}" style="padding-left:${8 + t.depth * 16}px">${esc(t.title)}</button>`).join('');
  const bmHtml = R.bookmarks.length
    ? R.bookmarks.map((b, i) => `<button data-b="${i}"><span>${esc(chapterTitle(b.ch))}</span><small>${esc(b.text)}…</small></button>`).join('')
    : '<p class="hint">No bookmarks yet. Tap the bookmark icon at the top while reading.</p>';
  openSheet('Contents', `
    <div class="tabs" role="tablist"><button role="tab" aria-selected="true" data-t="toc">Chapters</button><button role="tab" aria-selected="false" data-t="bm">Bookmarks (${R.bookmarks.length})</button></div>
    <div class="list" id="tocList">${tocHtml}</div>
    <div class="list" id="bmList" hidden>${bmHtml}</div>`, body => {
    body.querySelector('.tabs').onclick = e => {
      const t = e.target.dataset.t;
      if (!t) return;
      body.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-selected', b.dataset.t === t));
      body.querySelector('#tocList').hidden = t !== 'toc';
      body.querySelector('#bmList').hidden = t !== 'bm';
    };
    body.querySelector('#tocList').onclick = e => {
      const b = e.target.closest('[data-i]');
      if (!b) return;
      const t = toc[b.dataset.i];
      closeSheet();
      renderChapter(t.ch, { frag: t.frag });
    };
    body.querySelector('#bmList').onclick = e => {
      const b = e.target.closest('[data-b]');
      if (!b) return;
      const m = R.bookmarks[b.dataset.b];
      closeSheet();
      renderChapter(m.ch, { block: m.block });
    };
    body.querySelector('.current')?.scrollIntoView({ block: 'center' });
  });
};

$('#searchBtn').onclick = () => openSheet('Search', `
  <form id="searchForm" class="row"><input type="search" id="searchQ" class="grow" placeholder="Word or phrase" aria-label="Search text" style="padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--bg)"><button class="btn primary">Search</button></form>
  <div class="list" id="results"></div>`, body => {
  const q = body.querySelector('#searchQ');
  q.focus();
  body.querySelector('#searchForm').onsubmit = async e => {
    e.preventDefault();
    const term = q.value.trim().toLowerCase();
    const out = body.querySelector('#results');
    if (term.length < 2) { out.innerHTML = '<p class="hint">Type at least two characters.</p>'; return; }
    out.innerHTML = '<p class="hint">Searching…</p>';
    const hits = [];
    for (let i = 0; i < R.book.spine.length && hits.length < 200; i++) {
      const t = await chapterText(R.book, i), low = t.toLowerCase();
      let p = low.indexOf(term), n = 0;
      while (p >= 0 && hits.length < 200) {
        hits.push({ ch: i, n, snip: t.slice(Math.max(0, p - 50), p + term.length + 60) });
        p = low.indexOf(term, p + term.length); n++;
      }
    }
    out.innerHTML = hits.length
      ? `<p class="hint">${hits.length >= 200 ? '200+' : hits.length} matches</p>` + hits.map((h, i) => `<button data-h="${i}"><span>${esc(chapterTitle(h.ch))}</span><small>…${esc(h.snip)}…</small></button>`).join('')
      : '<p class="hint">No matches.</p>';
    out.onclick = async ev => {
      const b = ev.target.closest('[data-h]');
      if (!b) return;
      const h = hits[b.dataset.h];
      closeSheet();
      if (h.ch !== R.ch) await renderChapter(h.ch);
      findInChapter(term, h.n);
    };
  };
});

function findInChapter(term, nth) {
  const tw = document.createTreeWalker(els.chapter, NodeFilter.SHOW_TEXT, { acceptNode: n => n.parentElement.closest('rt,rp') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
  let count = 0;
  for (let n; (n = tw.nextNode());) {
    const low = n.data.toLowerCase();
    for (let p = low.indexOf(term); p >= 0; p = low.indexOf(term, p + term.length)) {
      if (count++ !== nth) continue;
      const r = document.createRange();
      r.setStart(n, p); r.setEnd(n, p + term.length);
      if (window.Highlight) { CSS.highlights.set('found', new Highlight(r)); setTimeout(() => CSS.highlights.delete('found'), 4000); }
      goToBlock(blockOf(n.parentElement));
      if (S.layout !== 'paged') n.parentElement.scrollIntoView({ block: 'center' });
      return;
    }
  }
}

// ---------------- sheet ----------------
const sheet = $('#sheet');
function openSheet(title, html, bind) {
  $('#sheetTitle').textContent = title;
  const body = $('#sheetBody');
  body.innerHTML = html;
  if (!sheet.open) sheet.showModal();
  bind?.(body);
}
function closeSheet() { sheet.close(); }
$('#sheetClose').onclick = closeSheet;
sheet.addEventListener('click', e => { if (e.target === sheet) closeSheet(); });

// ---------------- settings sheet: Display / Voice / Data ----------------
const opt = (v, label, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`;
const THEMES = [['auto', 'Auto'], ['light', 'Light'], ['sepia', 'Sepia'], ['dark', 'Night'], ['black', 'Black']];
const SWATCH = { auto: 'linear-gradient(135deg,#fbfbfd 50%,#171a30 50%)', light: '#fbfbfd', sepia: '#f3e9d2', dark: '#171a30', black: '#000' };
const SWATCH_INK = { auto: '#9a5800', light: '#1b1c2a', sepia: '#3a2e1f', dark: '#e4e2da', black: '#cfcfcf' };

function openSettings(tab = 'display') {
  openSheet('Settings', `
    <div class="tabs" role="tablist">
      ${[['display', 'Display'], ['voice', 'Voice'], ['data', 'Backup']].map(([k, l]) => `<button role="tab" data-tab="${k}" aria-selected="${k === tab}">${l}</button>`).join('')}
    </div>
    <div id="tabBody" style="display:grid;gap:18px"></div>`, body => {
    const show = t => {
      body.querySelectorAll('[data-tab]').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === t));
      ({ display: displayTab, voice: voiceTab, data: dataTab })[t](body.querySelector('#tabBody'));
    };
    body.querySelector('.tabs').onclick = e => e.target.dataset.tab && show(e.target.dataset.tab);
    show(tab);
  });
}

function displayTab(el) {
  el.innerHTML = `
    <div class="field"><span class="label">Theme</span>
      <div class="swatches">${THEMES.map(([k, l]) => `<button data-theme="${k}" aria-pressed="${S.theme === k}" style="background:${SWATCH[k]};color:${SWATCH_INK[k]}"><b>Aa</b>${l}</button>`).join('')}</div></div>
    <div class="field"><span class="label">Layout</span>
      <div class="seg" id="layoutSeg"><button data-v="scroll" aria-pressed="${S.layout === 'scroll'}">Scroll</button><button data-v="paged" aria-pressed="${S.layout === 'paged'}">Pages</button></div></div>
    <div class="field"><span class="label">Typeface</span>
      <div class="seg" id="fontSeg"><button data-v="serif" aria-pressed="${S.font === 'serif'}" style="font-family:var(--font-serif)">Book serif</button><button data-v="sans" aria-pressed="${S.font === 'sans'}">Clean sans</button></div></div>
    <div class="field"><label for="sz">Text size <span class="num" id="szV">${S.size}px</span></label><input type="range" id="sz" min="14" max="32" step="1" value="${S.size}"></div>
    <div class="field"><label for="lh">Line spacing <span class="num" id="lhV">${S.line}</span></label><input type="range" id="lh" min="1.3" max="2.2" step="0.05" value="${S.line}"></div>
    <div class="field"><label for="wd">Line width <span class="num" id="wdV">${S.width} em</span></label><input type="range" id="wd" min="24" max="52" step="1" value="${S.width}"></div>
    <label class="switch">Justify text <input type="checkbox" id="just" ${S.justify ? 'checked' : ''}></label>`;
  el.querySelector('.swatches').onclick = e => {
    const b = e.target.closest('[data-theme]');
    if (!b) return;
    S.theme = b.dataset.theme; saveSettings(); applyDisplay();
    el.querySelectorAll('.swatches button').forEach(x => x.setAttribute('aria-pressed', x === b));
  };
  const seg = (id, key) => el.querySelector(id).onclick = e => {
    const v = e.target.dataset.v;
    if (!v) return;
    S[key] = v; saveSettings(); applyDisplay();
    el.querySelectorAll(id + ' button').forEach(x => x.setAttribute('aria-pressed', x.dataset.v === v));
  };
  seg('#layoutSeg', 'layout'); seg('#fontSeg', 'font');
  const range = (id, key, fmt) => el.querySelector(id).oninput = e => {
    S[key] = +e.target.value; saveSettings(); applyDisplay();
    el.querySelector(id + 'V').textContent = fmt(S[key]);
  };
  range('#sz', 'size', v => v + 'px'); range('#lh', 'line', v => v); range('#wd', 'width', v => v + ' em');
  el.querySelector('#just').onchange = e => { S.justify = e.target.checked; saveSettings(); applyDisplay(); };
}

const PROVIDERS = [['device', 'Free device voice'], ['qwen', 'Qwen'], ['openai', 'OpenAI'], ['eleven', 'ElevenLabs']];

function voiceTab(el) {
  const p = S.provider, cfg = S[p];
  const keyField = (label, link) => `
    <div class="field"><label for="apiKey">${label} API key</label>
      <div class="row"><input type="password" id="apiKey" class="grow" autocomplete="off" spellcheck="false" placeholder="Paste your key" value="${esc(cfg.key)}" style="padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--bg)"><button class="btn small" id="showKey" type="button">Show</button></div>
      <p class="hint">Stored only on this device and sent only to ${label}. ${link}</p></div>`;
  const voiceInput = (id, label, list, value) => `
    <div class="field"><label for="${id}">${label}</label>
      <input type="text" id="${id}" list="${id}List" value="${esc(value)}" spellcheck="false" placeholder="Voice id">
      <datalist id="${id}List">${list.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</datalist></div>`;
  let specific = '';
  if (p === 'qwen') {
    const voices = QWEN_MODELS[cfg.model] || [];
    specific = `
      ${keyField('Qwen', 'Get one at <a href="https://modelstudio.console.alibabacloud.com/" target="_blank" rel="noopener">Alibaba Cloud Model Studio</a> → API keys.')}
      <div class="field"><label for="qBase">Region (must match your key)</label><select id="qBase">${QWEN_REGIONS.map(([v, l]) => opt(v, l, cfg.base)).join('')}</select></div>
      <div class="field"><label for="qModel">Model</label><select id="qModel">${Object.keys(QWEN_MODELS).map(m => opt(m, m, cfg.model)).join('')}</select>
        <p class="hint">3.0 TTS Plus is the most expressive; 3.1 TTS Flash is the newest, fastest and has native English voices.</p></div>
      ${voiceInput('v1', 'Narrator voice', voices, cfg.voice)}
      ${S.dialogueVoice ? voiceInput('v2', 'Dialogue voice', voices, cfg.voice2) : ''}
      <div class="field"><label for="qLang">Language hint</label><select id="qLang">${['Auto', 'English', 'Japanese', 'Chinese', 'Korean', 'French', 'German', 'Spanish', 'Italian', 'Portuguese', 'Russian'].map(l => opt(l, l, cfg.lang)).join('')}</select></div>`;
  } else if (p === 'openai') {
    const list = OPENAI_VOICES.map(v => [v, v]);
    specific = `
      ${keyField('OpenAI', 'Get one at <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener">platform.openai.com</a>.')}
      <div class="field"><label for="oModel">Model</label><select id="oModel">${OPENAI_MODELS.map(m => opt(m, m, cfg.model)).join('')}</select></div>
      ${voiceInput('v1', 'Narrator voice', list, cfg.voice)}
      ${S.dialogueVoice ? voiceInput('v2', 'Dialogue voice', list, cfg.voice2) : ''}`;
  } else if (p === 'eleven') {
    specific = `
      ${keyField('ElevenLabs', 'Get one at <a href="https://elevenlabs.io/app/settings/api-keys" target="_blank" rel="noopener">elevenlabs.io</a>.')}
      <div class="field"><label for="eModel">Model</label><select id="eModel">${ELEVEN_MODELS.map(m => opt(m, m, cfg.model)).join('')}</select></div>
      ${voiceInput('v1', 'Narrator voice', cfg.voices, cfg.voice)}
      ${S.dialogueVoice ? voiceInput('v2', 'Dialogue voice', cfg.voices, cfg.voice2) : ''}
      <button class="btn small" id="loadVoices" type="button">Load my voices</button>`;
  } else {
    const vs = speechSynthesis.getVoices();
    const lang = (R.book?.lang || navigator.language || 'en').slice(0, 2);
    const sorted = [...vs].sort((a, b) => (b.lang.startsWith(lang) - a.lang.startsWith(lang)) || (/natural|online|neural/i.test(b.name) - /natural|online|neural/i.test(a.name)));
    const sel = (id, cur) => `<select id="${id}">${opt('', 'System default', cur)}${sorted.map(v => opt(v.name, `${v.name} (${v.lang})`, cur)).join('')}</select>`;
    specific = `
      <p class="hint">Free and offline, using the voices built into this device. Quality depends on the device; Microsoft Edge's "Natural" voices are the best free option. For audiobook-grade narration, use Qwen.</p>
      <div class="field"><label for="dv1">Narrator voice</label>${sel('dv1', cfg.voice)}</div>
      ${S.dialogueVoice ? `<div class="field"><label for="dv2">Dialogue voice</label>${sel('dv2', cfg.voice2)}</div>` : ''}`;
  }
  const instr = (p === 'qwen' && cfg.model.startsWith('qwen-audio')) || (p === 'openai' && cfg.model.startsWith('gpt-'));
  el.innerHTML = `
    <div class="field"><span class="label">Voice service</span>
      <div class="seg" id="provSeg">${PROVIDERS.map(([k, l]) => `<button data-v="${k}" aria-pressed="${p === k}">${l}</button>`).join('')}</div></div>
    ${specific}
    ${instr ? `<div class="field"><label for="instr">Narration style</label><textarea id="instr" maxlength="200" rows="2">${esc(S.instruction)}</textarea><p class="hint">Plain-language direction for the voice, e.g. "calm and gentle, slower pace".</p></div>` : ''}
    <div class="row"><button class="btn primary" id="testVoice" type="button"><svg class="i"><use href="#i-play"/></svg>Test voice</button><span id="testMsg" class="hint"></span></div>
    <hr class="div">
    <label class="switch">Separate voice for dialogue <input type="checkbox" id="dlg" ${S.dialogueVoice ? 'checked' : ''}></label>
    <p class="hint" style="margin-top:-12px">Text inside 「」, 『』 or quotation marks is read by the dialogue voice.</p>
    <label class="switch">Skip translator notes and footnote marks <input type="checkbox" id="notes" ${S.skipNotes ? 'checked' : ''}></label>
    <div class="field"><span class="label">Pronunciation</span>
      <div id="pron" style="display:grid;gap:6px"></div>
      <button class="btn small" id="addPron" type="button" style="justify-self:start"><svg class="i"><use href="#i-plus"/></svg>Add a word</button>
      <p class="hint">Fix how names are read, e.g. "Rimuru" → "Ree-moo-roo".</p></div>
    <hr class="div">
    ${R.id && p !== 'device' ? `<div class="field"><span class="label">Offline listening</span>
      <button class="btn" id="dlChapter" type="button"><svg class="i"><use href="#i-down"/></svg>Download this chapter's audio</button>
      <div class="meter" id="dlMeter" hidden><i></i></div><p class="hint" id="dlMsg">Generates every sentence now, so it plays later without internet and costs nothing to replay.</p></div>` : ''}
    <div class="field"><span class="label">Usage on this device</span>
      ${['qwen', 'openai', 'eleven'].map(k => `<div class="stat"><span>${PROVIDERS.find(x => x[0] === k)[1]}</span><b>${(S.usage[k] || 0).toLocaleString()} characters</b></div>`).join('')}
      <div class="stat"><span>Saved audio</span><b id="cacheSize">…</b></div>
      <button class="btn small" id="clearCache" type="button" style="justify-self:start">Clear saved audio</button></div>`;

  const changed = (rebuild = false) => {
    saveSettings(); player.reset(); updatePlayUI();
    if (rebuild && R.id) { const a = R.anchor; rebuildChunks(); goToBlock(a); }
  };
  el.querySelector('#provSeg').onclick = e => { const v = e.target.dataset.v; if (!v) return; player.pause(); S.provider = v; changed(); voiceTab(el); };
  const key = el.querySelector('#apiKey');
  if (key) {
    key.oninput = () => { cfg.key = key.value.trim(); changed(); };
    el.querySelector('#showKey').onclick = e => { key.type = key.type === 'password' ? 'text' : 'password'; e.target.textContent = key.type === 'password' ? 'Show' : 'Hide'; };
  }
  const bindVal = (id, k, after) => { const x = el.querySelector(id); if (x) x.onchange = () => { cfg[k] = x.value.trim(); changed(); after?.(); }; };
  bindVal('#qBase', 'base');
  bindVal('#qModel', 'model', () => {
    const list = QWEN_MODELS[cfg.model] || [];
    if (!list.some(([v]) => v === cfg.voice)) cfg.voice = list[0]?.[0] || '';
    if (!list.some(([v]) => v === cfg.voice2)) cfg.voice2 = list[1]?.[0] || cfg.voice;
    saveSettings(); voiceTab(el);
  });
  bindVal('#qLang', 'lang'); bindVal('#oModel', 'model', () => voiceTab(el)); bindVal('#eModel', 'model');
  bindVal('#v1', 'voice'); bindVal('#v2', 'voice2'); bindVal('#dv1', 'voice'); bindVal('#dv2', 'voice2');
  const instrEl = el.querySelector('#instr');
  if (instrEl) instrEl.onchange = () => { S.instruction = instrEl.value.trim(); changed(); };
  el.querySelector('#dlg').onchange = e => { S.dialogueVoice = e.target.checked; changed(true); voiceTab(el); };
  el.querySelector('#notes').onchange = e => { S.skipNotes = e.target.checked; changed(true); };
  el.querySelector('#loadVoices')?.addEventListener('click', async () => {
    try { cfg.voices = await elevenVoices(cfg.key); if (!cfg.voice) cfg.voice = cfg.voices[0]?.[0] || ''; saveSettings(); voiceTab(el); toast(`Loaded ${cfg.voices.length} voices.`); }
    catch (e) { toast(e.message, 6000); }
  });

  const pronEl = el.querySelector('#pron');
  const drawPron = () => {
    pronEl.innerHTML = S.pron.map((r, i) => `<div class="pron-row"><input aria-label="Written as" data-i="${i}" data-k="from" value="${esc(r.from)}" placeholder="Written"><input aria-label="Say as" data-i="${i}" data-k="to" value="${esc(r.to)}" placeholder="Say as"><button class="icon-btn" data-del="${i}" aria-label="Remove"><svg class="i"><use href="#i-x"/></svg></button></div>`).join('');
  };
  drawPron();
  pronEl.onchange = e => { const { i, k } = e.target.dataset; if (k) { S.pron[i][k] = e.target.value; changed(); } };
  pronEl.onclick = e => { const d = e.target.closest('[data-del]'); if (d) { S.pron.splice(+d.dataset.del, 1); changed(); drawPron(); } };
  el.querySelector('#addPron').onclick = () => { S.pron.push({ from: '', to: '' }); drawPron(); pronEl.querySelector('.pron-row:last-child input').focus(); };

  el.querySelector('#testVoice').onclick = async () => {
    const msg = el.querySelector('#testMsg'), sample = speakable('The lantern flickered once, and the story began. “Are you ready?” she asked.', S);
    msg.textContent = 'Generating…'; msg.classList.remove('err');
    try {
      if (S.provider === 'device') {
        const u = new SpeechSynthesisUtterance(sample);
        u.voice = speechSynthesis.getVoices().find(v => v.name === S.device.voice) || null;
        u.rate = S.speed; speechSynthesis.cancel(); speechSynthesis.speak(u);
      } else {
        const blob = await synth(sample, false, S);
        const a = new Audio(URL.createObjectURL(blob));
        a.playbackRate = S.speed; await a.play();
        saveSettings();
      }
      msg.textContent = 'Playing sample.';
    } catch (e) { msg.textContent = e.message; msg.classList.add('err'); }
  };

  const dl = el.querySelector('#dlChapter');
  if (dl) dl.onclick = async () => {
    const meter = el.querySelector('#dlMeter'), bar = meter.querySelector('i'), m = el.querySelector('#dlMsg');
    dl.disabled = true; meter.hidden = false;
    const n = R.chunks.length;
    let done = 0, failed = null, next = 0;
    const work = async () => {
      while (next < n && !failed) {
        const i = next++;
        try { await synth(speakable(R.chunks[i].raw, S), R.chunks[i].dialogue, S); } catch (e) { failed = e; }
        done++; bar.style.width = (done / n * 100) + '%'; m.textContent = `${done} of ${n} sentences ready`;
      }
    };
    await Promise.all([work(), work()]);
    saveSettings();
    m.textContent = failed ? `Stopped: ${failed.message}` : 'This chapter is saved for offline listening.';
    dl.disabled = false;
  };

  const showCache = async () => {
    const n = await db.count('audio').catch(() => 0);
    const est = await navigator.storage?.estimate?.().catch(() => null);
    el.querySelector('#cacheSize').textContent = `${n.toLocaleString()} clips${est ? ` · ${(est.usage / 1048576).toFixed(0)} MB total storage` : ''}`;
  };
  showCache();
  el.querySelector('#clearCache').onclick = async () => { await db.clear('audio'); player.reset(); showCache(); toast('Saved audio cleared.'); };
}

function dataTab(el) {
  el.innerHTML = `
    <p class="hint">Books are stored on each device separately. To continue on another device, add the same .epub there, then move your place with a backup file.</p>
    <label class="switch">Include API keys in the backup <input type="checkbox" id="withKeys"></label>
    <button class="btn primary" id="exportBtn" type="button" style="justify-self:start"><svg class="i"><use href="#i-down"/></svg>Save backup file</button>
    <div class="field"><label for="importBackup">Restore from a backup file</label><input type="file" id="importBackup" accept=".json,application/json"></div>
    <p class="hint" id="dataMsg"></p>
    <hr class="div">
    <div class="stat"><span>Storage</span><b id="storeInfo">…</b></div>`;
  navigator.storage?.estimate?.().then(e => el.querySelector('#storeInfo').textContent = `${(e.usage / 1048576).toFixed(0)} MB used of ${(e.quota / 1073741824).toFixed(1)} GB`).catch(() => {});
  el.querySelector('#exportBtn').onclick = async () => {
    const s = structuredClone(S);
    if (!el.querySelector('#withKeys').checked) for (const k of ['qwen', 'openai', 'eleven']) s[k].key = '';
    const progress = await db.all('progress');
    const bookmarks = {};
    for (const p of progress) bookmarks[p.id] = await db.get('kv', 'bm:' + p.id) || [];
    const blob = new Blob([JSON.stringify({ app: 'lantern', v: 1, at: Date.now(), settings: s, progress, bookmarks }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `lantern-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  el.querySelector('#importBackup').onchange = async e => {
    const msg = el.querySelector('#dataMsg');
    try {
      const j = JSON.parse(await e.target.files[0].text());
      if (j.app !== 'lantern') throw new Error('this is not a Lantern backup file');
      let n = 0;
      for (const p of j.progress || []) {
        const cur = await db.get('progress', p.id);
        if (!cur || (p.at || 0) > (cur.at || 0)) { await db.set('progress', p.id, p); n++; }
      }
      for (const [id, list] of Object.entries(j.bookmarks || {})) if (list.length) await db.set('kv', 'bm:' + id, list);
      for (const k of ['qwen', 'openai', 'eleven']) if (!j.settings?.[k]?.key) delete j.settings?.[k]?.key;
      for (const [k, v] of Object.entries(j.settings || {})) {
        if (!(k in DEFAULTS)) continue;
        if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(S[k], v); else S[k] = v;
      }
      saveSettings(); applyDisplay(); updatePlayUI();
      msg.textContent = `Restored. ${n} reading position${n === 1 ? '' : 's'} updated.`;
      renderShelf();
    } catch (err) { msg.textContent = `Couldn't restore: ${err.message}`; }
  };
}

$('#displayBtn').onclick = () => openSettings('display');
$('#voiceBtn').onclick = () => openSettings('voice');
$('#libSettingsBtn').onclick = () => openSettings('voice');

// ---------------- import wiring ----------------
$('#importBtn').onclick = () => $('#fileInput').click();
$('#fileInput').onchange = async e => { const id = await importFiles([...e.target.files]); e.target.value = ''; if (id && e.target.files?.length === 1) openBook(id); };
$('#sampleBtn').onclick = async () => {
  try {
    const r = await fetch('sample.epub');
    const id = await importFiles([new File([await r.blob()], 'sample.epub', { type: 'application/epub+zip' })]);
    if (id) openBook(id);
  } catch { toast('The sample book could not be loaded.'); }
};
let dragDepth = 0;
addEventListener('dragenter', e => { if ([...e.dataTransfer.types].includes('Files') && !R.id) { dragDepth++; $('#dropHint').hidden = false; } });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropHint').hidden = true; } });
addEventListener('dragover', e => e.preventDefault());
addEventListener('drop', async e => {
  e.preventDefault(); dragDepth = 0; $('#dropHint').hidden = true;
  const files = [...e.dataTransfer.files];
  if (files.length) { const id = await importFiles(files); if (id && files.length === 1) openBook(id); }
});

// ---------------- start ----------------
async function start() {
  await loadSettings();
  applyDisplay();
  updatePlayUI();
  speechSynthesis?.addEventListener?.('voiceschanged', updatePlayUI);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyDisplay);
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  // files shared to the app (Android share sheet) or opened with it (desktop)
  if (new URLSearchParams(location.search).has('shared') && 'caches' in window) {
    const c = await caches.open('lantern-share');
    const files = [];
    for (const req of await c.keys()) {
      const res = await c.match(req);
      files.push(new File([await res.blob()], decodeURIComponent(req.url.split('/').pop()), { type: 'application/epub+zip' }));
      await c.delete(req);
    }
    history.replaceState(null, '', location.pathname);
    if (files.length) { const id = await importFiles(files); if (id) return openBook(id); }
  }
  if ('launchQueue' in window) {
    launchQueue.setConsumer(async p => {
      if (!p.files?.length) return;
      const id = await importFiles(await Promise.all(p.files.map(h => h.getFile())));
      if (id) openBook(id);
    });
  }
  await renderShelf();
}
start();
