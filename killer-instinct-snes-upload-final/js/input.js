// Keyboard + gamepad -> SNES pad words (bit layout of $4218/$4219 read as one 16-bit value).
(function () {
  'use strict';
  const BTN = { B: 0x8000, Y: 0x4000, Select: 0x2000, Start: 0x1000, Up: 0x0800, Down: 0x0400, Left: 0x0200, Right: 0x0100, A: 0x0080, X: 0x0040, L: 0x0020, R: 0x0010 };
  const ORDER = ['Up', 'Down', 'Left', 'Right', 'Y', 'B', 'X', 'A', 'L', 'R', 'Start', 'Select'];
  // KI Web controls.txt: WASD + right-hand arcade layout
  const DEFAULT_KEYS = {
    Up: ['KeyW'], Down: ['KeyS'], Left: ['KeyA'], Right: ['KeyD'],
    R: ['KeyN'], L: ['KeyM'], Y: ['KeyJ'], B: ['KeyK'], X: ['KeyI'], A: ['KeyO'],
    Start: ['Enter'], Select: ['ShiftRight', 'Backspace'],
  };
  const DEFAULT_KEYS2 = {
    Up: ['ArrowUp'], Down: ['ArrowDown'], Left: ['ArrowLeft'], Right: ['ArrowRight'],
    Y: ['Numpad4'], X: ['Numpad5'], R: ['Numpad6'], B: ['Numpad1'], A: ['Numpad2'], L: ['Numpad3'],
    Start: ['NumpadEnter'], Select: ['NumpadAdd'],
  };
  // Standard Gamepad layout; "Mapped the same as SNES controller"
  const DEFAULT_PAD = {
    Up: [12], Down: [13], Left: [14], Right: [15],
    L: [4], R: [5], Y: [2], B: [0], X: [3], A: [1],
    Start: [9], Select: [8],
  };

  function load(name, def) {
    try { const v = JSON.parse(localStorage.getItem(name)); if (v && typeof v === 'object') return Object.assign({}, def, v); } catch (e) { /* storage blocked */ }
    return JSON.parse(JSON.stringify(def));
  }
  function save(name, v) { try { localStorage.setItem(name, JSON.stringify(v)); } catch (e) { /* storage blocked */ } }

  class Input {
    constructor() {
      this.down = new Set();
      this.keys = [load('ki.keys1', DEFAULT_KEYS), load('ki.keys2', DEFAULT_KEYS2)];
      this.pad = load('ki.pad', DEFAULT_PAD);
      this.touch = 0;                 // bits from the on-screen pad
      this.capture = null;            // remap callback
      window.addEventListener('keydown', (e) => {
        if (this.capture) { e.preventDefault(); const f = this.capture; this.capture = null; f({ key: e.code }); return; }
        if (this.isGameKey(e.code)) e.preventDefault();
        this.down.add(e.code);
      });
      window.addEventListener('keyup', (e) => { this.down.delete(e.code); });
      window.addEventListener('blur', () => this.down.clear());
    }
    isGameKey(code) {
      for (const k of this.keys) for (const b in k) if (k[b].includes(code)) return true;
      return false;
    }
    pads() { const g = navigator.getGamepads ? navigator.getGamepads() : []; return Array.from(g || []).filter(p => p && p.connected); }

    // poll a pending remap capture on gamepads (call every frame while capturing)
    pollCapture() {
      if (!this.capture || !this.capture.pad) return;
      for (const gp of this.pads()) {
        for (let i = 0; i < gp.buttons.length; i++) {
          if (gp.buttons[i].pressed && !(this.capturePrev && this.capturePrev[i])) {
            const f = this.capture; this.capture = null; f({ button: i }); return;
          }
        }
        this.capturePrev = gp.buttons.map(b => b.pressed);
      }
    }

    padWord(gp) {
      let w = 0;
      if (!gp) return 0;
      const b = gp.buttons;
      for (const name of ORDER) {
        for (const i of this.pad[name]) if (b[i] && (b[i].pressed || b[i].value > 0.5)) w |= BTN[name];
      }
      const ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
      if (ax < -0.5) w |= BTN.Left; if (ax > 0.5) w |= BTN.Right;
      if (ay < -0.5) w |= BTN.Up; if (ay > 0.5) w |= BTN.Down;
      return w;
    }
    keyWord(p) {
      let w = 0;
      const k = this.keys[p];
      for (const name of ORDER) for (const c of k[name]) if (this.down.has(c)) w |= BTN[name];
      return w;
    }
    // [P1, P2]: P1 = keyboard set 1 + first gamepad + touch; P2 = keyboard set 2 + second gamepad
    read() {
      const gps = this.pads();
      let p1 = this.keyWord(0) | this.padWord(gps[0]) | this.touch;
      let p2 = this.keyWord(1) | this.padWord(gps[1]);
      // a real pad cannot press opposite directions together
      const fix = (w) => {
        if ((w & BTN.Left) && (w & BTN.Right)) w &= ~(BTN.Left | BTN.Right);
        if ((w & BTN.Up) && (w & BTN.Down)) w &= ~(BTN.Up | BTN.Down);
        return w;
      };
      return [fix(p1), fix(p2)];
    }
    anyPressed() {
      if (this.down.size) return true;
      for (const gp of this.pads()) if (gp.buttons.some(b => b.pressed)) return true;
      return false;
    }
    setKey(p, name, code) {
      const k = this.keys[p];
      for (const b in k) k[b] = k[b].filter(c => c !== code);
      k[name] = [code];
      save(p ? 'ki.keys2' : 'ki.keys1', k);
    }
    setPad(name, i) {
      for (const b in this.pad) this.pad[b] = this.pad[b].filter(c => c !== i);
      this.pad[name] = [i];
      save('ki.pad', this.pad);
    }
    resetDefaults() {
      this.keys = [JSON.parse(JSON.stringify(DEFAULT_KEYS)), JSON.parse(JSON.stringify(DEFAULT_KEYS2))];
      this.pad = JSON.parse(JSON.stringify(DEFAULT_PAD));
      save('ki.keys1', this.keys[0]); save('ki.keys2', this.keys[1]); save('ki.pad', this.pad);
    }
  }
  Input.BTN = BTN; Input.ORDER = ORDER;
  globalThis.KIInput = Input;
})();
