// Killer Instinct's SPC700 sound driver, reimplemented natively (1:1 with decomp/tools/kidriver.py,
// which is verified write-for-write against the real driver; see docs/audio.md).
// State lives in the 64 KB ARAM image exactly where the driver keeps it.
(function () {
  'use strict';
  const BIT = [1, 2, 4, 8, 16, 32, 64, 128, 1, 2, 4, 8, 16, 32, 64, 128];

  class Driver {
    constructor(ram, dspWrite) {
      this.ram = ram;                    // Uint8Array(65536), shared with the DSP
      this.dsp = new Uint8Array(128);    // DSP register shadow (what the driver reads back)
      this.dspWrite = dspWrite;          // (reg, value) -> DSP
      this.loader = false;
    }
    r(a) { return this.ram[a & 0xFFFF]; }
    w(a, v) { this.ram[a & 0xFFFF] = v; }
    dw(reg, v) { v &= 0xFF; this.dsp[reg & 0x7F] = v; this.dspWrite(reg & 0x7F, v); }
    ptr(x) { return this.r(0x45 + x) | (this.r(0x55 + x) << 8); }
    setptr(x, p) { this.w(0x45 + x, p); this.w(0x55 + x, p >> 8); }
    stolen(x) { return this.r(0x01E0 + x); }

    transfer(dest, data) {
      if (data && data.length) { this.ram.set(data, dest); return; }
      this.loader = false;
      if (dest === 0x0672) this.boot();
      else if (dest !== 0x06D9) throw new Error('loader jump to ' + dest.toString(16));
    }

    dspInit() {                          // $0DA7
      this.dw(0x6C, 0xE0); this.dw(0x4C, 0); this.dw(0x5C, 0xFF);
      this.dw(0x2D, 0); this.dw(0x3D, 0); this.dw(0x4D, 0);
      this.w(0x0230, 0); this.w(0x0231, 0);
      this.dw(0x0C, 0); this.dw(0x1C, 0); this.dw(0x5D, 0x1D);
      for (let v = 0; v < 8; v++) {
        const b = v << 4;
        this.dw(b, 0); this.dw(b + 1, 0); this.dw(b + 5, 0); this.dw(b + 6, 0); this.dw(b + 7, 0xFF);
      }
      this.dw(0x0D, 0x37); this.dw(0x2C, 0x20); this.dw(0x3C, 0x20);
      this.w(0xE5, 100); this.w(0x0D, 0);
      this.dw(0x0F, 0x7F); this.dw(0x1F, 0x01);
      for (const reg of [0x2F, 0x3F, 0x4F, 0x5F, 0x6F, 0x7F]) this.dw(reg, 0);
      this.chanInit(true);
      this.dw(0x6C, 0);
    }
    chanInit(clearStolen) {              // $0E4C / $0EA2
      const e6 = this.r(0xE6) | (this.r(0xE7) << 8);
      this.w(0x0A, 0); this.w(0x0C, 0);
      let y = 0;
      for (let x = 0; x < 8; x++) {
        this.w(0x35 + x, 1); this.w(0x0110 + x, 1);
        this.w(0x45 + x, this.r(e6 + y)); y++;
        this.w(0x55 + x, this.r(e6 + y)); y++;
        this.w(0xD5 + x, x * 8);
        for (const a of [0x01D0, 0x25, 0x0120, 0x0130, 0x0150, 0x0140]) this.w(a + x, 0);
        if (clearStolen) this.w(0x01E0 + x, 0);
      }
      this.w(0x20, this.r(e6 + y)); this.w(0x23, this.r(e6 + y + 1));
      this.w(0x1F, 0); this.w(0x22, 0);
      this.w(0x01, 0x40);
    }
    ramp() {                             // $0683
      let a = this.r(0x0C);
      while (a !== 0x7F) { a = (a + 1) & 0xFF; this.dw(0x0C, a); this.dw(0x1C, a); }
      this.w(0x0C, a);
    }
    boot() { this.w(0xE7, 0x10); this.w(0xE6, 0x30); this.dspInit(); this.ramp(); }

    // returns true when the driver polls again at once (after $x3)
    command(cmd, param) {
      this.w(0x055C, param);
      this.w(0xE8, this.r(0xE8) + 1);
      if (cmd < 0x80) { this.sfxStart(param, cmd); return false; }
      const k = cmd & 7;
      if (k === 3) {
        for (let a = 0x7F; a >= 0; a--) { this.w(0x0C, a); this.dw(0x0C, a); this.dw(0x1C, a); }
        const s = this.r(0x055C) * 2;
        this.w(0xE6, this.r(0x1042 + s)); this.w(0xE7, this.r(0x1043 + s));
        this.chanInit(false);
        this.ramp();
        return true;
      }
      if (k === 6) { this.w(0x1E, 1); return false; }
      if (k === 7) {
        if (this.r(0x055C) === 0) {
          this.dw(0x5C, 0xFF);
          this.dw(0x2C, 0); this.dw(0x3C, 0); this.dw(0x6C, 0xA0); this.dw(0x4D, 0);
          this.ram.fill(0, 0xD700, 0x10000);
          this.dspInit();
          this.dw(0x6C, 0xFF); this.dw(0x7D, 0); this.dw(0x6D, 0xFF);
          this.w(0xEB, 0xFF);
        }
        this.loader = true;
        return false;
      }
      // other $8x values jump through a zero table entry on the real driver: ignore
      return false;
    }

    sfxStart(v, a) {                     // $0EEF
      const a2 = (a << 1) & 0xFF;
      v &= 7;
      this.w(0x01E0 + v, 1);
      this.dw(0x3D, this.dsp[0x3D] & ~BIT[v]);
      const x = v + 8;
      this.w(0xD5 + x, (x << 3) & 0xFF);
      this.w(0x0110 + x, 1);
      for (const b of [0x0120, 0x0130, 0x25, 0x01D0, 0x01E0, 0x0150, 0x0140, 0x0294, 0x65]) this.w(b + x, 0);
      for (const b of [0x0254, 0x0264, 0x0314, 0x0324]) this.w(b + x, 0x40);
      this.w(0x0274 + x, 0x8E); this.w(0x0284 + x, 0xE0);
      this.w(0x45 + x, this.r(0x1750 + a2)); this.w(0x55 + x, this.r(0x1751 + a2));
      this.w(0x35 + x, 2);
      this.dw(0x4D, this.dsp[0x4D] & ~BIT[x]);
    }

    tick() {
      if (!this.r(0x1E)) return;
      let s = this.r(0x1F) + this.r(0x20); this.w(0x1F, s); this.w(0x21, s > 0xFF ? 0x80 : 0);
      s = this.r(0x22) + this.r(0x23); this.w(0x22, s); this.w(0x24, s > 0xFF ? 0x80 : 0);
      for (let x = 0; x < 8; x++) {
        if (this.r(0x21)) { while (this.step(x)); } else this.modulate(x);
        if (this.r(0x01E0 + x)) {
          const xs = x | 8;
          if (this.r(0x24)) { while (this.step(xs)); } else this.modulate(xs);
        }
      }
      this.ramp();
    }

    step(x) {
      if (!this.r(0x0110 + x)) return false;
      const d = (this.r(0x35 + x) - 1) & 0xFF;
      this.w(0x35 + x, d);
      const hi = this.r(0x25 + x);
      if (d === 1) {
        if (hi === 0 && !this.stolen(x)) this.dw(0x5C, BIT[x]);
        this.modulate(x); return false;
      }
      if (d === 0xFF) {
        if (hi === 0) return this.event(x);
        this.w(0x25 + x, hi - 1); this.modulate(x); return false;
      }
      if (d === 0 && hi === 0) return this.event(x);
      this.modulate(x); return false;
    }

    event(x) {
      const p = this.ptr(x);
      this.w(0x00, p); this.w(0x01, p >> 8);
      const a = this.r(p);
      if (a & 0x80) { this.note(x, a, p); this.modulate(x); return false; }
      const f = this['c' + a.toString(16).toUpperCase().padStart(2, '0')];
      if (!f) {                          // zero table entry: the real driver would crash; stop the channel
        this.w(0x0110 + x, 0);
        return false;
      }
      return f.call(this, x, p);
    }

    note(x, a, p) {
      if (a === 0x80) {
        if (!this.stolen(x)) {
          this.dw(0x5C, BIT[x]);
          const b = ((x & 7) << 4) | 2;
          this.dw(b, 0); this.dw(b + 1, 0);
        }
        this.duration(x, p); return;
      }
      if (a >= 0xE0) a = a === 0xE1 ? this.r(0x16 + x) : this.r(0x0E + x);
      let s = a + 0x24;
      const c = s >> 8;
      s = (s & 0xFF) + this.r(0x0140 + x) + c;
      const idx = (s << 1) & 0xFF;
      const ft = this.r(0x65 + x);
      const lo = this.r(0x0F60 + idx), hi = this.r(0x0F61 + idx);
      let pitch;
      if (ft) {
        this.w(0x04, ft);
        const m = ft < 0x80 ? ft : (-ft) & 0xFF;
        let t = (lo * m) >> 8;
        this.w(0x03, 0);
        t = (hi * m + t) & 0xFFFF;
        t >>= 2;
        this.w(0x02, t); this.w(0x03, t >> 8);
        const base = lo | (hi << 8);
        pitch = ((ft & 0x80) ? base - t : base + t) & 0xFFFF;
      } else pitch = lo | (hi << 8);
      this.w(0x02, pitch); this.w(0x03, pitch >> 8);
      if (this.stolen(x)) { this.duration(x, p); return; }
      const b = (x & 7) << 4;
      this.dw(b, this.scale(x, this.r(0x0254 + x)));
      this.dw(b + 1, this.scale(x, this.r(0x0264 + x)));
      const fl = this.r(0x0150 + x);
      if (fl & 1) {
        this.w(0x01A0 + x, this.r(0x0160 + x)); this.w(0x0100 + x, this.r(0x0170 + x));
        this.w(0x95 + x, this.r(0x0180 + x)); this.w(0x01C0 + x, this.r(0x0190 + x));
      }
      if (fl & 2) {
        const dv = this.r(0x0234 + x);
        if (dv & 0x80) this.w(0x0234 + x, -dv);
        this.w(0xA5 + x, this.r(0x0200 + x) >> 1);
        this.w(0xB5 + x, this.r(0x0210 + x)); this.w(0xC5 + x, this.r(0x0220 + x));
      }
      this.w(0x85 + x, pitch); this.w(0x75 + x, pitch >> 8);
      this.dw(b + 2, pitch); this.dw(b + 3, pitch >> 8);
      this.dw(b + 4, this.r(0x0244 + x));
      this.dw(b + 5, this.r(0x0274 + x)); this.dw(b + 6, this.r(0x0284 + x));
      this.dw(b + 7, 0x7F);
      this.dw(0x5C, 0);
      this.dw(0x4C, BIT[x]);
      this.duration(x, p);
    }

    duration(x, p) {
      let n;
      if (this.r(0x0120 + x)) {
        n = 1;
        this.w(0x35 + x, this.r(0x0120 + x)); this.w(0x25 + x, this.r(0x0130 + x));
      } else {
        this.w(0x35 + x, this.r(p + 1));
        n = 2;
        if (this.r(0x01D0 + x)) { this.w(0x25 + x, this.r(p + 1)); this.w(0x35 + x, this.r(p + 2)); n = 3; }
      }
      this.w(0x00, n); this.w(0x01, 0);
      this.setptr(x, p + n);
    }
    scale(x, v) { return ((v * (x < 8 ? 0x23 : 0x3C)) / 100) | 0; }

    addpitch(x, delta) {
      this.w(0x00, delta); this.w(0x01, delta >> 8);
      const p = (((this.r(0x75 + x) << 8) | this.r(0x85 + x)) + delta) & 0xFFFF;
      this.w(0x85 + x, p); this.w(0x75 + x, p >> 8);
      if (!this.stolen(x)) { const b = ((x & 7) << 4) | 2; this.dw(b, p); this.dw(b + 1, p >> 8); }
    }
    modulate(x) {
      const fl = this.r(0x0150 + x);
      if (fl & 1) this.slide(x);
      if (fl & 2) {
        if (this.r(0xC5 + x)) { this.w(0xC5 + x, this.r(0xC5 + x) - 1); return; }
        let c = (this.r(0xB5 + x) - 1) & 0xFF;
        this.w(0xB5 + x, c);
        if (c) return;
        this.w(0xB5 + x, this.r(0x0210 + x));
        const dv = this.r(0x0234 + x);
        this.addpitch(x, (dv & 0x80) ? dv - 256 : dv);
        c = (this.r(0xA5 + x) - 1) & 0xFF;
        this.w(0xA5 + x, c);
        if (c === 0) { this.w(0xA5 + x, this.r(0x0200 + x)); this.w(0x0234 + x, -dv); }
      }
    }
    slide(x) {
      let c = this.r(0x01A0 + x);
      if (c) {
        if (c === 0xFF) return;
        c = (c - 1) & 0xFF;
        this.w(0x01A0 + x, c);
        if (c) return;
        this.w(0x0100 + x, 1);
      }
      const t = (this.r(0x0100 + x) - 1) & 0xFF;
      this.w(0x0100 + x, t);
      if (t) return;
      this.w(0x0100 + x, this.r(0x0170 + x));
      let d = this.r(0x01B0 + x);
      const f = this.r(0x01C0 + x);
      if (f) { this.w(0x01C0 + x, f - 1); d = (-d) & 0xFF; }
      this.addpitch(x, (d & 0x80) ? d - 256 : d);
      const n = (this.r(0x95 + x) - 1) & 0xFF;
      this.w(0x95 + x, n);
      if (n === 0) this.w(0x01A0 + x, 0xFF);
    }

    // ---- track commands ----
    a55(x) { this.w(0x35 + x, 1); this.w(0x25 + x, 0); }
    adv(x, p, n) { this.w(0x00, n); this.w(0x01, 0); this.setptr(x, p + n); return true; }
    c00(x) {
      this.w(0x0110 + x, 0);
      if (!this.stolen(x)) this.dw(0x5C, BIT[x]);
      if (x >= 8) {
        const v = x - 8;
        this.w(0x01E0 + v, 0);
        this.dw(0x3D, this.dsp[0x3D] & ~BIT[v]);
        if (this.r(0x0294 + v)) this.dw(0x4D, this.dsp[0x4D] | BIT[v]);
        else this.dw(0x4D, this.dsp[0x4D] & ~BIT[v]);
      }
      return false;
    }
    inst(x, p) { this.w(0x0244 + x, this.r(0x0560 + this.r(p + 1))); }
    c01(x, p) { this.a55(x); this.inst(x, p); return this.adv(x, p, 2); }
    c22(x, p) { this.a55(x); this.inst(x, p); this.w(0x0140 + x, this.r(p + 2)); this.w(0x65 + x, this.r(p + 3)); return this.adv(x, p, 4); }
    c1E(x, p) { this.a55(x); this.w(0x0254 + x, this.r(p + 1)); this.w(0x0264 + x, this.r(p + 1)); return this.adv(x, p, 2); }
    c02(x, p) { this.a55(x); this.w(0x0254 + x, this.r(p + 1)); this.w(0x0264 + x, this.r(p + 2)); return this.adv(x, p, 3); }
    c23(x, p) {
      this.a55(x);
      const e = this.r(p + 1);
      this.dw(0x6C, 0);
      this.dw(0x7D, e >> 1);
      const a3 = ((e << 2) & 0xFF) | (e >> 7);
      const esa = (0xFF - a3) & 0xFF;
      this.dw(0x6D, esa);
      this.w(0xEB, esa);
      this.ram.fill(0, esa << 8, 0x10000);
      return this.adv(x, p, 2);
    }
    c03(x, p) { this.a55(x); this.setptr(x, this.r(p + 1) | (this.r(p + 2) << 8)); return true; }
    push(x, count, ret) {
      const y = this.r(0xD5 + x);
      this.w(0x0454 + y, count); this.w(0x03D4 + y, ret >> 8); this.w(0x0354 + y, ret);
      this.w(0xD5 + x, y + 1);
    }
    c04(x, p) {
      this.a55(x);
      this.w(0x04, this.r(p + 1));
      const tgt = this.r(p + 2) | (this.r(p + 3) << 8);
      this.w(0x02, tgt); this.w(0x03, tgt >> 8);
      this.push(x, this.r(p + 1), p);
      this.setptr(x, tgt);
      return true;
    }
    c1F(x, p) {
      this.a55(x);
      this.w(0x04, 1);
      const tgt = this.r(p + 1) | (this.r(p + 2) << 8);
      this.w(0x02, tgt); this.w(0x03, tgt >> 8);
      const y = this.r(0xD5 + x);
      this.w(0x0454 + y, 1);
      const lo = p & 0xFF; let hi = p >> 8;
      if (lo === 0) hi = (hi - 1) & 0xFF;
      this.w(0x03D4 + y, hi); this.w(0x0354 + y, lo - 1);
      this.w(0xD5 + x, y + 1);
      this.setptr(x, tgt);
      return true;
    }
    c05(x) {
      this.a55(x);
      const y = (this.r(0xD5 + x) - 1) & 0xFF;
      this.w(0xD5 + x, y);
      const q = this.r(0x0354 + y) | (this.r(0x03D4 + y) << 8);
      this.setptr(x, q);
      const n = (this.r(0x0454 + y) - 1) & 0xFF;
      this.w(0x0454 + y, n);
      if (n === 0) return this.adv(x, q, 4);
      this.w(0x00, q); this.w(0x01, q >> 8);
      const tgt = this.r(q + 2) | (this.r(q + 3) << 8);
      this.w(0x02, tgt); this.w(0x03, tgt >> 8);
      this.w(0xD5 + x, y + 1);
      this.setptr(x, tgt);
      return true;
    }
    c06(x, p) {
      this.a55(x);
      this.w(0x0120 + x, this.r(p + 1));
      let n = 2;
      if (this.r(0x01D0 + x)) { this.w(0x0130 + x, this.r(p + 1)); this.w(0x0120 + x, this.r(p + 2)); n = 3; }
      return this.adv(x, p, n);
    }
    bfc(x, p) { this.w(0x35 + x, 1); this.w(0x25 + x, 0); return this.adv(x, p, 1); }
    c07(x, p) { this.w(0x0120 + x, 0); this.w(0x0130 + x, 0); return this.bfc(x, p); }
    slideOn(x, p, delta) {
      this.w(0x01B0 + x, delta);
      this.w(0x0150 + x, this.r(0x0150 + x) | 1);
      this.a55(x);
      this.w(0x0160 + x, this.r(p + 1)); this.w(0x0170 + x, this.r(p + 2));
      this.w(0x0180 + x, this.r(p + 3)); this.w(0x0190 + x, this.r(p + 5));
      return this.adv(x, p, 6);
    }
    c08(x, p) { return this.slideOn(x, p, this.r(p + 4)); }
    c09(x, p) { return this.slideOn(x, p, -this.r(p + 4)); }
    c0A(x, p) { this.w(0x0150 + x, this.r(0x0150 + x) & 0xFE); return this.bfc(x, p); }
    c0B(x, p) { this.w(0x20, this.r(p + 1)); this.a55(x); return this.adv(x, p, 2); }
    c0E(x, p) { this.w(0x0150 + x, this.r(0x0150 + x) & 0xFD); return this.bfc(x, p); }
    c0F(x, p) {
      this.w(0x0220 + x, this.r(p + 4));
      this.w(0x0150 + x, this.r(0x0150 + x) | 2);
      this.a55(x);
      this.w(0x0200 + x, this.r(p + 1)); this.w(0x0210 + x, this.r(p + 2));
      this.w(0x0234 + x, this.r(p + 3));
      return this.adv(x, p, 5);
    }
    c10(x, p) { this.a55(x); this.w(0x0274 + x, this.r(p + 1)); this.w(0x0284 + x, this.r(p + 2)); return this.adv(x, p, 3); }
    c20(x, p) { this.a55(x); this.w(0x0274 + x, 0x8F); this.w(0x0284 + x, 0xE0); return this.adv(x, p, 1); }
    c21(x, p) { this.a55(x); this.w(0x0274 + x, 0x8E); this.w(0x0284 + x, 0xE0); return this.adv(x, p, 1); }
    c12(x, p) { this.a55(x); this.w(0x65 + x, this.r(p + 1)); return this.adv(x, p, 2); }
    c13(x, p) { this.a55(x); this.w(0x0140 + x, this.r(p + 1)); return this.adv(x, p, 2); }
    c14(x, p) { this.a55(x); this.w(0x0140 + x, this.r(p + 1) + this.r(0x0140 + x)); return this.adv(x, p, 2); }
    c16(x, p) { this.a55(x); this.dw(0x4D, this.dsp[0x4D] | BIT[x]); this.w(0x0294 + x, 1); return this.adv(x, p, 1); }
    c17(x, p) {
      this.dw(0x4D, this.dsp[0x4D] & ~BIT[x]);
      this.w(0x0294 + x, 0); this.w(0x25 + x, 0); this.w(0x35 + x, 1);
      return this.adv(x, p, 1);
    }
    dip(x, p, delta) {
      this.w(0x01B0 + x, delta);
      this.w(0x0150 + x, this.r(0x0150 + x) | 1);
      this.a55(x);
      this.w(0x0160 + x, this.r(p + 1)); this.w(0x0170 + x, this.r(p + 2));
      const n = this.r(p + 3);
      this.w(0x0190 + x, n); this.w(0x0180 + x, n << 1);
      return this.adv(x, p, 5);
    }
    c26(x, p) { return this.dip(x, p, -this.r(p + 4)); }
    c27(x, p) { return this.dip(x, p, this.r(p + 4)); }
    c2B(x, p) { this.a55(x); this.w(0x01D0 + x, 1); return this.adv(x, p, 1); }
    c2C(x, p) { this.a55(x); this.w(0x01D0 + x, 0); return this.adv(x, p, 1); }
  }

  globalThis.KIDriver = Driver;
})();
