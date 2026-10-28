// App shell: ROM loading, start screen (unlocks audio), frame pacing, video, audio, menu.
(function () {
  'use strict';
  const V11_CRC = 0x09E9A04E;
  const $ = (id) => document.getElementById(id);
  const ls = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } };

  // ---------- CRC32 ----------
  const CRC_T = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; CRC_T[n] = c >>> 0; }
  function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

  // ---------- ROM persistence (IndexedDB; optional) ----------
  let idbDead = false;
  function idb() {
    return new Promise((res, rej) => {
      if (idbDead) { rej(new Error('IndexedDB unavailable')); return; }
      const t = setTimeout(() => { idbDead = true; rej(new Error('IndexedDB timeout')); }, 1500);
      try {
        const r = indexedDB.open('ki-port', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('rom');
        r.onsuccess = () => { clearTimeout(t); res(r.result); };
        r.onerror = () => { clearTimeout(t); idbDead = true; rej(r.error); };
      } catch (e) { clearTimeout(t); idbDead = true; rej(e); }
    });
  }
  // small things (battery RAM) also go to localStorage, which works from file:// too
  const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s); };
  const unb64 = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  async function saveRom(bytes) {
    try { const db = await idb(); db.transaction('rom', 'readwrite').objectStore('rom').put(bytes, 'v11'); } catch (e) { /* not available */ }
  }
  async function loadSavedRom() {
    try {
      const db = await idb();
      return await new Promise((res) => {
        const q = db.transaction('rom').objectStore('rom').get('v11');
        q.onsuccess = () => res(q.result || null); q.onerror = () => res(null);
      });
    } catch (e) { return null; }
  }
  async function forgetRom() {
    try { const db = await idb(); db.transaction('rom', 'readwrite').objectStore('rom').delete('v11'); } catch (e) { /* ignore */ }
  }

  async function idbPut(key, val) {
    if (key.startsWith('sram')) lsSet('ki.' + key, b64(val));
    try { const db = await idb(); await new Promise((res) => { const t = db.transaction('rom', 'readwrite'); t.objectStore('rom').put(val, key); t.oncomplete = res; t.onerror = res; }); } catch (e) { /* not available */ }
  }
  async function idbGet(key) {
    if (key.startsWith('sram')) { const v = ls('ki.' + key, null); if (v) return unb64(v); }
    try {
      const db = await idb();
      return await new Promise((res) => { const q = db.transaction('rom').objectStore('rom').get(key); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); });
    } catch (e) { return null; }
  }

  // ---------- Arcade MegaPatch: IPS on v1.1 + MSU-1 files ----------
  function applyIPS(rom, ips) {
    const p = new Uint8Array(ips);
    if (String.fromCharCode(p[0], p[1], p[2], p[3], p[4]) !== 'PATCH') throw new Error('not an IPS patch');
    const out = new Uint8Array(rom);
    let i = 5;
    while (!(p[i] === 0x45 && p[i + 1] === 0x4F && p[i + 2] === 0x46)) {
      const off = (p[i] << 16) | (p[i + 1] << 8) | p[i + 2], n = (p[i + 3] << 8) | p[i + 4]; i += 5;
      if (n === 0) { const rl = (p[i] << 8) | p[i + 1]; out.fill(p[i + 2], off, off + rl); i += 3; }
      else { out.set(p.subarray(i, i + n), off); i += n; }
    }
    return out;
  }
  const mega = { ok: false, files: new Map(), data: null, rom: null, note: '' };
  // files: Map name(lowercase) -> File or FileSystemFileHandle
  async function fileOf(h) { return h.getFile ? await h.getFile() : h; }
  async function megaFromFiles(files) {
    mega.files = files; mega.ok = false; mega.rom = null; mega.data = null;
    const names = [...files.keys()];
    const msuName = names.find(n => n.endsWith('.msu'));
    if (!msuName) { mega.note = 'No .msu file in that folder.'; return false; }
    const base = msuName.slice(0, -4);
    const pcm = names.filter(n => n.startsWith(base + '-') && n.endsWith('.pcm')).length;
    let rom = null;
    const ipsName = names.find(n => n.endsWith('.ips'));
    if (ipsName && app.rom) {
      rom = applyIPS(app.rom, await (await fileOf(files.get(ipsName))).arrayBuffer());
      mega.note = 'patch ' + ipsName + ' applied to your v1.1';
    } else {
      const sfc = names.find(n => /\.(sfc|smc)$/.test(n));
      if (sfc) {
        const r = checkRom(await (await fileOf(files.get(sfc))).arrayBuffer());
        if (r.rom && String.fromCharCode.apply(null, r.rom.slice(0xFFC0, 0xFFD4)).indexOf('MSU1') >= 0) { rom = r.rom; mega.note = 'patched ROM ' + sfc; }
      }
    }
    if (!rom) { mega.note = 'No patch.ips (or patched .sfc) in that folder.'; return false; }
    mega.rom = rom; mega.base = base;
    mega.note += ', ' + pcm + ' audio tracks, data ' + msuName;
    mega.ok = true;
    return true;
  }
  async function megaLoadData() {
    if (mega.data) return mega.data;
    const name = [...mega.files.keys()].find(n => n.endsWith('.msu'));
    mega.data = new Uint8Array(await (await fileOf(mega.files.get(name))).arrayBuffer());
    return mega.data;
  }
  function megaTrack(n) {
    const h = mega.files.get(mega.base + '-' + n + '.pcm');
    if (!h) return null;
    return fileOf(h).then(f => f.arrayBuffer());
  }
  async function megaFromHandle(dir) {
    const files = new Map();
    for await (const [name, h] of dir.entries()) if (h.kind === 'file') files.set(name.toLowerCase(), h);
    return megaFromFiles(files);
  }

  function checkRom(buf) {
    let b = new Uint8Array(buf);
    if (b.length % 1024 === 512) b = b.slice(512);                  // copier header
    if (b.length !== 0x400000) return { error: 'This file is ' + b.length + ' bytes; the Killer Instinct cartridge is 4 MB (4,194,304 bytes).' };
    const title = String.fromCharCode.apply(null, b.slice(0xFFC0, 0xFFD5)).trim();
    if (!/^KILLER INSTINCT/.test(title)) return { error: 'This does not look like Killer Instinct (internal title "' + title + '").' };
    const crc = crc32(b);
    const warn = crc === V11_CRC ? '' : 'CRC ' + crc.toString(16).toUpperCase().padStart(8, '0') +
      ' is not the USA v1.1 cartridge (09E9A04E). It may not run correctly.';
    return { rom: b, warn, crc };
  }

  // ---------- audio ----------
  const WORKLET = `
  class KIOut extends AudioWorkletProcessor {
    constructor() {
      super();
      this.q = []; this.cur = null; this.pos = 0; this.n = 0; this.calls = 0;
      this.port.onmessage = (e) => { if (e.data === 'flush') { this.q = []; this.cur = null; this.n = 0; return; } this.q.push(e.data); this.n += e.data.length >> 1; };
    }
    process(inputs, outputs) {
      const L = outputs[0][0], R = outputs[0][1] || outputs[0][0];
      for (let i = 0; i < L.length; i++) {
        if (!this.cur || this.pos >= this.cur.length) { this.cur = this.q.shift() || null; this.pos = 0; }
        if (this.cur) { L[i] = this.cur[this.pos]; R[i] = this.cur[this.pos + 1]; this.pos += 2; this.n--; }
        else { L[i] = 0; R[i] = 0; }
      }
      if ((++this.calls & 3) === 0) this.port.postMessage(this.n);
      return true;
    }
  }
  registerProcessor('ki-out', KIOut);`;

  class Audio {
    constructor() { this.ctx = null; this.node = null; this.queued = 0; this.reportAt = 0; this.gain = null; this.rate = 32000; this.mode = 'none'; this.spBuf = []; }
    async start() {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try { this.ctx = new AC({ sampleRate: 32000, latencyHint: 'interactive' }); }
      catch (e) { this.ctx = new AC({ latencyHint: 'interactive' }); }
      this.rate = this.ctx.sampleRate;
      this.gain = this.ctx.createGain(); this.gain.connect(this.ctx.destination);
      this.setVolume(+ls('ki.vol', 80));
      try {
        if (!this.ctx.audioWorklet) throw new Error('no worklet');
        // data: URL works from file:// too (a blob: URL has origin "null" there and is refused)
        try { await this.ctx.audioWorklet.addModule('data:application/javascript,' + encodeURIComponent(WORKLET)); }
        catch (e1) { await this.ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }))); }
        this.node = new AudioWorkletNode(this.ctx, 'ki-out', { numberOfInputs: 0, outputChannelCount: [2] });
        this.node.port.onmessage = (e) => { this.queued = e.data; this.reportAt = performance.now(); };
        this.node.connect(this.gain);
        this.mode = 'worklet';
      } catch (e) {
        // fallback: ScriptProcessor on the main thread
        const sp = this.ctx.createScriptProcessor(1024, 0, 2);
        sp.onaudioprocess = (ev) => {
          const L = ev.outputBuffer.getChannelData(0), R = ev.outputBuffer.getChannelData(1);
          for (let i = 0; i < L.length; i++) {
            const c = this.spBuf[0];
            if (!c) { L[i] = R[i] = 0; continue; }
            L[i] = c[c.pos]; R[i] = c[c.pos + 1]; c.pos += 2; this.queued--;
            if (c.pos >= c.length) this.spBuf.shift();
          }
        };
        sp.connect(this.gain);
        this.mode = 'script';
      }
      if (this.ctx.state !== 'running') await this.ctx.resume();
    }
    setVolume(v) { if (this.gain) this.gain.gain.value = (v / 100) * 1.0; }
    // estimated samples still queued at the device
    level() {
      if (this.mode === 'worklet') return this.queued - (performance.now() - this.reportAt) * this.rate / 1000;
      return this.queued;
    }
    // drop everything queued (pause, or after a snapshot restore jumps elsewhere in the game)
    flush() {
      if (this.mode === 'worklet' && this.node) { this.node.port.postMessage('flush'); this.queued = 0; }
      else if (this.mode === 'script') { this.spBuf = []; this.queued = 0; }
    }
    push(chunk) {
      if (this.mode === 'worklet') { this.node.port.postMessage(chunk, [chunk.buffer]); this.queued += chunk.length >> 1; }
      else if (this.mode === 'script') { chunk.pos = 0; this.spBuf.push(chunk); this.queued += chunk.length >> 1; }
    }
  }

  // linear resampler 32 kHz -> device rate (only when the browser refused 32 kHz)
  function resample(src, n, ratio, state) {
    const outN = Math.floor((n - state.frac) / ratio) + 1;
    const out = new Float32Array(Math.max(0, outN) * 2);
    let k = 0, t = state.frac;
    while (t < n - 1 && k < out.length) {
      const i = t | 0, f = t - i;
      out[k++] = src[i * 2] * (1 - f) + src[i * 2 + 2] * f;
      out[k++] = src[i * 2 + 1] * (1 - f) + src[i * 2 + 3] * f;
      t += ratio;
    }
    state.frac = t - (n - 1);
    return out.subarray(0, k);
  }

  // ---------- app ----------
  const app = {
    snes: null, input: null, audio: new Audio(), running: false, paused: false,
    canvas: null, ctx2d: null, img: null, tmp: new Float32Array(4096 * 2), rs: { frac: 0 },
    frameTimes: [], lastT: 0, accum: 0, fpsShow: false,
    wide: +ls('ki.wide', '0') || 0,
    eyedolSel: ls('ki.eyedolsel', '1') === '1',
    emuMs: 0, drawMs: 0, csFrames: 0, csBg: null, thumbs: null,
    opaqueFighters: false,   // (no longer needed: the PPU colour-math fix makes fighters solid, as on hardware)
    tapeBlur: ls('ki.blur', '0') === '1',
    megaOn: ls('ki.mega', '0') === '1',
  };

  function setStatus(msg, cls) { const s = $('romStatus'); s.textContent = msg; s.className = cls || ''; }

  async function useRom(buf, remember) {
    const r = checkRom(buf);
    if (r.error) { setStatus(r.error, 'err'); return; }
    if (remember) saveRom(r.rom);
    app.rom = r.rom;
    if (app.autoMega && !mega.ok) {            // a MegaPatch folder was found next to index.html before the ROM
      if (await megaFromFiles(app.autoMega.files)) { mega.note += ' (found in ' + app.autoMega.where + ')'; if (app.megaUI) app.megaUI(); }
    }
    setStatus(r.warn || 'Killer Instinct (USA) v1.1 - ready.', r.warn ? 'warn' : 'ok');
    $('loadPanel').hidden = true;
    $('startPanel').hidden = false;
    $('startPanel').focus();
    armStart();
  }

  function armStart() {
    const go = async (e) => {
      if (app.running) return;
      if (e && e.type === 'keydown' && e.code === 'Escape') return;
      cleanup();
      await begin();
    };
    const padPoll = () => {
      if (app.running) return;
      if (app.input && app.input.pads().some(p => p.buttons.some(b => b.pressed))) { go(); return; }
      requestAnimationFrame(padPoll);
    };
    const cleanup = () => {
      window.removeEventListener('keydown', go); window.removeEventListener('pointerdown', go);
    };
    window.addEventListener('keydown', go); window.addEventListener('pointerdown', go);
    requestAnimationFrame(padPoll);
  }

  async function begin() {
    app.running = true;
    // audio first, still inside the key press / click (browsers only allow it there)
    app.ratio = 1;
    app.audio.start().then(() => { app.ratio = 32000 / (app.audio.rate || 32000); app.rs.frac = 0; })
      .catch((e) => { console.warn('audio', e); app.audio.mode = 'none'; });
    $('splash').hidden = true;
    $('game').hidden = false;
    if (!mega.ok && app.megaOn) {
      // the MegaPatch folder chosen in an earlier session (File System Access API)
      const restore = (async () => {
        const dir = await idbGet('mega-dir');
        if (dir && dir.queryPermission) {
          let perm = await dir.queryPermission({ mode: 'read' });
          if (perm !== 'granted') perm = await dir.requestPermission({ mode: 'read' });
          if (perm === 'granted') await megaFromHandle(dir);
        }
      })().catch(() => {});
      await Promise.race([restore, new Promise(r => setTimeout(r, 4000))]);
      if (app.megaUI) app.megaUI();
    }
    setTimeout(startThumbs, app.debugSS ? 0 : 3000);
    try { await makeMachine(); } catch (e) { console.warn('MegaPatch', e); app.megaOn = false; await makeMachine(); }
    app.lastT = performance.now();
    requestAnimationFrame(loop);
  }

  async function makeMachine() {
    // selectable Eyedol (Justin3009's patch) plus his port-added No Mercy and Humiliation
    const withEyedol = (rom) => {
      if (!app.eyedolSel) return rom;
      const r = KIRomFix.selectableEyedol(rom) || rom;
      return KIRomFix.eyedolFinishers(r) || r;
    };
    if (app.megaOn && mega.ok) {
      const st = $('loadMsg'); st.hidden = false; st.textContent = 'Loading the MegaPatch data (ki.msu)...';
      let data;
      try { data = await megaLoadData(); } finally { st.hidden = true; }
      const msu = new KIMSU1({ data, track: megaTrack });
      const sram = await idbGet('sram-mega');
      app.snes = new KISNES(withEyedol(mega.rom), { lle: true, msu, sram: sram ? new Uint8Array(sram) : null });
    } else {
      app.snes = new KISNES(withEyedol(app.rom));
    }
    app.prev = null; app.optBoot = false;
  }
  // battery RAM: stored every few seconds when the game changed it
  setInterval(() => {
    const s = app.snes;
    if (s && s.sram && s.sramDirty) { s.sramDirty = false; idbPut(app.megaOn && mega.ok ? 'sram-mega' : 'sram', s.sram.slice()); }
  }, 3000);

  function grabBackdrop(s) {
    const p = s.ppu, keep = p.frame.slice();
    p.hideObj = true;
    for (let y = 1; y <= 224; y++) p.renderLine(y);
    p.hideObj = false;
    app.csBg = p.frame.slice();
    p.frame.set(keep);
  }
  function pushAudio() {
    const s = app.snes;
    const n = s.apu.pull(app.tmp, app.tmp.length >> 1);
    if (n && app.audio.mode !== 'none' && app.audio.ctx && app.audio.ctx.state === 'running') {
      const chunk = Math.abs(app.ratio - 1) < 1e-6 ? app.tmp.slice(0, n * 2) : resample(app.tmp, n, app.ratio, app.rs).slice();
      app.audio.push(chunk);
    }
  }
  // ---- stage thumbnails: made once in the background, kept in IndexedDB ----
  async function startThumbs() {
    if (!app.rom) return;
    const key = 'stages2-' + crc32(app.rom).toString(16);
    const cached = await idbGet(key);
    if (cached && cached.length === 17) { useThumbs(cached); return; }
    app.thumbs = new KIThumbs(app.rom, (out) => {
      app.thumbs = null;
      if (out.length === 17) { idbPut(key, out); useThumbs(out); }
    });
  }
  function useThumbs(imgs) {
    const c = document.createElement('canvas'); c.width = KIThumbs.W; c.height = KIThumbs.H;
    const g = c.getContext('2d'), urls = [];
    for (const im of imgs) { const d = g.createImageData(KIThumbs.W, KIThumbs.H); d.data.set(im); g.putImageData(d, 0, 0); urls.push(c.toDataURL()); }
    app.ss.setThumbs(urls);
  }
  function stepThumbs() {
    if (app.thumbs) app.thumbs.step(app.turbo ? 10 : app.ss && app.ss.open ? 6 : 2);
    if (app.debugPause && app.snes && app.snes.frameCount > 100 && !app.pzShown) {
      app.pzShown = true; app.pause.who = 0; app.pause.openMenu(app.snes); if (app.debugPause === 'moves') app.pause.act('moves');
    }
    if (app.debugSS && app.thumbs && app.snes && app.snes.frameCount > 100) { while (app.thumbs && app.thumbs.step(500)); }
    if (app.debugSS && !app.thumbs && app.snes && app.snes.frameCount > 100 && !app.ss.open && !app.ssShown) {
      app.ss.stage = 3;
      app.ssShown = true; app.ss.open = true; app.ss.col = 0; app.ss.nav = 0xFFFF; app.ss.root.hidden = false; app.ss.show();
    }
  }

  // the game's Options (difficulty, combo breakers, random select, timer, both button layouts) live in
  // RAM and reset at power-on: keep them in localStorage and put them back after the boot defaults
  const OPT = [0x0224, 0x0225, 0x0226, 0x0227, 0x0228, 0x0229, 0x022C, 0x022D, 0x022E, 0x022F, 0x0230, 0x0231,
    0x0247, 0x0248, 0x024A, 0x024C, 0x024D];
  function gameOptions(s) {
    const h = (s.wram[2] << 16) | (s.wram[1] << 8) | s.wram[0];
    if (h !== 0x8187B3) return;                              // the main menu
    const key = 'ki.options' + (s.sram ? '.mega' : '');
    if (!app.optBoot) {                                      // first main menu since power-on: restore
      app.optBoot = true;
      const v = ls(key, null);
      if (v) { const b = unb64(v); if (b.length === OPT.length) OPT.forEach((a, i) => { s.wram[a] = b[i]; }); }
      return;
    }
    if ((s.frameCount & 31) === 0) {
      const b = Uint8Array.from(OPT.map(a => s.wram[a])), v = b64(b);
      if (v !== app.optSaved) { app.optSaved = v; lsSet(key, v); }
    }
  }

  function runOneFrame() {
    const s = app.snes;
    const p = app.input.read();
    const gps = app.input.pads();
    if (!app.macros) app.macros = new KIMacros();
    for (let i = 0; i < 2; i++) { const m = app.macros.frame(s, i, gps[i]); if (m >= 0) p[i] = m; }
    const q = app.pause.beforeFrame(s, p);
    if (app.holdOff) { if ((p[0] | p[1]) & 0xFFF0) { q[0] = 0; q[1] = 0; } else app.holdOff = false; }
    s.pads[0] = q[0]; s.pads[1] = q[1];
    gameOptions(s);
    const t0 = performance.now();
    s.ppu.setWide(app.wide);
    // widescreen: keep the camera inside the stage art and let fighters and sprites use the side columns
    if (s.romWide !== app.wide) { KIRomFix.widescreen(s.rom, app.wide); s.romWide = app.wide; }
    s.ppu.hudLines = ((s.wram[2] << 16) | (s.wram[1] << 8) | s.wram[0]) === 0x8086EE ? 24 : 0;
    // widescreen: slow layers whose art runs out (js/parallax.js); the scroll tables shown this frame were built
    // from last frame's camera, so drifting layers use that
    { const st = s.wram[0x12F0], pd = globalThis.KIParallax && KIParallax[st], cs = ((s.wram[0x12F8] | (s.wram[0x12F9] << 8)) << 16) >> 16;
      s.ppu.parallax = app.wide && s.ppu.hudLines && pd && pd.bands.length
        ? { bands: pd.bands, cs: app.lastCs == null ? cs : app.lastCs, cs0: pd.cs0, C: pd.C, frame: s.frameCount } : null;
      app.lastCs = cs; }
    if (app.arcade) app.arcade.beginFrame(s);      // arcade fighter art: which sprites the PPU leaves out
    s.ppu.opaqueObj = app.opaqueFighters && ((s.wram[2] << 16) | (s.wram[1] << 8) | s.wram[0]) === 0x8086EE;   // fights only
    s.runFrame();
    app.emuMs = app.emuMs * 0.95 + (performance.now() - t0) * 0.05;
    if (app.ss) {
      // remember the character select backdrop (backgrounds only) for the stage select screen
      const h = (s.wram[2] << 16) | (s.wram[1] << 8) | s.wram[0];
      if (h === 0x818D4A) { if (++app.csFrames === 45) grabBackdrop(s); } else app.csFrames = 0;
      app.ss.watch(s);
    }
    afterFrame();
    // audio
    pushAudio();
  }

  // "Tape blur": every shown picture is the average of the last two SNES frames, like phosphor
  // persistence on an old TV / a worn VHS tape. Flickering sprites (Cinder's invisibility, drawn
  // every other frame) become see-through ghosts. Off by default; a menu toggle.
  function afterFrame() {
    const s = app.snes, f = s.ppu.frame;
    if (!app.tapeBlur) { app.present = f; return; }
    if (!app.prev || app.prev.length !== f.length) { app.prev = new Uint32Array(f.length); app.prev.set(f); app.out = new Uint32Array(f.length); }
    const o = app.out, p = app.prev;
    for (let i = 0; i < f.length; i++) {
      const a = f[i], b = p[i];
      o[i] = a === b ? a : (0xFF000000 | (((a & 0xFEFEFE) >>> 1) + ((b & 0xFEFEFE) >>> 1)));
    }
    app.present = o;
    p.set(f);
  }

  function draw() {
    const t = performance.now();
    app.video.draw(app.present || app.snes.ppu.frame);
    if (app.arcade) app.arcade.draw(app.snes.ppu);
    app.drawMs = app.drawMs * 0.95 + (performance.now() - t) * 0.05;
  }

  function loop(t) {
    requestAnimationFrame(loop);
    app.input.pollCapture();
    if (app.paused || !app.snes) { app.lastT = t; return; }
    if (app.pause && app.pause.open) {         // Start menu holds the game, sound included (music off while paused)
      const p = app.input.read(); app.pause.input(p[0] | p[1]);
      app.lastT = t; app.accum = 0;
      // the canvas keeps the last picture; it only has to be drawn again after a resize clears it
      if (app.pause.open && app.pause.frame && app.pause.redraw) { app.pause.redraw = false; app.video.draw(app.pause.frame); }
      return;
    }
    if (app.ss && app.ss.open) {               // stage/music select holds the game; the music plays on
      const p = app.input.read(); app.ss.inputPlayers(p[0], p[1]); app.ss.input((p[0] | p[1]) & ~0x2000);
      const FT = 1000 / 60.0988;
      app.accum += Math.min(100, Math.max(0, t - app.lastT));
      let n = 0;
      while (app.accum >= FT * 0.98 && n < 3) { app.snes.idleFrame(); pushAudio(); app.accum -= FT; n++; }
      app.lastT = t;
      if (app.csBg) app.video.draw(app.csBg);
      if (app.arcade) app.arcade.clear();
      stepThumbs();
      return;
    }
    let frames = 0;
    if (app.turbo) { for (let i = 0; i < app.turbo; i++) { runOneFrame(); frames++; } }
    else {
      // Run on the wall clock: one SNES frame (16.64 ms) per elapsed frame time. On a 60 Hz
      // screen that is exactly one frame per refresh (the 0.98 tolerance absorbs vsync jitter),
      // so motion is even. The sound queue only steers it at the extremes.
      const FT = 1000 / 60.0988;
      app.accum += Math.min(100, Math.max(0, t - app.lastT));
      if (app.audio.mode !== 'none' && app.audio.ctx && app.audio.ctx.state === 'running') {
        const lvl = app.audio.level(), r = app.audio.rate;
        if (lvl < r * 0.03) app.accum += FT;           // queue nearly dry (<30 ms): one extra frame
        else if (lvl > r * 0.09) app.accum -= FT;      // queue too deep (>90 ms lag): skip one
      }
      while (app.accum >= FT * 0.98 && frames < 3 && !(app.ss && app.ss.open) && !(app.pause && app.pause.open)) { runOneFrame(); frames++; app.accum -= FT; }
      if (app.accum > FT * 3) app.accum = 0;            // tab was in the background
      if (app.accum < -FT * 2) app.accum = -FT * 2;
    }
    app.lastT = t;
    if (frames) draw();
    stepThumbs();
    if (app.fpsShow) {
      app.frameTimes.push(t); while (app.frameTimes.length && app.frameTimes[0] < t - 1000) app.frameTimes.shift();
      $('fps').textContent = app.frameTimes.length + ' Hz display | emulation ' + app.emuMs.toFixed(1) + ' ms/frame | draw ' + app.drawMs.toFixed(1) + ' ms | ' + app.video.renderer + (app.debug ? ' frames ' + app.snes.frameCount + ' audio ' + app.audio.mode + ' ' + (app.audio.ctx ? app.audio.ctx.state : '-') : '');
    }
  }

  // ---------- menu ----------
  function buildRemap() {
    const tbl = $('remap');
    tbl.innerHTML = '<tr><th>SNES</th><th>Keyboard</th><th>Controller</th></tr>';
    for (const name of KIInput.ORDER) {
      const tr = document.createElement('tr');
      const k = app.input.keys[0][name].map(c => c.replace(/^Key/, '').replace(/^Digit/, '')).join(' / ');
      const g = app.input.pad[name].map(i => 'button ' + i).join(' / ');
      tr.innerHTML = '<td>' + name + '</td><td><button data-k="' + name + '">' + (k || '-') + '</button></td><td><button data-g="' + name + '">' + (g || '-') + '</button></td>';
      tbl.appendChild(tr);
    }
    tbl.querySelectorAll('button[data-k]').forEach(b => b.onclick = () => {
      b.textContent = 'press a key...';
      app.input.capture = (r) => { if (r.key && r.key !== 'Escape') app.input.setKey(0, b.dataset.k, r.key); buildRemap(); };
    });
    tbl.querySelectorAll('button[data-g]').forEach(b => b.onclick = () => {
      b.textContent = 'press a button...';
      const pads = app.input.pads();
      app.input.capturePrev = pads[0] ? pads[0].buttons.map(x => x.pressed) : null;
      const f = (r) => { if (r.button !== undefined) app.input.setPad(b.dataset.g, r.button); else if (r.key && r.key !== 'Escape') { /* key pressed: ignore */ } buildRemap(); };
      f.pad = true;
      app.input.capture = f;
    });
  }
  function openMenu() {
    if (!app.snes) return;
    app.paused = true;
    $('menu').hidden = false;
    buildRemap();
    const pads = app.input.pads();
    $('padInfo').textContent = pads.length ? pads.map((p, i) => 'P' + (i + 1) + ': ' + p.id).join('\n') : 'No controller seen yet - press a button on it.';
    if (app.audio.ctx) app.audio.ctx.suspend();
  }
  function closeMenu() {
    $('menu').hidden = true;
    app.input.capture = null;
    app.paused = false;
    if (app.audio.ctx) app.audio.ctx.resume();
  }

  // the pause menu / command list cover the game picture only (4:3 or widescreen), not the whole window
  function placePause() {
    const r = $('screen').getBoundingClientRect(), el = $('pause');
    el.style.left = r.left + 'px'; el.style.top = r.top + 'px'; el.style.width = r.width + 'px'; el.style.height = r.height + 'px';
  }
  function applyScale() {
    const mode = ls('ki.aspect', '43');
    const W = window.innerWidth, H = window.innerHeight - 4;
    const sw = 256 + 2 * (app.wide || 0);
    const aw = mode === '43' ? sw * 8 / 7 : sw;
    let s = Math.min(W / aw, H / 224);
    if (ls('ki.int', '0') === '1' && s >= 1) s = Math.floor(s);
    app.video.resize(Math.floor(aw * s), Math.floor(224 * s));
    if (app.pause && app.pause.open) { app.pause.redraw = true; placePause(); }
    if (app.arcade) app.arcade.place($('screen').getBoundingClientRect(), window.devicePixelRatio || 1);
  }

  function setupTouch() {
    const t = $('touch');
    if (!('ontouchstart' in window) && !(navigator.maxTouchPoints > 0)) return;
    t.hidden = ls('ki.touch', '1') === '0';
    const B = KIInput.BTN;
    const active = new Map();
    const update = () => { let w = 0; for (const v of active.values()) w |= v; app.input.touch = w; };
    const hit = (x, y) => {
      const el = document.elementFromPoint(x, y);
      if (!el || !el.dataset || !el.dataset.b) return 0;
      return el.dataset.b.split(' ').reduce((w, n) => w | B[n], 0);
    };
    const on = (e) => {
      e.preventDefault();
      for (const tc of e.changedTouches) active.set(tc.identifier, hit(tc.clientX, tc.clientY));
      update();
    };
    const off = (e) => { for (const tc of e.changedTouches) active.delete(tc.identifier); update(); };
    t.addEventListener('touchstart', on, { passive: false });
    t.addEventListener('touchmove', on, { passive: false });
    t.addEventListener('touchend', off); t.addEventListener('touchcancel', off);
  }

  window.addEventListener('DOMContentLoaded', async () => {
    app.canvas = $('screen');
    app.video = new KIVideo(app.canvas, { allowSoftware: ls('ki.softgl', '0') === '1' });
    app.ss = new KIStageSelect($('stageSel'));
    app.pause = new KIPause($('pause'));
    app.pause.onJump = () => { app.prev = null; app.ss.prevH = 0; app.holdOff = true; app.optBoot = false; app.audio.flush(); };
    app.pause.onClose = () => { app.holdOff = true; $('screen').classList.remove('pz-blur', 'pz-cl'); $('arcadeArt').classList.remove('pz-blur', 'pz-cl'); };
    app.pause.onOpen = () => {
      app.pause.frame = (app.present || app.snes.ppu.frame).slice();   // exactly what is on screen now
      app.audio.flush();
      placePause(); $('screen').classList.add('pz-blur'); $('arcadeArt').classList.add('pz-blur');
    };
    app.pause.onView = (v) => { $('screen').classList.toggle('pz-cl', v === 'moves'); $('arcadeArt').classList.toggle('pz-cl', v === 'moves'); };
    app.ss.onClose = () => { app.holdOff = true; };
    app.ss.enabled = ls('ki.stagesel', '1') === '1';
    app.video.mode = Math.max(0, KIVideo.MODES.indexOf(ls('ki.filter', 'off')));
    // arcade fighter art (js/arcadeart.js): drawn on #arcadeArt over the picture
    app.arcade = new KIArcadeArt(); app.arcade.attach($('arcadeArt'));
    app.arcade.enabled = ls('ki.arcade', '0') === '1';
    app.input = new KIInput();
    applyScale();
    window.addEventListener('resize', applyScale);
    setupTouch();

    $('romFile').addEventListener('change', async (e) => {
      const f = e.target.files[0]; if (!f) return;
      useRom(await f.arrayBuffer(), $('remember').checked);
    });
    const drop = $('splash');
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
    drop.addEventListener('drop', async (e) => {
      e.preventDefault(); drop.classList.remove('drag');
      const f = e.dataTransfer.files[0]; if (f) useRom(await f.arrayBuffer(), $('remember').checked);
    });
    const q = new URLSearchParams(location.search);
    if (q.get('debug')) {
      app.fpsShow = true; $('fps').hidden = false;
      window.onerror = (m, src, l, c, e) => { $('fps').textContent = 'ERROR ' + m + ' @' + l + ':' + c; };
      window.addEventListener('unhandledrejection', (e) => { $('fps').hidden = false; $('fps').textContent = 'ERROR ' + (e.reason && e.reason.stack || e.reason); });
      app.debug = true;
      app.turbo = +(q.get('turbo') || 0);
      app.debugSS = !!q.get('stagesel');
      app.debugPause = q.get('pause');
      if (q.get('wide')) app.wide = +q.get('wide');
      if (q.get('filter')) app.video.mode = Math.max(0, KIVideo.MODES.indexOf(q.get('filter')));
    }

    window.addEventListener('keydown', (e) => {
      if (!app.snes) return;
      if (e.code === 'Escape' || e.code === 'F1') { e.preventDefault(); if ($('menu').hidden) openMenu(); else if (!app.input.capture) closeMenu(); }
      else if (e.code === 'F11') { e.preventDefault(); toggleFull(); }
      else if (e.code === 'F2') { app.fpsShow = !app.fpsShow; $('fps').hidden = !app.fpsShow; }
    });
    // Select + Start on a controller opens the menu? No: KI uses Start alone; the menu uses the Guide/Home button (16)
    setInterval(() => {
      if (!app.snes) return;
      for (const gp of app.input.pads()) if (gp.buttons[16] && gp.buttons[16].pressed) { if ($('menu').hidden) openMenu(); }
    }, 100);
    function toggleFull() {
      if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {});
    }
    // browsers only let sound start from a key/click/tap (a gamepad press does not count)
    const unlock = () => {
      const c = app.audio.ctx;
      if (c && c.state !== 'running' && !app.paused) c.resume().then(() => { $('soundHint').hidden = true; }).catch(() => {});
    };
    window.addEventListener('keydown', unlock); window.addEventListener('pointerdown', unlock); window.addEventListener('touchstart', unlock);
    setInterval(() => {
      const c = app.audio.ctx;
      $('soundHint').hidden = !app.snes || app.paused || !c || c.state === 'running';
    }, 500);
    $('btnMenu').onclick = openMenu;
    $('btnResume').onclick = closeMenu;
    $('btnFull').onclick = toggleFull;
    $('btnReset').onclick = async () => { await makeMachine(); closeMenu(); };
    // MegaPatch setup / toggle
    const megaUI = () => {
      $('megaToggle').disabled = !mega.ok;
      $('megaToggle').checked = app.megaOn && mega.ok;
      $('megaInfo').textContent = mega.ok ? 'Ready: ' + mega.note + '.' : (mega.note || 'Not set up. Choose the folder with ki.msu, the ki-N.pcm tracks and patch.ips (on a phone: Choose files and select all of them).');
    };
    app.megaUI = megaUI;
    $('megaPick').onclick = async () => {
      try {
        if (window.showDirectoryPicker) {
          const dir = await window.showDirectoryPicker({ id: 'ki-msu' });
          await megaFromHandle(dir);
          if (mega.ok) idbPut('mega-dir', dir);
        } else $('megaDir').click();
      } catch (e) { mega.note = 'Folder not opened (' + e.message + ').'; }
      megaUI();
    };
    $('megaPickFiles').onclick = () => $('megaFiles').click();
    $('megaFiles').onchange = async (e) => {
      const files = new Map();
      for (const f of e.target.files) files.set(f.name.toLowerCase(), f);
      await megaFromFiles(files); megaUI();
    };
    $('megaDir').onchange = async (e) => {
      const files = new Map();
      for (const f of e.target.files) files.set(f.name.toLowerCase(), f);
      await megaFromFiles(files); megaUI();
    };
    $('megaToggle').onchange = async () => {
      app.megaOn = $('megaToggle').checked; lsSet('ki.mega', app.megaOn ? '1' : '0');
      $('megaInfo').textContent = 'Starting...';
      if (app.snes) await makeMachine();
      megaUI();
      if (app.snes) closeMenu();
    };
    megaUI();
    $('btnDefaults').onclick = () => { app.input.resetDefaults(); buildRemap(); };
    const vol = $('vol'); vol.value = ls('ki.vol', 80);
    vol.oninput = () => { app.audio.setVolume(+vol.value); lsSet('ki.vol', vol.value); };
    const asp = $('aspect'); asp.value = ls('ki.aspect', '43');
    asp.onchange = () => { lsSet('ki.aspect', asp.value); applyScale(); };
    const flt = $('filter'); flt.value = KIVideo.MODES[app.video.mode];
    flt.onchange = () => { app.video.mode = KIVideo.MODES.indexOf(flt.value); lsSet('ki.filter', flt.value); applyScale(); if (app.snes) draw(); };
    const eyt = $('eyedolToggle'); eyt.checked = app.eyedolSel;
    eyt.onchange = async () => { app.eyedolSel = eyt.checked; lsSet('ki.eyedolsel', eyt.checked ? '1' : '0'); if (app.snes) { await makeMachine(); closeMenu(); } };
    const sst = $('stageSelToggle'); sst.checked = app.ss.enabled;
    sst.onchange = () => { app.ss.enabled = sst.checked; lsSet('ki.stagesel', sst.checked ? '1' : '0'); };
    const wd = $('wide'); wd.value = String(app.wide);
    wd.onchange = () => { app.wide = +wd.value; lsSet('ki.wide', wd.value); if (app.snes) app.snes.ppu.setWide(app.wide); app.prev = null; applyScale(); };
    const sg = $('softGlToggle'); sg.checked = ls('ki.softgl', '0') === '1';
    const glInfo = () => { $('glInfo').textContent = 'Drawing with ' + app.video.renderer + (app.video.gl ? '' : ' (no screen filters: this browser has no hardware WebGL here)') + '.'; };
    sg.onchange = () => {
      lsSet('ki.softgl', sg.checked ? '1' : '0');
      const old = app.canvas, nc = document.createElement('canvas');
      nc.id = 'screen'; nc.width = 256; nc.height = 224; old.replaceWith(nc);
      app.canvas = nc;
      const mode = app.video.mode;
      app.video = new KIVideo(nc, { allowSoftware: sg.checked }); app.video.mode = mode;
      applyScale(); if (app.snes) draw(); glInfo();
    };
    glInfo();
    // arcade art: from the local server (serve.ps1: /arcade/ = ki-arcade/out/art) or a folder you choose
    const at = $('arcadeToggle'), ai = $('arcadeInfo');
    const arcadeInfo = (t) => { ai.textContent = t; };
    at.checked = app.arcade.enabled;
    at.onchange = () => {
      app.arcade.enabled = at.checked; lsSet('ki.arcade', at.checked ? '1' : '0');
      if (at.checked && !app.arcade.ready()) arcadeInfo('Choose the folder with the arcade art (ki-arcade/out/art/kinst) first.');
      if (!at.checked) app.arcade.clear();
    };
    $('arcadePick').onclick = () => $('arcadeDir').click();
    $('arcadeDir').onchange = (e) => {
      const n = app.arcade.useFiles(e.target.files);
      arcadeInfo(n ? n + ' files found - arcade fighters will be used in fights' : 'No fighters_4x folder in that folder.');
    };
    if (location.protocol.startsWith('http')) {
      app.arcade.probeServer('arcade/kinst/').then((ok) => {
        if (ok) { app.arcade.useServer('arcade/kinst/'); arcadeInfo('Arcade art found (ki-arcade/out/art/kinst via the local server).'); }
        else arcadeInfo('Arcade art not found next to the port: choose its folder (ki-arcade/out/art/kinst).');
      });
    } else arcadeInfo('Opened as a file: choose the arcade art folder (ki-arcade/out/art/kinst).');
    const fb = $('flickerToggle'); fb.checked = app.tapeBlur;
    fb.onchange = () => { app.tapeBlur = fb.checked; app.prev = null; lsSet('ki.blur', fb.checked ? '1' : '0'); };
    const tch = $('touchToggle'); tch.checked = ls('ki.touch', '1') !== '0';
    tch.onchange = () => { lsSet('ki.touch', tch.checked ? '1' : '0'); $('touch').hidden = !tch.checked || !(navigator.maxTouchPoints > 0); };
    // ROM sources run last, after all the menu and keyboard wiring above
    const romSources = async () => {
      if (q.get('autorom')) {
        const r = await fetch(q.get('autorom'));
        await useRom(await r.arrayBuffer(), false);
        if (q.get('megaurl')) {            // debug: MegaPatch folder served over http
          const u = q.get('megaurl'), files = new Map();
          const h = (n) => ({ getFile: async () => { const r = await fetch(u + n); if (!r.ok) throw new Error(n); return r.blob(); } });
          files.set('ki.msu', h('ki.msu')); files.set('ki.sfc', h('ki.sfc'));
          for (let n = 0; n < 64; n++) files.set('ki-' + n + '.pcm', h('ki-' + n + '.pcm'));
          try { await megaFromFiles(files); } catch (e) { mega.note = 'ERR ' + e.message; }
          app.megaOn = true; $('romStatus').textContent = 'mega ' + mega.ok + ': ' + mega.note;
        }
        if (q.get('autostart')) { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyZ' })); }
        return;
      }
      // served by "Play Killer Instinct.bat" (serve.ps1): find the ROM and the MegaPatch folder next to index.html
      let autoRom = false;
      if (/^https?:$/.test(location.protocol)) {
        try {
          const list = async (d) => { const r = await fetch('__list?dir=' + encodeURIComponent(d)); return r.ok ? r.json() : { files: [], dirs: [] }; };
          const root = await list('');
          const places = [['', root]];
          for (const d of root.dirs) places.push([d + '/', await list(d)]);
          const roms = [], msu = [];
          for (const [d, l] of places) {
            for (const f of l.files) { if (/\.(sfc|smc)$/i.test(f)) roms.push(d + f); if (/\.msu$/i.test(f)) msu.push(d); }
          }
          for (const r of roms) {
            const buf = await (await fetch(r)).arrayBuffer();
            const c = checkRom(buf);
            if (c.rom && c.crc === V11_CRC) { await useRom(buf, false); autoRom = true; break; }
          }
          if (msu.length) {
            const d = msu[0], l = places.find(x => x[0] === d)[1], files = new Map();
            for (const f of l.files) files.set(f.toLowerCase(), { getFile: async () => (await fetch(d + f)).blob() });
            app.autoMega = { files, where: d || 'this folder' };
            if (app.rom && await megaFromFiles(files)) { mega.note += ' (found in ' + app.autoMega.where + ')'; if (app.megaUI) app.megaUI(); }
          }
        } catch (e) { console.warn('auto-detect', e); }
      }
      if (autoRom) return;
      const saved = await loadSavedRom();
      if (saved) {
        $('savedRow').hidden = false;
        $('useSaved').onclick = () => useRom(saved.buffer ? saved.buffer : saved, false);
        $('forget').onclick = async () => { await forgetRom(); $('savedRow').hidden = true; };
      }
    };
    romSources();
  });
})();
