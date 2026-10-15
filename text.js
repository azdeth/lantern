// Splits a rendered chapter into speakable chunks (whole sentences, <= max chars), each
// mapped back to a DOM Range so it can be highlighted while it is read.
const INLINE = new Set(('a abbr b bdi bdo big cite code del dfn em font i ins kbd mark q rb rtc ruby s samp ' +
  'small span strike strong sub sup time tt u var wbr br img image svg').split(' '));
const QUOTES = /「[^」]*」?|『[^』]*』?|“[^”]*”?|"[^"\n]*"?/g;
const HARD = 500; // providers cap requests around 600 chars

export function buildChunks(root, { lang = 'en', max = 280, skipNotes = true, splitDialogue = false } = {}) {
  const blocks = [], byEl = new Map();
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n; (n = tw.nextNode());) {
    let el = n.parentElement, skip = false;
    while (el !== root && INLINE.has(el.localName)) {
      if (el.localName === 'sup' && skipNotes) skip = true;
      if (/noteref/.test(el.dataset.type || '') && skipNotes) skip = true;
      el = el.parentElement;
    }
    if (skip || n.parentElement.closest('rt,rp')) continue;
    if (skipNotes && el.closest('aside[data-type]')) continue;
    let b = byEl.get(el);
    if (!b) {
      if (!n.data.trim()) continue;
      b = { el, nodes: [], offs: [], text: '' };
      byEl.set(el, b);
      blocks.push(b);
    }
    b.offs.push(b.text.length);
    b.nodes.push(n);
    b.text += n.data;
  }

  const seg = new Intl.Segmenter(lang, { granularity: 'sentence' });
  const chunks = [];
  blocks.forEach((b, bi) => {
    const t = b.text;
    const push = (start, end, dialogue) => {
      const raw = t.slice(start, end).replace(/\s+/g, ' ').trim();
      if (/[\p{L}\p{N}]/u.test(raw)) chunks.push({ block: bi, start, end, raw, dialogue });
    };
    const runs = [];
    if (splitDialogue) {
      let last = 0;
      for (const m of t.matchAll(QUOTES)) {
        if (!m[0]) continue;
        if (m.index > last) runs.push([last, m.index, false]);
        runs.push([m.index, m.index + m[0].length, true]);
        last = m.index + m[0].length;
      }
      if (last < t.length) runs.push([last, t.length, false]);
    } else runs.push([0, t.length, false]);

    for (const [s, e, dlg] of runs) {
      let cs = s, ce = s;
      for (const { index, segment } of seg.segment(t.slice(s, e))) {
        const se = s + index + segment.length;
        if (se - cs > max && ce > cs) { push(cs, ce, dlg); cs = ce; }
        ce = se;
        while (ce - cs > HARD) { const cut = findCut(t, cs, cs + HARD); push(cs, cut, dlg); cs = cut; }
      }
      if (ce > cs) push(cs, ce, dlg);
    }
  });
  return { blocks, chunks };
}

function findCut(t, from, to) {
  const part = t.slice(from, to);
  const i = Math.max(part.lastIndexOf(', '), part.lastIndexOf('、'), part.lastIndexOf('，'), part.lastIndexOf('; '));
  if (i > HARD / 3) return from + i + 1;
  const sp = part.lastIndexOf(' ');
  return sp > HARD / 3 ? from + sp + 1 : to;
}

// DOM Range for chunk c (text offsets inside its block).
export function chunkRange(blocks, c) {
  const b = blocks[c.block], r = document.createRange();
  const at = pos => {
    let k = b.offs.length - 1;
    while (k > 0 && b.offs[k] > pos) k--;
    return [b.nodes[k], Math.min(pos - b.offs[k], b.nodes[k].data.length)];
  };
  r.setStart(...at(c.start));
  r.setEnd(...at(c.end));
  return r;
}

const NOTES = /\s*(?:\((?:T\/?N|TL ?notes?|TN|Translator'?s? notes?|ED|Editor'?s? notes?)\b[^)]*\)|\[(?:T\/?N|TL ?notes?|TN|Notes?)\b[^\]]*\])/gi;

// Final text sent to a voice: notes removed, pronunciation rules applied.
export function speakable(raw, { skipNotes = true, pron = [] } = {}) {
  let s = skipNotes ? raw.replace(NOTES, '') : raw;
  for (const { from, to } of pron) {
    if (!from) continue;
    const esc = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const edge = /^\w/.test(from) && /\w$/.test(from);
    s = s.replace(new RegExp(edge ? `\\b${esc}\\b` : esc, 'g'), to);
  }
  return s.trim();
}
