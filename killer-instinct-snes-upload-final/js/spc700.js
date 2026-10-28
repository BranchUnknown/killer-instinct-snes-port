// SPC700 CPU + timers + I/O registers, for running a sound program that is not KI's original
// driver (the Arcade MegaPatch rewrites part of it). Cycle counts from LakeSnes (decomp/tools/spcref).
// The boot ROM is not included: js/apu.js performs the boot-ROM upload itself and starts this core
// at the uploaded loader.
(function () {
  'use strict';
  const CYC = [
    2, 8, 4, 5, 3, 4, 3, 6, 2, 6, 5, 4, 5, 4, 6, 8, 2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 6, 5, 2, 2, 4, 6,
    2, 8, 4, 5, 3, 4, 3, 6, 2, 6, 5, 4, 5, 4, 5, 4, 2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 6, 5, 2, 2, 3, 8,
    2, 8, 4, 5, 3, 4, 3, 6, 2, 6, 4, 4, 5, 4, 6, 6, 2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 4, 5, 2, 2, 4, 3,
    2, 8, 4, 5, 3, 4, 3, 6, 2, 6, 4, 4, 5, 4, 5, 5, 2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 5, 5, 2, 2, 3, 6,
    2, 8, 4, 5, 3, 4, 3, 6, 2, 6, 5, 4, 5, 2, 4, 5, 2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 5, 5, 2, 2, 12, 5,
    2, 8, 4, 5, 3, 4, 3, 6, 2, 6, 4, 4, 5, 2, 4, 4, 2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 5, 5, 2, 2, 3, 4,
    2, 8, 4, 5, 4, 5, 4, 7, 2, 5, 6, 4, 5, 2, 4, 9, 2, 8, 4, 5, 5, 6, 6, 7, 4, 5, 5, 5, 2, 2, 6, 3,
    2, 8, 4, 5, 3, 4, 3, 6, 2, 4, 5, 3, 4, 3, 4, 3, 2, 8, 4, 5, 4, 5, 5, 6, 3, 4, 5, 4, 2, 2, 4, 3];

  class SPC700 {
    constructor(ram, dsp, ports) {
      this.ram = ram; this.dsp = dsp;
      this.inP = ports.inP; this.outP = ports.outP;   // shared with the CPU side
      this.reset();
    }
    reset() {
      this.a = 0; this.x = 0; this.y = 0; this.sp = 0xEF; this.pc = 0;
      this.n = 0; this.v = 0; this.p = 0; this.b = 0; this.h = 0; this.i = 0; this.z = 0; this.c = 0;
      this.stopped = false;
      this.dspAdr = 0;
      this.left = 0;
      this.timer = [0, 1, 2].map(i => ({ cycles: 0, div: 0, target: 0, counter: 0, on: false, period: i === 2 ? 16 : 128 }));
      this.onTick = null;
    }

    // ---- memory ----
    rd(a) {
      a &= 0xFFFF;
      if ((a & 0xFFF0) === 0x00F0) {
        switch (a) {
          case 0xF2: return this.dspAdr;
          case 0xF3: return this.dsp.read(this.dspAdr & 0x7F);
          case 0xF4: case 0xF5: case 0xF6: case 0xF7: return this.inP[a - 0xF4];
          case 0xF8: case 0xF9: return this.ram[a];
          case 0xFD: case 0xFE: case 0xFF: {
            const t = this.timer[a - 0xFD], v = t.counter; t.counter = 0; return v;
          }
          default: return 0;
        }
      }
      return this.ram[a];
    }
    wr(a, v) {
      a &= 0xFFFF; v &= 0xFF;
      if ((a & 0xFFF0) === 0x00F0) {
        switch (a) {
          case 0xF1:
            for (let i = 0; i < 3; i++) {
              const on = (v >> i) & 1;
              if (on && !this.timer[i].on) { this.timer[i].div = 0; this.timer[i].counter = 0; }
              this.timer[i].on = !!on;
            }
            if (v & 0x10) { this.inP[0] = 0; this.inP[1] = 0; }
            if (v & 0x20) { this.inP[2] = 0; this.inP[3] = 0; }
            return;
          case 0xF2: this.dspAdr = v; return;
          case 0xF3: if (this.dspAdr < 0x80) this.dsp.write(this.dspAdr, v); return;
          case 0xF4: case 0xF5: case 0xF6: case 0xF7: this.outP[a - 0xF4] = v; return;
          case 0xFA: case 0xFB: case 0xFC: this.timer[a - 0xFA].target = v; return;
          case 0xF8: case 0xF9: this.ram[a] = v; return;
          default: return;
        }
      }
      this.ram[a] = v;
    }
    fetch() { const v = this.rd(this.pc); this.pc = (this.pc + 1) & 0xFFFF; return v; }
    fetch16() { const l = this.fetch(); return l | (this.fetch() << 8); }
    push(v) { this.wr(0x100 | this.sp, v); this.sp = (this.sp - 1) & 0xFF; }
    pull() { this.sp = (this.sp + 1) & 0xFF; return this.rd(0x100 | this.sp); }
    push16(v) { this.push(v >> 8); this.push(v & 0xFF); }
    pull16() { const l = this.pull(); return l | (this.pull() << 8); }
    getP() { return (this.n << 7) | (this.v << 6) | (this.p << 5) | (this.b << 4) | (this.h << 3) | (this.i << 2) | (this.z << 1) | this.c; }
    setP(v) { this.n = (v >> 7) & 1; this.v = (v >> 6) & 1; this.p = (v >> 5) & 1; this.b = (v >> 4) & 1; this.h = (v >> 3) & 1; this.i = (v >> 2) & 1; this.z = (v >> 1) & 1; this.c = v & 1; }
    zn(v) { this.z = (v & 0xFF) === 0 ? 1 : 0; this.n = (v >> 7) & 1; return v & 0xFF; }

    // ---- addressing ----
    dp() { return this.fetch() | (this.p << 8); }
    dpx() { return ((this.fetch() + this.x) & 0xFF) | (this.p << 8); }
    dpy() { return ((this.fetch() + this.y) & 0xFF) | (this.p << 8); }
    abs() { return this.fetch16(); }
    abx() { return (this.fetch16() + this.x) & 0xFFFF; }
    aby() { return (this.fetch16() + this.y) & 0xFFFF; }
    ind() { return this.x | (this.p << 8); }
    idx() { const q = this.fetch(), P = this.p << 8; return this.rd(((q + this.x) & 0xFF) | P) | (this.rd(((q + this.x + 1) & 0xFF) | P) << 8); }
    idy() { const q = this.fetch(), P = this.p << 8; return ((this.rd(q | P) | (this.rd(((q + 1) & 0xFF) | P) << 8)) + this.y) & 0xFFFF; }
    imm() { const a = this.pc; this.pc = (this.pc + 1) & 0xFFFF; return a; }
    word(lo) { const P = lo & 0xFF00; return [lo, ((lo + 1) & 0xFF) | P]; }

    // ---- ALU (8-bit, values in, result out) ----
    adc(a, b) {
      const r = a + b + this.c;
      this.v = (~(a ^ b) & (a ^ r) & 0x80) ? 1 : 0;
      this.h = ((a & 0xF) + (b & 0xF) + this.c) > 0xF ? 1 : 0;
      this.c = r > 0xFF ? 1 : 0;
      return this.zn(r);
    }
    sbc(a, b) { return this.adc(a, b ^ 0xFF); }
    cmp(a, b) { const r = a - b; this.c = r >= 0 ? 1 : 0; this.zn(r & 0xFF); }
    asl(v) { this.c = (v >> 7) & 1; return this.zn(v << 1); }
    lsr(v) { this.c = v & 1; return this.zn(v >> 1); }
    rol(v) { const c = this.c; this.c = (v >> 7) & 1; return this.zn((v << 1) | c); }
    ror(v) { const c = this.c; this.c = v & 1; return this.zn((v >> 1) | (c << 7)); }
    rmw(a, f) { this.wr(a, f.call(this, this.rd(a))); }
    branch(cond) {
      const o = this.fetch();
      if (cond) { this.left += 2; this.pc = (this.pc + ((o << 24) >> 24)) & 0xFFFF; }
    }
    absbit() { const w = this.fetch16(); return [w & 0x1FFF, w >> 13]; }

    // run SPC cycles; timers tick per cycle like LakeSnes
    run(cycles) {
      while (cycles > 0) {
        if (this.left <= 0) this.left += this.stopped ? 1 : this.step();
        const n = Math.min(this.left, cycles);
        this.left -= n; cycles -= n;
        for (let i = 0; i < 3; i++) {
          const t = this.timer[i];
          t.cycles -= n;
          while (t.cycles <= 0) {
            t.cycles += t.period;
            if (t.on) {
              t.div = (t.div + 1) & 0xFF;
              if (t.div === t.target) { t.div = 0; t.counter = (t.counter + 1) & 0xF; }
            }
          }
        }
      }
    }

    step() {
      const op = this.fetch();
      this.left += 0;
      let cyc = CYC[op];
      const save = this.left; this.left = 0;
      this.exec(op);
      cyc += this.left; this.left = save;
      return cyc;
    }

    exec(op) {
      let a, v, w, t;
      const lo = op & 0x0F, hi = op >> 4;
      // the regular ALU block: 0x04-0x09/0x14-0x19 for OR(0) AND(2) EOR(4) CMP(6) ADC(8) SBC(A)
      if ((hi & 1) === 0 && lo >= 4 && lo <= 9 && hi <= 0xA || (hi & 1) === 1 && lo >= 4 && lo <= 9 && hi <= 0xB) {
        const grp = hi >> 1;
        let src;
        switch (op & 0x1F) {
          case 0x04: src = this.dp(); break; case 0x05: src = this.abs(); break; case 0x06: src = this.ind(); break;
          case 0x07: src = this.idx(); break; case 0x08: src = this.imm(); break;
          case 0x14: src = this.dpx(); break; case 0x15: src = this.abx(); break; case 0x16: src = this.aby(); break;
          case 0x17: src = this.idy(); break;
          default: src = -1;
        }
        if (src >= 0) { this.alu(grp, -1, this.rd(src)); return; }
        // memory-to-memory forms: 09 dp,dp  18 dp,imm  19 (x),(y)
        let dst;
        if ((op & 0x1F) === 0x09) { const s = this.dp(); dst = this.dp(); v = this.rd(s); }
        else if ((op & 0x1F) === 0x18) { v = this.rd(this.imm()); dst = this.dp(); }
        else { v = this.rd(this.y | (this.p << 8)); dst = this.x | (this.p << 8); }
        this.alu(grp, dst, v);
        return;
      }
      switch (op) {
        case 0x00: return;
        // TCALL n
        case 0x01: case 0x11: case 0x21: case 0x31: case 0x41: case 0x51: case 0x61: case 0x71:
        case 0x81: case 0x91: case 0xA1: case 0xB1: case 0xC1: case 0xD1: case 0xE1: case 0xF1:
          this.push16(this.pc); a = 0xFFDE - 2 * hi; this.pc = this.rd(a) | (this.rd(a + 1) << 8); return;
        // SET1 / CLR1 dp.bit
        case 0x02: case 0x22: case 0x42: case 0x62: case 0x82: case 0xA2: case 0xC2: case 0xE2:
          a = this.dp(); this.wr(a, this.rd(a) | (1 << (op >> 5))); return;
        case 0x12: case 0x32: case 0x52: case 0x72: case 0x92: case 0xB2: case 0xD2: case 0xF2:
          a = this.dp(); this.wr(a, this.rd(a) & ~(1 << (op >> 5))); return;
        // BBS / BBC dp.bit, rel
        case 0x03: case 0x23: case 0x43: case 0x63: case 0x83: case 0xA3: case 0xC3: case 0xE3:
          v = this.rd(this.dp()); this.branch(v & (1 << (op >> 5))); return;
        case 0x13: case 0x33: case 0x53: case 0x73: case 0x93: case 0xB3: case 0xD3: case 0xF3:
          v = this.rd(this.dp()); this.branch(!(v & (1 << (op >> 5)))); return;
        // bit ops on abs.bit
        case 0x0A: [a, t] = this.absbit(); this.c |= (this.rd(a) >> t) & 1; return;
        case 0x2A: [a, t] = this.absbit(); this.c |= (~(this.rd(a) >> t)) & 1; return;
        case 0x4A: [a, t] = this.absbit(); this.c &= (this.rd(a) >> t) & 1; return;
        case 0x6A: [a, t] = this.absbit(); this.c &= (~(this.rd(a) >> t)) & 1; return;
        case 0x8A: [a, t] = this.absbit(); this.c ^= (this.rd(a) >> t) & 1; return;
        case 0xAA: [a, t] = this.absbit(); this.c = (this.rd(a) >> t) & 1; return;
        case 0xCA: [a, t] = this.absbit(); v = this.rd(a); this.wr(a, this.c ? v | (1 << t) : v & ~(1 << t)); return;
        case 0xEA: [a, t] = this.absbit(); this.wr(a, this.rd(a) ^ (1 << t)); return;
        // shifts / inc / dec
        case 0x0B: this.rmw(this.dp(), this.asl); return;
        case 0x0C: this.rmw(this.abs(), this.asl); return;
        case 0x1B: this.rmw(this.dpx(), this.asl); return;
        case 0x1C: this.a = this.asl(this.a); return;
        case 0x2B: this.rmw(this.dp(), this.rol); return;
        case 0x2C: this.rmw(this.abs(), this.rol); return;
        case 0x3B: this.rmw(this.dpx(), this.rol); return;
        case 0x3C: this.a = this.rol(this.a); return;
        case 0x4B: this.rmw(this.dp(), this.lsr); return;
        case 0x4C: this.rmw(this.abs(), this.lsr); return;
        case 0x5B: this.rmw(this.dpx(), this.lsr); return;
        case 0x5C: this.a = this.lsr(this.a); return;
        case 0x6B: this.rmw(this.dp(), this.ror); return;
        case 0x6C: this.rmw(this.abs(), this.ror); return;
        case 0x7B: this.rmw(this.dpx(), this.ror); return;
        case 0x7C: this.a = this.ror(this.a); return;
        case 0x8B: a = this.dp(); this.wr(a, this.zn(this.rd(a) - 1)); return;
        case 0x8C: a = this.abs(); this.wr(a, this.zn(this.rd(a) - 1)); return;
        case 0x9B: a = this.dpx(); this.wr(a, this.zn(this.rd(a) - 1)); return;
        case 0x9C: this.a = this.zn(this.a - 1); return;
        case 0xAB: a = this.dp(); this.wr(a, this.zn(this.rd(a) + 1)); return;
        case 0xAC: a = this.abs(); this.wr(a, this.zn(this.rd(a) + 1)); return;
        case 0xBB: a = this.dpx(); this.wr(a, this.zn(this.rd(a) + 1)); return;
        case 0xBC: this.a = this.zn(this.a + 1); return;
        case 0x1D: this.x = this.zn(this.x - 1); return;
        case 0x3D: this.x = this.zn(this.x + 1); return;
        case 0xDC: this.y = this.zn(this.y - 1); return;
        case 0xFC: this.y = this.zn(this.y + 1); return;
        // word ops
        case 0x1A: case 0x3A: {
          const [l, h] = this.word(this.dp());
          w = ((this.rd(l) | (this.rd(h) << 8)) + (op === 0x1A ? -1 : 1)) & 0xFFFF;
          this.wr(l, w); this.wr(h, w >> 8);
          this.z = w === 0 ? 1 : 0; this.n = (w >> 15) & 1; return;
        }
        case 0x5A: case 0x7A: case 0x9A: case 0xBA: case 0xDA: {
          const [l, h] = this.word(this.dp());
          if (op === 0xDA) { this.rd(l); this.wr(l, this.a); this.wr(h, this.y); return; }
          w = this.rd(l) | (this.rd(h) << 8);
          const ya = this.a | (this.y << 8);
          if (op === 0xBA) { this.a = w & 0xFF; this.y = w >> 8; this.z = w === 0 ? 1 : 0; this.n = (w >> 15) & 1; return; }
          if (op === 0x5A) { const r = ya - w; this.c = r >= 0 ? 1 : 0; this.z = (r & 0xFFFF) === 0 ? 1 : 0; this.n = (r >> 15) & 1; return; }
          const vv = op === 0x9A ? w ^ 0xFFFF : w, cin = op === 0x9A ? 1 : 0;
          const r = ya + vv + cin;
          this.v = (~(ya ^ vv) & (ya ^ r) & 0x8000) ? 1 : 0;
          this.h = ((ya & 0xFFF) + (vv & 0xFFF) + cin) > 0xFFF ? 1 : 0;
          this.c = r > 0xFFFF ? 1 : 0;
          this.z = (r & 0xFFFF) === 0 ? 1 : 0; this.n = (r >> 15) & 1;
          this.a = r & 0xFF; this.y = (r >> 8) & 0xFF; return;
        }
        // compares with X / Y
        case 0x1E: this.cmp(this.x, this.rd(this.abs())); return;
        case 0x3E: this.cmp(this.x, this.rd(this.dp())); return;
        case 0xC8: this.cmp(this.x, this.fetch()); return;
        case 0x5E: this.cmp(this.y, this.rd(this.abs())); return;
        case 0x7E: this.cmp(this.y, this.rd(this.dp())); return;
        case 0xAD: this.cmp(this.y, this.fetch()); return;
        // TSET1 / TCLR1
        case 0x0E: a = this.abs(); v = this.rd(a); this.zn((this.a - v) & 0xFF); this.wr(a, v | this.a); return;
        case 0x4E: a = this.abs(); v = this.rd(a); this.zn((this.a - v) & 0xFF); this.wr(a, v & ~this.a); return;
        // stack / flags
        case 0x0D: this.push(this.getP()); return;
        case 0x2D: this.push(this.a); return;
        case 0x4D: this.push(this.x); return;
        case 0x6D: this.push(this.y); return;
        case 0x8E: this.setP(this.pull()); return;
        case 0xAE: this.a = this.pull(); return;
        case 0xCE: this.x = this.pull(); return;
        case 0xEE: this.y = this.pull(); return;
        case 0x20: this.p = 0; return;
        case 0x40: this.p = 1; return;
        case 0x60: this.c = 0; return;
        case 0x80: this.c = 1; return;
        case 0xA0: this.i = 1; return;
        case 0xC0: this.i = 0; return;
        case 0xE0: this.v = 0; this.h = 0; return;
        case 0xED: this.c ^= 1; return;
        // branches / jumps
        case 0x10: this.branch(!this.n); return;
        case 0x30: this.branch(this.n); return;
        case 0x50: this.branch(!this.v); return;
        case 0x70: this.branch(this.v); return;
        case 0x90: this.branch(!this.c); return;
        case 0xB0: this.branch(this.c); return;
        case 0xD0: this.branch(!this.z); return;
        case 0xF0: this.branch(this.z); return;
        case 0x2F: v = this.fetch(); this.pc = (this.pc + ((v << 24) >> 24)) & 0xFFFF; return;
        case 0x2E: v = this.rd(this.dp()); this.branch(this.a !== v); return;
        case 0xDE: v = this.rd(this.dpx()); this.branch(this.a !== v); return;
        case 0x6E: a = this.dp(); v = (this.rd(a) - 1) & 0xFF; this.wr(a, v); this.branch(v !== 0); return;
        case 0xFE: this.y = (this.y - 1) & 0xFF; this.branch(this.y !== 0); return;
        case 0x5F: this.pc = this.fetch16(); return;
        case 0x1F: w = (this.fetch16() + this.x) & 0xFFFF; this.pc = this.rd(w) | (this.rd((w + 1) & 0xFFFF) << 8); return;
        case 0x3F: w = this.fetch16(); this.push16(this.pc); this.pc = w; return;
        case 0x4F: v = this.fetch(); this.push16(this.pc); this.pc = 0xFF00 | v; return;
        case 0x6F: this.pc = this.pull16(); return;
        case 0x7F: this.setP(this.pull()); this.pc = this.pull16(); return;
        case 0x0F: this.push16(this.pc); this.push(this.getP()); this.i = 0; this.b = 1; this.pc = this.rd(0xFFDE) | (this.rd(0xFFDF) << 8); return;
        // moves to A / X / Y
        case 0xE4: this.a = this.zn(this.rd(this.dp())); return;
        case 0xE5: this.a = this.zn(this.rd(this.abs())); return;
        case 0xE6: this.a = this.zn(this.rd(this.ind())); return;
        case 0xE7: this.a = this.zn(this.rd(this.idx())); return;
        case 0xE8: this.a = this.zn(this.fetch()); return;
        case 0xF4: this.a = this.zn(this.rd(this.dpx())); return;
        case 0xF5: this.a = this.zn(this.rd(this.abx())); return;
        case 0xF6: this.a = this.zn(this.rd(this.aby())); return;
        case 0xF7: this.a = this.zn(this.rd(this.idy())); return;
        case 0xBF: this.a = this.zn(this.rd(this.x | (this.p << 8))); this.x = (this.x + 1) & 0xFF; return;
        case 0xF8: this.x = this.zn(this.rd(this.dp())); return;
        case 0xE9: this.x = this.zn(this.rd(this.abs())); return;
        case 0xCD: this.x = this.zn(this.fetch()); return;
        case 0xF9: this.x = this.zn(this.rd(this.dpy())); return;
        case 0xEB: this.y = this.zn(this.rd(this.dp())); return;
        case 0xEC: this.y = this.zn(this.rd(this.abs())); return;
        case 0x8D: this.y = this.zn(this.fetch()); return;
        case 0xFB: this.y = this.zn(this.rd(this.dpx())); return;
        // register transfers
        case 0x7D: this.a = this.zn(this.x); return;
        case 0xDD: this.a = this.zn(this.y); return;
        case 0x5D: this.x = this.zn(this.a); return;
        case 0xFD: this.y = this.zn(this.a); return;
        case 0x9D: this.x = this.zn(this.sp); return;
        case 0xBD: this.sp = this.x; return;
        // stores (dummy read first, as on hardware)
        case 0xC4: a = this.dp(); this.rd(a); this.wr(a, this.a); return;
        case 0xC5: a = this.abs(); this.rd(a); this.wr(a, this.a); return;
        case 0xC6: a = this.ind(); this.rd(a); this.wr(a, this.a); return;
        case 0xC7: a = this.idx(); this.rd(a); this.wr(a, this.a); return;
        case 0xD4: a = this.dpx(); this.rd(a); this.wr(a, this.a); return;
        case 0xD5: a = this.abx(); this.rd(a); this.wr(a, this.a); return;
        case 0xD6: a = this.aby(); this.rd(a); this.wr(a, this.a); return;
        case 0xD7: a = this.idy(); this.rd(a); this.wr(a, this.a); return;
        case 0xAF: this.wr(this.x | (this.p << 8), this.a); this.x = (this.x + 1) & 0xFF; return;
        case 0xD8: a = this.dp(); this.rd(a); this.wr(a, this.x); return;
        case 0xC9: a = this.abs(); this.rd(a); this.wr(a, this.x); return;
        case 0xD9: a = this.dpy(); this.rd(a); this.wr(a, this.x); return;
        case 0xCB: a = this.dp(); this.rd(a); this.wr(a, this.y); return;
        case 0xCC: a = this.abs(); this.rd(a); this.wr(a, this.y); return;
        case 0xDB: a = this.dpx(); this.rd(a); this.wr(a, this.y); return;
        case 0xFA: { const s = this.dp(); v = this.rd(s); this.wr(this.dp(), v); return; }
        case 0x8F: { v = this.fetch(); a = this.dp(); this.rd(a); this.wr(a, v); return; }
        // multiply / divide / decimal
        case 0xCF: w = this.a * this.y; this.a = w & 0xFF; this.y = w >> 8; this.zn(this.y); return;
        case 0x9E: {
          const ya = this.a | (this.y << 8);
          let q = 0xFFFF, m = this.a;
          if (this.x !== 0) { q = Math.floor(ya / this.x); m = ya % this.x; }
          this.v = q > 0xFF ? 1 : 0;
          this.h = (this.x & 0xF) <= (this.y & 0xF) ? 1 : 0;
          this.a = q & 0xFF; this.y = m & 0xFF; this.zn(this.a); return;
        }
        case 0x9F: this.a = this.zn((this.a >> 4) | (this.a << 4)); return;
        case 0xDF:
          if (this.a > 0x99 || this.c) { this.a = (this.a + 0x60) & 0xFF; this.c = 1; }
          if ((this.a & 0xF) > 9 || this.h) this.a = (this.a + 6) & 0xFF;
          this.zn(this.a); return;
        case 0xBE:
          if (this.a > 0x99 || !this.c) { this.a = (this.a - 0x60) & 0xFF; this.c = 0; }
          if ((this.a & 0xF) > 9 || !this.h) this.a = (this.a - 6) & 0xFF;
          this.zn(this.a); return;
        case 0xEF: case 0xFF: this.stopped = true; return;
      }
      throw new Error('SPC700 opcode ' + op.toString(16));
    }

    alu(grp, dst, v) {
      const src = dst < 0 ? this.a : this.rd(dst);
      let r;
      switch (grp) {
        case 0: r = this.zn(src | v); break;
        case 1: r = this.zn(src & v); break;
        case 2: r = this.zn(src ^ v); break;
        case 3: this.cmp(src, v); return;
        case 4: r = this.adc(src, v); break;
        case 5: r = this.sbc(src, v); break;
      }
      if (dst < 0) this.a = r; else this.wr(dst, r);
    }
  }

  globalThis.KISPC700 = SPC700;
})();
