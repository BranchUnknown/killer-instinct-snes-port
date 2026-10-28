// Start menu for fights: Resume, Moves List, Restart Match, Reselect Character, Quit to Main Menu.
// Start no longer reaches the game in a fight (so Practice no longer ends on Start); the port holds
// the machine (sound included) and keeps the last picture on screen, blurred, with the menu over it.
// Restart / Reselect / Quit restore snapshots (js/state.js) taken when a match starts, at character
// select and at the main menu. Moves List = a KI 2013 style command list (js/movelist_data.js from StrategyWiki,
// icons js/moveicons.js); the older list built from the fighters' move data in WRAM is the fallback.
(function () {
  'use strict';
  const H_MENU = 0x8187B3, H_SELECT = 0x818D4A, H_FIGHT = 0x8086EE;
  const CHARS = ['Jago', 'T.J. Combo', 'Spinal', 'Thunder', 'Glacius', 'Fulgore', 'Cinder', 'Sabrewulf', 'Orchid', 'Riptor', 'Eyedol'];
  const DIRS = ['N', '↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];
  const BTNS = [[0x0020, 'QP'], [0x4000, 'MP'], [0x0040, 'FP'], [0x0010, 'QK'], [0x8000, 'MK'], [0x0080, 'FK']];
  const FIN = ['Ultra', 'No Mercy', 'Humiliation', 'Ultimate'];

  function romw(rom, a) { return rom[a] | (rom[a + 1] << 8); }

  // every special / combo / finisher record of player p, grouped by move id
  function moveList(s, p) {
    const w = s.wram, base = p ? 0x10000 : 0, c = w[p ? 0x1063 : 0x105F] - 1;
    if (c < 0 || c > 10) return null;
    const rb = (a) => w[base + (a & 0xFFFF)];
    const seen = new Map();
    for (let st = 0; st < 3; st++) {
      let q = romw(s.rom, 0x0201AA + c * 8 + st * 2);
      for (let n = 0; n < 90; n++) {
        const mask = rb(q) | (rb(q + 1) << 8);
        if (!mask) break;
        const cnt = rb(q + 2), mode = rb(q + 3), hold = rb(q + 4);
        for (let k = 0; k < cnt; k++) {
          const mp = rb(q + 5 + 2 * k) | (rb(q + 6 + 2 * k) << 8);
          const len = rb(mp), move = rb(mp + len - 1);
          let fin = -1, combo = 0, prev = false, dirs = [], notes = [];
          for (let i = 1; i + 2 < len; i += 3) {
            const op = rb(mp + i), mn = rb(mp + i + 1);
            if (op <= 8) { if (op && dirs[dirs.length - 1] !== DIRS[op]) dirs.push(DIRS[op]); }
            else if (op >= 11 && op <= 18) dirs.push('hold ' + DIRS[op - 10]);
            else if (op === 0xE9) fin = mn;
            else if (op === 0xE2 || op === 0xE8) combo = Math.max(combo, mn);
            else if (op === 0xE3 || op === 0xE6) prev = true;
            else if (op === 0xE0) notes.push('close');
            else if (op === 0xEA) notes.push('far');
            else if (op === 0xEB) notes.push('vs. air');
          }
          if (!dirs.length && fin < 0) continue;           // plain normals / chains without a motion
          const btn = BTNS.filter(([m]) => mask & m).map(([, n]) => n).join('/');
          const text = (mode ? 'hold ' + btn + ', ' : '') + dirs.join(' ') + (mode ? ', release ' + btn : ' + ' + btn) +
            (st === 2 ? ' (in the air)' : '') + (notes.length ? ' (' + [...new Set(notes)].join(', ') + ')' : '');
          const kind = fin >= 0 ? 'fin' + fin : (combo || prev) ? 'combo' : 'special';
          const key = kind + ':' + move;
          if (!seen.has(key)) seen.set(key, { kind, move, text, combo, alts: [] });
          else if (seen.get(key).alts.length < 1 && seen.get(key).text !== text) seen.get(key).alts.push(text);
        }
        q += 5 + 2 * cnt;
      }
    }
    // identical inputs (e.g. crouching / standing variants of one special) are listed once
    const texts = new Set(), all = [];
    for (const m of seen.values()) { const k = m.kind + '|' + m.text; if (!texts.has(k)) { texts.add(k); all.push(m); } }
    const specialTexts = new Set(all.filter(m => m.kind === 'special').map(m => m.text));
    for (let i = all.length - 1; i >= 0; i--) if (all[i].kind === 'combo' && specialTexts.has(all[i].text) && !all[i].combo) all.splice(i, 1);
    const out = { name: CHARS[c], groups: [] };
    const sp = all.filter(m => m.kind === 'special'), co = all.filter(m => m.kind === 'combo');
    out.groups.push(['Special moves', sp.map((m, i) => ['Special ' + (i + 1), m.text])]);
    out.groups.push(['Combo moves (openers, linkers, enders)', co.map((m, i) => ['Combo ' + (i + 1) + (m.combo > 1 ? ' (' + m.combo + '+ hits)' : ''), m.text])]);
    const fins = [];
    for (let t = 0; t < 4; t++) {
      const f = all.filter(m => m.kind === 'fin' + t);
      f.forEach((m, i) => fins.push([FIN[t] + (t === 1 ? ' ' + (i + 1) : f.length > 1 ? ' ' + (i + 1) : ''), m.text]));
    }
    out.groups.push(['Finishers and combo finishers', fins]);
    return out;
  }

  // command list from js/movelist_data.js (StrategyWiki "Killer Instinct/Moves"), shown KI 2013 style
  const WIKI = ['Jago', 'Combo', 'Spinal', 'Thunder', 'Glacius', 'Fulgore', 'Cinder', 'Sabrewulf', 'Orchid', 'Riptor', 'Eyedol'];
  const CAT_ORDER = [['Specials', 'Special Moves'], ['Release Specials', 'Release Specials'], ['Shadow Moves', 'Shadow Moves'],
    ['Finishers', 'Finishers'], ['Command Normals', 'Command Normals'], ['Normal Openers and Auto Double', 'Openers & Auto-Doubles'],
    ['Special Openers', 'Special Openers'], ['Linkers', 'Linkers'], ['Enders', 'Enders']];
  const FLAG_TEXT = { breaker: 'Combo Breaker', after_breaker: 'Only available after a Combo Breaker', shadow: 'Shadow version possible (after a Combo Breaker)' };
  // "No Mercy 1 (Sword Stab)" -> main name + smaller subtitle, so long names fit
  function nameHtml(n) {
    const m = /^(.*?)\s*\(([^)]+)\)$/.exec(n);
    return m && m[1] ? m[1].toUpperCase() + '<small>' + m[2].toUpperCase() + '</small>' : n.toUpperCase();
  }
  function commandList(s, p) {
    const c = s.wram[p ? 0x1063 : 0x105F] - 1;
    const data = globalThis.KIMovesData && globalThis.KIMovesData[WIKI[c]];
    if (!data) return null;
    const cats = [];
    for (const [key, title] of CAT_ORDER) {
      const sec = data.find(x => x.name === key);
      if (sec && sec.moves.length && !(sec.moves.length === 1 && sec.moves[0].name === 'None')) cats.push({ title, moves: sec.moves });
    }
    for (const sec of data) if (!CAT_ORDER.some(([k]) => k === sec.name) && sec.moves.length) cats.push({ title: sec.name, moves: sec.moves });
    return { name: CHARS[c], cats };
  }

  class Pause {
    constructor(root) {
      this.root = root; this.open = false; this.view = 'menu'; this.sel = 0; this.nav = 0xFFFF;
      this.snaps = {}; this.prevH = 0; this.prevStart = [0, 0]; this.frame = null; this.tab = 0; this.cat = 0; this.row = 0;
      this.items = [['Resume', 'resume'], ['Moves List', 'moves'], ['Restart Match', 'restart'], ['Reselect Character', 'reselect'], ['Quit to Main Menu', 'quit']];
      root.innerHTML = '<div class="pz-title">PAUSE</div><div class="pz-box"></div>';
      this.box = root.querySelector('.pz-box');
    }
    handler(s) { return (s.wram[2] << 16) | (s.wram[1] << 8) | s.wram[0]; }
    // before each emulated frame: snapshots on screen changes, Start interception. Returns the pads to send.
    beforeFrame(s, pads) {
      const h = this.handler(s);
      if (h !== this.prevH) {
        if (h === H_MENU) this.snaps.menu = KIState.save(s);
        if (h === H_SELECT) this.snaps.select = KIState.save(s);
        if (h === H_FIGHT) this.snaps.fight = KIState.save(s);
        this.prevH = h;
      }
      const out = pads.slice();
      if (h === H_FIGHT) {
        const gt = s.wram[0x12CE];
        for (let p = 0; p < 2; p++) {
          const st = pads[p] & 0x1000, edge = st && !this.prevStart[p];
          if (gt === 1 && p === 1) continue;                    // 1P: P2's Start = new challenger
          if (st) out[p] &= ~0x1000;
          if (edge) { this.who = p; this.openMenu(s); }
        }
      }
      this.prevStart = [pads[0] & 0x1000, pads[1] & 0x1000];
      return out;
    }
    openMenu(s) {
      this.s = s; this.open = true; this.view = 'menu'; this.sel = 0; this.nav = 0xFFFF;
      // the picture stays as it was when Start was pressed (the app blurs it and stops the music: onOpen)
      this.root.hidden = false;
      if (this.onOpen) this.onOpen();
      this.draw();
    }
    close() { this.open = false; this.root.hidden = true; if (this.onView) this.onView(null); if (this.onClose) this.onClose(); }
    act(what) {
      const s = this.s;
      if (what === 'resume') this.close();
      else if (what === 'moves') { this.view = 'moves'; this.tab = this.who || 0; this.cat = 0; this.row = 0; this.draw(); }
      else {
        const snap = what === 'restart' ? this.snaps.fight : what === 'reselect' ? this.snaps.select : this.snaps.menu;
        if (snap) { KIState.restore(s, snap); this.prevH = this.handler(s); }
        else if (what === 'quit') s.reset();
        this.close();
        if (this.onJump) this.onJump(what);
      }
    }
    draw() {
      if (this.onView) this.onView(this.view);
      if (this.view === 'menu') {
        this.root.classList.remove('cl');
        this.box.innerHTML = this.items.map(([t], i) => '<button class="pz-item' + (i === this.sel ? ' on' : '') + '" data-i="' + i + '">' + t + '</button>').join('');
        this.box.querySelectorAll('.pz-item').forEach(b => b.onclick = () => { this.sel = +b.dataset.i; this.act(this.items[this.sel][1]); });
        return;
      }
      this.root.classList.add('cl');
      const cl = commandList(this.s, this.tab), I = globalThis.KIMoveIcons;
      if (!cl || !I || !cl.cats.length) { this.drawRomList(); return; }
      this.cat = (this.cat % cl.cats.length + cl.cats.length) % cl.cats.length;
      const cat = cl.cats[this.cat], moves = cat.moves;
      this.row = Math.max(0, Math.min(this.row, moves.length - 1));
      const sel = moves[this.row] || { name: '', input: [] };
      let h = '<div class="cl-head"><span class="cl-title">COMMAND LIST</span><span class="cl-name">' + cl.name.toUpperCase() + '</span>' +
        '<span class="cl-who">' + (this.tab ? 'P2' : 'P1') + '</span></div>' +
        '<div class="cl-cat"><b class="cl-prev">&lt;</b><span>' + cat.title.toUpperCase() + '</span><b class="cl-next">&gt;</b></div>' +
        '<div class="cl-list">';
      moves.forEach((m, i) => {
        h += '<div class="cl-row' + (i === this.row ? ' on' : '') + (m.sub ? ' sub' : '') + '" data-i="' + i + '"><span class="cl-mname">' +
          (m.sub ? '<i>&#9492;</i>' : '') + nameHtml(m.name) + (m.flags && m.flags.includes('breaker') ? ' <em>BREAKER</em>' : '') +
          '</span><span class="cl-inp' + (m.input.length > 22 ? ' xlong' : m.input.length > 14 ? ' long' : '') + '">' + I.render(m.input) + '</span></div>';
      });
      h += '</div><div class="cl-info"><div class="cl-desc"><p class="cl-dname">' + sel.name.toUpperCase() + '</p><p>' + I.words(sel.input) + '</p>' +
        (sel.flags || []).map(f => '<p class="cl-flag">' + FLAG_TEXT[f] + '</p>').join('') + '</div>' +
        '<div class="cl-legend"><span>' + I.button('P', 'Q') + I.button('K', 'Q') + ' QUICK</span><span>' + I.button('P', 'M') + I.button('K', 'M') + ' MEDIUM</span>' +
        '<span>' + I.button('P', 'F') + I.button('K', 'F') + ' FIERCE</span><span>' + I.button('P', 'A') + I.button('K', 'A') + ' ANY</span></div></div>' +
        '<div class="cl-hint"><span><i>&#9650;&#9660;</i>Move</span><span><i>&#9664;&#9654;</i>Category</span><span><i>L/R</i>P1 / P2</span><span><i>B</i>Back</span>' +
        '<span class="cl-src">Inputs shown facing right &middot; move list: StrategyWiki</span></div>';
      this.box.innerHTML = h;
      this.box.querySelectorAll('.cl-row').forEach(r => r.onclick = () => { this.row = +r.dataset.i; this.draw(); });
      this.box.querySelector('.cl-prev').onclick = () => { this.cat--; this.row = 0; this.draw(); };
      this.box.querySelector('.cl-next').onclick = () => { this.cat++; this.row = 0; this.draw(); };
      this.box.querySelector('.cl-who').onclick = () => { this.tab ^= 1; this.cat = 0; this.row = 0; this.draw(); };
      this.moves = this.box.querySelector('.cl-list');
      const on = this.moves.querySelector('.cl-row.on');
      if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
    }
    // the previous list, built from the fighters' move data in WRAM (used if the command-list data is missing)
    drawRomList() {
      this.root.classList.remove('cl');
      const ml = moveList(this.s, this.tab);
      let h = '<div class="pz-tabs"><button data-t="0" class="' + (this.tab === 0 ? 'on' : '') + '">P1</button><button data-t="1" class="' + (this.tab === 1 ? 'on' : '') + '">P2</button>' +
        '<span>' + (ml ? ml.name : '') + '</span></div><div class="pz-moves">';
      if (!ml) h += '<p>No move data.</p>';
      else for (const [g, rows] of ml.groups) {
        if (!rows.length) continue;
        h += '<h3>' + g + '</h3><table>' + rows.map(([n, t]) => '<tr><td>' + n + '</td><td>' + t + '</td></tr>').join('') + '</table>';
      }
      h += '</div><div class="pz-hint">Left/Right: P1 / P2 &nbsp; B: back &nbsp; Start: resume &nbsp; (directions as when facing right)</div>';
      this.box.innerHTML = h;
      this.box.querySelectorAll('.pz-tabs button').forEach(b => b.onclick = () => { this.tab = +b.dataset.t; this.draw(); });
      this.moves = this.box.querySelector('.pz-moves');
    }
    // navigation with SNES pad words (both players); Xbox A = SNES B, Xbox B = SNES A
    input(pad) {
      const nw = pad & ~this.nav; this.nav = pad;
      if (!this.open || !nw) return;
      if (nw & 0x1000) { this.close(); return; }
      if (this.view === 'menu') {
        if (nw & 0x0800) { this.sel = (this.sel + this.items.length - 1) % this.items.length; this.draw(); }
        if (nw & 0x0400) { this.sel = (this.sel + 1) % this.items.length; this.draw(); }
        if (nw & 0x8000) this.act(this.items[this.sel][1]);
        if (nw & 0x0080) this.close();
      } else {
        if (!this.root.classList.contains('cl')) {             // fallback list
          if (nw & 0x0300) { this.tab ^= 1; this.draw(); }
          if (nw & 0x0080) { this.view = 'menu'; this.draw(); }
          if (this.moves && (nw & 0x0400)) this.moves.scrollTop += 60;
          if (this.moves && (nw & 0x0800)) this.moves.scrollTop -= 60;
          return;
        }
        if (nw & 0x0080) { this.view = 'menu'; this.draw(); return; }
        if (nw & 0x0200) { this.cat--; this.row = 0; }
        if (nw & 0x0100) { this.cat++; this.row = 0; }
        if (nw & 0x0030) { this.tab ^= 1; this.cat = 0; this.row = 0; }
        if (nw & 0x0800) this.row--;
        if (nw & 0x0400) this.row++;
        if (nw & 0x0F30) this.draw();
      }
    }
  }
  Pause.moveList = moveList;
  globalThis.KIPause = Pause;
})();
