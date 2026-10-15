// Tiny IndexedDB key-value wrapper. Stores: books, files, progress, kv, audio.
let dbp;
function open() {
  return (dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open('lantern', 1);
    r.onupgradeneeded = () => {
      for (const s of ['books', 'files', 'progress', 'kv', 'audio']) r.result.createObjectStore(s);
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => res(req?.result);
    t.onerror = t.onabort = () => rej(t.error);
  });
}

export const get = (s, k) => tx(s, 'readonly', o => o.get(k));
export const set = (s, k, v) => tx(s, 'readwrite', o => o.put(v, k));
export const del = (s, k) => tx(s, 'readwrite', o => o.delete(k));
export const all = s => tx(s, 'readonly', o => o.getAll());
export const count = s => tx(s, 'readonly', o => o.count());
export const clear = s => tx(s, 'readwrite', o => o.clear());
