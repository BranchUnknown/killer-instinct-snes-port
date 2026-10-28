// Controller shortcuts for finishers, built at runtime from the fighter's own move list in WRAM
// (the decompressed character block at $7E:B000 for P1 / $7F:B000 for P2; record format in
// decomp/tools/movelist.py). Right stick: up = Humiliation, right/down/left = No Mercy 1/2/3;
// RT = Ultra, LT = Ultimate (combo enders: the game itself decides whether it is allowed).
// R3 = Combo Breaker reward (shadow moves; see frame()).
(function () {
  'use strict';
  const LOGICAL = [0x0020, 0x4000, 0x0040, 0x0010, 0x8000, 0x0080];  // QP MP FP QK MK FK (record masks)
  const PHYS = [0x0020, 0x4000, 0x0040, 0x0010, 0x8000, 0x0080];     // L Y X R B A ($83F465)
  const U = 0x0800, D = 0x0400, L = 0x0200, R = 0x0100;

  function romw(rom, a) { return rom[a] | (rom[a + 1] << 8); }

  // all finisher-gated records of player p: [{type, mask, dirs:[op,...], move}]
  function finishers(s, p) {
    const w = s.wram, base = p ? 0x10000 : 0;
    const c = w[p ? 0x1063 : 0x105F] - 1;
    if (c < 0 || c > 10) return [];
    const rb = (a) => w[base + (a & 0xFFFF)];
    const out = [];
    for (let st = 0; st < 2; st++) {
      let q = romw(s.rom, 0x0201AA + c * 8 + st * 2);
      for (let n = 0; n < 80; n++) {
        const mask = rb(q) | (rb(q + 1) << 8);
        if (!mask) break;
        const cnt = rb(q + 2), mode = rb(q + 3), hold = rb(q + 4);
        for (let k = 0; k < cnt; k++) {
          const mp = rb(q + 5 + 2 * k) | (rb(q + 6 + 2 * k) << 8);
          const len = rb(mp);
          let type = -1; const els = [];
          for (let i = 1; i + 2 < len; i += 3) {
            const op = rb(mp + i), mn = rb(mp + i + 1), mx = rb(mp + i + 2);
            if (op === 0xE9) type = mn;
            else if (op <= 8 || (op >= 11 && op <= 18)) els.push([op <= 8 ? op : op - 10, mn, op > 8]);
            else if (op === 0xE1 && mx <= 8) els.push([mx, 1, false]);
          }
          if (type >= 0 && !mode && !hold) out.push({ type, mask, els, move: rb(mp + len - 1) });
        }
        q += 5 + 2 * cnt;
      }
    }
    return out;
  }

  // frame-by-frame pad words for one finisher
  function sequence(s, p, f) {
    const w = s.wram;
    const right = (w[0x0763 + 4 * p] & 0x80) === 0;           // act_dir: +2 facing right, -2 left
    const F = right ? R : L, B = right ? L : R;
    const DIR = [0, U, U | F, F, D | F, D, D | B, B, U | B];
    let btn = 0;
    for (let k = 0; k < 6; k++) if (f.mask & LOGICAL[k]) { btn = PHYS[(w[0x0224 + 8 * p + k] >> 1) % 6]; break; }
    const seq = [0, 0];
    let last = -1;
    for (const [d, mn, charge] of f.els) {
      if (d === last && !charge) continue;
      const n = charge ? Math.max(mn + 3, 3) : Math.min(Math.max(mn + 1, 2), 4);
      for (let i = 0; i < n; i++) seq.push(DIR[d]);
      last = d;
    }
    const hold = last >= 0 ? DIR[last] : 0;
    seq.push(hold | btn, hold | btn, hold | btn, 0, 0);
    return seq;
  }

  class Macros {
    constructor() { this.run = [null, null]; this.prev = [{}, {}]; }
    // kind: 'ultra' | 'ultimate' | 'humil' | 'fin1' | 'fin2' | 'fin3'
    start(s, p, kind) {
      const all = finishers(s, p);
      let f = null;
      if (kind === 'ultra') f = all.find(x => x.type === 0);
      else if (kind === 'ultimate') f = all.find(x => x.type === 3);
      else if (kind === 'humil') f = all.find(x => x.type === 2);
      else {
        const seen = []; for (const x of all) if (x.type === 1 && !seen.some(y => y.move === x.move)) seen.push(x);
        f = seen[+kind.slice(3) - 1] || seen[0];          // fewer than 3 No Mercies: the other directions use the first
      }
      if (f) this.run[p] = sequence(s, p, f);
    }
    // called once per frame with the gamepad of each player; returns pad override or -1
    frame(s, p, gp) {
      if (gp && s.wram[0x105F]) {
        const ax = gp.axes, b = gp.buttons;
        const st = {
          humil: (ax[3] || 0) < -0.6, fin1: (ax[2] || 0) > 0.6, fin2: (ax[3] || 0) > 0.6, fin3: (ax[2] || 0) < -0.6,
          ultra: !!(b[7] && b[7].value > 0.5), ultimate: !!(b[6] && b[6].value > 0.5),
        };
        const pr = this.prev[p];
        // R3: the Combo Breaker reward (the glowing pip at the life-bar tip that allows shadow moves; Spinal's
        // skulls are the same counter, $0EE6 P1 / $0EEA P2, +1 like the breaker script's $AC, max 5). Fights only.
        st.shadow = !!(b[10 + 1] && b[10 + 1].pressed);
        if (st.shadow && !pr.shadow && ((s.wram[2] << 16) | (s.wram[1] << 8) | s.wram[0]) === 0x8086EE) {
          const a = 0x0EE6 + 4 * p; if (s.wram[a] < 5) s.wram[a]++;
        }
        if (!this.run[p]) for (const k in st) if (k !== 'shadow' && st[k] && !pr[k]) { this.start(s, p, k); break; }
        this.prev[p] = st;
      }
      const r = this.run[p];
      if (!r) return -1;
      const v = r.shift();
      if (!r.length) this.run[p] = null;
      return v;
    }
  }
  globalThis.KIMacros = Macros;
})();
