const EOCD = 0x06054b50;
const EOCD64 = 0x06064b50;
const EOCD64_LOCATOR = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MARKER = 'assets/private/game.json';

const SLACK = 1024;

const PARALLEL = 6;
let active = 0;
const queue = [];
async function slot(task) {
  if (active >= PARALLEL) await new Promise((resolve) => queue.push(resolve));
  active++;
  try {
    return await task();
  } finally {
    active--;
    if (queue.length) queue.shift()();
  }
}

const CHUNK = 8 << 20;
async function fetchRange(url, start, end) {
  if (end - start + 1 <= 2 * CHUNK) return fetchPiece(url, start, end);
  const out = new Uint8Array(end - start + 1);
  const pieces = [];
  for (let at = start; at <= end; at += CHUNK) {
    const last = Math.min(end, at + CHUNK - 1);
    pieces.push(fetchPiece(url, at, last).then((bytes) => out.set(bytes, at - start)));
  }
  await Promise.all(pieces);
  return out;
}

async function fetchPiece(url, start, end) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await slot(async () => {
        const response = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, cache: 'no-store' });
        if (response.status !== 206) {
          const error = new Error(response.status === 200
            ? `${url} ignores range requests, so the browser cannot read single files out of it`
            : `${url}: HTTP ${response.status}`);
          error.final = true;
          throw error;
        }
        return new Uint8Array(await response.arrayBuffer());
      });
    } catch (error) {
      if (error.final || attempt >= 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }
}

const u16 = (b, i) => b[i] | (b[i + 1] << 8);
const u32 = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
const u64 = (b, i) => u32(b, i) + u32(b, i + 4) * 4294967296;

function wrapperPrefix(names, marker = MARKER) {
  for (const name of names) {
    if (name.endsWith(marker) && name.length > marker.length) return name.slice(0, name.length - marker.length);
    if (name === marker) return '';
  }
  return '';
}

async function inflate(bytes, method, size, name) {
  let out;
  if (method === 0) out = bytes;
  else if (method === 8) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    out = new Uint8Array(await new Response(stream).arrayBuffer());
  } else throw new Error(`${name}: zip method ${method} is not supported (store or deflate only)`);
  if (out.length !== size) throw new Error(`${name}: unpacked ${out.length} of ${size} bytes`);
  return out;
}

