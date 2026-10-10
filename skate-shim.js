(() => {
  const shim = {
    manifest: null,
    cdnBase: '',
    packPrefix: '/packs/',
    blobs: new Map(),
    assembling: new Map(),
    onProgress: null,
    onDone: null,
    progress: { loaded: 0, total: 0, packsDone: 0, packsTotal: 0, percent: 0 },
    stats: { assembled: 0, ranges: 0, bytesServed: 0 },

    async install({ manifestUrl, cdnBase = '', packPrefix = '/packs/',
                    showLoader = true, background = 'loadbg.jpg',
                    fileOrigin = '', onProgress = null, onDone = null }) {
      this.cdnBase = String(cdnBase).replace(/\/+$/, '');
      this.packPrefix = packPrefix;

      this.fileOrigin = String(fileOrigin).replace(/\/+$/, '');
      this.onProgress = onProgress;
      this.onDone = onDone;

      if (showLoader) this._makeLoader(background);

      try {
        const response = await fetch(manifestUrl, { cache: 'no-store' });
        if (!response.ok) throw new Error(`manifest ${manifestUrl}: HTTP ${response.status}`);
        this.manifest = await response.json();

        const names = Object.keys(this.manifest);

        const eager = names.filter((n) => !this.manifest[n].lazy);
        this.progress.total = eager.reduce((sum, n) => sum + this.manifest[n].size, 0);
        this.progress.packsTotal = eager.length;
        this._emit();

        this._patch();
        return this;
      } catch (error) {
        this._fail(error);
        throw error;
      }
    },

    _makeLoader(background = 'loadbg.jpg') {

      if (typeof document === 'undefined') return;
      if (document.getElementById('shim-loader')) return;
      const css = document.createElement('style');
      const bgUrl = String(background).replace(/"/g, '%22');
      css.textContent = `
        #shim-loader{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;
          justify-content:center;background:#000;color:#fff;font:12px/1 sans-serif;}
        #shim-loader.hidden{display:none;}
        #shim-loader::before{content:"";position:absolute;inset:0;
          background:url("${bgUrl}") center/cover no-repeat;filter:blur(20px);transform:scale(1.1);}
        #shim-loader::after{content:"";position:absolute;inset:0;background:rgba(0,0,0,.55);}
        #shim-content{position:relative;display:flex;flex-direction:column;align-items:center;}
        #shim-label{font-size:12px;margin-bottom:6px;}
        #shim-percent{font-size:12px;margin-bottom:10px;}
        #shim-track{width:min(420px,70vw);height:10px;background:rgba(255,255,255,.15);}
        #shim-fill{width:0%;height:100%;background:#fff;transition:width .12s linear;}
        #shim-note{margin-top:10px;font-size:11px;color:#bbb;}
      `;
      document.head.appendChild(css);

      const loader = document.createElement('div');
      loader.id = 'shim-loader';
      loader.innerHTML = `
        <div id="shim-content">
          <div id="shim-label">loading</div>
          <div id="shim-percent">0%</div>
          <div id="shim-track"><div id="shim-fill"></div></div>
          <div id="shim-note">preparing game data</div>
        </div>
      `;

      const attach = () => {
        if (document.body) document.body.appendChild(loader);
        else document.addEventListener('DOMContentLoaded',
          () => document.body.appendChild(loader), { once: true });
      };
      attach();
      this._loader = loader;
    },

    _emit() {
      const p = this.progress;
      p.percent = p.total ? Math.min(100, Math.floor((p.loaded / p.total) * 100)) : 0;
      if (this._loader) {
        const fill = this._loader.querySelector('#shim-fill');
        const pct = this._loader.querySelector('#shim-percent');
        const note = this._loader.querySelector('#shim-note');
        if (fill) fill.style.width = p.percent + '%';
        if (pct) pct.textContent = p.percent + '%';
        if (note) {
          note.textContent = `${(p.loaded / 1e9).toFixed(2)} / `
            + `${(p.total / 1e9).toFixed(2)} GB  ·  `
            + `${p.packsDone}/${p.packsTotal} packs`;
        }
      }
      if (this.onProgress) this.onProgress(p);
    },

    _hideLoader() {
      if (this._loader) this._loader.classList.add('hidden');
    },

    _fail(error) {
      if (this._loader) {
        const label = this._loader.querySelector('#shim-label');
        const note = this._loader.querySelector('#shim-note');
        if (label) label.textContent = 'Failed to load game data';
        if (note) note.textContent = String((error && error.message) || error);
      }
    },

    _finish() {
      this._hideLoader();
      if (this.onDone) this.onDone(this.progress);
    },

    _zipName(url) {
      if (!this.manifest) return null;
      const raw = String(url).split(/[?#]/)[0];
      let abs = raw;
      try {
        abs = new URL(raw, location.href).href;
      } catch {  }

      if (this.cdnBase && abs.includes(this.cdnBase)) return null;
      const base = abs.split('/').pop();
      return Object.prototype.hasOwnProperty.call(this.manifest, base) ? base : null;
    },

    async _fetchPart(url, attempts = 6) {
      const delays = [0, 500, 1500, 5000, 30000, 65000];
      let last = null;
      for (let attempt = 0; attempt < attempts; attempt++) {
        if (attempt > 0) {
          const wait = delays[Math.min(attempt, delays.length - 1)];
          await new Promise((r) => setTimeout(r, wait));
        }
        let response = null;
        try {

          response = await fetch(url, { cache: attempt === 0 ? 'force-cache' : 'no-store' });
        } catch (error) {
          last = new Error(`network error (${error.message})`);
          continue;
        }
        if (response.ok) return response;
        last = new Error(`HTTP ${response.status}`);

        const retryable = response.status === 403 || response.status === 404
          || response.status === 429 || response.status >= 500;
        if (!retryable) return response;
      }
      throw last || new Error('unknown failure');
    },

    async _blobFor(name) {
      if (this.blobs.has(name)) return this.blobs.get(name);
      if (this.assembling.has(name)) return this.assembling.get(name);

      const promise = (async () => {
        const entry = this.manifest[name];

        const counted = !entry.lazy;
        const buffers = [];
        for (const part of entry.parts) {
          const url = `${this.cdnBase}/${part}`;
          let response;
          try {
            response = await this._fetchPart(url);
          } catch (error) {
            throw new Error(`${part}: ${error.message}`);
          }
          if (!response.ok) throw new Error(`${part}: HTTP ${response.status}`);

          if (response.body && response.body.getReader) {
            const reader = response.body.getReader();
            const chunks = [];
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              chunks.push(value);
              if (counted) {
                this.progress.loaded += value.length;
                this._emit();
              }
            }
            const joined = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
            let at = 0;
            for (const chunk of chunks) { joined.set(chunk, at); at += chunk.length; }
            buffers.push(joined);
          } else {
            const buf = new Uint8Array(await response.arrayBuffer());
            if (counted) {
              this.progress.loaded += buf.length;
              this._emit();
            }
            buffers.push(buf);
          }
        }

        const blob = new Blob(buffers, { type: 'application/zip' });
        if (blob.size !== entry.size) {
          console.warn(`[skate-shim] ${name}: assembled ${blob.size}, `
            + `manifest says ${entry.size}`);
        }
        this.blobs.set(name, blob);
        this.stats.assembled++;
        if (counted) this.progress.packsDone++;

        if (counted && this.progress.packsDone >= this.progress.packsTotal) {
          this.progress.loaded = this.progress.total;
        }
        this._emit();
        return blob;
      })();

      this.assembling.set(name, promise);
      try {
        return await promise;
      } finally {
        this.assembling.delete(name);
        if (this.progress.packsDone >= this.progress.packsTotal) this._finish();
      }
    },

    _rangeOf(init) {
      if (!init || !init.headers) return null;
      let raw = null;
      try {
        raw = new Headers(init.headers).get('Range');
      } catch {
        raw = null;
      }
      if (!raw && typeof init.headers === 'object') {
        for (const key of Object.keys(init.headers)) {
          if (key.toLowerCase() === 'range') raw = init.headers[key];
        }
      }
      if (!raw) return null;
      const match = /^bytes=(\d*)-(\d*)$/.exec(String(raw).trim());
      if (!match || (!match[1] && !match[2])) return null;
      return { start: match[1], end: match[2] };
    },

    async _respond(name, init) {
      const blob = await this._blobFor(name);
      const method = ((init && init.method) || 'GET').toUpperCase();
      const size = blob.size;

      const ctype = (this.manifest[name] && this.manifest[name].type) || 'application/zip';

      if (method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: {
            'Content-Type': ctype,
            'Content-Length': String(size),
            'Accept-Ranges': 'bytes',
          },
        });
      }

      const range = this._rangeOf(init);
      if (!range) {
        return new Response(blob, {
          status: 200,
          headers: {
            'Content-Type': ctype,
            'Content-Length': String(size),
            'Accept-Ranges': 'bytes',
          },
        });
      }

      let start = range.start ? Number(range.start) : 0;
      let end = range.end ? Number(range.end) : size - 1;
      if (!range.start) {
        start = Math.max(0, size - Number(range.end));
        end = size - 1;
      }
      end = Math.min(end, size - 1);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${size}` },
        });
      }

      const slice = blob.slice(start, end + 1);
      this.stats.ranges++;
      this.stats.bytesServed += slice.size;
      return new Response(slice, {
        status: 206,
        headers: {
          'Content-Type': ctype,
          'Content-Length': String(slice.size),
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes',
        },
      });
    },

    _patch() {
      const originalFetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : (input && input.url) || String(input);

        const name = this._zipName(url);
        if (name) {
          return this._respond(name, init).catch((error) => {
            this._fail(error);
            console.error(`[skate-shim] ${name} failed:`, error);
            throw error;
          });
        }

        if (this.fileOrigin) {
          let target = url;
          try {
            const abs = new URL(url, location.href);
            const isFile = abs.protocol === 'file:';
            if (abs.origin === location.origin || isFile) {
              let path;
              if (isFile) {

                const dir = new URL('.', location.href).pathname;
                path = abs.pathname.startsWith(dir)
                  ? abs.pathname.slice(dir.length)
                  : abs.pathname;
                path = path.replace(/^\/+/, '').replace(/^[A-Za-z]:\//, '');
              } else {
                path = abs.pathname.replace(/^\/+/, '');
              }

              path = path.replace(/^null\//, '');
              if (path === 'boot-package' && abs.search === '?raw=1') {
                target = `${this.fileOrigin}/boot-package-raw.gz`;
              } else {
                target = `${this.fileOrigin}/${path}${abs.search}`;
              }
            }
          } catch {  }
          return originalFetch(target, init);
        }

        return originalFetch(input, init);
      };
    },
  };

  window.__skateShim = shim;
})();
