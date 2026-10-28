// Arcade art: draws the fighters with the arcade's own sprites (4x upscaled, ki-arcade/out/art/kinst) over the
// SNES picture, in fights. The PPU leaves the two fighters' sprites out of the frame (ppu.split, OBJ tiles P1
// $000-$05F, P2 $060-$0BF) and hands back their SNES pixels (fallback while an arcade frame is still loading)
// and the picture pixels that are in front of the fighters (HUD, foreground) - those are drawn again on top.
//
// Mapping (measured, test/arcade_fit2.py: silhouette IoU 0.84 against the SNES sprites):
//   SNES (act_anim $0855, act_frame $0625) -> arcade anim id, frame index frame-1 (SNES frame 0 = nothing)
//   arcade pixel -> SNES pixel: x * 0.65, y * 0.75 (the SNES art is the arcade art at ~0.76 of its size on a
//   4:3 screen); the arcade frame origin (meta x, y) sits on the fighter's screen position ($0943, $0993)
//   (+0.75 / +1.5 SNES pixels), mirrored when the fighter faces left ($0B73 bit 14).
// Costume: SNES colour ($0250 / $0254) 0..5 -> fighters_4x (0) / fighters_cN_4x; 6, 7 -> 5.
// Art source: the local server (serve.ps1 maps /arcade/ to ki-arcade/out/art) or a folder chosen by the user.
(function () {
  'use strict';
  const NAMES = ['', '01_jago', '02_tjcombo', '03_spinal', '04_thunder', '05_glacius', '06_fulgore', '07_cinder',
    '08_sabrewulf', '09_orchid', '10_riptor', '11_eyedol'];
  const SX = 0.65, SY = 0.75, DX = 0.75, DY = 1.5, SCALE = 4;   // SCALE: the art is 4x the arcade pixels
  const FIGHT = 0x8086EE;                                         // fight main loop handler
  const CACHE_MAX = 900;

  class ArcadeArt {
    constructor() {
      this.enabled = false;
      this.base = null;            // URL prefix for the server source, e.g. 'arcade/kinst/'
      this.files = null;           // Map relative path -> File for a chosen folder
      this.meta = new Map();       // char -> Promise / object { anims: Map(id -> frames) }
      this.img = new Map();        // key -> { bmp, state }
      this.state = null;           // fighters captured for the frame being rendered
      this.canvas = null; this.ctx = null;
      this.tmp = null;             // scratch canvas at SNES resolution
      this.status = '';
    }

    // ---- sources ----
    useServer(prefix) { this.base = prefix; this.files = null; this.reset(); }
    useFiles(fileList) {
      // a folder chosen with <input webkitdirectory>: index by the path below the folder that holds fighters_4x
      const m = new Map();
      for (const f of fileList) {
        const p = (f.webkitRelativePath || f.name).replace(/\\/g, '/');
        const i = p.indexOf('fighters');
        if (i >= 0) m.set(p.slice(i), f);
      }
      this.files = m; this.base = null; this.reset();
      return m.size;
    }
    reset() { for (const v of this.img.values()) if (v.bmp && v.bmp.close) v.bmp.close(); this.img.clear(); this.meta.clear(); }
    ready() { return !!(this.base || (this.files && this.files.size)); }
    async fetchBlob(rel) {
      if (this.files) { const f = this.files.get(rel); if (!f) throw new Error('missing ' + rel); return f; }
      const r = await fetch(this.base + rel);
      if (!r.ok) throw new Error(r.status + ' ' + rel);
      return r.blob();
    }
    // is the server source there? (checks one meta file)
    async probeServer(prefix) {
      try { const r = await fetch(prefix + 'fighters_4x/01_jago/meta.json', { method: 'HEAD' }); return r.ok; } catch (e) { return false; }
    }

    // ---- data ----
    getMeta(t) {
      let m = this.meta.get(t);
      if (m) return m.obj || null;
      m = { obj: null };
      this.meta.set(t, m);
      this.fetchBlob('fighters_4x/' + NAMES[t] + '/meta.json').then((b) => b.text()).then((txt) => {
        const d = JSON.parse(txt), main = new Map(), x = new Map();
        for (const a of d.anims) (a.section === 'main' ? main : x).set(a.id, a.frames);
        m.obj = { main, x };
      }).catch((e) => { m.obj = { main: new Map(), x: new Map(), error: String(e) }; this.status = 'arcade art: ' + e; });
      return null;
    }
    frameInfo(t, anim, frame) {
      const m = this.getMeta(t);
      if (!m || frame <= 0) return null;
      const fl = m.main.get(anim) || m.x.get(anim);
      if (!fl) return null;
      const g = fl[frame - 1];
      return g && g.file && g.w ? g : null;
    }
    image(t, costume, g) {
      const add = g.blend === 'add';
      const dir = (costume > 0 && !add) ? 'fighters_c' + costume + '_4x' : 'fighters_4x';
      const key = dir + '/' + NAMES[t] + '/' + g.file;
      let e = this.img.get(key);
      if (e) { this.img.delete(key); this.img.set(key, e); return e.bmp; }   // LRU touch
      e = { bmp: null };
      this.img.set(key, e);
      this.fetchBlob(key).then((b) => createImageBitmap(b)).then((bmp) => { e.bmp = bmp; })
        .catch(() => {
          // a costume folder can miss frames (still being upscaled): fall back to costume 0
          if (dir !== 'fighters_4x') this.fetchBlob('fighters_4x/' + NAMES[t] + '/' + g.file).then((b) => createImageBitmap(b)).then((bmp) => { e.bmp = bmp; }).catch(() => { e.bmp = false; });
          else e.bmp = false;
        });
      while (this.img.size > CACHE_MAX) {
        const k = this.img.keys().next().value, v = this.img.get(k);
        if (v.bmp && v.bmp.close) v.bmp.close();
        this.img.delete(k);
      }
      return null;
    }
    prefetchAnim(t, costume, anim) {
      const m = this.getMeta(t); if (!m) return;
      const fl = m.main.get(anim) || m.x.get(anim); if (!fl) return;
      for (const g of fl) if (g && g.file && g.w) this.image(t, costume, g);
    }

    // ---- per frame ----
    // called before the SNES frame runs: decide which fighters the PPU leaves out, remember their state
    beginFrame(s) {
      const ppu = s.ppu, w = s.wram;
      const h = (w[2] << 16) | (w[1] << 8) | w[0];
      if (!this.enabled || !this.ready() || h !== FIGHT) { ppu.split = null; this.state = null; return; }
      const w16 = (a) => w[a] | (w[a + 1] << 8), s16 = (a) => (w16(a) << 16) >> 16;
      const f = [];
      for (const X of [0, 4]) {
        const type = w[0x0493 + X], f2 = w16(0x0B73 + X);
        let costume = w[X ? 0x0254 : 0x0250]; if (costume > 5) costume = 5;
        f.push({ X, type, anim: w16(0x0855 + X), frame: w16(0x0625 + X), sx: s16(0x0943 + X), sy: s16(0x0993 + X),
          flip: (f2 >> 14) & 1, visible: f2 & 1, costume, ok: type >= 1 && type <= 11 });
      }
      // the same character and colour on both sides: the game gives P2 the next colour
      if (f[0].type === f[1].type && f[0].costume === f[1].costume) f[1].costume = (f[1].costume + 1) % 6;
      this.last = this.last || {};
      for (const x of f) if (x.ok) {
        this.getMeta(x.type);
        const k = x.type + ':' + x.costume + ':' + x.anim;
        if (this.last[x.X] !== k) { this.last[x.X] = k; this.prefetchAnim(x.type, x.costume, x.anim); }
      }
      ppu.split = [f[0].ok, f[1].ok];
      // fighters' sprite priority (OAM attribute bits 4-5 of their first sprite): what counts as "in front"
      const oam = ppu.oam;
      let pri = 2, first = 0;
      for (let k = 0; k < 128; k++) {
        const chr = oam[k * 4 + 2] | ((oam[k * 4 + 3] & 1) << 8);
        if (chr < 0xC0 && oam[k * 4 + 1] < 224) { pri = (oam[k * 4 + 3] >> 4) & 3; first = chr < 0x60 ? 1 : 2; break; }
      }
      ppu.frontPri = pri;
      this.state = { f, first, E: ppu.E, W: ppu.W };
    }

    attach(canvas) {
      this.canvas = canvas; this.ctx = canvas.getContext('2d');
      this.tmp = document.createElement('canvas');
    }
    place(rect, dpr) {
      if (!this.canvas) return;
      const c = this.canvas;
      c.style.left = rect.left + 'px'; c.style.top = rect.top + 'px'; c.style.width = rect.width + 'px'; c.style.height = rect.height + 'px';
      const w = Math.round(rect.width * dpr), h = Math.round(rect.height * dpr);
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    }
    clear() { if (this.ctx) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); this.drawn = false; }

    // after the frame is shown: arcade fighters (or the SNES ones as fallback), then what is in front of them
    draw(ppu) {
      const st = this.state;
      if (!this.ctx) return;
      if (!st || !ppu.split || !ppu.fighterBuf) { if (this.drawn) this.clear(); return; }
      const c = this.ctx, W = st.W, kx = this.canvas.width / W, ky = this.canvas.height / 224;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.drawn = true;
      // back fighter first: the one whose sprites come first in OAM is in front
      const order = st.first === 1 ? [1, 0] : [0, 1];
      let fallback = 0;
      for (const i of order) {
        const f = st.f[i];
        if (!f.ok) continue;
        const g = this.frameInfo(f.type, f.anim, f.frame);
        const bmp = g ? this.image(f.type, f.costume, g) : null;
        if (!g || f.frame === 0) continue;                       // nothing to draw this frame
        if (!bmp) { fallback |= 1 << i; continue; }              // still loading: SNES pixels instead
        const iw = bmp.width / SCALE, ih = bmp.height / SCALE;   // arcade pixels
        const sx = f.sx + st.E, top = f.sy + SY * (g.y - ih) + DY;
        c.save();
        c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high';
        if (g.blend === 'add') c.globalCompositeOperation = 'lighter';
        if (!f.flip) {
          const left = sx - SX * g.x + DX;
          c.setTransform(kx * SX / SCALE, 0, 0, ky * SY / SCALE, left * kx, top * ky);
        } else {
          const right = sx + SX * g.x - DX;
          c.setTransform(-kx * SX / SCALE, 0, 0, ky * SY / SCALE, right * kx, top * ky);
        }
        c.drawImage(bmp, 0, 0);
        c.restore();
      }
      c.setTransform(1, 0, 0, 1, 0, 0);
      // SNES-resolution layers: fallback fighters, then the pixels in front of the fighters
      const n = W * 224, tmp = this.tmp;
      if (tmp.width !== W || tmp.height !== 224) { tmp.width = W; tmp.height = 224; this.tctx = tmp.getContext('2d'); this.timg = this.tctx.createImageData(W, 224); }
      const out = new Uint32Array(this.timg.data.buffer);
      c.imageSmoothingEnabled = false;
      if (fallback) {
        const fb = ppu.fighterBuf, id = ppu.fighterId;
        for (let p = 0; p < n; p++) out[p] = (fallback >> (id[p] - 1)) & 1 && id[p] ? fb[p] : 0;
        this.tctx.putImageData(this.timg, 0, 0); c.drawImage(tmp, 0, 0, this.canvas.width, this.canvas.height);
      }
      out.set(ppu.frontBuf.subarray(0, n));
      this.tctx.putImageData(this.timg, 0, 0); c.drawImage(tmp, 0, 0, this.canvas.width, this.canvas.height);
    }
  }
  globalThis.KIArcadeArt = ArcadeArt;
})();
