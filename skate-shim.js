// Reassembly shim for the skate3 web port.
//
// Makes the engine read its data zips from split parts fetched from a CDN
// (jsDelivr/GitHub) instead of needing a range-serving server.
//
//   1. Reads packs-manifest.json: each logical zip -> ordered list of .partNNN
//      files, plus the true assembled size.
//   2. Patches window.fetch. When the engine asks for a known zip, the shim
//      downloads that zip's parts once, concatenates them into a Blob, and
//      answers every later request (HEAD, GET, ranged GET) from that Blob.
//
// Ranges are sliced here rather than handing back a blob: URL: browsers do not
// reliably apply a Range header to blob: URLs, and pack.js refuses any response
// that is not a 206 with a Content-Range.
//
// It also draws a loading screen, because assembling ~2.3 GB of parts takes a
// while and the page would otherwise sit on a black screen with no feedback.
(() => {
  const shim = {
    manifest: null,
    cdnBase: '',
    packPrefix: '/packs/',
    blobs: new Map(),        // zip name -> assembled Blob
    assembling: new Map(),   // zip name -> Promise<Blob>
    onProgress: null,
    onDone: null,
    progress: { loaded: 0, total: 0, packsDone: 0, packsTotal: 0, percent: 0 },
    stats: { assembled: 0, ranges: 0, bytesServed: 0 },

    async install({ manifestUrl, cdnBase = '', packPrefix = '/packs/',
                    showLoader = true, background = 'loadbg.jpg',
                    onProgress = null, onDone = null }) {
      this.cdnBase = String(cdnBase).replace(/\/+$/, '');
      this.packPrefix = packPrefix;
      this.onProgress = onProgress;
      this.onDone = onDone;

      if (showLoader) this._makeLoader(background);

      try {
        const response = await fetch(manifestUrl, { cache: 'no-store' });
        if (!response.ok) throw new Error(`manifest ${manifestUrl}: HTTP ${response.status}`);
        this.manifest = await response.json();

        const names = Object.keys(this.manifest);
        // The denominator is every byte the manifest describes. All packs are
        // needed at startup: pack.js opens each one (a HEAD) to read its central
        // directory, and a HEAD forces the whole zip to be assembled here.
        this.progress.total = names.reduce((sum, n) => sum + this.manifest[n].size, 0);
        this.progress.packsTotal = names.length;
        this._emit();

        this._patch();
        console.log(`[skate-shim] ready: ${names.length} packs, `
          + `${(this.progress.total / 1e9).toFixed(2)} GB to assemble`);
        return this;
      } catch (error) {
        this._fail(error);
        throw error;
      }
    },

    // --- loading screen -----------------------------------------------------
    _makeLoader(background = 'loadbg.jpg') {
      // No DOM (e.g. a Node test): the loader is cosmetic, so skip it.
      if (typeof document === 'undefined') return;
      if (document.getElementById('shim-loader')) return;
      const css = document.createElement('style');
      // Type matches the game's own UI: index.html defines --fe-font as the
      // skate. 3 stack (Futura with Century Gothic / Trebuchet fallbacks) and
      // sets its labels in 800 weight, uppercase, widely letter-spaced. Using
      // the same stack and treatment keeps this screen looking like part of the
      // game rather than a generic web overlay.
      const feFont = `var(--fe-font, Futura, 'Futura Std', 'Futura PT', `
        + `'Century Gothic', 'Avenir Next', 'Trebuchet MS', sans-serif)`;
      // The art is small (576x324) and gets blurred, so it is scaled past the
      // edges: that hides the soft border a blur otherwise leaves behind, and
      // the upscale stops mattering once it is frosted.
      const bgUrl = String(background).replace(/"/g, '%22');
      css.textContent = `
        #shim-loader{position:fixed;inset:0;z-index:99999;background:#000;
          overflow:hidden;display:flex;align-items:center;justify-content:center;
          font-family:${feFont};color:#fff;}
        #shim-loader.hidden{display:none;}
        #shim-bg{position:absolute;inset:-8%;background-image:url("${bgUrl}");
          background-size:cover;background-position:center;background-repeat:no-repeat;
          filter:blur(22px) saturate(1.15) brightness(.85);transform:scale(1.08);}
        #shim-scrim{position:absolute;inset:0;
          background:radial-gradient(120% 100% at 50% 45%,rgba(0,0,0,.35),rgba(0,0,0,.72));}
        #shim-content{position:relative;z-index:1;display:flex;flex-direction:column;
          align-items:center;}
        #shim-percent{font-family:${feFont};font-size:11px;font-weight:600;
          letter-spacing:.16em;line-height:1;font-variant-numeric:tabular-nums;
          color:#fff;text-shadow:.85px .85px 1px rgba(0,0,0,.45);margin-bottom:12px;}
        #shim-track{width:min(420px,70vw);height:12px;background:rgba(0,0,0,.55);
          box-shadow:0 0 0 1px rgba(255,255,255,.12);}
        #shim-fill{width:0%;height:100%;background:#fff;transition:width .12s linear;}
        #shim-note{margin-top:12px;font-family:${feFont};font-size:11px;
          font-weight:600;letter-spacing:.16em;text-transform:uppercase;
          color:var(--fe-dim,#9db6c6);font-variant-numeric:tabular-nums;
          text-shadow:.85px .85px 1px rgba(0,0,0,.45);}
      `;
      document.head.appendChild(css);

      const loader = document.createElement('div');
      loader.id = 'shim-loader';
      loader.innerHTML = `
        <div id="shim-bg"></div>
        <div id="shim-scrim"></div>
        <div id="shim-content">
          <div id="shim-percent">0%</div>
          <div id="shim-track"><div id="shim-fill"></div></div>
          <div id="shim-note">preparing game data</div>
        </div>
      `;
      // Attach as soon as <body> exists so nothing paints before it.
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
      console.log(`[skate-shim] all packs assembled (${this.stats.assembled})`);
      this._hideLoader();
      if (this.onDone) this.onDone(this.progress);
    },

    // --- assembly -----------------------------------------------------------
    // A request is ours when it sits under the pack prefix AND its final path
    // segment names a managed zip. The prefix test is essential: parts live
    // under a different directory, and for an unsplit zip the part file has the
    // SAME basename as the zip, so matching on basename alone makes the shim
    // intercept its own part fetch and recurse until the stack overflows.
    _zipName(url) {
      if (!this.manifest) return null;
      const path = String(url).split(/[?#]/)[0];
      if (this.packPrefix && !path.includes(this.packPrefix)) return null;
      const base = path.split('/').pop();
      return Object.prototype.hasOwnProperty.call(this.manifest, base) ? base : null;
    },

    async _blobFor(name) {
      if (this.blobs.has(name)) return this.blobs.get(name);
      if (this.assembling.has(name)) return this.assembling.get(name);

      const promise = (async () => {
        const entry = this.manifest[name];
        const buffers = [];
        for (const part of entry.parts) {
          const url = `${this.cdnBase}/${part}`;
          let response;
          try {
            response = await fetch(url, { cache: 'force-cache' });
          } catch (error) {
            throw new Error(`${part}: network error (${error.message})`);
          }
          if (!response.ok) throw new Error(`${part}: HTTP ${response.status}`);

          // Stream so the progress bar advances smoothly and accurately.
          if (response.body && response.body.getReader) {
            const reader = response.body.getReader();
            const chunks = [];
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              chunks.push(value);
              this.progress.loaded += value.length;
              this._emit();
            }
            const joined = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
            let at = 0;
            for (const chunk of chunks) { joined.set(chunk, at); at += chunk.length; }
            buffers.push(joined);
          } else {
            const buf = new Uint8Array(await response.arrayBuffer());
            this.progress.loaded += buf.length;
            this._emit();
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
        this.progress.packsDone++;
        // Snap to the exact total once everything is in, so the bar can reach
        // 100% even if a per-part byte count drifted.
        if (this.progress.packsDone >= this.progress.packsTotal) {
          this.progress.loaded = this.progress.total;
        }
        this._emit();
        console.log(`[skate-shim] assembled ${name} `
          + `(${(blob.size / 1e6).toFixed(1)} MB from ${entry.parts.length} parts)`);
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

      // pack.js openPack() does a HEAD first to learn the size.
      if (method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: {
            'Content-Type': 'application/zip',
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
            'Content-Type': 'application/zip',
            'Content-Length': String(size),
            'Accept-Ranges': 'bytes',
          },
        });
      }

      let start = range.start ? Number(range.start) : 0;
      let end = range.end ? Number(range.end) : size - 1;
      if (!range.start) {                       // suffix range: bytes=-N
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
          'Content-Type': 'application/zip',
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
        if (!name) return originalFetch(input, init);
        return this._respond(name, init).catch((error) => {
          this._fail(error);
          console.error(`[skate-shim] ${name} failed:`, error);
          throw error;
        });
      };
      console.log('[skate-shim] fetch patched');
    },
  };

  window.__skateShim = shim;
})();