export async function openPack(url, storeFor = null, marker = MARKER) {
  const head = await fetch(url, { method: 'HEAD', cache: 'no-store' });
  if (!head.ok) throw new Error(`${url}: HTTP ${head.status}`);
  const size = Number(head.headers.get('content-length'));
  if (!size) throw new Error(`${url} did not report its size`);
  const version = `${size}-${head.headers.get('etag') || head.headers.get('last-modified') || ''}`.replace(/[^\w.-]/g, '');
  const store = storeFor ? storeFor(version) : null;

  const versioned = `${url}${url.includes('?') ? '&' : '?'}v=${version}`;

  let downloaded = 0;

  const savedRange = async (start, end) => Boolean(store && store.has && await store.has(`${start}-${end}`));
  const range = async (url, start, end) => {
    const key = `${start}-${end}`;
    if (store) {
      const saved = await store.get(key);
      if (saved && saved.length === end - start + 1) return saved;
    }
    const bytes = await fetchRange(versioned, start, end);
    downloaded += bytes.length;
    if (store) await store.put(key, bytes);
    return bytes;
  };

  const tail = await range(url, Math.max(0, size - 65557), size - 1);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (u32(tail, i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(`${url} is not a zip`);
  let directorySize = u32(tail, eocd + 12);
  let directoryOffset = u32(tail, eocd + 16);
  if (eocd >= 20 && u32(tail, eocd - 20) === EOCD64_LOCATOR) {
    const record = u64(tail, eocd - 12);
    const header = await range(url, record, record + 55);
    if (u32(header, 0) !== EOCD64) throw new Error(`${url} has a broken zip64 record`);
    directorySize = u64(header, 40);
    directoryOffset = u64(header, 48);
  }

  const directory = await range(url, directoryOffset, directoryOffset + directorySize - 1);
  const decoder = new TextDecoder();
  const found = [];
  for (let at = 0; at + 46 <= directory.length && u32(directory, at) === CENTRAL;) {
    const method = u16(directory, at + 10);
    let compressed = u32(directory, at + 20);
    let uncompressed = u32(directory, at + 24);
    const nameLength = u16(directory, at + 28);
    const extraLength = u16(directory, at + 30);
    const commentLength = u16(directory, at + 32);
    let offset = u32(directory, at + 42);
    const name = decoder.decode(directory.subarray(at + 46, at + 46 + nameLength));
    if (compressed === 0xffffffff || uncompressed === 0xffffffff || offset === 0xffffffff) {
      for (let x = at + 46 + nameLength, end = x + extraLength; x + 4 <= end;) {
        const id = u16(directory, x);
        const length = u16(directory, x + 2);
        if (id === 1) {
          let slot = x + 4;
          if (uncompressed === 0xffffffff) { uncompressed = u64(directory, slot); slot += 8; }
          if (compressed === 0xffffffff) { compressed = u64(directory, slot); slot += 8; }
          if (offset === 0xffffffff) offset = u64(directory, slot);
          break;
        }
        x += 4 + length;
      }
    }
    if (!name.endsWith('/')) found.push({ name, method, compressed, size: uncompressed, offset, nameLength, extraLength });
    at += 46 + nameLength + extraLength + commentLength;
  }
  const wrapper = wrapperPrefix(found.map((entry) => entry.name), marker);
  const entries = new Map();
  for (const entry of found) {
    if (wrapper && !entry.name.startsWith(wrapper)) continue;
    const name = entry.name.slice(wrapper.length);
    if (name) entries.set(name, { ...entry, name });
  }
  if (!entries.has(marker)) throw new Error(`${url} does not contain a converted install (no ${marker})`);

  const extract = (entry, bytes, base) => {
    const at = entry.offset - base;
    if (at + 30 > bytes.length || u32(bytes, at) !== LOCAL) throw new Error(`${entry.name}: broken local header`);
    const start = at + 30 + u16(bytes, at + 26) + u16(bytes, at + 28);
    if (start + entry.compressed > bytes.length) return null;
    return bytes.subarray(start, start + entry.compressed);
  };
  const span = (entry) => entry.offset + 30 + entry.nameLength + entry.extraLength + SLACK + entry.compressed;

  async function read(name) {
    const entry = entries.get(name);
    if (!entry) return null;
    if (entry.size === 0) return new Uint8Array(0);
    let bytes = await range(url, entry.offset, Math.min(size - 1, span(entry)));
    let data = extract(entry, bytes, entry.offset);
    if (!data) {
      const header = 30 + u16(bytes, 26) + u16(bytes, 28);
      bytes = await range(url, entry.offset, entry.offset + header + entry.compressed - 1);
      data = extract(entry, bytes, entry.offset);
    }
    return inflate(data, entry.method, entry.size, name);
  }

  async function readMany(names, progress) {
    const wanted = names.map((name) => entries.get(name)).filter(Boolean).sort((a, b) => a.offset - b.offset);
    const GAP = 1 << 20;
    const runs = [];
    for (const entry of wanted) {
      const last = runs[runs.length - 1];
      const end = Math.min(size - 1, span(entry));
      if (last && entry.offset - last.end <= GAP) {
        last.end = Math.max(last.end, end);
        last.entries.push(entry);
      } else runs.push({ start: entry.offset, end, entries: [entry] });
    }
    const total = runs.reduce((sum, run) => sum + run.end - run.start + 1, 0);
    let done = 0;
    const files = new Map();
    let next = 0;
    const worker = async () => {
      while (next < runs.length) {
        const run = runs[next++];
        const bytes = await range(url, run.start, run.end);
        for (const entry of run.entries) {
          const data = extract(entry, bytes, run.start);
          files.set(entry.name, data ? await inflate(data, entry.method, entry.size, entry.name) : await read(entry.name));
        }
        done += bytes.length;
        if (progress) progress(done, total);
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, runs.length) }, worker));
    return files;
  }

  return {
    url,
    version,
    get downloaded() { return downloaded; },
    entries,
    has: (name) => entries.has(name),

    fetchAhead: async (name) => {
      const entry = entries.get(name);
      if (entry && entry.size) await range(url, entry.offset, Math.min(size - 1, span(entry)));
    },

    saved: async (name) => {
      const entry = entries.get(name);
      return Boolean(entry) && savedRange(entry.offset, Math.min(size - 1, span(entry)));
    },
    list: () => [...entries.values()].map((entry) => ({ path: entry.name, size: entry.size })),
    read,
    readMany,
  };
}
