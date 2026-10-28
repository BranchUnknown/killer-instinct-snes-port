// Stage + music select (Tournament, 2 Player, Practice), shown between character select and the VS
// screen. Layout after the Xbox 360 prototype (name plate, big preview, card strip with arrows) with
// the modern KI's music panel. The choice is written into the game's variables right after
// FightInit's PickStage (KIRomFix.stageHook): stage $12F0, music_override $1353 (song, $FFFF = theme).
(function () {
  'use strict';
  const STAGES = [
    'Skull dungeon', 'Snow shrine (Glacius)', 'Blood floor (Riptor)', 'Mountain temple', 'Tiger shrine (Jago)',
    'Ultratech factory (Fulgore)', 'Red hall (Eyedol)', 'Castle gate', 'Canyon (Thunder)', 'Boxing ring (TJ Combo)',
    'Lava pit (Eyedol)', 'Castle hall (Sabrewulf)', 'Back alley', 'Rooftop at night (Orchid)', 'Rooftop at sunset (Cinder)',
    'Moonlit ruins (Spinal)', 'Sky (secret)'];
  const SONG_OF_STAGE = [10, 4, 9, 4, 0, 6, 10, 2, 3, 1, 10, 7, 11, 8, 5, 2];
  const SONGS = [];
  for (let k = 0; k < 12; k++) {
    const st = SONG_OF_STAGE.indexOf(k);
    SONGS.push('Theme ' + (k + 1) + (st >= 0 ? ' - ' + STAGES[st].replace(/ \(.*/, '') : ''));
  }
  const PAD = { L: 0x0200, R: 0x0100, U: 0x0800, D: 0x0400, A: 0x8000 /* Xbox A = SNES B */, B: 0x0080 /* Xbox B = SNES A */,
    X: 0x4000 /* Xbox X = SNES Y */, Y: 0x0040 /* Xbox Y = SNES X */, START: 0x1000 };

  class StageSelect {
    constructor(root) {
      this.root = root;
      this.open = false; this.enabled = true;
      this.stage = 0; this.music = 0;          // 0 = Random / Default
      this.musicOpen = false;
      this.pick = null; this.prevH = 0; this.nav = 0xFFFF; this.urls = [];
      if (!root.querySelector) return;          // (headless tests)
      root.innerHTML = `
        <div class="ss-title">STAGE SELECT</div>
        <div class="ss-plate"><span class="ss-name"></span></div>
        <div class="ss-preview"><img class="ss-big" alt=""><div class="ss-q">?</div>
          <div class="ss-theme"><small class="ss-tl">DEFAULT THEME</small><span class="ss-tn"></span></div></div>
        <div class="ss-music" hidden><button class="ss-ml">&lsaquo;</button><span class="ss-mn"></span><button class="ss-mr">&rsaquo;</button></div>
        <div class="ss-strip"><button class="ss-arrow ss-l">&lsaquo;</button><div class="ss-cards"></div><button class="ss-arrow ss-r">&rsaquo;</button></div>
        <div class="ss-hints"><span><i class="dp">&#10021;</i> Change Stage</span><span><i class="xa">A</i> Select</span><span><i class="xb">B</i> Back</span><span><i class="xy">Y</i> Show/Hide Music</span><span><i class="xx">X</i> Default Music</span></div>`;
      const q = (c) => root.querySelector(c);
      this.el = { name: q('.ss-name'), big: q('.ss-big'), qm: q('.ss-q'), tl: q('.ss-tl'), tn: q('.ss-tn'), music: q('.ss-music'),
        mn: q('.ss-mn'), cards: q('.ss-cards') };
      q('.ss-l').onclick = () => this.move(-1); q('.ss-r').onclick = () => this.move(1);
      q('.ss-ml').onclick = () => this.moveMusic(-1); q('.ss-mr').onclick = () => this.moveMusic(1);
      q('.ss-preview').onclick = () => this.confirm();
      this.cards = [];
      for (let k = 0; k < 5; k++) {
        const c = document.createElement('div'); c.className = 'ss-card' + (k === 2 ? ' on' : '');
        c.innerHTML = '<img alt=""><b>?</b>'; c.onclick = () => this.move(k - 2);
        this.el.cards.appendChild(c); this.cards.push(c);
      }
    }
    get n() { return STAGES.length + 1; }
    setThumbs(urls) { this.urls = urls; if (this.open) this.show(); }
    move(d) { this.stage = (this.stage + d + this.n) % this.n; this.show(); }
    moveMusic(d) { const m = SONGS.length + 1; this.music = (this.music + d + m) % m; this.show(); }
    show() {
      if (!this.el) return;
      const st = this.stage, url = st ? this.urls[st - 1] : null;
      this.el.name.textContent = st ? STAGES[st - 1] : 'RANDOM';
      this.el.big.hidden = !url; if (url) this.el.big.src = url;
      this.el.qm.hidden = !!url;
      this.el.tl.textContent = this.music ? 'MUSIC' : 'DEFAULT THEME';
      this.el.tn.textContent = this.music ? SONGS[this.music - 1] : (st ? SONGS[SONG_OF_STAGE[(st - 1) % 16]].replace(/^Theme \d+ - /, '') + ' theme' : 'Random');
      this.el.music.hidden = !this.musicOpen;
      this.el.mn.textContent = this.music ? SONGS[this.music - 1] : 'Default (the stage\'s theme)';
      this.cards.forEach((c, k) => {
        const i = (st + k - 2 + this.n) % this.n, u = i ? this.urls[i - 1] : null, im = c.querySelector('img');
        im.hidden = !u; if (u) im.src = u;
        c.querySelector('b').hidden = !!u;
        c.title = i ? STAGES[i - 1] : 'Random';
      });
    }
    // call after every emulated frame; true while the selector holds the game
    watch(s) {
      const h = (s.wram[2] << 16) | (s.wram[1] << 8) | s.wram[0];
      const gt = s.wram[0x12CE];
      const left = this.prevH === 0x818D4A && h !== 0x818D4A;
      this.prevH = h;
      if (left && (gt === 0 || gt === 2 || gt === 3) && this.enabled) {
        this.s = s; this.open = true; this.musicOpen = false; this.nav = 0xFFFF;
        this.root.hidden = false; this.show(); this.arm(s);
      }
      return this.open;
    }
    arm(s) {
      const c = s.cpu, h = KIRomFix.stageHook(s.rom);
      c.bpPB = h.pb; c.bpPC = h.pc;
      c.onBreak = () => {
        if (!this.pick) return;
        if (this.pick.stage >= 0) { s.wram[0x12F0] = this.pick.stage; s.wram[0x12F1] = 0; }
        if (this.pick.music >= 0) { s.wram[0x1353] = this.pick.music; s.wram[0x1354] = 0; }
        this.pick = null;
      };
    }
    confirm() {
      // Random: pick the stage here, so its own theme can be set before the game reads the music
      // (the MegaPatch reads music_override before PickStage and plays a random track for $FFFF)
      const stage = this.stage ? this.stage - 1 : Math.floor(Math.random() * 16);
      let music = this.music - 1;
      if (music < 0 && this.s && stage < 16) music = this.s.rom[0x019E + stage];   // the stage theme ($C0:019E)
      this.pick = { stage, music };
      // the MegaPatch reads music_override before the stage hook, so set it right away as well
      if (this.s && this.pick.music >= 0) { this.s.wram[0x1353] = this.pick.music; this.s.wram[0x1354] = 0; }
      this.open = false; this.root.hidden = true;
      if (this.onClose) this.onClose();
    }
    // pad = SNES pad word this frame (both players); edge-detected
    input(pad) {
      const nw = pad & ~this.nav; this.nav = pad;
      if (!this.open || !nw) return;
      if (nw & PAD.L) this.move(-1);
      if (nw & PAD.R) this.move(1);
      if (this.musicOpen && (nw & PAD.U)) this.moveMusic(-1);
      if (this.musicOpen && (nw & PAD.D)) this.moveMusic(1);
      if (nw & PAD.Y) { this.musicOpen = !this.musicOpen; this.show(); }
      if (nw & PAD.X) { this.music = 0; this.show(); }
      if (nw & PAD.B) { this.musicOpen = false; this.show(); }
      if (nw & (PAD.A | PAD.START)) this.confirm();
    }
    inputPlayers() { /* Eyedol is on the character select now (Selectable Eyedol patch) */ }
  }
  globalThis.KIStageSelect = StageSelect;
})();
