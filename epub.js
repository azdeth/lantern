// EPUB reading with no libraries: zip central directory + native DecompressionStream.
const utf8 = new TextDecoder();

export function openZip(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  let e = u8.length - 22;
  const stop = Math.max(0, u8.length - 65557);
  while (e >= stop && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < stop) throw new Error('this is not an EPUB file (no zip directory found)');
  const files = new Map();
  let p = dv.getUint32(e + 16, true);
  const n = dv.getUint16(e + 10, true);
  for (let i = 0; i < n && dv.getUint32(p, true) === 0x02014b50; i++) {
    const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
    files.set(utf8.decode(u8.subarray(p + 46, p + 46 + nl)), {
      method: dv.getUint16(p + 10, true),
      size: dv.getUint32(p + 20, true),
      off: dv.getUint32(p + 42, true),
    });
    p += 46 + nl + xl + cl;
  }
  async function read(name) {
    const f = files.get(name);
    if (!f) return null;
    const start = f.off + 30 + dv.getUint16(f.off + 26, true) + dv.getUint16(f.off + 28, true);
    const raw = u8.subarray(start, start + f.size);
    if (f.method === 0) return raw.slice();
    const out = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(out).arrayBuffer());
  }
  return { files, read, text: async name => { const b = await read(name); return b && utf8.decode(b); } };
}

// Resolve an href relative to a file path inside the zip ("OEBPS/text/c1.xhtml" + "../img/a.jpg").
export function resolve(base, href) {
  const u = new URL(href, 'http://x/' + base);
  let path;
  try { path = decodeURIComponent(u.pathname.slice(1)); } catch { path = u.pathname.slice(1); }
  return { path, frag: u.hash.slice(1) };
}

const xml = (s, type = 'application/xml') => new DOMParser().parseFromString(s, type);
const tags = (doc, name) => [...doc.getElementsByTagNameNS('*', name)];

export async function parseEpub(buf) {
  const zip = openZip(buf);
  const container = await zip.text('META-INF/container.xml');
  if (!container) throw new Error('missing META-INF/container.xml');
  const opfPath = tags(xml(container), 'rootfile')[0]?.getAttribute('full-path');
  const opfText = opfPath && await zip.text(opfPath);
  if (!opfText) throw new Error('missing package (.opf) file');
  const opf = xml(opfText);

  const meta = name => tags(opf, name)[0]?.textContent.trim() || '';
  const manifest = new Map();
  for (const it of tags(opf, 'item')) {
    manifest.set(it.getAttribute('id'), {
      path: resolve(opfPath, it.getAttribute('href')).path,
      type: it.getAttribute('media-type') || '',
      props: it.getAttribute('properties') || '',
    });
  }
  const spine = tags(opf, 'itemref')
    .map(r => manifest.get(r.getAttribute('idref')))
    .filter(it => it && /x?html/.test(it.type))
    .map(it => it.path);
  if (!spine.length) throw new Error('the book has no readable chapters');

  const items = [...manifest.values()];
  const coverId = tags(opf, 'meta').find(m => m.getAttribute('name') === 'cover')?.getAttribute('content');
  const cover = items.find(i => i.props.includes('cover-image'))
    || manifest.get(coverId)
    || items.find(i => i.type.startsWith('image/') && /cover/i.test(i.path));

  return {
    zip, spine,
    title: meta('title') || 'Untitled',
    author: meta('creator'),
    lang: meta('language') || 'en',
    cover: cover?.type.startsWith('image/') ? cover : null,
    toc: await readToc(zip, manifest, opf, opfPath, spine),
  };
}

