// Stage thumbnails, made once from the player's ROM: a hidden second machine boots to the first
// fight setup, snapshots itself there, then for every stage restores the snapshot, forces the
// stage ($12F0 at $8084B1, as the stage select does) and photographs the backgrounds (sprites
// hidden, HUD rows cropped). Runs a few frames per tick in the background; cached by the caller.
(function () {
  'use strict';
  const NST = 17, AFTER = 60, TW = 256, TH = 200;

  class Thumbs {
    constructor(rom, done) {
      this.s = new KISNES(rom);
      this.done = done;
      this.phase = 'boot'; this.f = 0; this.st = 0; this.base = null; this.hit = false; this.k = 0;
      this.out = [];
      const c = this.s.cpu;
      c.bpPB = 0x80; c.bpPC = 0x84B1;
      c.onBreak = () => {
        this.hit = true;
        if (this.phase === 'stage') { this.s.wram[0x12F0] = this.st; this.s.wram[0x12F1] = 0; }
      };
    }
    // run up to n frames; returns false when finished
    step(n) {
      const s = this.s;
      for (let i = 0; i < n; i++) {
        if (this.phase === 'boot') {
          const snap = KIState.save(s);
          this.hit = false;
          this.f++;
          s.pads[0] = this.f % 60 === 30 ? 0x1000 : 0;
          s.runFrame();
          if (this.hit) { this.base = snap; this.phase = 'stage'; this.begin(); }
          else if (this.f > 6000) { this.phase = 'done'; this.done(this.out); return false; }
        } else if (this.phase === 'stage') {
          s.pads[0] = 0;
          const fight = ((s.wram[2] << 16) | (s.wram[1] << 8) | s.wram[0]) === 0x8086EE;
          if (fight && this.k === AFTER) s.ppu.hideObj = true;
          s.runFrame();
          s.ppu.hideObj = false;
          if (!fight) { if (++this.guard > 2000) { this.phase = 'done'; this.done(this.out); return false; } continue; }
          if (this.k++ === AFTER) {
            this.out[this.st] = this.shrink(s.ppu.frame);
            if (++this.st >= NST) { this.phase = 'done'; this.done(this.out); return false; }
            this.begin();
          }
        } else return false;
      }
      return true;
    }
    begin() { KIState.restore(this.s, this.base); this.k = 0; this.guard = 0; }
    // the stage below the HUD: rows 24..223 of the 256-wide frame
    shrink(fr) {
      const o = new Uint8ClampedArray(TW * TH * 4);
      for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) {
        const p = fr[(24 + y) * 256 + x], q = (y * TW + x) * 4;
        o[q] = p & 255; o[q + 1] = (p >> 8) & 255; o[q + 2] = (p >> 16) & 255; o[q + 3] = 255;
      }
      return o;
    }
  }
  Thumbs.W = TW; Thumbs.H = TH;
  globalThis.KIThumbs = Thumbs;
})();
