// S-PPU: registers + scanline renderer (modes 0-7, sprites, windows, colour math, mosaic).
(function () {
  'use strict';

  const OBJ_SIZES = [[8, 8, 16, 16], [8, 8, 32, 32], [8, 8, 64, 64], [16, 16, 32, 32],
    [16, 16, 64, 64], [32, 32, 64, 64], [16, 32, 32, 64], [16, 32, 32, 32]];
  // bits per pixel of BG1..4 per mode (0 = layer absent, 7 = mode 7)
  const BPP = [[2, 2, 2, 2], [4, 4, 2, 0], [4, 4, 0, 0], [8, 4, 0, 0], [8, 2, 0, 0], [4, 2, 0, 0], [4, 0, 0, 0], [7, 0, 0, 0]];

  // layer ids: 0-3 BG1-4, 4 OBJ, 5 backdrop
  // z-order tables: [layer, priority] from back to front
  function zt(list) { return list.map(s => [s[0], s[1]]); }
  const Z = {
    0: zt([[3, 0], [2, 0], [4, 0], [3, 1], [2, 1], [4, 1], [1, 0], [0, 0], [4, 2], [1, 1], [0, 1], [4, 3]]),
    1: zt([[2, 0], [4, 0], [2, 1], [4, 1], [1, 0], [0, 0], [4, 2], [1, 1], [0, 1], [4, 3]]),
    '1p': zt([[2, 0], [4, 0], [4, 1], [1, 0], [0, 0], [4, 2], [1, 1], [0, 1], [4, 3], [2, 1]]),
    2: zt([[1, 0], [4, 0], [0, 0], [4, 1], [1, 1], [4, 2], [0, 1], [4, 3]]),
    7: zt([[4, 0], [0, 0], [4, 1], [4, 2], [4, 3]]),            // OBJ0 < BG1 < OBJ1 < OBJ2 < OBJ3
    '7e': zt([[1, 0], [4, 0], [0, 0], [1, 1], [4, 1], [4, 2], [4, 3]]), // BG2L < OBJ0 < BG1 < BG2H < OBJ1..3
  };
  function zmap(list) {        // -> zv[layer*4+prio] = z (1..)
    const zv = new Int8Array(24);
    list.forEach((e, i) => { zv[e[0] * 4 + e[1]] = i + 1; });
    return zv;
  }
  const ZV = {};
  for (const k in Z) ZV[k] = zmap(Z[k]);

  class PPU {
    constructor() {
      this.vram = new Uint16Array(0x8000);
      this.cgram = new Uint16Array(256);
      this.oam = new Uint8Array(544);
      this.E = 0; this.W = 256; this.hudLines = 0;             // widescreen: E extra columns each side
      this.extRow = -1; this.wramRef = null;                   // widescreen: terrain row buffer (see snes.js runDMA)
      this.opt = true;                                         // offset-per-tile (modes 2/4/6)
      this.parallax = null;                                    // widescreen: slow layers whose art runs out (main.js)
      this.frame = new Uint32Array(256 * 224);
      this.reset();
      // per-line scratch
      this.lpix = []; this.lpri = [];
      for (let i = 0; i < 5; i++) { this.lpix.push(new Uint16Array(512)); this.lpri.push(new Uint8Array(512)); }
      this.objPal = new Uint8Array(512);
      this.objRefl = new Uint8Array(512);   // 1 = pixel from a vertically flipped sprite (floor reflections)
      this.opaqueObj = false;               // enhancement: sprites under a translucent floor stay solid
      // Arcade art (js/arcadeart.js): fighter sprites (OBJ tiles P1 $000-$05F, P2 $060-$0BF) are left out of the
      // frame for the fighters in split[] and go to side buffers instead: fighterBuf (the fighter's own pixels
      // where it would be visible, fighterId 1/2) and frontBuf (picture pixels that are in front of a sprite of
      // priority frontPri, i.e. whatever must cover the replacement art: HUD, foreground layers)
      this.split = null;                    // [p1, p2] booleans, or null = off
      this.frontPri = 2;
      this.objFighter = new Uint8Array(512);
      this.fighterBuf = null; this.fighterId = null; this.frontBuf = null;
      this.win = [];
      for (let i = 0; i < 6; i++) this.win.push(new Uint8Array(512));
      this.line = 0;
      // RGB lookup for 15-bit colour at each brightness
      this.rgb = [];
      for (let b = 0; b < 16; b++) {
        const t = new Uint32Array(32768);
        for (let c = 0; c < 32768; c++) {
          const r = c & 31, g = (c >> 5) & 31, bl = (c >> 10) & 31;
          const f = (v) => { const x = (v * (b + 1)) >> 4; return (x << 3) | (x >> 2); };
          t[c] = 0xFF000000 | (f(bl) << 16) | (f(g) << 8) | f(r);
        }
        this.rgb.push(t);
      }
    }

    reset() {
      this.forceBlank = true; this.bright = 0;
      this.obsel = 0; this.objSize = 0; this.objBase = 0; this.objNameSel = 0;
      this.oamAddr = 0; this.oamBaseAddr = 0; this.oamPrio = false; this.oamLatch = 0;
      this.bgmode = 0; this.bg3prio = false; this.tileSize = [0, 0, 0, 0];
      this.mosaicSize = 0; this.mosaicEn = 0;
      this.scBase = [0, 0, 0, 0]; this.scSize = [0, 0, 0, 0]; this.chrBase = [0, 0, 0, 0];
      this.hofs = [0, 0, 0, 0]; this.vofs = [0, 0, 0, 0]; this.ofsPrev1 = 0; this.ofsPrev2 = 0;
      this.vmain = 0; this.vaddr = 0; this.vprefetch = 0;
      this.m7sel = 0; this.m7a = 0; this.m7b = 0; this.m7c = 0; this.m7d = 0; this.m7x = 0; this.m7y = 0;
      this.m7hofs = 0; this.m7vofs = 0; this.m7prev = 0;
      this.cgAddr = 0; this.cgLatch = 0; this.cgHigh = false;
      this.wsel = [0, 0, 0, 0, 0, 0];   // per layer 0-3 BG, 4 OBJ, 5 colour: 4 bits (W1 inv, W1 en, W2 inv, W2 en)
      this.wl = [0, 0]; this.wr = [0, 0];
      this.wlog = [0, 0, 0, 0, 0, 0];
      this.tm = 0; this.ts = 0; this.tmw = 0; this.tsw = 0;
      this.cgwsel = 0; this.cgadsub = 0;
      this.fixR = 0; this.fixG = 0; this.fixB = 0;
      this.setini = 0;
      this.mpy = 0;
      this.ophct = 0; this.opvct = 0; this.hLatchHi = false; this.vLatchHi = false;
      this.oamReadLatch = 0;
      this.timeOver = false; this.rangeOver = false;
    }

    // ---------------- registers ----------------
    vramStep() { const s = this.vmain & 3; return s === 0 ? 1 : s === 1 ? 32 : 128; }
    vramRemap(a) {
      switch ((this.vmain >> 2) & 3) {
        case 0: return a;
        case 1: return (a & 0xFF00) | ((a & 0x001F) << 3) | ((a >> 5) & 7);
        case 2: return (a & 0xFE00) | ((a & 0x003F) << 3) | ((a >> 6) & 7);
        default: return (a & 0xFC00) | ((a & 0x007F) << 3) | ((a >> 7) & 7);
      }
    }
    updateMpy() {
      const a = (this.m7a << 16) >> 16, b = ((this.m7b >> 8) << 24) >> 24;
      this.mpy = (a * b) & 0xFFFFFF;
    }

    write(r, v) {
      switch (r) {
        case 0x00: {
          const wasBlank = this.forceBlank;
          this.forceBlank = (v & 0x80) !== 0; this.bright = v & 15;
          if (wasBlank && !this.forceBlank && this.vblank) { /* nothing */ }
          break;
        }
        case 0x01: this.obsel = v; this.objSize = v >> 5; this.objNameSel = (v >> 3) & 3; this.objBase = (v & 7) << 13; break;
        case 0x02: this.oamBaseAddr = (this.oamBaseAddr & 0x200) | (v << 1); this.oamAddr = this.oamBaseAddr; break;
        case 0x03: this.oamBaseAddr = ((v & 1) << 9) | (this.oamBaseAddr & 0x1FE); this.oamPrio = (v & 0x80) !== 0; this.oamAddr = this.oamBaseAddr; break;
        case 0x04: {
          const a = this.oamAddr;
          if (a < 0x200) {
            if ((a & 1) === 0) this.oamLatch = v;
            else { this.oam[a - 1] = this.oamLatch; this.oam[a] = v; }
          } else {
            this.oam[0x200 + (a & 0x1F)] = v;
          }
          this.oamAddr = (a + 1) & 0x3FF;
          break;
        }
        case 0x05:
          this.bgmode = v & 7; this.bg3prio = (v & 8) !== 0;
          for (let i = 0; i < 4; i++) this.tileSize[i] = (v >> (4 + i)) & 1;
          break;
        case 0x06: this.mosaicSize = v >> 4; this.mosaicEn = v & 15; break;
        case 0x07: case 0x08: case 0x09: case 0x0A: {
          const i = r - 7; this.scBase[i] = (v & 0xFC) << 8; this.scSize[i] = v & 3; break;
        }
        case 0x0B: this.chrBase[0] = (v & 0x0F) << 12; this.chrBase[1] = (v & 0xF0) << 8; break;
        case 0x0C: this.chrBase[2] = (v & 0x0F) << 12; this.chrBase[3] = (v & 0xF0) << 8; break;
        case 0x0D: case 0x0F: case 0x11: case 0x13: {
          const i = (r - 0x0D) >> 1;
          this.hofs[i] = ((v << 8) | (this.ofsPrev1 & ~7) | (this.ofsPrev2 & 7)) & 0x3FF;
          this.ofsPrev1 = v; this.ofsPrev2 = v;
          if (i === 0) { this.m7hofs = ((v << 8) | this.m7prev) & 0x1FFF; this.m7prev = v; }
          break;
        }
        case 0x0E: case 0x10: case 0x12: case 0x14: {
          const i = (r - 0x0E) >> 1;
          this.vofs[i] = ((v << 8) | this.ofsPrev1) & 0x3FF;
          this.ofsPrev1 = v;
          if (i === 0) { this.m7vofs = ((v << 8) | this.m7prev) & 0x1FFF; this.m7prev = v; }
          break;
        }
        case 0x15: this.vmain = v; break;
        case 0x16: this.vaddr = (this.vaddr & 0xFF00) | v; this.vprefetch = this.vram[this.vramRemap(this.vaddr) & 0x7FFF]; break;
        case 0x17: this.vaddr = (this.vaddr & 0x00FF) | (v << 8); this.vprefetch = this.vram[this.vramRemap(this.vaddr) & 0x7FFF]; break;
        case 0x18: {
          const a = this.vramRemap(this.vaddr) & 0x7FFF;
          if (this.vramOk()) this.vram[a] = (this.vram[a] & 0xFF00) | v;
          if (!(this.vmain & 0x80)) this.vaddr = (this.vaddr + this.vramStep()) & 0xFFFF;
          break;
        }
        case 0x19: {
          const a = this.vramRemap(this.vaddr) & 0x7FFF;
          if (this.vramOk()) this.vram[a] = (this.vram[a] & 0x00FF) | (v << 8);
          if (this.vmain & 0x80) this.vaddr = (this.vaddr + this.vramStep()) & 0xFFFF;
          break;
        }
        case 0x1A: this.m7sel = v; break;
        case 0x1B: this.m7a = ((v << 8) | this.m7prev) & 0xFFFF; this.m7prev = v; this.updateMpy(); break;
        case 0x1C: this.m7b = ((v << 8) | this.m7prev) & 0xFFFF; this.m7prev = v; this.updateMpy(); break;
        case 0x1D: this.m7c = ((v << 8) | this.m7prev) & 0xFFFF; this.m7prev = v; break;
        case 0x1E: this.m7d = ((v << 8) | this.m7prev) & 0xFFFF; this.m7prev = v; break;
        case 0x1F: this.m7x = ((v << 8) | this.m7prev) & 0x1FFF; this.m7prev = v; break;
        case 0x20: this.m7y = ((v << 8) | this.m7prev) & 0x1FFF; this.m7prev = v; break;
        case 0x21: this.cgAddr = v; this.cgHigh = false; break;
        case 0x22:
          if (!this.cgHigh) { this.cgLatch = v; this.cgHigh = true; }
          else { this.cgram[this.cgAddr] = ((v & 0x7F) << 8) | this.cgLatch; this.cgAddr = (this.cgAddr + 1) & 0xFF; this.cgHigh = false; }
          break;
        case 0x23: this.wsel[0] = v & 15; this.wsel[1] = v >> 4; break;
        case 0x24: this.wsel[2] = v & 15; this.wsel[3] = v >> 4; break;
        case 0x25: this.wsel[4] = v & 15; this.wsel[5] = v >> 4; break;
        case 0x26: this.wl[0] = v; break;
        case 0x27: this.wr[0] = v; break;
        case 0x28: this.wl[1] = v; break;
        case 0x29: this.wr[1] = v; break;
        case 0x2A: for (let i = 0; i < 4; i++) this.wlog[i] = (v >> (i * 2)) & 3; break;
        case 0x2B: this.wlog[4] = v & 3; this.wlog[5] = (v >> 2) & 3; break;
        case 0x2C: this.tm = v & 0x1F; break;
        case 0x2D: this.ts = v & 0x1F; break;
        case 0x2E: this.tmw = v & 0x1F; break;
        case 0x2F: this.tsw = v & 0x1F; break;
        case 0x30: this.cgwsel = v; break;
        case 0x31: this.cgadsub = v; break;
        case 0x32:
          if (v & 0x20) this.fixR = v & 31;
          if (v & 0x40) this.fixG = v & 31;
          if (v & 0x80) this.fixB = v & 31;
          break;
        case 0x33: this.setini = v; break;
      }
    }
    vramOk() { return true; }   // (writes outside vblank are allowed here; the game only writes in blank)

    read(r, mdr) {
      switch (r) {
        case 0x34: return this.mpy & 0xFF;
        case 0x35: return (this.mpy >> 8) & 0xFF;
        case 0x36: return (this.mpy >> 16) & 0xFF;
        case 0x37: this.latchHV(); return mdr;
        case 0x38: {
          const a = this.oamAddr;
          const v = a < 0x200 ? this.oam[a] : this.oam[0x200 + (a & 0x1F)];
          this.oamAddr = (a + 1) & 0x3FF;
          return v;
        }
        case 0x39: {
          const v = this.vprefetch & 0xFF;
          if (!(this.vmain & 0x80)) { this.vprefetch = this.vram[this.vramRemap(this.vaddr) & 0x7FFF]; this.vaddr = (this.vaddr + this.vramStep()) & 0xFFFF; }
          return v;
        }
        case 0x3A: {
          const v = this.vprefetch >> 8;
          if (this.vmain & 0x80) { this.vprefetch = this.vram[this.vramRemap(this.vaddr) & 0x7FFF]; this.vaddr = (this.vaddr + this.vramStep()) & 0xFFFF; }
          return v;
        }
        case 0x3B: {
          let v;
          if (!this.cgHigh) { v = this.cgram[this.cgAddr] & 0xFF; this.cgHigh = true; }
          else { v = (this.cgram[this.cgAddr] >> 8) & 0x7F; this.cgAddr = (this.cgAddr + 1) & 0xFF; this.cgHigh = false; }
          return v;
        }
        case 0x3C: { const v = this.hLatchHi ? (this.ophct >> 8) & 1 : this.ophct & 0xFF; this.hLatchHi = !this.hLatchHi; return v; }
        case 0x3D: { const v = this.vLatchHi ? (this.opvct >> 8) & 1 : this.opvct & 0xFF; this.vLatchHi = !this.vLatchHi; return v; }
        case 0x3E: return (this.timeOver ? 0x80 : 0) | (this.rangeOver ? 0x40 : 0) | 0x01;
        case 0x3F: this.hLatchHi = false; this.vLatchHi = false; return 0x03;
      }
      return mdr;
    }
    latchHV() { if (this.hvSource) { const t = this.hvSource(); this.ophct = t[0]; this.opvct = t[1]; } }

    // called at the start of vblank
    vblankStart() {
      if (!this.forceBlank) this.oamAddr = this.oamBaseAddr;
    }

    // widescreen: a layer band scrolling at rate k < 1 whose art ends where 4:3 stops showing it gets its scroll
    // remapped so that art range spans the wider view (slower parallax); if it is narrower than the view, it is
    // held centred. parallax = {bands: [[layer, y0, y1, k]], cs: cam_scroll, cs0, C} (js/parallax.js).
    parallaxHofs(i, y) {
      const P = this.parallax;
      for (const b of P.bands) {
        const [l, y0, y1, k, h0s] = b;
        if (l !== i || y < y0 || y > y1) continue;
        const E = this.E, A = k * P.C, h = this.hofs[i];
        let h0, d;
        if (h0s) {                                     // fixed base: the camera offset follows from the scroll itself (smooth)
          h0 = h0s[y - y0]; const t = ((h - h0) % 1024 + 1024) % 1024; d = (t > 512 ? t - 1024 : t) / k;
        } else {                                         // drifting layer (clouds): from the camera, smoothed per frame
          d = P.cs - P.cs0; const raw = h - k * d;
          const st = this.pxState || (this.pxState = new Map()), key = b;
          let e = st.get(key);
          if (!e || Math.abs(raw - e.v) > 8) e = { v: raw, f: -1 };
          if (e.f !== P.frame) { e.v += (raw - e.v) * 0.15; e.f = P.frame; }
          st.set(key, e); h0 = e.v;
        }
        const r = A >= 2 * E ? h0 + E + Math.max(0, Math.min(P.C - 2 * E, d - E)) * (A - 2 * E) / (P.C - 2 * E) : h0 + A / 2;
        return Math.round(r) & 0x3FF;
      }
      return -1;
    }

    setWide(E) {
      E = Math.max(0, Math.min(128, E | 0));
      if (E === this.E) return;
      this.E = E; this.W = 256 + 2 * E;
      this.frame = new Uint32Array(this.W * 224);
      this.fighterBuf = null;
    }
    ensureSplitBuffers() {
      const n = this.W * 224;
      if (!this.fighterBuf || this.fighterBuf.length !== n) {
        this.fighterBuf = new Uint32Array(n); this.fighterId = new Uint8Array(n); this.frontBuf = new Uint32Array(n);
      }
    }

    // ---------------- rendering ----------------
    renderLine(y) {          // y = 1..224
      const W = this.W, out = this.frame, row = (y - 1) * W;
      if (this.forceBlank) {
        out.fill(0xFF000000, row, row + W);
        if (this.split && this.fighterBuf) { this.fighterBuf.fill(0, row, row + W); this.fighterId.fill(0, row, row + W); this.frontBuf.fill(0, row, row + W); }
        return;
      }
      const mode = this.bgmode;
      const bpp = BPP[mode];
      const extbg = mode === 7 && (this.setini & 0x40);
      const used = (this.tm | this.ts);
      const act = [];                       // layers drawn this line
      if (mode === 7) {
        if (used & 1) { this.renderMode7(y, 0); act.push(0); }
        if (extbg && (used & 2)) { this.renderMode7(y, 1); act.push(1); }
      } else {
        for (let i = 0; i < 4; i++) if (bpp[i] && (used & (1 << i))) {
          const ph = this.E && this.parallax && i < 2 ? this.parallaxHofs(i, y) : -1;
          if (ph >= 0) { const h = this.hofs[i]; this.hofs[i] = ph; this.renderBG(i, y, bpp[i], mode); this.hofs[i] = h; }
          else this.renderBG(i, y, bpp[i], mode);
          act.push(i);
          // widescreen: the fight HUD (BG3, top rows) has no art beyond 256 - keep its extra columns empty
          if (i === 2 && this.E && y <= this.hudLines) { const px = this.lpix[2]; px.fill(0, 0, this.E); px.fill(0, this.E + 256, this.W); }
        }
      }
      if ((used & 0x10) && !this.hideObj) { this.renderOBJ(y); act.push(4); }
      const clipM = (this.cgwsel >> 6) & 3, prevM = (this.cgwsel >> 4) & 3;
      const wmask = this.tmw | this.tsw;
      for (let l = 0; l < 5; l++) if (wmask & (1 << l)) this.computeWindow(l);
      if (clipM === 1 || clipM === 2 || prevM === 1 || prevM === 2) this.computeWindow(5);
      const zv = mode === 0 ? ZV[0] : mode === 1 ? (this.bg3prio ? ZV['1p'] : ZV[1]) : mode === 7 ? (extbg ? ZV['7e'] : ZV[7]) : ZV[2];
      const cg = this.cgram, pal = this.rgb[this.bright];
      const direct = (this.cgwsel & 1) && (mode === 3 || mode === 4 || mode === 7);
      const subOn = (this.cgwsel & 2) !== 0;
      const fixed = this.fixR | (this.fixG << 5) | (this.fixB << 10);
      const sub = (this.cgadsub & 0x80) !== 0, half = (this.cgadsub & 0x40) !== 0;
      const adsub = this.cgadsub;
      const cw = this.win[5];
      const tm = this.tm, ts = this.ts, tmw = this.tmw, tsw = this.tsw;
      const n = act.length;
      const LP = act.map(l => this.lpix[l]), LR = act.map(l => this.lpri[l]), LW = act.map(l => this.win[l]);
      const LB = act.map(l => 1 << l), LZ = act.map(l => l * 4);
      const objPal = this.objPal;
      const anyMath = (adsub & 0x3F) !== 0;
      const split = this.split, objF = this.objFighter;
      let kObj = -1, zFront = 0, fBuf = null, fId = null, frBuf = null;
      if (split) {
        this.ensureSplitBuffers(); fBuf = this.fighterBuf; fId = this.fighterId; frBuf = this.frontBuf;
        fBuf.fill(0, row, row + W); fId.fill(0, row, row + W); frBuf.fill(0, row, row + W);
        kObj = act.indexOf(4); zFront = zv[16 + this.frontPri];
      }
      for (let x = 0; x < W; x++) {
        let mz = 0, ml = 5, mc = 0;
        let sz = 0, sl = 5, sc = 0;
        let skipObj = false;
        if (kObj >= 0) {
          const f = objF[x];
          if (f && split[f - 1] && LP[kObj][x]) skipObj = true;
        }
        for (let k = 0; k < n; k++) {
          if (skipObj && k === kObj) continue;
          const p = LP[k][x];
          if (!p) continue;
          const z = zv[LZ[k] + LR[k][x]];
          if (!z) continue;
          const bit = LB[k];
          if ((tm & bit) && z > mz && !((tmw & bit) && LW[k][x])) { mz = z; ml = act[k]; mc = p; }
          if ((ts & bit) && z > sz && !((tsw & bit) && LW[k][x])) { sz = z; sl = act[k]; sc = p; }
        }
        if (split) {
          if (skipObj && (tm & 16)) {                        // the hidden fighter pixel: visible over the picture?
            const zf = zv[LZ[kObj] + LR[kObj][x]];
            if (zf > mz) { fBuf[row + x] = pal[cg[(LP[kObj][x] - 1) & 0xFF]]; fId[row + x] = objF[x]; }
          }
          if (ml !== 5 && ml !== 4 && mz > zFront) frBuf[row + x] = 1;   // marked; filled with the final colour below
        }
        let main = ml === 5 ? cg[0] : (mc & 0x8000) ? this.colorOf(mc, ml, direct) : cg[(mc - 1) & 0xFF];
        const inW = cw[x];
        const clip = clipM === 3 || (clipM === 1 && inW) || (clipM === 2 && !inW);
        if (clip) main = 0;
        if (!anyMath) { out[row + x] = pal[main]; if (frBuf && frBuf[row + x]) frBuf[row + x] = pal[main]; continue; }
        if (this.opaqueObj && sl === 4 && ml !== 4 && !this.objRefl[x] && objPal[x] <= 1) {
          // the fighter itself (not its mirrored reflection) shows through the floor solid
          out[row + x] = pal[cg[(sc - 1) & 0xFF]]; if (frBuf && frBuf[row + x]) frBuf[row + x] = out[row + x]; continue;
        }
        const prevent = prevM === 3 || (prevM === 1 && inW) || (prevM === 2 && !inW);
        const mathOn = !prevent && ((ml === 5 ? (adsub & 0x20) : ml === 4 ? ((adsub & 0x10) && objPal[x] >= 4 ? 1 : 0) : (adsub & (1 << ml))) !== 0);
        let c = main;
        if (mathOn) {
          let subc, subBackdrop = false;
          if (subOn) {
            if (sl === 5) { subc = fixed; subBackdrop = true; }
            else subc = (sc & 0x8000) ? this.colorOf(sc, sl, direct) : cg[(sc - 1) & 0xFF];
          } else subc = fixed;
          const h = half && !(subOn && subBackdrop) && !clip ? 1 : 0;
          let r = main & 31, g = (main >> 5) & 31, b = (main >> 10) & 31;
          const r2 = subc & 31, g2 = (subc >> 5) & 31, b2 = (subc >> 10) & 31;
          if (!sub) { r += r2; g += g2; b += b2; } else { r -= r2; g -= g2; b -= b2; }
          if (h) { r >>= 1; g >>= 1; b >>= 1; }
          r = r < 0 ? 0 : r > 31 ? 31 : r; g = g < 0 ? 0 : g > 31 ? 31 : g; b = b < 0 ? 0 : b > 31 ? 31 : b;
          c = r | (g << 5) | (b << 10);
        }
        out[row + x] = pal[c];
        if (frBuf && frBuf[row + x]) frBuf[row + x] = pal[c];
        if (this.dbg) this.dbg[x] = ml | (sl << 4) | (mathOn ? 0x100 : 0);
      }
    }

    colorOf(p, layer, direct) {
      // p: 1 + palette index (0 = transparent), or for direct colour 0x8000|bits
      if (p & 0x8000) {
        const v = p & 0x7FF;   // bbgggrrr + ppp (palette bits for direct colour)
        const c = v & 0xFF, pp = v >> 8;
        const r = ((c & 7) << 2) | ((pp & 1) << 1), g = (((c >> 3) & 7) << 2) | (pp & 2), b = (((c >> 6) & 3) << 3) | ((pp & 4));
        return r | (g << 5) | (b << 10);
      }
      return this.cgram[(p - 1) & 0xFF];
    }

    computeWindow(l) {
      const w = this.win[l], s = this.wsel[l];
      const e1 = (s & 2) !== 0, i1 = (s & 1) !== 0, e2 = (s & 8) !== 0, i2 = (s & 4) !== 0;
      if (!e1 && !e2) { w.fill(0); return; }
      const L1 = this.wl[0], R1 = this.wr[0], L2 = this.wl[1], R2 = this.wr[1], lg = this.wlog[l];
      const W = this.W, E = this.E;
      for (let x = 0; x < W; x++) {
        const sx = x < E ? 0 : x - E > 255 ? 255 : x - E;   // widescreen: side columns copy the edge
        let a = (sx >= L1 && sx <= R1) ? 1 : 0; if (i1) a ^= 1;
        let b = (sx >= L2 && sx <= R2) ? 1 : 0; if (i2) b ^= 1;
        let r;
        if (e1 && !e2) r = a; else if (!e1 && e2) r = b;
        else r = lg === 0 ? (a | b) : lg === 1 ? (a & b) : lg === 2 ? (a ^ b) : (1 ^ (a ^ b));
        w[x] = r;
      }
    }

    // BG3 map entry at BG3 pixel (px, py); used by offset-per-tile. In widescreen the terrain stages' offset row
    // (VRAM $7820, uploaded 32 entries at a time) continues from the game's row buffer (see snes.js runDMA).
    bg3Entry(px, py) {
      const big = this.tileSize[2], t = big ? 16 : 8, scs = this.scSize[2];
      const wm = scs & 1, hm = (scs & 2) ? 1 : 0;
      const tx = Math.floor(px / t), ty = ((py & 0x3FF) / t) | 0;
      const row = this.scBase[2] + ((ty & 31) << 5) + ((((ty >> 5) & hm) ? (wm ? 0x800 : 0x400) : 0));
      if (this.E && this.extRow >= 0 && row === 0x7820 && !wm && (tx < 0 || tx >= 32)) {
        const a = this.extRow + 2 * tx, w = this.wramRef;
        return a >= 0x1637 && a < 0x16F5 ? w[a] | (w[a + 1] << 8) : 0xFFFF;
      }
      const c = tx & (wm ? 63 : 31);
      return this.vram[(row + (c & 31) + (((c >> 5) & wm) ? 0x400 : 0)) & 0x7FFF];
    }

    // offset-per-tile (modes 2, 4, 6): each BG1/BG2 tile column takes its scroll from BG3's map
    // (mode 2/6: row 0 = horizontal, row 1 = vertical entries; mode 4: one row, bit 15 picks which);
    // bit 13 applies the entry to BG1, bit 14 to BG2. The first column on screen is never changed.
    renderBGopt(i, y, bpp, mode) {
      const pix = this.lpix[i], pri = this.lpri[i], vram = this.vram;
      const big = this.tileSize[i], tsz = big ? 16 : 8, tmask = tsz - 1;
      const scBase = this.scBase[i], scs = this.scSize[i], chr = this.chrBase[i];
      const wmask = (scs & 1) ? 1 : 0, hmask = (scs & 2) ? 1 : 0;
      const planeWords = bpp * 4, palMul = 1 << bpp;
      const direct = bpp === 8 && (this.cgwsel & 1) && mode === 4;
      const hofs = this.hofs[i], vofs = this.vofs[i], h3 = this.hofs[2], v3 = this.vofs[2];
      const bit = i === 0 ? 0x2000 : 0x4000, W = this.W, E = this.E;
      let lastCol = 1e9, hs = hofs, vs = vofs;
      for (let x = 0; x < W; x++) {
        const sxs = x - E, col = Math.floor((sxs + (hofs & 7)) / 8);
        if (col !== lastCol) {
          lastCol = col; hs = hofs; vs = vofs;
          if (col >= 1 || (E && col < 1)) {                  // widescreen: the side columns are always offset
            const bx = (col - 1) * 8 + (h3 & ~7);
            const hv = this.bg3Entry(bx, v3);
            if (mode === 4) {
              if (hv & bit) { if (hv & 0x8000) vs = hv & 0x3FF; else hs = (hv & 0x3F8) | (hofs & 7); }
            } else {
              const vv = this.bg3Entry(bx, v3 + 8);
              if (hv & bit) hs = (hv & 0x3F8) | (hofs & 7);
              if (vv & bit) vs = vv & 0x3FF;
            }
          }
        }
        const sx = (hs + sxs) & 0x3FF, sy = (y + vs) & 0x3FF;
        const tx = (sx / tsz) | 0, ty = (sy / tsz) | 0;
        const rowBase = scBase + ((ty & 31) << 5) + ((((ty >> 5) & hmask) ? (wmask ? 0x800 : 0x400) : 0));
        const ent = vram[(rowBase + (tx & 31) + (((tx >> 5) & wmask) ? 0x400 : 0)) & 0x7FFF];
        let tile = ent & 0x3FF, px = sx & tmask, py = sy & tmask;
        if ((ent >> 14) & 1) px = tmask - px;
        if ((ent >> 15) & 1) py = tmask - py;
        if (big) { tile += (px >> 3) + ((py >> 3) << 4); px &= 7; py &= 7; }
        const base = (chr + (tile & 0x3FF) * planeWords) & 0x7FFF, b = 7 - px;
        let w = vram[(base + py) & 0x7FFF];
        let c = ((w >> b) & 1) | (((w >> (8 + b)) & 1) << 1);
        if (bpp >= 4) {
          w = vram[(base + 8 + py) & 0x7FFF]; c |= (((w >> b) & 1) << 2) | (((w >> (8 + b)) & 1) << 3);
          if (bpp === 8) {
            w = vram[(base + 16 + py) & 0x7FFF]; c |= (((w >> b) & 1) << 4) | (((w >> (8 + b)) & 1) << 5);
            w = vram[(base + 24 + py) & 0x7FFF]; c |= (((w >> b) & 1) << 6) | (((w >> (8 + b)) & 1) << 7);
          }
        }
        if (c === 0) { pix[x] = 0; continue; }
        const p = (ent >> 10) & 7;
        pix[x] = bpp === 8 ? (direct ? 0x8000 | c | (p << 8) : c + 1) : p * palMul + c + 1;
        pri[x] = (ent >> 13) & 1;
      }
    }

    renderBG(i, y, bpp, mode) {
      if (i < 2 && this.opt && (mode === 2 || mode === 4 || mode === 6)) { this.renderBGopt(i, y, bpp, mode); return; }
      const pix = this.lpix[i], pri = this.lpri[i], vram = this.vram;
      const big = this.tileSize[i];
      const tsz = big ? 16 : 8, tmask = tsz - 1;
      const mos = (this.mosaicEn >> i) & 1 ? this.mosaicSize + 1 : 1;
      let yy = y;
      if (mos > 1) yy = y - ((y - 1) % mos);
      const sy = (yy + this.vofs[i]) & 0x3FF;
      const scBase = this.scBase[i], scs = this.scSize[i];
      const chr = this.chrBase[i];
      const palBase = bpp === 2 ? (mode === 0 ? i * 32 : 0) : 0;
      const palMul = 1 << bpp;
      const hofs = this.hofs[i];
      const wmask = (scs & 1) ? 1 : 0, hmask = (scs & 2) ? 1 : 0;
      const ty = (sy / tsz) | 0;
      const rowBase = scBase + ((ty & 31) << 5) + ((((ty >> 5) & hmask) ? (wmask ? 0x800 : 0x400) : 0));
      const planeWords = bpp * 4;
      const direct = bpp === 8 && (this.cgwsel & 1) && (mode === 3 || mode === 4);
      // decode one tile row (8 pixels) into tmp[0..7]
      const tmp = this.tmpRow || (this.tmpRow = new Uint8Array(8));
      let x = 0;
      if (mos > 1) {
        // slow path with horizontal mosaic: one pixel at a time
        const W = this.W, E = this.E;
        for (x = 0; x < W; x++) {
          const xs = x - E;
          const sx = ((xs - (((xs % mos) + mos) % mos)) + hofs) & 0x3FF;
          const tx = (sx / tsz) | 0;
          let mapAddr = rowBase + (tx & 31) + (((tx >> 5) & wmask) ? 0x400 : 0);
          const ent = vram[mapAddr & 0x7FFF];
          let tile = ent & 0x3FF;
          let px = sx & tmask, py = sy & tmask;
          if ((ent >> 14) & 1) px = tmask - px;
          if ((ent >> 15) & 1) py = tmask - py;
          if (big) { tile += (px >> 3) + ((py >> 3) << 4); px &= 7; py &= 7; }
          const base = (chr + (tile & 0x3FF) * planeWords) & 0x7FFF, bit = 7 - px;
          let w = vram[(base + py) & 0x7FFF];
          let c = ((w >> bit) & 1) | (((w >> (8 + bit)) & 1) << 1);
          if (bpp >= 4) {
            w = vram[(base + 8 + py) & 0x7FFF]; c |= (((w >> bit) & 1) << 2) | (((w >> (8 + bit)) & 1) << 3);
            if (bpp === 8) {
              w = vram[(base + 16 + py) & 0x7FFF]; c |= (((w >> bit) & 1) << 4) | (((w >> (8 + bit)) & 1) << 5);
              w = vram[(base + 24 + py) & 0x7FFF]; c |= (((w >> bit) & 1) << 6) | (((w >> (8 + bit)) & 1) << 7);
            }
          }
          if (c === 0) { pix[x] = 0; continue; }
          const p = (ent >> 10) & 7;
          pix[x] = bpp === 8 ? (direct ? 0x8000 | c | (p << 8) : c + 1) : palBase + p * palMul + c + 1;
          pri[x] = (ent >> 13) & 1;
        }
        return;
      }
      // fast path: walk 8-pixel tile rows
      const W = this.W;
      let sx = (hofs - this.E) & 0x3FF;
      while (x < W) {
        const tx = (sx / tsz) | 0;
        const ent = vram[(rowBase + (tx & 31) + (((tx >> 5) & wmask) ? 0x400 : 0)) & 0x7FFF];
        const hf = (ent >> 14) & 1;
        let tile = ent & 0x3FF;
        let py = sy & tmask;
        if ((ent >> 15) & 1) py = tmask - py;
        let colInTile = sx & tmask;                 // pixel column inside the (8 or 16 wide) tile
        let half = colInTile >> 3;                  // which 8-pixel half for 16-wide tiles
        if (big) { if (hf) half ^= 1; tile += half + ((py >> 3) << 4); py &= 7; }
        const base = (chr + (tile & 0x3FF) * planeWords) & 0x7FFF;
        const w0 = vram[(base + py) & 0x7FFF];
        const w1 = bpp >= 4 ? vram[(base + 8 + py) & 0x7FFF] : 0;
        const w2 = bpp === 8 ? vram[(base + 16 + py) & 0x7FFF] : 0;
        const w3 = bpp === 8 ? vram[(base + 24 + py) & 0x7FFF] : 0;
        for (let k = 0; k < 8; k++) {
          const bit = hf ? k : 7 - k;
          tmp[k] = ((w0 >> bit) & 1) | (((w0 >> (8 + bit)) & 1) << 1) | (((w1 >> bit) & 1) << 2) | (((w1 >> (8 + bit)) & 1) << 3) |
            (((w2 >> bit) & 1) << 4) | (((w2 >> (8 + bit)) & 1) << 5) | (((w3 >> bit) & 1) << 6) | (((w3 >> (8 + bit)) & 1) << 7);
        }
        const p = (ent >> 10) & 7, pr = (ent >> 13) & 1;
        const add = palBase + p * palMul + 1;
        let k = colInTile & 7;
        for (; k < 8 && x < W; k++, x++, sx = (sx + 1) & 0x3FF) {
          const c = tmp[k];
          if (c === 0) { pix[x] = 0; continue; }
          pix[x] = bpp === 8 ? (direct ? 0x8000 | c | (p << 8) : c + 1) : add + c;
          pri[x] = pr;
        }
      }
    }

    renderMode7(y, layer) {
      const pix = this.lpix[layer], pri = this.lpri[layer], vram = this.vram;
      const s16 = (v) => (v << 16) >> 16, s13 = (v) => (v << 19) >> 19;
      const a = s16(this.m7a), b = s16(this.m7b), c = s16(this.m7c), d = s16(this.m7d);
      const cx = s13(this.m7x), cy = s13(this.m7y), hofs = s13(this.m7hofs), vofs = s13(this.m7vofs);
      const hflip = this.m7sel & 1, vflip = (this.m7sel >> 1) & 1, rep = this.m7sel >> 6;
      const mos = (this.mosaicEn & 1) ? this.mosaicSize + 1 : 1;
      let line = y;
      if (mos > 1) line = y - ((y - 1) % mos);
      const yy = vflip ? 255 - line : line;
      const clip = (v) => (v & 0x2000) ? (v | ~0x3FF) : (v & 0x3FF);
      const hc = clip(hofs - cx), vc = clip(vofs - cy);
      const psx = ((a * hc) & ~63) + ((b * vc) & ~63) + ((b * yy) & ~63) + (cx << 8);
      const psy = ((c * hc) & ~63) + ((d * vc) & ~63) + ((d * yy) & ~63) + (cy << 8);
      const W = this.W, E = this.E;
      for (let x = 0; x < W; x++) {
        const xs = x - E;
        const xx = mos > 1 ? xs - (((xs % mos) + mos) % mos) : xs;
        const sx = hflip ? 255 - xx : xx;
        const px = (psx + a * sx) >> 8, py = (psy + c * sx) >> 8;
        let tile;
        if ((px | py) & ~0x3FF) {
          if (rep === 2) { pix[x] = 0; continue; }
          tile = rep === 3 ? 0 : vram[(((py >> 3) & 127) << 7) + ((px >> 3) & 127)] & 0xFF;
        } else tile = vram[((py >> 3) << 7) + (px >> 3)] & 0xFF;
        const col = vram[(tile << 6) + ((py & 7) << 3) + (px & 7)] >> 8;
        if (layer === 1) {
          const cc = col & 0x7F;
          if (!cc) { pix[x] = 0; continue; }
          pix[x] = cc + 1; pri[x] = col >> 7;
        } else {
          if (!col) { pix[x] = 0; continue; }
          pix[x] = (this.cgwsel & 1) ? 0x8000 | col : col + 1;
          pri[x] = 0;
        }
      }
    }

    renderOBJ(y) {
      const pix = this.lpix[4], pri = this.lpri[4], opal = this.objPal, oam = this.oam, vram = this.vram;
      const sizes = OBJ_SIZES[this.objSize], E = this.E;
      const line = (y) & 0xFF;
      const first = this.oamPrio ? (this.oamBaseAddr >> 2) & 127 : 0;
      const list = [];
      this.rangeOver = false; this.timeOver = false;
      for (let k = 0; k < 128; k++) {
        const n = (first + k) & 127;
        const hi = (oam[0x200 + (n >> 2)] >> ((n & 3) * 2)) & 3;
        const big = hi >> 1;
        const w = sizes[big * 2], h = sizes[big * 2 + 1];
        let x = oam[n * 4] | ((hi & 1) << 8);
        if (x >= 256 && !(E && x < 256 + E)) x -= 512;   // widescreen: 256..255+E are on the right
        const sy = oam[n * 4 + 1];
        const dy = (line - sy) & 0xFF;
        if (dy >= h) continue;
        if (x <= -w - E || x >= 256 + E) { if (x !== -256) continue; }
        if (list.length === 32) { this.rangeOver = true; break; }
        list.push([n, x, dy, w, h]);
      }
      // tiles are fetched from the last sprite in range to the first; max 34
      const tiles = [];
      for (let k = list.length - 1; k >= 0; k--) {
        const [n, x, dy, w, h] = list[k];
        const attr = oam[n * 4 + 3];
        const hf = (attr >> 6) & 1, vf = (attr >> 7) & 1;
        let ry = vf ? h - 1 - dy : dy;
        if (vf && w !== h && h === 2 * w) { /* rectangular sizes flip per whole sprite */ }
        const chr = oam[n * 4 + 2] | ((attr & 1) << 8);
        for (let tx = 0; tx < w / 8; tx++) {
          const sx = x + tx * 8;
          if (sx <= -8 - E || sx >= 256 + E) continue;
          if (tiles.length === 34) { this.timeOver = true; break; }
          const col = hf ? (w / 8 - 1 - tx) : tx;
          tiles.push([k, sx, chr, col, ry, attr]);
        }
      }
      pix.fill(0);
      const objF = this.objFighter; objF.fill(0);
      // draw in reverse fetch order so the first OAM entries win
      const W = this.W, drawnBy = new Int16Array(W).fill(999);
      for (let t = tiles.length - 1; t >= 0; t--) {
        const [k, sx, chr, col, ry, attr] = tiles[t];
        const hf = (attr >> 6) & 1;
        const n = ((chr >> 4) + (ry >> 3)) & 15, m = ((chr & 15) + col) & 15;
        const name = (chr & 0x100) | (n << 4) | m;
        let addr = this.objBase + ((name & 0xFF) << 4);
        if (name & 0x100) addr += (this.objNameSel + 1) << 12;
        addr &= 0x7FFF;
        const r = ry & 7;
        const w0 = vram[(addr + r) & 0x7FFF], w1 = vram[(addr + 8 + r) & 0x7FFF];
        const p = (attr >> 1) & 7, pr = (attr >> 4) & 3;
        for (let i = 0; i < 8; i++) {
          const x = sx + i + E;
          if (x < 0 || x >= W) continue;
          const bit = hf ? i : 7 - i;
          const c = ((w0 >> bit) & 1) | (((w0 >> (8 + bit)) & 1) << 1) | (((w1 >> bit) & 1) << 2) | (((w1 >> (8 + bit)) & 1) << 3);
          if (!c) continue;
          if (k > drawnBy[x]) continue;
          drawnBy[x] = k;
          pix[x] = 128 + p * 16 + c + 1; pri[x] = pr; opal[x] = p; this.objRefl[x] = attr >> 7;
          objF[x] = chr < 0x60 ? 1 : chr < 0xC0 ? 2 : 0;
        }
      }
    }
  }

  globalThis.KIPPU = PPU;
})();