async function readToc(zip, manifest, opf, opfPath, spine) {
  const items = [...manifest.values()];
  const out = [];
  const push = (title, base, href, depth) => {
    if (!href || !title) return;
    const { path, frag } = resolve(base, href);
    const ch = spine.indexOf(path);
    if (ch >= 0) out.push({ title: title.replace(/\s+/g, ' ').trim(), ch, frag, depth });
  };
  const nav = items.find(i => i.props.split(/\s+/).includes('nav'));
  if (nav) {
    const doc = xml(await zip.text(nav.path) || '', 'application/xhtml+xml');
    const tocNav = tags(doc, 'nav').find(n => /toc/.test(n.getAttribute('epub:type') || n.getAttributeNS('http://www.idpf.org/2007/ops', 'type') || '')) || tags(doc, 'nav')[0];
    if (tocNav) {
      for (const a of tocNav.getElementsByTagNameNS('*', 'a')) {
        let depth = 0;
        for (let e = a.parentElement; e && e !== tocNav; e = e.parentElement) if (e.localName === 'ol') depth++;
        push(a.textContent, nav.path, a.getAttribute('href'), Math.max(0, depth - 1));
      }
    }
  }
  if (!out.length) {
    const ncxId = tags(opf, 'spine')[0]?.getAttribute('toc');
    const ncx = items.find(i => i.type === 'application/x-dtbncx+xml') || manifest.get(ncxId);
    if (ncx) {
      const doc = xml(await zip.text(ncx.path) || '');
      for (const np of tags(doc, 'navPoint')) {
        let depth = 0;
        for (let e = np.parentElement; e && e.localName === 'navPoint'; e = e.parentElement) depth++;
        push(tags(np, 'text')[0]?.textContent, ncx.path, tags(np, 'content')[0]?.getAttribute('src'), depth);
      }
    }
  }
  return out;
}

// ---- chapter rendering (sanitised: book scripts, styles and handlers are dropped) ----
const DROP = new Set(['script', 'style', 'link', 'meta', 'title', 'iframe', 'object', 'embed', 'form', 'input',
  'button', 'textarea', 'select', 'base', 'noscript', 'audio', 'video', 'source', 'foreignObject', 'head']);
const KEEP_ATTR = new Set(['id', 'alt', 'colspan', 'rowspan', 'viewBox', 'width', 'height', 'preserveAspectRatio', 'lang', 'dir']);
const XLINK = 'http://www.w3.org/1999/xlink';

async function parseChapter(book, i) {
  const path = book.spine[i];
  const src = await book.zip.text(path) || '';
  let doc = xml(src, 'application/xhtml+xml');
  if (doc.getElementsByTagName('parsererror').length) doc = xml(src, 'text/html');
  return { doc, path };
}

export async function loadChapter(book, i) {
  const { doc, path } = await parseChapter(book, i);
  const body = doc.body || tags(doc, 'body')[0] || doc.documentElement;
  const root = document.importNode(body, true);
  book.urls ??= new Map();
  const imgUrl = async href => {
    const p = resolve(path, href).path;
    if (!book.urls.has(p)) {
      const bytes = await book.zip.read(p);
      book.urls.set(p, bytes ? URL.createObjectURL(new Blob([bytes], { type: mimeOf(p) })) : '');
    }
    return book.urls.get(p);
  };
  const jobs = [];
  for (const el of [...root.querySelectorAll('*')]) {
    const name = el.localName;
    if (DROP.has(name)) { el.remove(); continue; }
    const href = el.getAttribute('href') || el.getAttributeNS(XLINK, 'href');
    const srcAttr = el.getAttribute('src');
    const type = el.getAttributeNS('http://www.idpf.org/2007/ops', 'type') || el.getAttribute('epub:type');
    for (const a of [...el.attributes]) if (!KEEP_ATTR.has(a.localName)) el.removeAttributeNode(a);
    if (type) el.dataset.type = type;
    if (name === 'img' && srcAttr) jobs.push(imgUrl(srcAttr).then(u => { el.src = u; el.loading = 'lazy'; }));
    else if (name === 'image' && href) jobs.push(imgUrl(href).then(u => el.setAttribute('href', u)));
    else if (name === 'a' && href) {
      if (/^https?:/i.test(href)) { el.href = href; el.target = '_blank'; el.rel = 'noopener noreferrer'; }
      else if (!/^[a-z]+:/i.test(href)) {
        const { path: p, frag } = resolve(path, href);
        el.dataset.ch = book.spine.indexOf(p);
        el.dataset.frag = frag;
        el.href = '#';
      }
    }
  }
  await Promise.all(jobs);
  return root;
}

export async function chapterText(book, i) {
  const { doc } = await parseChapter(book, i);
  const body = doc.body || tags(doc, 'body')[0] || doc.documentElement;
  for (const el of [...body.querySelectorAll('rt,rp,script,style')]) el.remove();
  return body.textContent.replace(/\s+/g, ' ');
}

export function mimeOf(p) {
  const ext = p.split('.').pop().toLowerCase();
  return { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif' }[ext] || 'application/octet-stream';
}
