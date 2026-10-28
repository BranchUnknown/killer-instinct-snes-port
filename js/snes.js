// System: HiROM/FastROM memory map, CPU I/O registers, DMA/HDMA, joypads, scanline scheduler.
(function () {
  'use strict';
  const LINE = 1364, LINES = 262, HDMA_H = 1104;

  class SNES {
    constructor(rom, opts) {
      opts = opts || {};
      this.rom = rom;                       // Uint8Array, 4 MB
      // battery RAM from the header ($FFD8 = log2 KB); HiROM: banks $20-$3F/$A0-$BF, $6000-$7FFF
      const sc = rom[0xFFD8];
      this.sram = sc > 0 && sc < 8 ? (opts.sram && opts.sram.length === (1024 << sc) ? opts.sram : new Uint8Array(1024 << sc)) : null;
      this.sramMask = this.sram ? this.sram.length - 1 : 0;
      this.sramDirty = false;
      this.msu = opts.msu || null;          // KIMSU1 or null
      this.wram = new Uint8Array(0x20000);
      this.ppu = new KIPPU();
      this.ppu.wramRef = this.wram;
      this.apu = new KIAPU({ lle: !!opts.lle, msu: this.msu });
      this.cpu = new KICPU(this);
      this.cycles = 0;                      // master cycles in the current line
      this.total = 0;                       // master cycles since power-on (before this line)
      this.dma = [];
      for (let i = 0; i < 8; i++) this.dma.push({
        ctrl: 0xFF, bAddr: 0xFF, aAddr: 0xFFFF, aBank: 0xFF, count: 0xFFFF, indBank: 0xFF,
        table: 0xFFFF, lineCnt: 0xFF, unused: 0xFF, doTransfer: false, terminated: false,
      });
      this.pads = [0, 0];                   // current button state (SNES bit order, 16 bits)
      this.ppu.hvSource = () => [Math.floor(this.cycles / 4), this.vcount];
      this.reset();
    }

    reset() {
      this.wram.fill(0);
      this.nmitimen = 0; this.rdnmi = false; this.wrio = 0xFF;
      this.mulA = 0xFF; this.mulB = 0xFF; this.divA = 0xFFFF; this.rdmpy = 0; this.rddiv = 0;
      this.htime = 0x1FF; this.vtime = 0x1FF; this.timeup = false; this.irqAt = Infinity;
      this.mdmaen = 0; this.hdmaen = 0; this.memsel = 0;
      this.joy = [0, 0, 0, 0];
      this.latch = 0; this.ser = [0, 0];
      this.wramAddr = 0;
      this.mdr = 0;
      this.vcount = 0; this.inVblank = false; this.autoJoyBusy = 0;
      this.frameCount = 0;
      this.ppu.reset();
      this.apu.reset();
      if (this.msu) this.msu.reset();
      this.cpu.reset();
    }

    now() { return this.total + this.cycles; }

    // ---------------- memory ----------------
    speed(bank, addr) {
      if (bank & 0x40) {
        if ((bank & 0xFE) === 0x7E) return 8;
        return (bank & 0x80) && (this.memsel & 1) ? 6 : 8;
      }
      if (addr & 0x8000) return (bank & 0x80) && (this.memsel & 1) ? 6 : 8;
      if (addr < 0x2000) return 8;
      if (addr < 0x4000) return 6;
      if (addr < 0x4200) return 12;
      if (addr < 0x6000) return 6;
      return 8;
    }

    read(a) {
      const bank = a >> 16, addr = a & 0xFFFF;
      this.cycles += this.speed(bank, addr);
      let v;
      if ((bank & 0xFE) === 0x7E) v = this.wram[a & 0x1FFFF];
      else if (bank & 0x40) v = this.rom[((bank & 0x3F) << 16) | addr];
      else if (addr & 0x8000) v = this.rom[((bank & 0x3F) << 16) | addr];
      else if (addr < 0x2000) v = this.wram[addr];
      else if (addr >= 0x6000) v = this.sram && (bank & 0x60) === 0x20 ? this.sram[(addr - 0x6000) & this.sramMask] : this.mdr;
      else if (this.msu && addr < 0x2008) v = this.msu.read(addr);
      else v = this.readIO(addr);
      this.mdr = v;
      return v;
    }
    write(a, v) {
      const bank = a >> 16, addr = a & 0xFFFF;
      this.cycles += this.speed(bank, addr);
      this.mdr = v;
      if ((bank & 0xFE) === 0x7E) { this.wram[a & 0x1FFFF] = v; return; }
      if (bank & 0x40) return;
      if (addr & 0x8000) return;
      if (addr < 0x2000) { this.wram[addr] = v; return; }
      if (addr >= 0x6000) {
        if (this.sram && (bank & 0x60) === 0x20) { const i = (addr - 0x6000) & this.sramMask; if (this.sram[i] !== v) { this.sram[i] = v; this.sramDirty = true; } }
        return;
      }
      if (this.msu && addr < 0x2008) { this.msu.write(addr, v); return; }
      this.writeIO(addr, v);
    }

    // B-bus (used by the CPU at $21xx and by DMA)
    readB(r) {
      if (r >= 0x40 && r < 0x80) return this.apu.cpuRead(r & 3, this.now());
      if (r === 0x80) { const v = this.wram[this.wramAddr]; this.wramAddr = (this.wramAddr + 1) & 0x1FFFF; return v; }
      if (r >= 0x34 && r < 0x40) return this.ppu.read(r, this.mdr);
      return this.mdr;
    }
    writeB(r, v) {
      if (r < 0x34) { this.ppu.write(r, v); return; }
      if (r >= 0x40 && r < 0x80) { this.apu.cpuWrite(r & 3, v, this.now()); return; }
      switch (r) {
        case 0x80: this.wram[this.wramAddr] = v; this.wramAddr = (this.wramAddr + 1) & 0x1FFFF; break;
        case 0x81: this.wramAddr = (this.wramAddr & 0x1FF00) | v; break;
        case 0x82: this.wramAddr = (this.wramAddr & 0x100FF) | (v << 8); break;
        case 0x83: this.wramAddr = (this.wramAddr & 0x0FFFF) | ((v & 1) << 16); break;
      }
    }

    readIO(addr) {
      if (addr >= 0x2100 && addr < 0x2200) return this.readB(addr & 0xFF);
      if (addr === 0x4016) { const v = (this.mdr & 0xFC) | (this.serialBit(0)); return v; }
      if (addr === 0x4017) { const v = (this.mdr & 0xE0) | 0x1C | (this.serialBit(1)); return v; }
      if (addr >= 0x4300 && addr < 0x4380) return this.readDMA(addr);
      switch (addr) {
        case 0x4210: { const v = (this.rdnmi ? 0x80 : 0) | (this.mdr & 0x70) | 0x02; this.rdnmi = false; return v; }
        case 0x4211: { const v = (this.timeup ? 0x80 : 0) | (this.mdr & 0x7F); this.timeup = false; this.cpu.irqLine = false; return v; }
        case 0x4212: {
          const h = this.cycles;
          return (this.inVblank ? 0x80 : 0) | ((h >= 1096 || h < 16) ? 0x40 : 0) | (this.autoJoyBusy > 0 ? 1 : 0) | (this.mdr & 0x3E);
        }
        case 0x4213: return this.wrio;
        case 0x4214: return this.rddiv & 0xFF;
        case 0x4215: return this.rddiv >> 8;
        case 0x4216: return this.rdmpy & 0xFF;
        case 0x4217: return this.rdmpy >> 8;
        case 0x4218: return this.joy[0] & 0xFF;
        case 0x4219: return this.joy[0] >> 8;
        case 0x421A: return this.joy[1] & 0xFF;
        case 0x421B: return this.joy[1] >> 8;
        case 0x421C: case 0x421D: case 0x421E: case 0x421F: return 0;
      }
      return this.mdr;
    }
    writeIO(addr, v) {
      if (addr >= 0x2100 && addr < 0x2200) { this.writeB(addr & 0xFF, v); return; }
      if (addr === 0x4016) {
        const nl = v & 1;
        if (this.latch && !nl) { this.ser[0] = this.pads[0]; this.ser[1] = this.pads[1]; }
        this.latch = nl;
        if (nl) { this.ser[0] = this.pads[0]; this.ser[1] = this.pads[1]; }
        return;
      }
      if (addr >= 0x4300 && addr < 0x4380) { this.writeDMA(addr, v); return; }
      switch (addr) {
        case 0x4200: {
          const old = this.nmitimen; this.nmitimen = v;
          if (!(old & 0x80) && (v & 0x80) && this.rdnmi && this.inVblank) this.cpu.nmiPending = true;
          if (!(v & 0x30)) { this.timeup = false; this.cpu.irqLine = false; }
          this.irqArm();
          break;
        }
        case 0x4201: this.wrio = v; break;
        case 0x4202: this.mulA = v; break;
        case 0x4203: this.mulB = v; this.rdmpy = this.mulA * v; this.rddiv = v; break;
        case 0x4204: this.divA = (this.divA & 0xFF00) | v; break;
        case 0x4205: this.divA = (this.divA & 0x00FF) | (v << 8); break;
        case 0x4206:
          if (v === 0) { this.rddiv = 0xFFFF; this.rdmpy = this.divA; }
          else { this.rddiv = Math.floor(this.divA / v); this.rdmpy = this.divA % v; }
          break;
        case 0x4207: this.htime = (this.htime & 0x100) | v; this.irqArm(); break;
        case 0x4208: this.htime = (this.htime & 0xFF) | ((v & 1) << 8); this.irqArm(); break;
        case 0x4209: this.vtime = (this.vtime & 0x100) | v; this.irqArm(); break;
        case 0x420A: this.vtime = (this.vtime & 0xFF) | ((v & 1) << 8); this.irqArm(); break;
        case 0x420B: this.mdmaen = v; if (v) this.runDMA(v); break;
        case 0x420C: this.hdmaen = v; break;
        case 0x420D: this.memsel = v & 1; break;
      }
    }
    serialBit(p) {
      if (this.latch) return (this.pads[p] >> 15) & 1;
      const b = (this.ser[p] >> 15) & 1;
      this.ser[p] = ((this.ser[p] << 1) | 1) & 0xFFFF;
      return b;
    }

    // ---------------- DMA ----------------
    readDMA(addr) {
      const c = this.dma[(addr >> 4) & 7];
      switch (addr & 0xF) {
        case 0: return c.ctrl; case 1: return c.bAddr;
        case 2: return c.aAddr & 0xFF; case 3: return c.aAddr >> 8; case 4: return c.aBank;
        case 5: return c.count & 0xFF; case 6: return c.count >> 8; case 7: return c.indBank;
        case 8: return c.table & 0xFF; case 9: return c.table >> 8; case 0xA: return c.lineCnt;
        case 0xB: case 0xF: return c.unused;
      }
      return this.mdr;
    }
    writeDMA(addr, v) {
      const c = this.dma[(addr >> 4) & 7];
      switch (addr & 0xF) {
        case 0: c.ctrl = v; break; case 1: c.bAddr = v; break;
        case 2: c.aAddr = (c.aAddr & 0xFF00) | v; break; case 3: c.aAddr = (c.aAddr & 0xFF) | (v << 8); break;
        case 4: c.aBank = v; break;
        case 5: c.count = (c.count & 0xFF00) | v; break; case 6: c.count = (c.count & 0xFF) | (v << 8); break;
        case 7: c.indBank = v; break;
        case 8: c.table = (c.table & 0xFF00) | v; break; case 9: c.table = (c.table & 0xFF) | (v << 8); break;
        case 0xA: c.lineCnt = v; break;
        case 0xB: case 0xF: c.unused = v; break;
      }
    }
    // A-bus access for DMA: no B-bus registers through the A side
    dmaReadA(a) {
      const bank = a >> 16, addr = a & 0xFFFF;
      if (!(bank & 0x40) && (addr & 0xFF00) === 0x2100) return this.mdr;
      if (!(bank & 0x40) && addr >= 0x4300 && addr < 0x4380) return this.mdr;
      const save = this.cycles; const v = this.read(a); this.cycles = save; return v;
    }
    dmaWriteA(a, v) {
      const bank = a >> 16, addr = a & 0xFFFF;
      if (!(bank & 0x40) && (addr & 0xFF00) === 0x2100) return;
      const save = this.cycles; this.write(a, v); this.cycles = save;
    }
    static pattern(mode) {
      return [[0], [0, 1], [0, 0], [0, 0, 1, 1], [0, 1, 2, 3], [0, 1, 0, 1], [0, 0], [0, 0, 1, 1]][mode & 7];
    }
    runDMA(mask) {
      this.cycles += 12;
      for (let ch = 0; ch < 8; ch++) {
        if (!(mask & (1 << ch))) continue;
        const c = this.dma[ch];
        this.cycles += 8;
        const pat = SNES.pattern(c.ctrl), toA = (c.ctrl & 0x80) !== 0;
        // widescreen: the terrain stages (8, 10) upload only the 32 visible floor tiles from the row buffer
        // $1637-$16F4 to VRAM $7820 each frame; remember where, so the side columns can use the neighbours
        if (!toA && c.bAddr === 0x18 && c.count === 0x40 && this.ppu.vaddr === 0x7820 && (c.aBank === 0 || c.aBank === 0x7E) &&
            c.aAddr >= 0x1637 && c.aAddr < 0x16F5) this.ppu.extRow = c.aAddr;
        const step = (c.ctrl & 0x08) ? 0 : (c.ctrl & 0x10) ? -1 : 1;
        let n = c.count === 0 ? 0x10000 : c.count, k = 0;
        while (n > 0) {
          const b = (c.bAddr + pat[k & (pat.length - 1)]) & 0xFF;
          const a = (c.aBank << 16) | c.aAddr;
          if (toA) this.dmaWriteA(a, this.readB(b));
          else this.writeB(b, this.dmaReadA(a));
          this.cycles += 8;
          c.aAddr = (c.aAddr + step) & 0xFFFF;
          k++; n--;
        }
        c.count = 0;
      }
      this.mdmaen = 0;
    }

    hdmaInit() {
      for (let ch = 0; ch < 8; ch++) {
        const c = this.dma[ch];
        c.doTransfer = false; c.terminated = false;
        if (!(this.hdmaen & (1 << ch))) continue;
        c.table = c.aAddr;
        this.hdmaLoadLine(c);
        this.cycles += 8;
      }
    }
    hdmaLoadLine(c) {
      c.lineCnt = this.dmaReadA((c.aBank << 16) | c.table); c.table = (c.table + 1) & 0xFFFF;
      if (c.ctrl & 0x40) {
        const lo = this.dmaReadA((c.aBank << 16) | c.table); c.table = (c.table + 1) & 0xFFFF;
        const hi = this.dmaReadA((c.aBank << 16) | c.table); c.table = (c.table + 1) & 0xFFFF;
        c.count = lo | (hi << 8);
      }
      c.terminated = c.lineCnt === 0;
      c.doTransfer = true;
    }
    hdmaRun() {
      for (let ch = 0; ch < 8; ch++) {
        const c = this.dma[ch];
        if (!(this.hdmaen & (1 << ch)) || c.terminated) continue;
        this.cycles += 8;
        if (c.doTransfer) {
          const pat = SNES.pattern(c.ctrl), ind = (c.ctrl & 0x40) !== 0, toA = (c.ctrl & 0x80) !== 0;
          for (let k = 0; k < pat.length; k++) {
            const b = (c.bAddr + pat[k]) & 0xFF;
            let a;
            if (ind) { a = (c.indBank << 16) | c.count; c.count = (c.count + 1) & 0xFFFF; }
            else { a = (c.aBank << 16) | c.table; c.table = (c.table + 1) & 0xFFFF; }
            if (toA) this.dmaWriteA(a, this.readB(b)); else this.writeB(b, this.dmaReadA(a));
            this.cycles += 8;
          }
        }
        c.lineCnt = (c.lineCnt - 1) & 0xFF;
        c.doTransfer = (c.lineCnt & 0x80) !== 0;
        if ((c.lineCnt & 0x7F) === 0) this.hdmaLoadLine(c);
      }
    }

    // ---------------- timing ----------------
    runUntil(h) {
      const cpu = this.cpu;
      while (this.cycles < h) {
        cpu.step();
        if (this.cycles >= this.irqAt) { this.irqAt = Infinity; this.timeup = true; cpu.irqLine = true; }
      }
    }
    // H/V timer IRQ ($4200 bits 4-5; not used by the original game, the MegaPatch's VS video needs it):
    // the master-cycle point in the current line where it fires, if it still lies ahead
    irqArm() {
      const m = this.nmitimen & 0x30;
      let t = Infinity;
      if (m && !((m & 0x20) && this.vcount !== this.vtime) && !((m & 0x10) && this.htime > 339)) t = (m & 0x10) ? this.htime * 4 + 14 : 10;
      this.irqAt = t > this.cycles ? t : Infinity;
    }

    // advance time for the sound only (the CPU is held, e.g. while a port menu is open)
    idleFrame() {
      this.total += LINE * LINES;
      this.apu.catchUp(this.now());
    }

    runFrame() {
      for (let v = 0; v < LINES; v++) {
        this.vcount = v;
        if (v === 0) {
          this.inVblank = false; this.rdnmi = false;
          this.hdmaInit();
        } else if (v <= 224) {
          this.ppu.renderLine(v);
        }
        if (this.nmitimen & 0x30) this.irqArm(); else this.irqAt = Infinity;
        if (v === 225) {
          this.ppu.extRow = -1;
          this.inVblank = true;
          this.ppu.vblankStart();
          this.rdnmi = true;
          if (this.nmitimen & 0x80) this.cpu.nmiPending = true;
          if (this.nmitimen & 1) { this.joy[0] = this.pads[0]; this.joy[1] = this.pads[1]; this.autoJoyBusy = 3; }
        } else if (this.autoJoyBusy > 0) this.autoJoyBusy--;
        this.runUntil(HDMA_H);
        if (v <= 224) this.hdmaRun();
        this.runUntil(LINE);
        this.cycles -= LINE;
        this.total += LINE;
      }
      this.apu.catchUp(this.now());
      this.frameCount++;
    }
  }

  globalThis.KISNES = SNES;
})();
