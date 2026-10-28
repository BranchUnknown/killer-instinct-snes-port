// APU side: the four CPU<->APU ports, the boot ROM / upload-loader protocol and KI's driver
// (js/driver.js), all native; the S-DSP (js/dsp.js) makes the 32 kHz output.
// Time base: master clock cycles from the bus. 32000 samples/s, driver ticks every 400 samples (80 Hz).
(function () {
  'use strict';
  const MASTER = 21477272;
  const SPC = MASTER / 1024000;     // master cycles per SPC700 cycle
  // SPC-side cost of one handshake step (cycle counts of the real loops)
  const LAT_IPL = 18 * SPC;         // boot ROM byte loop (25 cycles a byte, measured on kispc, minus CPU overlap)
  const LAT_LOADER = 41 * SPC;      // KI loader word loop $0531..$0548 (45 cycles a word, measured)
  const LAT_DRIVER = 30 * SPC;      // driver poll ($0691..)

  class APU {
    constructor(opts) {
      opts = opts || {};
      this.lleMode = !!opts.lle;          // run the uploaded SPC700 program (Arcade MegaPatch)
      this.msu = opts.msu || null;
      this.mixBuf = new Float32Array(2);
      this.ram = new Uint8Array(65536);
      this.dsp = new KIDSP(this.ram);
      this.driver = new KIDriver(this.ram, (r, v) => this.dsp.write(r, v));
      this.inP = new Uint8Array(4);
      this.outP = new Uint8Array(4);
      this.reset();
      this.ring = new Float32Array(32768 * 2);   // stereo output ring
      this.rHead = 0; this.rTail = 0;
      this.mutedOutput = false;
      this.LAT = LAT_IPL;
      this.busyUntil = 0;      // master time until which the SPC is busy (memory clears, timer waits)
    }
    reset() {
      this.ram.fill(0);
      this.dsp.reset();
      this.outP.set([0xAA, 0xBB, 0, 0]); this.inP.fill(0);
      this.state = 'ipl'; this.iplIdx = 0; this.iplAddr = 0; this.iplActive = false; this.lastIn0 = 0;
      this.ldX = 0; this.ldStage = 0; this.ldDest = 0; this.ldCount = 0;
      this.samples = 0;        // samples generated
      this.lastWrite = 0;      // master time of the last CPU port write
      this.pending = false;    // CPU input not yet seen by the SPC
      this.later = null;       // [time, fn]: a delayed SPC-side action
      this.tickLeft = 400; this.timerOn = false; this.tickPending = false;
      this.pollNow = true;     // driver polls continuously until it starts ticking
    }

    // ---------- CPU side ----------
    cpuWrite(port, v, now) {
      this.catchUp(now);
      if (this.state === 'lle') { this.inP[port & 3] = v; return; }
      this.inP[port & 3] = v;
      this.lastWrite = now; this.pending = true;
    }
    cpuRead(port, now) {
      this.catchUp(now);
      return this.outP[port & 3];
    }

    // advance APU time to master cycle 'now'
    catchUp(now) {
      if (this.later && now >= this.later[0]) { const f = this.later[1]; this.later = null; f(); }
      const target = Math.floor(now * 32000 / MASTER);
      while (this.samples < target) {
        this.sampleStep();
        // handshake steps that need no tick
        const t = this.samples * MASTER / 32000;
        if (this.pending && this.state !== 'driverTick' && t - this.lastWrite >= this.LAT && t >= this.busyUntil) this.service();
      }
      if (this.pending && this.state !== 'driverTick' && now - this.lastWrite >= this.LAT && now >= this.busyUntil) this.service();
    }

    sampleStep() {
      if (this.state === 'lle') this.spc.run(32);
      else if (this.tickPending && this.state === 'driverTick') {
        // the timer counted while the driver was in the loader: first poll ticks at once
        this.tickPending = false;
        this.driver.tick();
        this.pollOnce();
      } else if (this.state === 'driverTick' || this.timerOn) {
        if (--this.tickLeft <= 0) {
          this.tickLeft += 400;
          if (this.state === 'driverTick') {
            this.driver.tick();
            this.pollOnce();
          } else this.tickPending = true;
        }
      }
      this.dsp.cycle();
      this.samples++;
      const i = this.rHead;
      let l = this.dsp.outL / 32768, r = this.dsp.outR / 32768;
      if (this.msu) { const m = this.mixBuf; m[0] = l; m[1] = r; this.msu.mix(m); l = m[0]; r = m[1]; }
      this.ring[i] = l; this.ring[i + 1] = r;
      this.rHead = (i + 2) & (this.ring.length - 1);
      if (this.rHead === this.rTail) this.rTail = (this.rTail + 2) & (this.ring.length - 1);
    }

    // SPC reacts to the CPU's port writes
    service() {
      if (this.state === 'lle') { this.pending = false; return; }
      switch (this.state) {
        case 'ipl': this.serviceIPL(); break;
        case 'loader': this.serviceLoader(); break;
        case 'driverPoll': this.pollOnce(); break;
      }
    }

    serviceIPL() {
      const p0 = this.inP[0];
      if (!this.iplActive) {
        if (p0 !== 0xCC) { this.pending = false; return; }
        this.iplStart(p0);
        return;
      }
      if (p0 === this.iplIdx) {
        this.ram[(this.iplAddr + this.iplIdx) & 0xFFFF] = this.inP[1];
        this.outP[0] = p0;
        this.iplIdx = (this.iplIdx + 1) & 0xFF;
        if (this.iplIdx === 0) this.iplAddr = (this.iplAddr + 256) & 0xFFFF;
        this.pending = false;
      } else if (p0 !== ((this.iplIdx - 1) & 0xFF)) {
        this.iplStart(p0);
      } else this.pending = false;
    }
    iplStart(p0) {
      const dest = this.inP[2] | (this.inP[3] << 8);
      this.outP[0] = p0;
      this.pending = false;
      if (this.inP[1] === 0 && this.iplActive) {
        this.iplActive = false;
        this.execute(dest);
        return;
      }
      this.iplActive = true; this.iplAddr = dest; this.iplIdx = 0;
    }

    execute(dest) {
      if (this.lleMode) {           // hand over to the real SPC700 at the uploaded code
        this.spc = new KISPC700(this.ram, this.dsp, { inP: this.inP, outP: this.outP });
        this.spc.pc = dest; this.spc.sp = 0xEF;
        this.state = 'lle';
        return;
      }
      if (dest === 0x04D8) {         // KI's loader: $04D8 (port 0 keeps the IPL's echo for a moment)
        this.later = [this.lastWrite + this.LAT + 400, () => { this.outP[0] = 0; }];
        this.busyUntil = this.lastWrite + (0x3000 * 13 + 48 * 10) * SPC;
        this.LAT = LAT_LOADER;
        this.ldX = 1;
        this.ram.fill(0, 0xD000, 0x10000);
        this.loaderEntry04F3();
        return;
      }
      throw new Error('APU: unexpected IPL jump to ' + dest.toString(16));
    }
    loaderEntry04F3() {
      this.dsp.write(0x6C, 0xFF); this.dsp.write(0x7D, 0); this.dsp.write(0x6D, 0xFF);
      this.ram[0xEB] = 0xFF;
      this.state = 'loader'; this.ldStage = 0;
    }

    serviceLoader() {
      const p0 = this.inP[0];
      if (p0 !== this.ldX) { this.pending = false; return; }
      const word = this.inP[1] | (this.inP[2] << 8);
      this.outP[0] = p0;
      this.ldX = (this.ldX + 1) & 0xFF;
      this.pending = false;
      if (this.ldStage === 0) { this.ldDest = word; this.ldStage = 1; return; }
      if (this.ldStage === 1) {
        this.ldCount = word;
        if (word === 0) {               // jump
          this.ram[0xE8] = this.ldX;
          this.ldStage = 0;
          this.driver.transfer(this.ldDest, null);
          this.enterDriver(this.ldDest);
          return;
        }
        this.ldStage = 2; return;
      }
      this.ram[this.ldDest & 0xFFFF] = this.inP[1];
      this.ram[(this.ldDest + 1) & 0xFFFF] = this.inP[2];
      this.ldDest = (this.ldDest + 2) & 0xFFFF;
      if (--this.ldCount === 0) this.ldStage = 0;
    }

    enterDriver(dest) {
      if (dest === 0x0672) {            // fresh start: $0680 stops timer 0, main loop
        this.timerOn = false;
        this.mainLoopTop();
      } else {                          // $06D9: resume (timer kept running)
        this.afterPoll();
      }
    }
    // $0683: poll; if nothing, $06D9: playing -> (re)start timer and wait for ticks
    mainLoopTop() {
      this.state = 'driverPoll';
      this.LAT = LAT_DRIVER;
      if (this.pending) this.pollOnce(); else this.afterPoll();
    }
    afterPoll() {
      if (this.ram[0x1E]) {
        if (!this.timerOn) { this.timerOn = true; this.tickLeft = 400; this.tickPending = false; }
        this.state = 'driverTick';
      } else {
        this.state = 'driverPoll';       // keeps polling
      }
    }

    // one poll of the driver main loop ($0691)
    pollOnce() {
      const e8 = this.ram[0xE8];
      if (!this.pending || this.inP[0] !== e8) {
        if (this.inP[0] !== e8) this.pending = false;
        this.afterPoll();
        return;
      }
      const cmd = this.inP[1], param = this.inP[2];
      this.outP[0] = this.inP[0];
      this.pending = false;
      const again = this.driver.command(cmd, param);
      if (this.driver.loader) {
        this.LAT = LAT_LOADER;
        if (cmd >= 0x80 && (cmd & 7) === 7 && param === 0) {
          this.timerOn = false;
          // $0730: 25 ms timer-1 wait, then clear $D700-$FFFF (13 SPC cycles a byte)
          const t = this.samples * MASTER / 32000;
          this.busyUntil = t + 0.025 * MASTER + (0x2900 * 13 + 41 * 10) * SPC;
        }
        this.ldX = this.ram[0xE8]; this.state = 'loader'; this.ldStage = 0;
        return;
      }
      if (cmd >= 0x80 && (cmd & 7) === 6) { this.timerOn = false; this.afterPoll(); return; }  // $06D3: restart timer
      if (again) { this.timerOn = false; this.mainLoopTop(); return; }
      // SFX: wait for the next tick
      if (this.ram[0x1E]) { if (!this.timerOn) { this.timerOn = true; this.tickLeft = 400; } this.state = 'driverTick'; }
      else this.state = 'driverPoll';
    }

    // pull up to n stereo frames for the audio device
    pull(out, n) {
      let got = 0;
      while (got < n && this.rTail !== this.rHead) {
        out[got * 2] = this.ring[this.rTail]; out[got * 2 + 1] = this.ring[this.rTail + 1];
        this.rTail = (this.rTail + 2) & (this.ring.length - 1);
        got++;
      }
      return got;
    }
    buffered() { return ((this.rHead - this.rTail) & (this.ring.length - 1)) >> 1; }
  }

  globalThis.KIAPU = APU;
})();
