import { openPack } from './pack.js?v=9798389b2cfa';

const ORIGIN_KEY = 'skate3-source-origin';

const PACK_KEY = 'skate3-pack-url';
const isZip = (value) => /\.zip(\?.*)?$/i.test(value);
const LOCAL_DIR = 'skate3-local';

const MOUNTED = /^(assets|settings)\/|^userdata\/custom-characters\/entries\/[0-9a-f]{64}\/(manifest\.json|preview\.png)$/;

const LAZY = /^assets\/private\/(customisation\/(?!.*\.json$)|audio\/.*\.ogg$)/;

const UNUSED = /^assets\/private\/(customisation\/sets\/[^/]+\/catalog\.json|native-props\/|native-backdrops\/)/;
const mountedPath = (path) => MOUNTED.test(path) && !LAZY.test(path) && !UNUSED.test(path);

const otherSky = (path, map, frontEnd = false) => {
  const sky = /^assets\/private\/native-skies\/([^/.]+)\./.exec(path);
  if (sky && frontEnd) return true;
  const stem = (map || '').replace(/^.*\//, '').replace(/\.skate$/i, '');
  return Boolean(sky && stem && sky[1].toLowerCase() !== stem.toLowerCase());
};
const MAP_FILE = /^maps\/(private\/)?[^/]+\.(skate|irradiance)$/i;
const NEAREST = ['NotFoundError', 'TypeMismatchError'];

export function origin() {
  let saved = (localStorage.getItem(ORIGIN_KEY) || '').trim();

  if (isZip(saved)) {
    localStorage.setItem(PACK_KEY, saved);
    localStorage.removeItem(ORIGIN_KEY);
    saved = '';
  }
  return (saved || location.origin).replace(/\/+$/, '');
}

export function setOrigin(value) {
  const clean = (value || '').trim().replace(/\/+$/, '');
  packState = null;
  cached = null;

  if (isZip(clean)) {
    localStorage.setItem(PACK_KEY, clean);
    localStorage.removeItem(ORIGIN_KEY);
    return;
  }
  localStorage.removeItem(PACK_KEY);
  if (!clean || clean === location.origin) localStorage.removeItem(ORIGIN_KEY);
  else localStorage.setItem(ORIGIN_KEY, clean);
}

let cached = null;

let packState = null;

const DOWNLOADS = 'skate3-downloads-v1';
const DOWNLOAD_KEY = `${location.origin}/__skate3-downloads/`;

const cacheApi = () => typeof caches !== 'undefined' && window.isSecureContext;
const hasDownloads = () => cacheApi() || typeof indexedDB !== 'undefined';
let persistAsked = false;

async function downloads() {
  if (!hasDownloads()) return null;
  try {
    return cacheApi() ? await caches.open(DOWNLOADS) : await idbCache();
  } catch {
    return null;
  }
}

const IDB_DOWNLOADS = 'skate3-downloads';
let idbOpen = null;
function idbCache() {
  idbOpen ||= new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_DOWNLOADS, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('files');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const run = (db, mode, action) => new Promise((resolve, reject) => {
    const transaction = db.transaction('files', mode);
    const request = action(transaction.objectStore('files'));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = transaction.onabort = () => reject(transaction.error);
  });
  return idbOpen.then((db) => ({
    async match(key) {
      const found = await run(db, 'readonly', (files) => files.get(typeof key === 'string' ? key : key.url));
      if (!found) return undefined;
      return { headers: new Headers(found.headers), arrayBuffer: () => found.blob.arrayBuffer() };
    },
    async put(key, response) {
      const blob = await response.blob();
      const headers = Object.fromEntries(response.headers.entries());
      await run(db, 'readwrite', (files) => files.put({ blob, headers }, key));
    },
    async keys() {
      return (await run(db, 'readonly', (files) => files.getAllKeys())).map((url) => ({ url }));
    },
    async delete(key) {
      await run(db, 'readwrite', (files) => files.delete(typeof key === 'string' ? key : key.url));
      return true;
    },
  }));
}

async function savedDownload(key) {
  const cache = await downloads();
  const hit = cache && await cache.match(DOWNLOAD_KEY + key).catch(() => null);
  return hit ? new Uint8Array(await hit.arrayBuffer()) : null;
}

async function saveDownload(key, bytes, headers = {}) {
  const cache = await downloads();
  if (!cache) return;

  if (!persistAsked && navigator.storage && navigator.storage.persist) {
    persistAsked = true;
    navigator.storage.persist().catch(() => {});
  }
  try {
    await cache.put(DOWNLOAD_KEY + key, new Response(bytes, { headers: { 'Content-Length': String(bytes.length), ...headers } }));
  } catch (error) {

    console.warn('could not save download', key, error && error.name);
  }
}

function packStore(url, version) {
  const prefix = `pack/${encodeURIComponent(url)}/`;
  (async () => {
    const cache = await downloads();
    if (!cache) return;
    for (const request of await cache.keys()) {
      const key = request.url.slice(DOWNLOAD_KEY.length);
      if (key.startsWith(prefix) && !key.startsWith(`${prefix}${version}/`)) await cache.delete(request);
    }
  })().catch(() => {});
  return {
    get: (key) => savedDownload(`${prefix}${version}/${key}`),
    put: (key, bytes) => saveDownload(`${prefix}${version}/${key}`, bytes),
    has: async (key) => {
      const cache = await downloads();
      return Boolean(cache && await cache.match(DOWNLOAD_KEY + `${prefix}${version}/${key}`).catch(() => null));
    },
  };
}

export async function downloadsSize() {
  const cache = await downloads();
  if (!cache) return 0;
  let total = 0;
  for (const request of await cache.keys()) {
    const hit = await cache.match(request);
    total += Number(hit && hit.headers.get('Content-Length')) || 0;
  }
  return total;
}

export async function clearDownloads() {
  if (cacheApi()) await caches.delete(DOWNLOADS).catch(() => {});
  if (typeof indexedDB !== 'undefined') {
    idbOpen = null;
    indexedDB.deleteDatabase(IDB_DOWNLOADS);
  }
}

const prefetching = new Map();
const prefetchQueue = [];
let prefetchRunning = false;

export function prefetch(path, background = false) {
  if (!hasDownloads() || prefetching.has(path) || prefetchQueue.includes(path)) return;
  if (background) prefetchQueue.push(path);
  else prefetchQueue.unshift(path);
  if (!prefetchRunning) runPrefetch();
}

async function runPrefetch() {
  prefetchRunning = true;
  while (prefetchQueue.length) {
    const path = prefetchQueue.shift();
    const job = (async () => {
      const pack = await gamePack().catch(() => null);
      if (pack && pack.has(path)) {
        if (!(await pack.saved(path))) await (pack.fetchAhead ? pack.fetchAhead(path) : pack.read(path));
      } else if (SAVED_FROM_SERVER.test(path)) {
        await fromServerSaved(path);
      }
    })().catch((error) => console.info('background download stopped:', path, error && error.message));
    prefetching.set(path, job);
    await job;
  }
  prefetchRunning = false;
}

const SAVED_FROM_SERVER = /^maps\//;

async function fromServerSaved(path) {
  const key = `server/${encodeURIComponent(origin())}/${path}`;
  const cache = await downloads();
  const hit = cache && await cache.match(DOWNLOAD_KEY + key).catch(() => null);
  const etag = hit && hit.headers.get('X-Skate3-ETag');
  const response = await fetch(`${origin()}/${path}`, { cache: 'no-store', headers: etag ? { 'If-None-Match': etag } : {} });
  if (response.status === 304 && hit) return new Uint8Array(await hit.arrayBuffer());
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const tag = response.headers.get('ETag');
  if (tag) await saveDownload(key, bytes, { 'X-Skate3-ETag': tag });
  return bytes;
}

async function packUrl() {
  const forced = new URLSearchParams(location.search).get('pack');
  if (forced) return { url: forced, fallback: false };
  origin();
  const chosen = (localStorage.getItem(PACK_KEY) || '').trim();
  if (chosen) return { url: chosen, fallback: false };
  try {
    const response = await fetch(`${origin()}/config.json`, { cache: 'no-cache' });
    if (!response.ok) return null;
    const config = await response.json();
    return typeof config.pack === 'string' && config.pack ? { url: config.pack, fallback: Boolean(config.fallback) } : null;
  } catch {
    return null;
  }
}

const ADD_ONS = [
  { file: 'skate3-audio.zip', marker: 'assets/private/audio/sounds.json', what: 'game audio', override: true },
  { file: 'skate3-ui.zip', marker: 'assets/private/frontend/buttons.json', what: 'original UI screens', override: true },
];

async function packParts(main, url) {
  if (!main.has('assets/private/pack-parts.json')) return [];
  const list = JSON.parse(new TextDecoder().decode(await main.read('assets/private/pack-parts.json')));
  return Promise.all(list.map(async ({ file, marker }) => {
    const address = new URL(file, url).href;
    return openPack(address, hasDownloads() ? (version) => packStore(address, version) : null, marker);
  }));
}

async function addOnPacks(url) {
  const opened = [];
  for (const addOn of ADD_ONS) {
    const address = new URL(addOn.file, url).href;
    try {
      const pack = await openPack(address, hasDownloads() ? (version) => packStore(address, version) : null, addOn.marker);
      pack.override = Boolean(addOn.override);
      opened.push(pack);
    } catch (error) {
      console.info(`No ${addOn.what} pack at ${address} (${error.message || error}); continuing without it.`);
    }
  }
  return opened;
}

function combine(main, extras) {
  if (!extras.length) return main;
  const all = [...extras.filter((pack) => pack.override), main, ...extras.filter((pack) => !pack.override)];
  const owner = (name) => all.find((pack) => pack.has(name));
  return {
    url: main.url,
    version: main.version,
    get downloaded() { return all.reduce((sum, pack) => sum + pack.downloaded, 0); },
    has: (name) => all.some((pack) => pack.has(name)),
    saved: async (name) => { const pack = owner(name); return Boolean(pack && pack.saved && await pack.saved(name)); },
    fetchAhead: async (name) => { const pack = owner(name); if (pack && pack.fetchAhead) await pack.fetchAhead(name); },
    list: () => {
      const seen = new Set();
      const out = [];
      for (const pack of all) for (const file of pack.list()) if (!seen.has(file.path)) { seen.add(file.path); out.push(file); }
      return out;
    },
    read: (name) => { const pack = owner(name); return pack ? pack.read(name) : Promise.resolve(null); },
    async readMany(names, progress) {
      const files = new Map();
      const groups = all.map((pack) => names.filter((name) => owner(name) === pack));
      let before = 0;
      for (const [index, pack] of all.entries()) {
        if (!groups[index].length) continue;
        let last = 0;
        const part = await pack.readMany(groups[index], (done, total) => {
          last = total;
          if (progress) progress(before + done, before + total);
        });
        before += last;
        for (const [name, bytes] of part) files.set(name, bytes);
      }
      return files;
    },
  };
}

export function gamePack() {
  if (!packState) {
    packState = (async () => {
      const source = await packUrl();
      if (!source) return null;
      const { url } = source;
      try {

        const main = await openPack(url, hasDownloads() ? (version) => packStore(url, version) : null);
        return combine(main, [...await packParts(main, url), ...await addOnPacks(url)]);
      } catch (error) {
        if (source.fallback) {
          console.warn(`Game data pack ${url} unreadable here (${error.message}); reading through the game server.`);
          return null;
        }
        const reason = error instanceof TypeError
          ? 'the browser could not reach it. The host must allow this site to read it (CORS) and answer range requests; see DEPLOY.md.'
          : error.message;
        throw new Error(`Game data pack ${url}: ${reason}`);
      }
    })();
    packState.catch(() => { packState = null; });
  }
  return packState;
}

export async function manifest(reload = false) {
  const base = origin();
  if (!reload && cached && cached.base === base && Date.now() - cached.at < 5000) return cached.files;
  const response = await fetch(`${base}/manifest.json`, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`No file list at ${base}/manifest.json (HTTP ${response.status}).`);
  let files = await response.json();
  if (!Array.isArray(files)) throw new Error(`${base}/manifest.json is not a list of files.`);

  const pack = await gamePack();
  if (pack) {
    const own = new Set(files.map((file) => file && file.path));
    files = [...pack.list().filter((file) => !own.has(file.path)), ...files];
  }
  cached = { base, at: Date.now(), files };
  return files;
}

async function fromOrigin(path) {
  const pack = await gamePack().catch(() => null);
  if (pack && pack.has(path)) return pack.read(path);
  if (SAVED_FROM_SERVER.test(path) && hasDownloads()) return fromServerSaved(path);
  const response = await fetch(`${origin()}/${path}`, { cache: 'no-cache' });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

let bundle = null;
let pending = null;
let unavailable = false;

export function startBootPackage(progress) {
  if (unavailable || bundle || pending) return pending;
  pending = (async () => {
    const pack = await gamePack();
    if (pack) {

      const names = pack.list().map((file) => file.path).filter(mountedPath);
      const before = pack.downloaded;
      const files = await pack.readMany(names, (done, total) => {

        if (progress) progress(done, total, pack.downloaded > before ? 'Downloading game data' : 'Loading saved game data');
      });
      bundle = files;
      return files;
    }
    const saved = await savedBootPackage(progress).catch((error) => {
      console.warn('saved game data unavailable, downloading:', error && error.message);
      return null;
    });
    if (saved) {
      bundle = await splitBootStream(saved);
      return bundle;
    }
    const response = await fetch(`${origin()}/boot-package`, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const expected = Number(response.headers.get('X-Boot-Bytes'))
      || Number(response.headers.get('Content-Length')) || 0;
    bundle = await splitBootStream(response.body, (at) => {
      if (progress) progress(at, expected || at, 'Downloading game data');
    });
    return bundle;
  })().catch((error) => {

    unavailable = true;
    console.warn('no boot package, asking for files one at a time:', error.message || error);
    return null;
  }).finally(() => {
    pending = null;
  });
  return pending;
}

async function splitBootStream(stream, progress) {
  const reader = stream.getReader();
  const files = new Map();
  let pending = new Uint8Array(0);
  let headerLength = -1;
  let list = null;
  let index = 0;
  let current = null;
  let filled = 0;
  let total = 0;
  const take = (chunk) => {
    let at = 0;
    while (at < chunk.length || (list && index < list.length && list[index].size === 0)) {
      if (!list) {

        const joined = new Uint8Array(pending.length + chunk.length - at);
        joined.set(pending);
        joined.set(chunk.subarray(at), pending.length);
        pending = joined;
        at = chunk.length;
        if (headerLength < 0 && pending.length >= 4) headerLength = new DataView(pending.buffer).getUint32(0, true);
        if (headerLength >= 0 && pending.length >= 4 + headerLength) {
          list = JSON.parse(new TextDecoder().decode(pending.subarray(4, 4 + headerLength))).files;
          const rest = pending.subarray(4 + headerLength);
          pending = new Uint8Array(0);
          if (rest.length) take(rest);
        }
        return;
      }
      if (index >= list.length) return;
      const file = list[index];
      if (!current) { current = new Uint8Array(file.size); filled = 0; }
      const count = Math.min(file.size - filled, chunk.length - at);
      current.set(chunk.subarray(at, at + count), filled);
      filled += count;
      at += count;
      if (filled === file.size) {
        files.set(file.path, current);
        current = null;
        index++;
      }
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    take(value);
    if (progress) progress(total);
  }
  if (!list || index < list.length) throw new Error('boot package ended early');
  return files;
}

async function savedBootPackage(progress) {
  if (!hasDownloads() || typeof DecompressionStream === 'undefined') return null;
  const key = `server/${encodeURIComponent(origin())}/boot-package.gz`;
  const cache = await downloads();
  if (!cache) return null;
  const hit = await cache.match(DOWNLOAD_KEY + key).catch(() => null);
  const etag = hit && hit.headers.get('X-Skate3-ETag');
  const response = await fetch(`${origin()}/boot-package?raw=1`, { cache: 'no-store', headers: etag ? { 'If-None-Match': etag } : {} });
  let compressed;
  if (response.status === 304 && hit) {
    if (progress) progress(1, 1, 'Loading saved game data');
    compressed = new Uint8Array(await hit.arrayBuffer());
  } else if (response.ok && response.headers.get('X-Boot-Raw')) {
    const expected = Number(response.headers.get('Content-Length')) || 0;
    const reader = response.body.getReader();
    compressed = new Uint8Array(expected);
    let at = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (compressed.length - at < value.length) {
        const grown = new Uint8Array(Math.max(compressed.length * 2, at + value.length));
        grown.set(compressed.subarray(0, at));
        compressed = grown;
      }
      compressed.set(value, at);
      at += value.length;
      if (progress) progress(at, expected || at, 'Downloading game data');
    }
    compressed = compressed.subarray(0, at);
    const tag = response.headers.get('ETag');
    if (tag) await saveDownload(key, compressed, { 'X-Skate3-ETag': tag });
  } else {
    return null;
  }

  return new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'));
}

export function releaseBootPackage() {
  bundle = null;
}

const memory = new Map();

const SETTINGS = /^settings\/[^/]+\.json$/;
const SETTINGS_KEY = 'skate3-settings:';
const SETTINGS_LIMIT = 256 * 1024;

function savedSettings() {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(SETTINGS_KEY)) out.push(key.slice(SETTINGS_KEY.length));
    }
  } catch {}
  return out;
}

