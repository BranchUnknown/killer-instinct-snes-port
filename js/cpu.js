// 65816 CPU core. Runs the game code read from the player's ROM.
// Memory timing comes from the bus (bus.read/bus.write add master cycles); internal
// operations add 6 master cycles each (io()).
(function () {
  'use strict';

  class CPU {
    constructor(bus) {
      this.bus = bus;
      this.A = 0; this.X = 0; this.Y = 0; this.S = 0x01FF; this.D = 0;
      this.DB = 0; this.PB = 0; this.PC = 0;
      this.N = 0; this.V = 0; this.M = 1; this.XF = 1; this.Dec = 0; this.I = 1; this.Z = 0; this.C = 0;
      this.E = 1;
      this.nmiPending = false;
      this.irqLine = false;
      this.waiting = false;
      this.stopped = false;
      this.bpPC = -1; this.bpPB = -1; this.onBreak = null;   // one host hook address (port features)
    }

    reset() {
      this.E = 1; this.M = 1; this.XF = 1; this.I = 1; this.Dec = 0;
      this.D = 0; this.DB = 0; this.PB = 0; this.S = 0x01FF;
      this.X &= 0xFF; this.Y &= 0xFF;
      this.PC = this.rd(0xFFFC) | (this.rd(0xFFFD) << 8);
      this.waiting = false; this.stopped = false; this.nmiPending = false;
    }

    // ---------- memory helpers ----------
    rd(a) { return this.bus.read(a & 0xFFFFFF); }
    wr(a, v) { this.bus.write(a & 0xFFFFFF, v & 0xFF); }
    io() { this.bus.cycles += 6; }
    fetch() { const v = this.rd((this.PB << 16) | this.PC); this.PC = (this.PC + 1) & 0xFFFF; return v; }
    fetch16() { const l = this.fetch(); return l | (this.fetch() << 8); }
    fetch24() { const l = this.fetch16(); return l | (this.fetch() << 16); }

    // read/write with wrap mode: w = true -> 16-bit wrap inside bank 0
    rd16(a, w) { const l = this.rd(a); return l | (this.rd(w ? (a + 1) & 0xFFFF : (a + 1) & 0xFFFFFF) << 8); }
    wr16(a, v, w) { this.wr(a, v); this.wr(w ? (a + 1) & 0xFFFF : (a + 1) & 0xFFFFFF, v >> 8); }

    push8(v) {
      this.wr(this.S, v);
      this.S = this.E ? 0x0100 | ((this.S - 1) & 0xFF) : (this.S - 1) & 0xFFFF;
    }
    pull8() {
      this.S = this.E ? 0x0100 | ((this.S + 1) & 0xFF) : (this.S + 1) & 0xFFFF;
      return this.rd(this.S);
    }
    push16(v) { this.push8(v >> 8); this.push8(v & 0xFF); }
    pull16() { const l = this.pull8(); return l | (this.pull8() << 8); }
    // "new" 65816 instructions (PEA/PEI/PER/PHD/PLD/JSL/RTL...) do not wrap the stack in E mode
    push8n(v) { this.wr(this.S, v); this.S = (this.S - 1) & 0xFFFF; }
    pull8n() { this.S = (this.S + 1) & 0xFFFF; return this.rd(this.S); }
    push16n(v) { this.push8n(v >> 8); this.push8n(v & 0xFF); }
    pull16n() { const l = this.pull8n(); return l | (this.pull8n() << 8); }
    fixStackE() { if (this.E) this.S = 0x0100 | (this.S & 0xFF); }

    getP() {
      return (this.N << 7) | (this.V << 6) | (this.M << 5) | (this.XF << 4) | (this.Dec << 3) |
        (this.I << 2) | (this.Z << 1) | this.C;
    }
    setP(p) {
      this.N = (p >> 7) & 1; this.V = (p >> 6) & 1; this.M = (p >> 5) & 1; this.XF = (p >> 4) & 1;
      this.Dec = (p >> 3) & 1; this.I = (p >> 2) & 1; this.Z = (p >> 1) & 1; this.C = p & 1;
      if (this.E) { this.M = 1; this.XF = 1; }
      if (this.XF) { this.X &= 0xFF; this.Y &= 0xFF; }
    }

    // ---------- addressing (return effective address; this.w = bank-0 wrap for 16-bit) ----------
    dpBase(off) {
      if (this.D & 0xFF) this.io();
      return (this.D + off) & 0xFFFF;
    }
    aDp() { this.w = true; return this.dpBase(this.fetch()); }
    aDpX() {
      const o = this.fetch(); this.io(); this.w = true;
      if (this.E && (this.D & 0xFF) === 0) return (this.D & 0xFF00) | ((o + this.X) & 0xFF);
      return this.dpBase((o + this.X) & 0xFFFF);
    }
    aDpY() {
      const o = this.fetch(); this.io(); this.w = true;
      if (this.E && (this.D & 0xFF) === 0) return (this.D & 0xFF00) | ((o + this.Y) & 0xFF);
      return this.dpBase((o + this.Y) & 0xFFFF);
    }
    aInd() { const p = this.dpBase(this.fetch()); this.w = false; return (this.DB << 16) | this.rd16(p, true); }
    aIndX() {
      const o = this.fetch(); this.io();
      const p = this.dpBase((o + this.X) & 0xFFFF); this.w = false;
      return (this.DB << 16) | this.rd16(p, true);
    }
    aIndY() {
      const p = this.dpBase(this.fetch()); const b = this.rd16(p, true); this.w = false;
      if (!this.XF || ((b & 0xFF) + this.Y) > 0xFF) this.io();
      return (((this.DB << 16) | b) + this.Y) & 0xFFFFFF;
    }
    aIndL() {
      const p = this.dpBase(this.fetch()); this.w = false;
      const l = this.rd16(p, true); return l | (this.rd((p + 2) & 0xFFFF) << 16);
    }
    aIndLY() {
      const p = this.dpBase(this.fetch()); this.w = false;
      const l = this.rd16(p, true) | (this.rd((p + 2) & 0xFFFF) << 16);
      return (l + this.Y) & 0xFFFFFF;
    }
    aAbs() { this.w = false; return (this.DB << 16) | this.fetch16(); }
    aAbsX() {
      const b = this.fetch16(); this.w = false;
      if (!this.XF || ((b & 0xFF) + this.X) > 0xFF) this.io();
      return (((this.DB << 16) | b) + this.X) & 0xFFFFFF;
    }
    aAbsXw() { const b = this.fetch16(); this.w = false; this.io(); return (((this.DB << 16) | b) + this.X) & 0xFFFFFF; }
    aAbsY() {
      const b = this.fetch16(); this.w = false;
      if (!this.XF || ((b & 0xFF) + this.Y) > 0xFF) this.io();
      return (((this.DB << 16) | b) + this.Y) & 0xFFFFFF;
    }
    aAbsYw() { const b = this.fetch16(); this.w = false; this.io(); return (((this.DB << 16) | b) + this.Y) & 0xFFFFFF; }
    aLong() { this.w = false; return this.fetch24(); }
    aLongX() { this.w = false; return (this.fetch24() + this.X) & 0xFFFFFF; }
    aSr() { const o = this.fetch(); this.io(); this.w = true; return (this.S + o) & 0xFFFF; }
    aSrY() {
      const o = this.fetch(); this.io();
      const b = this.rd16((this.S + o) & 0xFFFF, true); this.io(); this.w = false;
      return (((this.DB << 16) | b) + this.Y) & 0xFFFFFF;
    }

    // ---------- flag helpers ----------
    nz8(v) { this.N = (v >> 7) & 1; this.Z = (v & 0xFF) === 0 ? 1 : 0; }
    nz16(v) { this.N = (v >> 15) & 1; this.Z = (v & 0xFFFF) === 0 ? 1 : 0; }
    setA(v) { if (this.M) { this.A = (this.A & 0xFF00) | (v & 0xFF); this.nz8(v); } else { this.A = v & 0xFFFF; this.nz16(v); } }
    setX(v) { if (this.XF) { this.X = v & 0xFF; this.nz8(v); } else { this.X = v & 0xFFFF; this.nz16(v); } }
    setY(v) { if (this.XF) { this.Y = v & 0xFF; this.nz8(v); } else { this.Y = v & 0xFFFF; this.nz16(v); } }

    // read operand of accumulator size at address
    rdM(a) { return this.M ? this.rd(a) : this.rd16(a, this.w); }
    wrM(a, v) { if (this.M) this.wr(a, v); else this.wr16(a, v, this.w); }
    rdX(a) { return this.XF ? this.rd(a) : this.rd16(a, this.w); }
    wrX(a, v) { if (this.XF) this.wr(a, v); else this.wr16(a, v, this.w); }
    immM() { return this.M ? this.fetch() : this.fetch16(); }
    immX() { return this.XF ? this.fetch() : this.fetch16(); }

    // ---------- ALU ----------
    adc(v) {
      if (this.M) {
        const a = this.A & 0xFF; let r;
        if (!this.Dec) {
          r = a + v + this.C;
          this.V = (~(a ^ v) & (a ^ r) & 0x80) ? 1 : 0;
        } else {
          r = (a & 0x0F) + (v & 0x0F) + this.C;
          if (r > 0x09) r += 0x06;
          const c = r > 0x0F ? 1 : 0;
          r = (a & 0xF0) + (v & 0xF0) + (c << 4) + (r & 0x0F);
          this.V = (~(a ^ v) & (a ^ r) & 0x80) ? 1 : 0;
          if (r > 0x9F) r += 0x60;
        }
        this.C = r > 0xFF ? 1 : 0;
        this.A = (this.A & 0xFF00) | (r & 0xFF); this.nz8(r);
      } else {
        const a = this.A; let r;
        if (!this.Dec) {
          r = a + v + this.C;
          this.V = (~(a ^ v) & (a ^ r) & 0x8000) ? 1 : 0;
        } else {
          r = (a & 0x000F) + (v & 0x000F) + this.C;
          if (r > 0x0009) r += 0x0006;
          let c = r > 0x000F ? 1 : 0;
          r = (a & 0x00F0) + (v & 0x00F0) + (c << 4) + (r & 0x000F);
          if (r > 0x009F) r += 0x0060;
          c = r > 0x00FF ? 1 : 0;
          r = (a & 0x0F00) + (v & 0x0F00) + (c << 8) + (r & 0x00FF);
          if (r > 0x09FF) r += 0x0600;
          c = r > 0x0FFF ? 1 : 0;
          r = (a & 0xF000) + (v & 0xF000) + (c << 12) + (r & 0x0FFF);
          this.V = (~(a ^ v) & (a ^ r) & 0x8000) ? 1 : 0;
          if (r > 0x9FFF) r += 0x6000;
        }
        this.C = r > 0xFFFF ? 1 : 0;
        this.A = r & 0xFFFF; this.nz16(r);
      }
    }
    sbc(v) {
      if (this.M) {
        const a = this.A & 0xFF; v = ~v & 0xFF; let r;
        if (!this.Dec) {
          r = a + v + this.C;
          this.V = (~(a ^ v) & (a ^ r) & 0x80) ? 1 : 0;
        } else {
          r = (a & 0x0F) + (v & 0x0F) + this.C;
          if (r <= 0x0F) r -= 0x06;
          const c = r > 0x0F ? 1 : 0;
          r = (a & 0xF0) + (v & 0xF0) + (c << 4) + (r & 0x0F);
          this.V = (~(a ^ v) & (a ^ r) & 0x80) ? 1 : 0;
          if (r <= 0xFF) r -= 0x60;
        }
        this.C = r > 0xFF ? 1 : 0;
        this.A = (this.A & 0xFF00) | (r & 0xFF); this.nz8(r);
      } else {
        const a = this.A; v = ~v & 0xFFFF; let r;
        if (!this.Dec) {
          r = a + v + this.C;
          this.V = (~(a ^ v) & (a ^ r) & 0x8000) ? 1 : 0;
        } else {
          r = (a & 0x000F) + (v & 0x000F) + this.C;
          if (r <= 0x000F) r -= 0x0006;
          let c = r > 0x000F ? 1 : 0;
          r = (a & 0x00F0) + (v & 0x00F0) + (c << 4) + (r & 0x000F);
          if (r <= 0x00FF) r -= 0x0060;
          c = r > 0x00FF ? 1 : 0;
          r = (a & 0x0F00) + (v & 0x0F00) + (c << 8) + (r & 0x00FF);
          if (r <= 0x0FFF) r -= 0x0600;
          c = r > 0x0FFF ? 1 : 0;
          r = (a & 0xF000) + (v & 0xF000) + (c << 12) + (r & 0x0FFF);
          this.V = (~(a ^ v) & (a ^ r) & 0x8000) ? 1 : 0;
          if (r <= 0xFFFF) r -= 0x6000;
        }
        this.C = r > 0xFFFF ? 1 : 0;
        this.A = r & 0xFFFF; this.nz16(r);
      }
    }
    cmp(reg, v, small) {
      if (small) { const r = (reg & 0xFF) - v; this.C = r >= 0 ? 1 : 0; this.nz8(r & 0xFF); }
      else { const r = (reg & 0xFFFF) - v; this.C = r >= 0 ? 1 : 0; this.nz16(r & 0xFFFF); }
    }
    bit(v, imm) {
      if (this.M) {
        this.Z = ((this.A & v) & 0xFF) === 0 ? 1 : 0;
        if (!imm) { this.N = (v >> 7) & 1; this.V = (v >> 6) & 1; }
      } else {
        this.Z = ((this.A & v) & 0xFFFF) === 0 ? 1 : 0;
        if (!imm) { this.N = (v >> 15) & 1; this.V = (v >> 14) & 1; }
      }
    }
    // shifts on a value of accumulator size
    asl(v) { if (this.M) { this.C = (v >> 7) & 1; v = (v << 1) & 0xFF; this.nz8(v); } else { this.C = (v >> 15) & 1; v = (v << 1) & 0xFFFF; this.nz16(v); } return v; }
    lsr(v) { this.C = v & 1; v >>= 1; if (this.M) this.nz8(v); else this.nz16(v); return v; }
    rol(v) { const c = this.C; if (this.M) { this.C = (v >> 7) & 1; v = ((v << 1) | c) & 0xFF; this.nz8(v); } else { this.C = (v >> 15) & 1; v = ((v << 1) | c) & 0xFFFF; this.nz16(v); } return v; }
    ror(v) { const c = this.C; this.C = v & 1; if (this.M) { v = (v >> 1) | (c << 7); this.nz8(v); } else { v = (v >> 1) | (c << 15); this.nz16(v); } return v; }
    inc(v) { if (this.M) { v = (v + 1) & 0xFF; this.nz8(v); } else { v = (v + 1) & 0xFFFF; this.nz16(v); } return v; }
    dec(v) { if (this.M) { v = (v - 1) & 0xFF; this.nz8(v); } else { v = (v - 1) & 0xFFFF; this.nz16(v); } return v; }
    rmw(a, f) { const v = this.rdM(a); this.io(); this.wrM(a, f.call(this, v)); }
    tsb(a) { const v = this.rdM(a); this.io(); this.Z = (v & this.A & (this.M ? 0xFF : 0xFFFF)) === 0 ? 1 : 0; this.wrM(a, v | this.A); }
    trb(a) { const v = this.rdM(a); this.io(); this.Z = (v & this.A & (this.M ? 0xFF : 0xFFFF)) === 0 ? 1 : 0; this.wrM(a, v & ~this.A); }

    branch(cond) {
      const o = this.fetch();
      if (cond) {
        this.io();
        const t = (this.PC + ((o << 24) >> 24)) & 0xFFFF;
        if (this.E && (t & 0xFF00) !== (this.PC & 0xFF00)) this.io();
        this.PC = t;
      }
    }

    interrupt(vecN, vecE) {
      if (!this.E) this.push8(this.PB);
      this.push16(this.PC);
      this.push8(this.E ? (this.getP() & ~0x10) : this.getP());
      this.I = 1; this.Dec = 0; this.PB = 0;
      this.PC = this.rd16(this.E ? vecE : vecN, false);
    }

    // run one instruction (or service an interrupt)
    step() {
      if (this.nmiPending) {
        this.nmiPending = false; this.waiting = false;
        this.io(); this.io();
        this.interrupt(0xFFEA, 0xFFFA);
        return;
      }
      if (this.irqLine && !this.I) {
        this.waiting = false; this.io(); this.io();
        this.interrupt(0xFFEE, 0xFFFE);
        return;
      }
      if (this.waiting && this.irqLine) this.waiting = false;    // an IRQ ends WAI even while masked
      if (this.waiting || this.stopped) { this.io(); return; }
      if (this.PC === this.bpPC && this.PB === this.bpPB) this.onBreak();
      const op = this.fetch();
      let a, v;
      switch (op) {
        // ---- ORA ----
        case 0x09: this.setA(this.A | this.immM()); break;
        case 0x05: this.setA(this.A | this.rdM(this.aDp())); break;
        case 0x15: this.setA(this.A | this.rdM(this.aDpX())); break;
        case 0x12: this.setA(this.A | this.rdM(this.aInd())); break;
        case 0x01: this.setA(this.A | this.rdM(this.aIndX())); break;
        case 0x11: this.setA(this.A | this.rdM(this.aIndY())); break;
        case 0x07: this.setA(this.A | this.rdM(this.aIndL())); break;
        case 0x17: this.setA(this.A | this.rdM(this.aIndLY())); break;
        case 0x0D: this.setA(this.A | this.rdM(this.aAbs())); break;
        case 0x1D: this.setA(this.A | this.rdM(this.aAbsX())); break;
        case 0x19: this.setA(this.A | this.rdM(this.aAbsY())); break;
        case 0x0F: this.setA(this.A | this.rdM(this.aLong())); break;
        case 0x1F: this.setA(this.A | this.rdM(this.aLongX())); break;
        case 0x03: this.setA(this.A | this.rdM(this.aSr())); break;
        case 0x13: this.setA(this.A | this.rdM(this.aSrY())); break;
        // ---- AND ----
        case 0x29: this.setA(this.A & (this.immM() | (this.M ? 0xFF00 : 0))); break;
        case 0x25: this.setA(this.A & (this.rdM(this.aDp()) | (this.M ? 0xFF00 : 0))); break;
        case 0x35: this.setA(this.A & (this.rdM(this.aDpX()) | (this.M ? 0xFF00 : 0))); break;
        case 0x32: this.setA(this.A & (this.rdM(this.aInd()) | (this.M ? 0xFF00 : 0))); break;
        case 0x21: this.setA(this.A & (this.rdM(this.aIndX()) | (this.M ? 0xFF00 : 0))); break;
        case 0x31: this.setA(this.A & (this.rdM(this.aIndY()) | (this.M ? 0xFF00 : 0))); break;
        case 0x27: this.setA(this.A & (this.rdM(this.aIndL()) | (this.M ? 0xFF00 : 0))); break;
        case 0x37: this.setA(this.A & (this.rdM(this.aIndLY()) | (this.M ? 0xFF00 : 0))); break;
        case 0x2D: this.setA(this.A & (this.rdM(this.aAbs()) | (this.M ? 0xFF00 : 0))); break;
        case 0x3D: this.setA(this.A & (this.rdM(this.aAbsX()) | (this.M ? 0xFF00 : 0))); break;
        case 0x39: this.setA(this.A & (this.rdM(this.aAbsY()) | (this.M ? 0xFF00 : 0))); break;
        case 0x2F: this.setA(this.A & (this.rdM(this.aLong()) | (this.M ? 0xFF00 : 0))); break;
        case 0x3F: this.setA(this.A & (this.rdM(this.aLongX()) | (this.M ? 0xFF00 : 0))); break;
        case 0x23: this.setA(this.A & (this.rdM(this.aSr()) | (this.M ? 0xFF00 : 0))); break;
        case 0x33: this.setA(this.A & (this.rdM(this.aSrY()) | (this.M ? 0xFF00 : 0))); break;
        // ---- EOR ----
        case 0x49: this.setA(this.A ^ this.immM()); break;
        case 0x45: this.setA(this.A ^ this.rdM(this.aDp())); break;
        case 0x55: this.setA(this.A ^ this.rdM(this.aDpX())); break;
        case 0x52: this.setA(this.A ^ this.rdM(this.aInd())); break;
        case 0x41: this.setA(this.A ^ this.rdM(this.aIndX())); break;
        case 0x51: this.setA(this.A ^ this.rdM(this.aIndY())); break;
        case 0x47: this.setA(this.A ^ this.rdM(this.aIndL())); break;
        case 0x57: this.setA(this.A ^ this.rdM(this.aIndLY())); break;
        case 0x4D: this.setA(this.A ^ this.rdM(this.aAbs())); break;
        case 0x5D: this.setA(this.A ^ this.rdM(this.aAbsX())); break;
        case 0x59: this.setA(this.A ^ this.rdM(this.aAbsY())); break;
        case 0x4F: this.setA(this.A ^ this.rdM(this.aLong())); break;
        case 0x5F: this.setA(this.A ^ this.rdM(this.aLongX())); break;
        case 0x43: this.setA(this.A ^ this.rdM(this.aSr())); break;
        case 0x53: this.setA(this.A ^ this.rdM(this.aSrY())); break;
        // ---- ADC ----
        case 0x69: this.adc(this.immM()); break;
        case 0x65: this.adc(this.rdM(this.aDp())); break;
        case 0x75: this.adc(this.rdM(this.aDpX())); break;
        case 0x72: this.adc(this.rdM(this.aInd())); break;
        case 0x61: this.adc(this.rdM(this.aIndX())); break;
        case 0x71: this.adc(this.rdM(this.aIndY())); break;
        case 0x67: this.adc(this.rdM(this.aIndL())); break;
        case 0x77: this.adc(this.rdM(this.aIndLY())); break;
        case 0x6D: this.adc(this.rdM(this.aAbs())); break;
        case 0x7D: this.adc(this.rdM(this.aAbsX())); break;
        case 0x79: this.adc(this.rdM(this.aAbsY())); break;
        case 0x6F: this.adc(this.rdM(this.aLong())); break;
        case 0x7F: this.adc(this.rdM(this.aLongX())); break;
        case 0x63: this.adc(this.rdM(this.aSr())); break;
        case 0x73: this.adc(this.rdM(this.aSrY())); break;
        // ---- SBC ----
        case 0xE9: this.sbc(this.immM()); break;
        case 0xE5: this.sbc(this.rdM(this.aDp())); break;
        case 0xF5: this.sbc(this.rdM(this.aDpX())); break;
        case 0xF2: this.sbc(this.rdM(this.aInd())); break;
        case 0xE1: this.sbc(this.rdM(this.aIndX())); break;
        case 0xF1: this.sbc(this.rdM(this.aIndY())); break;
        case 0xE7: this.sbc(this.rdM(this.aIndL())); break;
        case 0xF7: this.sbc(this.rdM(this.aIndLY())); break;
        case 0xED: this.sbc(this.rdM(this.aAbs())); break;
        case 0xFD: this.sbc(this.rdM(this.aAbsX())); break;
        case 0xF9: this.sbc(this.rdM(this.aAbsY())); break;
        case 0xEF: this.sbc(this.rdM(this.aLong())); break;
        case 0xFF: this.sbc(this.rdM(this.aLongX())); break;
        case 0xE3: this.sbc(this.rdM(this.aSr())); break;
        case 0xF3: this.sbc(this.rdM(this.aSrY())); break;
        // ---- CMP ----
        case 0xC9: this.cmp(this.A, this.immM(), this.M); break;
        case 0xC5: this.cmp(this.A, this.rdM(this.aDp()), this.M); break;
        case 0xD5: this.cmp(this.A, this.rdM(this.aDpX()), this.M); break;
        case 0xD2: this.cmp(this.A, this.rdM(this.aInd()), this.M); break;
        case 0xC1: this.cmp(this.A, this.rdM(this.aIndX()), this.M); break;
        case 0xD1: this.cmp(this.A, this.rdM(this.aIndY()), this.M); break;
        case 0xC7: this.cmp(this.A, this.rdM(this.aIndL()), this.M); break;
        case 0xD7: this.cmp(this.A, this.rdM(this.aIndLY()), this.M); break;
        case 0xCD: this.cmp(this.A, this.rdM(this.aAbs()), this.M); break;
        case 0xDD: this.cmp(this.A, this.rdM(this.aAbsX()), this.M); break;
        case 0xD9: this.cmp(this.A, this.rdM(this.aAbsY()), this.M); break;
        case 0xCF: this.cmp(this.A, this.rdM(this.aLong()), this.M); break;
        case 0xDF: this.cmp(this.A, this.rdM(this.aLongX()), this.M); break;
        case 0xC3: this.cmp(this.A, this.rdM(this.aSr()), this.M); break;
        case 0xD3: this.cmp(this.A, this.rdM(this.aSrY()), this.M); break;
        // ---- CPX / CPY ----
        case 0xE0: this.cmp(this.X, this.immX(), this.XF); break;
        case 0xE4: this.cmp(this.X, this.rdX(this.aDp()), this.XF); break;
        case 0xEC: this.cmp(this.X, this.rdX(this.aAbs()), this.XF); break;
        case 0xC0: this.cmp(this.Y, this.immX(), this.XF); break;
        case 0xC4: this.cmp(this.Y, this.rdX(this.aDp()), this.XF); break;
        case 0xCC: this.cmp(this.Y, this.rdX(this.aAbs()), this.XF); break;
        // ---- BIT ----
        case 0x89: this.bit(this.immM(), true); break;
        case 0x24: this.bit(this.rdM(this.aDp()), false); break;
        case 0x34: this.bit(this.rdM(this.aDpX()), false); break;
        case 0x2C: this.bit(this.rdM(this.aAbs()), false); break;
        case 0x3C: this.bit(this.rdM(this.aAbsX()), false); break;
        // ---- LDA ----
        case 0xA9: this.setA(this.immM()); break;
        case 0xA5: this.setA(this.rdM(this.aDp())); break;
        case 0xB5: this.setA(this.rdM(this.aDpX())); break;
        case 0xB2: this.setA(this.rdM(this.aInd())); break;
        case 0xA1: this.setA(this.rdM(this.aIndX())); break;
        case 0xB1: this.setA(this.rdM(this.aIndY())); break;
        case 0xA7: this.setA(this.rdM(this.aIndL())); break;
        case 0xB7: this.setA(this.rdM(this.aIndLY())); break;
        case 0xAD: this.setA(this.rdM(this.aAbs())); break;
        case 0xBD: this.setA(this.rdM(this.aAbsX())); break;
        case 0xB9: this.setA(this.rdM(this.aAbsY())); break;
        case 0xAF: this.setA(this.rdM(this.aLong())); break;
        case 0xBF: this.setA(this.rdM(this.aLongX())); break;
        case 0xA3: this.setA(this.rdM(this.aSr())); break;
        case 0xB3: this.setA(this.rdM(this.aSrY())); break;
        // ---- LDX / LDY ----
        case 0xA2: this.setX(this.immX()); break;
        case 0xA6: this.setX(this.rdX(this.aDp())); break;
        case 0xB6: this.setX(this.rdX(this.aDpY())); break;
        case 0xAE: this.setX(this.rdX(this.aAbs())); break;
        case 0xBE: this.setX(this.rdX(this.aAbsY())); break;
        case 0xA0: this.setY(this.immX()); break;
        case 0xA4: this.setY(this.rdX(this.aDp())); break;
        case 0xB4: this.setY(this.rdX(this.aDpX())); break;
        case 0xAC: this.setY(this.rdX(this.aAbs())); break;
        case 0xBC: this.setY(this.rdX(this.aAbsX())); break;
        // ---- STA ----
        case 0x85: this.wrM(this.aDp(), this.A); break;
        case 0x95: this.wrM(this.aDpX(), this.A); break;
        case 0x92: this.wrM(this.aInd(), this.A); break;
        case 0x81: this.wrM(this.aIndX(), this.A); break;
        case 0x91: a = this.aIndY(); this.wrM(a, this.A); break;
        case 0x87: this.wrM(this.aIndL(), this.A); break;
        case 0x97: this.wrM(this.aIndLY(), this.A); break;
        case 0x8D: this.wrM(this.aAbs(), this.A); break;
        case 0x9D: this.wrM(this.aAbsXw(), this.A); break;
        case 0x99: this.wrM(this.aAbsYw(), this.A); break;
        case 0x8F: this.wrM(this.aLong(), this.A); break;
        case 0x9F: this.wrM(this.aLongX(), this.A); break;
        case 0x83: this.wrM(this.aSr(), this.A); break;
        case 0x93: this.wrM(this.aSrY(), this.A); break;
        // ---- STX / STY / STZ ----
        case 0x86: this.wrX(this.aDp(), this.X); break;
        case 0x96: this.wrX(this.aDpY(), this.X); break;
        case 0x8E: this.wrX(this.aAbs(), this.X); break;
        case 0x84: this.wrX(this.aDp(), this.Y); break;
        case 0x94: this.wrX(this.aDpX(), this.Y); break;
        case 0x8C: this.wrX(this.aAbs(), this.Y); break;
        case 0x64: this.wrM(this.aDp(), 0); break;
        case 0x74: this.wrM(this.aDpX(), 0); break;
        case 0x9C: this.wrM(this.aAbs(), 0); break;
        case 0x9E: this.wrM(this.aAbsXw(), 0); break;
        // ---- shifts / inc / dec ----
        case 0x0A: this.io(); v = this.asl(this.M ? this.A & 0xFF : this.A); this.A = this.M ? (this.A & 0xFF00) | v : v; break;
        case 0x4A: this.io(); v = this.lsr(this.M ? this.A & 0xFF : this.A); this.A = this.M ? (this.A & 0xFF00) | v : v; break;
        case 0x2A: this.io(); v = this.rol(this.M ? this.A & 0xFF : this.A); this.A = this.M ? (this.A & 0xFF00) | v : v; break;
        case 0x6A: this.io(); v = this.ror(this.M ? this.A & 0xFF : this.A); this.A = this.M ? (this.A & 0xFF00) | v : v; break;
        case 0x1A: this.io(); v = this.inc(this.M ? this.A & 0xFF : this.A); this.A = this.M ? (this.A & 0xFF00) | v : v; break;
        case 0x3A: this.io(); v = this.dec(this.M ? this.A & 0xFF : this.A); this.A = this.M ? (this.A & 0xFF00) | v : v; break;
        case 0x06: this.rmw(this.aDp(), this.asl); break;
        case 0x16: this.rmw(this.aDpX(), this.asl); break;
        case 0x0E: this.rmw(this.aAbs(), this.asl); break;
        case 0x1E: this.rmw(this.aAbsXw(), this.asl); break;
        case 0x46: this.rmw(this.aDp(), this.lsr); break;
        case 0x56: this.rmw(this.aDpX(), this.lsr); break;
        case 0x4E: this.rmw(this.aAbs(), this.lsr); break;
        case 0x5E: this.rmw(this.aAbsXw(), this.lsr); break;
        case 0x26: this.rmw(this.aDp(), this.rol); break;
        case 0x36: this.rmw(this.aDpX(), this.rol); break;
        case 0x2E: this.rmw(this.aAbs(), this.rol); break;
        case 0x3E: this.rmw(this.aAbsXw(), this.rol); break;
        case 0x66: this.rmw(this.aDp(), this.ror); break;
        case 0x76: this.rmw(this.aDpX(), this.ror); break;
        case 0x6E: this.rmw(this.aAbs(), this.ror); break;
        case 0x7E: this.rmw(this.aAbsXw(), this.ror); break;
        case 0xE6: this.rmw(this.aDp(), this.inc); break;
        case 0xF6: this.rmw(this.aDpX(), this.inc); break;
        case 0xEE: this.rmw(this.aAbs(), this.inc); break;
        case 0xFE: this.rmw(this.aAbsXw(), this.inc); break;
        case 0xC6: this.rmw(this.aDp(), this.dec); break;
        case 0xD6: this.rmw(this.aDpX(), this.dec); break;
        case 0xCE: this.rmw(this.aAbs(), this.dec); break;
        case 0xDE: this.rmw(this.aAbsXw(), this.dec); break;
        case 0x04: this.tsb(this.aDp()); break;
        case 0x0C: this.tsb(this.aAbs()); break;
        case 0x14: this.trb(this.aDp()); break;
        case 0x1C: this.trb(this.aAbs()); break;
        case 0xE8: this.io(); this.setX(this.X + 1); break;
        case 0xC8: this.io(); this.setY(this.Y + 1); break;
        case 0xCA: this.io(); this.setX(this.X - 1); break;
        case 0x88: this.io(); this.setY(this.Y - 1); break;
        // ---- branches ----
        case 0x10: this.branch(!this.N); break;
        case 0x30: this.branch(this.N); break;
        case 0x50: this.branch(!this.V); break;
        case 0x70: this.branch(this.V); break;
        case 0x90: this.branch(!this.C); break;
        case 0xB0: this.branch(this.C); break;
        case 0xD0: this.branch(!this.Z); break;
        case 0xF0: this.branch(this.Z); break;
        case 0x80: this.branch(true); break;
        case 0x82: v = this.fetch16(); this.io(); this.PC = (this.PC + v) & 0xFFFF; break;
        // ---- jumps / calls ----
        case 0x4C: this.PC = this.fetch16(); break;
        case 0x5C: v = this.fetch24(); this.PC = v & 0xFFFF; this.PB = v >> 16; break;
        case 0x6C: a = this.fetch16(); this.PC = this.rd16(a, true); break;
        case 0x7C: a = this.fetch16(); this.io(); this.PC = this.rd16((this.PB << 16) | ((a + this.X) & 0xFFFF), false); break;
        case 0xDC: a = this.fetch16(); v = this.rd16(a, true); this.PB = this.rd((a + 2) & 0xFFFF); this.PC = v; break;
        case 0x20: a = this.fetch16(); this.io(); this.push16((this.PC - 1) & 0xFFFF); this.PC = a; break;
        case 0xFC: {
          a = this.fetch16();                        // return address = last operand byte
          this.push16n((this.PC - 1) & 0xFFFF); this.io();
          this.PC = this.rd16((this.PB << 16) | ((a + this.X) & 0xFFFF), false);
          this.fixStackE();
          break;
        }
        case 0x22: {
          const lo = this.fetch16(); this.push8n(this.PB); this.io();
          const bk = this.fetch(); this.push16n((this.PC - 1) & 0xFFFF);
          this.PB = bk; this.PC = lo; this.fixStackE();
          break;
        }
        case 0x60: this.io(); this.io(); this.PC = (this.pull16() + 1) & 0xFFFF; this.io(); break;
        case 0x6B: this.io(); this.io(); this.PC = (this.pull16n() + 1) & 0xFFFF; this.PB = this.pull8n(); this.fixStackE(); break;
        case 0x40:
          this.io(); this.io();
          this.setP(this.pull8());
          this.PC = this.pull16();
          if (!this.E) this.PB = this.pull8();
          break;
        case 0x00: this.fetch(); this.interrupt(0xFFE6, 0xFFFE); break;
        case 0x02: this.fetch(); this.interrupt(0xFFE4, 0xFFF4); break;
        // ---- stack ----
        case 0x48: this.io(); if (this.M) this.push8(this.A); else this.push16(this.A); break;
        case 0xDA: this.io(); if (this.XF) this.push8(this.X); else this.push16(this.X); break;
        case 0x5A: this.io(); if (this.XF) this.push8(this.Y); else this.push16(this.Y); break;
        case 0x08: this.io(); this.push8(this.getP()); break;
        case 0x8B: this.io(); this.push8(this.DB); break;
        case 0x0B: this.io(); this.push16n(this.D); this.fixStackE(); break;
        case 0x4B: this.io(); this.push8(this.PB); break;
        case 0x68: this.io(); this.io(); this.setA(this.M ? this.pull8() : this.pull16()); break;
        case 0xFA: this.io(); this.io(); this.setX(this.XF ? this.pull8() : this.pull16()); break;
        case 0x7A: this.io(); this.io(); this.setY(this.XF ? this.pull8() : this.pull16()); break;
        case 0x28: this.io(); this.io(); this.setP(this.pull8()); break;
        case 0xAB: this.io(); this.io(); this.DB = this.pull8n(); this.fixStackE(); this.nz8(this.DB); break;
        case 0x2B: this.io(); this.io(); this.D = this.pull16n(); this.fixStackE(); this.nz16(this.D); break;
        case 0xF4: v = this.fetch16(); this.push16n(v); this.fixStackE(); break;
        case 0xD4: a = this.dpBase(this.fetch()); v = this.rd16(a, true); this.push16n(v); this.fixStackE(); break;
        case 0x62: v = this.fetch16(); this.io(); this.push16n((this.PC + v) & 0xFFFF); this.fixStackE(); break;
        // ---- transfers ----
        case 0xAA: this.io(); this.setX(this.A); break;
        case 0xA8: this.io(); this.setY(this.A); break;
        case 0x8A: this.io(); this.setA(this.X); break;
        case 0x98: this.io(); this.setA(this.Y); break;
        case 0xBA: this.io(); this.setX(this.S); break;
        case 0x9A: this.io(); this.S = this.E ? 0x0100 | (this.X & 0xFF) : this.X; break;
        case 0x9B: this.io(); this.setY(this.X); break;   // TXY
        case 0xBB: this.io(); this.setX(this.Y); break;   // TYX
        case 0x5B: this.io(); this.D = this.A; this.nz16(this.D); break;
        case 0x7B: this.io(); this.A = this.D; this.nz16(this.A); break;
        case 0x1B: this.io(); this.S = this.E ? 0x0100 | (this.A & 0xFF) : this.A; break;
        case 0x3B: this.io(); this.A = this.S; this.nz16(this.A); break;
        case 0xEB: this.io(); this.io(); this.A = ((this.A >> 8) | (this.A << 8)) & 0xFFFF; this.nz8(this.A & 0xFF); break;
        case 0xFB: {
          this.io();
          const c = this.C; this.C = this.E; this.E = c;
          if (this.E) { this.M = 1; this.XF = 1; this.X &= 0xFF; this.Y &= 0xFF; this.S = 0x0100 | (this.S & 0xFF); }
          break;
        }
        // ---- flags ----
        case 0x18: this.io(); this.C = 0; break;
        case 0x38: this.io(); this.C = 1; break;
        case 0x58: this.io(); this.I = 0; break;
        case 0x78: this.io(); this.I = 1; break;
        case 0xD8: this.io(); this.Dec = 0; break;
        case 0xF8: this.io(); this.Dec = 1; break;
        case 0xB8: this.io(); this.V = 0; break;
        case 0xC2: v = this.fetch(); this.io(); this.setP(this.getP() & ~v); break;
        case 0xE2: v = this.fetch(); this.io(); this.setP(this.getP() | v); break;
        // ---- block moves ----
        case 0x54: case 0x44: {
          const dst = this.fetch(), src = this.fetch();
          this.DB = dst;
          v = this.rd((src << 16) | this.X);
          this.wr((dst << 16) | this.Y, v);
          this.io(); this.io();
          const d = op === 0x54 ? 1 : -1;
          if (this.XF) { this.X = (this.X + d) & 0xFF; this.Y = (this.Y + d) & 0xFF; }
          else { this.X = (this.X + d) & 0xFFFF; this.Y = (this.Y + d) & 0xFFFF; }
          this.A = (this.A - 1) & 0xFFFF;
          if (this.A !== 0xFFFF) this.PC = (this.PC - 3) & 0xFFFF;
          break;
        }
        // ---- misc ----
        case 0xEA: this.io(); break;
        case 0x42: this.fetch(); break;
        case 0xCB: this.io(); this.io(); this.waiting = true; break;
        case 0xDB: this.io(); this.io(); this.stopped = true; break;
        default:
          throw new Error('unknown opcode ' + op.toString(16));
      }
    }
  }

  globalThis.KICPU = CPU;
})();
