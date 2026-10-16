// Network-first for the app's own files (updates show up at once), cache when offline.
const V = 'lantern-v2';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'db.js', 'epub.js', 'text.js', 'tts.js',
  'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'sample.epub'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== V && k !== 'lantern-share').map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method === 'POST' && url.pathname.endsWith('/share')) return e.respondWith(share(e.request));
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(fetch(e.request)
    .then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(V).then(c => c.put(e.request, copy)); }
      return r;
    })
    .catch(() => caches.match(e.request, { ignoreSearch: true })));
});

// Android share sheet: stash the shared .epub files, then open the app to import them.
async function share(req) {
  const form = await req.formData();
  const c = await caches.open('lantern-share');
  let i = 0;
  for (const f of form.getAll('book')) {
    if (f instanceof File) await c.put(`shared/${i++}/${encodeURIComponent(f.name || 'book.epub')}`, new Response(f));
  }
  return Response.redirect('./?shared=1', 303);
}