function keepSetting(path, data) {
  if (!SETTINGS.test(path)) return;
  try {
    if (data === null || data === undefined) localStorage.removeItem(SETTINGS_KEY + path);
    else if (data.length <= SETTINGS_LIMIT) localStorage.setItem(SETTINGS_KEY + path, new TextDecoder().decode(data));
  } catch (error) {
    console.warn('could not keep setting', path, error);
  }
}

function savedSetting(path) {
  if (!SETTINGS.test(path)) return null;
  try {
    const text = localStorage.getItem(SETTINGS_KEY + path);
    return text === null ? null : new TextEncoder().encode(text);
  } catch {
    return null;
  }
}

export function hasStore() {
  return Boolean(navigator.storage && navigator.storage.getDirectory);
}

async function localRoot(create) {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(LOCAL_DIR, { create });
}

async function localDir(parts, create) {
  let dir = await localRoot(create);
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create });
  return dir;
}

const split = (path) => path.split('/').filter(Boolean);

async function readLocal(path) {
  if (!hasStore()) return memory.get(path) || savedSetting(path);
  const parts = split(path);
  const name = parts.pop();
  try {
    const handle = await (await localDir(parts, false)).getFileHandle(name);
    return new Uint8Array(await (await handle.getFile()).arrayBuffer());
  } catch (error) {
    if (error && NEAREST.includes(error.name)) return savedSetting(path);
    throw error;
  }
}

export async function writeFile(path, data) {
  keepSetting(path, data);
  if (!hasStore()) {
    if (data === null || data === undefined) memory.delete(path);
    else memory.set(path, new Uint8Array(data));
    return;
  }
  const parts = split(path);
  const name = parts.pop();
  if (data === null || data === undefined) {
    try {
      await (await localDir(parts, false)).removeEntry(name);
    } catch (error) {
      if (!error || error.name !== 'NotFoundError') throw error;
    }
    return;
  }
  const handle = await (await localDir(parts, true)).getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(data);
  await writable.close();
}

async function localFiles() {
  if (!hasStore()) return [...memory].map(([path, data]) => ({ path, size: data.length }));
  const out = [];
  async function walk(dir, base) {
    for await (const [name, handle] of dir.entries()) {
      const path = base ? `${base}/${name}` : name;
      if (handle.kind === 'directory') await walk(handle, path);
      else out.push({ path, size: (await handle.getFile()).size });
    }
  }
  try {
    await walk(await localRoot(false), '');
  } catch (error) {
    if (!error || error.name !== 'NotFoundError') throw error;
  }
  return out;
}

const LEGACY_DIR = 'skate3-install';
const LEGACY_DB = 'skate3-web';

export async function discardLegacyCache() {
  let dropped = false;
  if (hasStore()) {
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(LEGACY_DIR, { recursive: true });
      dropped = true;
    } catch (error) {
      if (!error || error.name !== 'NotFoundError') console.warn('could not drop the old copy', error);
    }
  }
  try {
    await new Promise((resolve) => {
      const request = indexedDB.deleteDatabase(LEGACY_DB);
      request.onsuccess = request.onerror = request.onblocked = () => resolve();
    });
  } catch (error) {
    console.warn('could not drop the old folder handle', error);
  }
  localStorage.removeItem('skate3-asset-origin');
  return dropped;
}

export async function localCount() {
  return (await localFiles()).length;
}

export async function clearLocal() {
  for (const path of savedSettings()) keepSetting(path, null);
  if (!hasStore()) {
    memory.clear();
    return;
  }
  try {
    await (await navigator.storage.getDirectory()).removeEntry(LOCAL_DIR, { recursive: true });
  } catch (error) {
    if (!error || error.name !== 'NotFoundError') throw error;
  }
}

export async function readFile(path) {
  const local = await readLocal(path);
  if (local) return local;
  if (pending) await pending;
  const booted = bundle && bundle.get(path);
  if (booted) {

    bundle.delete(path);
    return booted;
  }

  if (prefetching.has(path)) await prefetching.get(path);
  return fromOrigin(path);
}

export const demoMap = 'maps/format-demo.skate';

export async function installSummary() {
  let base = origin();
  try {
    const pack = await gamePack();
    if (pack) base = pack.url;
    const files = await manifest();
    const wanted = files.filter((file) => file && mountedPath(file.path));
    return {
      origin: base,
      ready: wanted.some((file) => file.path === 'assets/private/game.json'),
      files: wanted.length,
      bytes: wanted.reduce((sum, file) => sum + (file.size || 0), 0),
      maps: files
        .filter((file) => file && /^maps\/(private\/)?[^/]+\.skate$/i.test(file.path))
        .map((file) => file.path)
        .sort(),
    };
  } catch (error) {
    return { origin: base, ready: false, files: 0, bytes: 0, maps: [], error: error.message };
  }
}

export async function bootConfig(map, difficulty, capture = false, teleport = null, frontEnd = false) {
  const files = await manifest();
  const mounted = (file) => file && mountedPath(file.path) && !otherSky(file.path, map, frontEnd);
  return {
    root: 'assets',

    mount: [...new Set([
      ...files.filter(mounted).map((file) => file.path),
      ...savedSettings(),
    ])],

    declared: files
      .filter((file) => file && (MAP_FILE.test(file.path) || (mountedPath(file.path) && !mounted(file))))
      .map((file) => file.path),

    frontEnd: Boolean(frontEnd),
    map,
    difficulty: difficulty || null,
    capture,

    teleport: teleport || null,
  };
}
