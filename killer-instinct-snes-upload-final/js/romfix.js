// ROM-level helpers shared by the port features.
(function () {
  'use strict';
  // The point right after FightInit's `jsl PickStage` (v1.1: $8084B1 `stz $1350; lda stage; cmp #2`).
  // The Arcade MegaPatch moves this code, so it is located by its bytes.
  function stageHook(rom) {
    const pat = [0x9C, 0x50, 0x13, 0xAD, 0xF0, 0x12, 0xC9, 0x02];
    for (let o = 0x8000; o < 0x10000 - pat.length; o++) {
      let k = 0; while (k < pat.length && rom[o + k] === pat[k]) k++;
      if (k === pat.length) return { pb: 0x80, pc: o };
    }
    return { pb: 0x80, pc: 0x84B1 };
  }

  // "Killer Instinct - Selectable Eyedol" by Justin3009 (romhacking.net hack 5453's sibling, IPS for
  // the USA v1.1 cartridge): Eyedol gets an 11th slot on the character select ring.
  // [file offset, original bytes, new bytes] - applied only when every original byte matches.
  const EYEDOL = [
    [0x00F6EE, '68', '89'],                 // ring wrap 360 -> 393 degrees
    [0x00F700, '68', '8c'],
    [0x00F766, '09c90a', '0ac90b'],         // highest character index 9 -> 10
    [0x00F85E, 'a9f0', '204e'],             // jsr $FF4E (per-side sprite offset)
    [0x00F86B, '0d', '0e'],
    [0x00FF4E, 'ffffffffffffffffffffffffff', 'e00400d004a9f0ff60a9cdff60'],
  ];
  const hex = (h) => Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16)));
  function selectableEyedol(rom) {
    // The patch's 13-byte routine plus our 11-entry position table (22 bytes) need unused space in
    // bank $80. v1.1: $FF4E (where the patch puts it); the MegaPatch uses that, so find a run of $FF.
    const isFree = (o, n) => { for (let i = 0; i < n; i++) if (rom[o + i] !== 0xFF) return false; return true; };
    const find = (n, avoid) => {
      for (let o = 0xFFB0 - n; o >= 0xC000; o--) if (isFree(o, n) && !(avoid >= 0 && o < avoid + 16 && o + n > avoid)) return o;
      return -1;
    };
    let at = isFree(0xFF4E, 16) ? 0xFF4E : find(16, -1);
    if (at < 0) return null;
    // the table is read with a long address (lda $bbhhll,X), so it may sit in any bank
    let tab = isFree(at + 14, 24) ? at + 14 : -1;
    if (tab < 0) for (let o = rom.length - 0x10000; o >= 0x10000 && tab < 0; o -= 0x10000) {
      for (let q = o + 0xFF00; q > o + 0x8000; q--) if (isFree(q, 32)) { tab = q + 4; break; }
    }
    if (tab < 0) return null;
    const h2 = (v) => (v & 0xFF).toString(16).padStart(2, '0') + ((v >> 8) & 0xFF).toString(16).padStart(2, '0');
    let table = '';
    for (let c = 0; c <= 10; c++) table += h2(((c - 4 + 11) % 11) * 36);   // ring position of each character
    const recs = [
      ...EYEDOL.filter(r => r[0] !== 0x00FF4E && r[0] !== 0x00F85E),
      [0x00F85E, 'a9f0ff', '20' + h2(at)],                    // jsr to the patch's routine
      [at, 'ff'.repeat(13), EYEDOL.find(r => r[0] === 0x00FF4E)[2]],
      // port fixes for the random select spin (Up + Start), which the patch leaves at 10 slots:
      [0x00F687, '68', '8c'], [0x00F68C, '68', '8c'],          // spin wraps at 396, not 360
      [0x00F6BB, '0a', '0b'], [0x00F6C0, '0a', '0b'],          // slot -> character mod 11
      [tab, 'ff'.repeat(22), table],                           // 11-entry ring position table
      [0x00F6CB, 'bbf880', h2(tab & 0xFFFF) + (tab < 0x10000 ? '80' : (0xC0 + (tab >> 16)).toString(16))],   // lda $80F8BB,X -> new table
    ];
    const ok = recs.every(([o, a]) => hex(a).every((v, i) => rom[o + i] === v));
    if (!ok) return null;
    const out = new Uint8Array(rom);
    for (const [o, , b] of recs) out.set(hex(b), o);
    return out;
  }
  // Port addition: Eyedol finishers.
  //   No Mercy 1 (B,N,B,N,B + FP): his golf swing (B,F+FP); the victim gets TJ Combo's wall splat.
  //   No Mercy 2 (F,N,F,N,F + QP): his fireball; on contact the victim dissolves like Riptor's acid spit,
  //               with green ashes.
  //   Humiliation (B,N,B,N,F,N,F + MP): his roar pose, the victim dances.
  // His staged block ($7E/$7F:B000, 6 KB) has no room, so the extra data goes to $CFF8+ in the same
  // bank - past his block, inside the 16.6 KB other fighters need, so unused while he is loaded:
  //   $CFF9/$D019/$D039  hit records 233/234/235 (copies of Riptor's 80 dissolve, TJ's 114 wall
  //                      splat, TJ's 110 dance)
  //   $D060        move table, 45 entries (his 41 copied from $B081 + moves 41-44)
  //   $D170 NM1, $D1D0 humiliation, $D310 NM2 cast, $D350 NM2 projectile (scripts)
  //   $D200/$D230/$D370  input motions
  //   $D260        stance-0 input list: the three new records, then his own list (copied from $B7D9)
  // The ROM pointers $C2:017E (move table) and $C2:01AA (input list) for Eyedol move there, and the
  // block-staging routines ($83DFCD P1 / $83DFFC P2) jump to a hook that runs RelocateCharData as
  // before and then copies the data in when the staged fighter is Eyedol. A second hook in
  // QueuePaletteById ($80C905) swaps the dissolve palette $2C for a green copy when the attacker is Eyedol.
  function eyedolFinishers(rom) {
    const CODE = 0x017A00, BLOB = 0x017B00, BASE = 0xCFF8, BLOBLEN = 0xD3A0 - BASE;   // $C1:7A00.. (free in v1.1 and the MegaPatch)
    const GREEN = 0x017EB0, GREEN2 = 0x017ED0, PALHOOK = 0x017EF0, END = 0x017F50;
    const isFree = (o, n) => { for (let i = 0; i < n; i++) if (rom[o + i] !== 0xFF) return false; return true; };
    if (!isFree(CODE, END - CODE)) return null;
    const w = (o) => rom[o] | (rom[o + 1] << 8);
    // Eyedol's block layout this patch was built from (v1.1 and the MegaPatch share it)
    if (w(0x020110 + 40) !== 0x674E || rom[0x020112 + 40] !== 0xC3 || w(0x02017E + 20) !== 0xB081 ||
        w(0x0201AA + 80) !== 0xB7D9 || w(0x020200 + 22) !== 0xB2D9) return null;
    const P1 = 0x03DFCD, P2 = 0x03DFFC, QPAL = 0x00C905;
    const same = (o, h) => hex(h).every((v, i) => rom[o + i] === v);
    if (!same(P1, 'a97e002003e06b') || !same(P2, 'a97f002003e06b') || !same(QPAL, '0a0aaaa452c03000b026') ||
        !same(0x002650 + 0x2C * 4, '4a462000')) return null;

    // the MegaPatch changes Riptor's acid record at run time to reaction $28 (its dissolve, palette $00);
    // v1.1 uses reaction $2A (palette $2C)
    const mega = String.fromCharCode.apply(null, rom.slice(0xFFC0, 0xFFD5)).indexOf('MSU1') >= 0;
    const blob = new Uint8Array(BLOBLEN);
    const put = (at, bytes) => blob.set(bytes, at - BASE);
    const lo = (a) => (a & 0xFF).toString(16).padStart(2, '0'), hi = (a) => ((a >> 8) & 0xFF).toString(16).padStart(2, '0');
    put(0xCFF9, [mega ? 0x28 : 0x2A]); put(0xCFFA, hex('0c0500000000000000000000000000000074002a2a2a034618000000000000'));   // r80 dissolve
    put(0xD019, hex('3408030003ff185097080012800000000000068034343405273c4c0000000080'));   // r114 wall splat
    put(0xD039, hex('310c0400f0000000000000000500000000000080313131000000000000000000'));   // r110 dance
    const NM1 = 0xD170, HU = 0xD1D0, NM2 = 0xD310, PROJ = 0xD350;
    const entry = (id, script, rest) => put(0xD060 + id * 6, [script & 0xFF, script >> 8, ...rest]);
    entry(41, NM1, [0x24, 0x00, 0x04, 0x0D]);     // golf swing: anim $24, flags/class as his move 12
    entry(42, HU, [0x2F, 0x00, 0x06, 0x03]);      // roar pose
    entry(43, NM2, [0x21, 0x00, 0x04, 0x03]);     // fireball cast: anim $21, as his move 11
    entry(44, PROJ, [0x2B, 0x00, 0x04, 0x06]);    // the fireball itself: as his move 25
    // NM1 = his golf swing (move 12, $C20F) as is, except for the hit record (234) and the held ending
    put(NM1, hex(
      'b9bb01' +                                                        // IMPACT_FLASH, FINISHER 1
      'bf91a66692bc0f09040c0188c8120c021103120192d4f0cc2012011401ccff' + // $C20F up to its HITBOX
      '8407eacc8181bf807cb450' +                                        // HITBOX life 7, record 234
      '1501ca15031c0292d4001c0423022304' +                              // the rest of $C20F
      'a9b6' + 'a612' + '2328' + '2328' +  // SFX_OPP $B6 + SFX $12 (as TJ's), hold the last frame
      '8f20' + 'bd78' + '80'));            // DRAW_IN_FRONT, SET_END_TIMER 120, END_MOVE
    put(HU, hex(
      '91b9bfbb05' +                       // CLR_VX, IMPACT_FLASH, FACE_OPPONENT, FINISHER 5 (humiliation)
      'c82f' + '0205' +                    // SET_ANIM $2F
      'cfd4' +                             // MUSIC_0E (dance music), LOAD_OPP_GFX (dance frames)
      '8402ebb68f90ae87a0b488' +           // HITBOX life 2, record 235, TJ's humiliation box
      '0305' + '0505' + 'a67b' + 'a003' +  // roar
      '1440' + '1440' +                    // hold
      'bdb4' + '80'));                     // SET_END_TIMER 180, END_MOVE
    // NM2 = his fireball cast (move 11, $C057), spawning move 44 instead of 25; Riptor's end timer
    put(NM2, hex(
      'b9bb01' +                                                        // IMPACT_FLASH, FINISHER 1
      '91a67a0a040e0488fafa1403' +                                      // $C057 wind-up
      '953c442c40' +                                                    // SPAWN_13 ... move 44
      '160117011601170116011701160117011601170116011701' +   // $C057's hold
      '14060e060a06' + 'bdc3' + '80'));                                 // recovery, SET_END_TIMER $C3, END_MOVE
    // the fireball: his move 25 ($C135) with hit record 233 (dissolve)
    put(PROJ, hex('92b40c' + '84fae965b785b986cf64d0' + '88fafa' + 'cb0a' + '88fafa' + 'cb0e' + '87' + lo(PROJ + 14) + hi(PROJ + 14)));
    // motions: L, (op,min,max)..., move, arg. e7 opp_grounded, e9 finisher_ok n, e0 close<n, ea far>n, e1 seek
    put(0xD200, hex('1d' + 'e70000' + 'e90100' + 'e03800' + '07010a' + '00010a' + '07010a' + '00010a' + '07010a' + 'e10a07' + '2900'));
    put(0xD230, hex('20' + 'e70000' + 'e90200' + '07010a' + '00010a' + '07010a' + '00010a' + '03010a' + '00010a' + '03010a' + 'e10a03' + '2a00'));
    put(0xD370, hex('20' + 'e70000' + 'e90100' + 'e0c800' + 'ea3000' + '03010a' + '00010a' + '03010a' + '00010a' + '03010a' + 'e10a03' + '2b00'));
    // list head: FP ($0040) -> NM1, MP ($4000) -> humiliation, QP ($0020) -> NM2
    put(0xD260, hex('4000010000' + '00d2' + '0040010000' + '30d2' + '2000010000' + '70d3'));
    const LIST = 0xD275;

    const out = new Uint8Array(rom);
    out.set(blob, BLOB);
    // green copies of the dissolve palettes: $2C ($C0:464A, v1.1 ash) and $00 ($C0:484A, MegaPatch acid)
    const greenify = (src, dst, gain) => {
      for (let i = 0; i < 16; i++) {
        const c = w(src + 2 * i), v = Math.max(c & 31, (c >> 5) & 31, (c >> 10) & 31);
        const g = Math.min(31, Math.round(v * gain)), r = Math.round(v * gain * 0.35), b = Math.round(v * gain * 0.12);
        const n = i === 0 ? c : (r | (g << 5) | (b << 10));
        out[dst + 2 * i] = n & 0xFF; out[dst + 2 * i + 1] = n >> 8;
      }
    };
    greenify(w(0x002650 + 0x2C * 4), GREEN, 2.6);
    greenify(w(0x002650), GREEN2, 1.0);
    // staging hook: called (jml) in place of `lda #$7E/$7F; jsr RelocateCharData`, returns with rtl
    const code = [];
    const hook = (bank, charAddr, rtlAt) => {
      const at = 0xC10000 | (CODE + code.length);
      const b = [0xA9, bank, 0x00,                       // lda #$007E/$007F
        0x4B, 0x62, 0, 0,                                // phk, per cont-1  (rtl lands on cont)
        0xF4, (rtlAt - 1) & 0xFF, (rtlAt - 1) >> 8,      // pea: RelocateCharData's rts -> the rtl at rtlAt
        0x5C, 0x03, 0xE0, 0x83];                         // jml RelocateCharData
      const cont = b.length;
      b[5] = (cont - 1 - 7) & 0xFF; b[6] = ((cont - 1 - 7) >> 8) & 0xFF;
      b.push(0xC2, 0x30,                                 // rep #$30
        0xAF, charAddr & 0xFF, charAddr >> 8, 0x00,      // lda $00:p1_char / p2_char
        0x29, 0xFF, 0x00, 0xC9, 0x0A, 0x00, 0xD0, 38,    // and #$FF; cmp #10 (Eyedol); bne done
        0x8B,                                            // phb
        0xA9, (BLOBLEN - 1) & 0xFF, (BLOBLEN - 1) >> 8, 0xA2, BLOB & 0xFF, (BLOB >> 8) & 0xFF, 0xA0, BASE & 0xFF, BASE >> 8,
        0x54, bank, 0xC1,                                // mvn: ROM blob -> $CFF8
        0xA9, 0xF5, 0x00, 0xA2, 0x81, 0xB0, 0xA0, 0x60, 0xD0,
        0x54, bank, bank,                                // mvn: his 41 move-table entries -> $D060
        0xA9, 0x96, 0x00, 0xA2, 0xD9, 0xB7, 0xA0, LIST & 0xFF, LIST >> 8,
        0x54, bank, bank,                                // mvn: his input list (+ terminator) -> $D275
        0xAB,                                            // plb
        0x6B);                                           // done: rtl
      code.push(...b);
      return at;
    };
    const h1 = hook(0x7E, 0x024E, 0xDFD3), h2 = hook(0x7F, 0x0252, 0xE002);
    if (code.length > BLOB - CODE) return null;
    out.set(code, CODE);
    // palette hook (16-bit A/X/Y): the dissolve palette ($2C v1.1, $00 MegaPatch) while Eyedol is the
    // attacker and a finisher is running -> queue the green copy instead
    const G = GREEN & 0xFFFF, G2 = GREEN2 & 0xFFFF;
    const pal = hex(
      'a0' + lo(G) + hi(G) + 'c92c00' + 'f008' +          // ldy #green; cmp #$2C; beq chk
      'a0' + lo(G2) + hi(G2) + 'c90000' + 'd01a' +        // ldy #green2; cmp #$00; bne normal
      '48' + 'a64a' + 'bd9304' + '29ff00' + 'c90b00' + 'd00b' +   // chk: pha; other_actor is Eyedol? else restore
      'ad9110' + '29ff00' + 'f003' +                      // finisher_type set? else restore
      '68' + '800a' +                                     // pla; bra green
      '68' +                                              // restore: pla
      '0a0aaaa452' + '5c0ac980' +                         // normal: asl, asl, tax, ldy $52; jml $80C90A
      '98' + 'a452' + 'c03000' + 'b017' +                 // green: tya; ldy $52; cpy #$30; bcs done
      '997d14' + 'a92000' + '997b14' +                    // source (bank $C1), 32 bytes
      'a900c1' + '997f14' +                               // CGRAM base 0 (the caller adds the actor's), bank $C1
      '98' + '18' + '690600' + '8552' + '18' +            // next queue slot
      '5c35c980');                                        // done: jml $80C935 (rts)
    out.set(pal, PALHOOK);
    out.set([0x5C, PALHOOK & 0xFF, (PALHOOK >> 8) & 0xFF, 0xC1], QPAL);
    out.set([0x5C, h1 & 0xFF, (h1 >> 8) & 0xFF, h1 >> 16], P1);
    out.set([0x5C, h2 & 0xFF, (h2 >> 8) & 0xFF, h2 >> 16], P2);
    out.set([0x60, 0xD0], 0x02017E + 20);             // Eyedol's move table -> $D060
    out.set([0x60, 0xD2], 0x0201AA + 80);             // Eyedol's stance-0 input list -> $D260
    return out;
  }

  // Widescreen (E extra columns each side): the camera never shows past the stage art, and fighters
  // can still walk to the real stage ends. Applied to the running ROM in place; E = 0 restores it.
  //   $83DF4C  camera target clamp  -> min+E .. max-E   (the table $C0:013A also bounds the fighters, so
  //                                                      it is left alone)
  //   $83DD49  round-start camera   -> min+E / max-E
  //   $809B9E  ScreenEdgeClamp      -> x - camera_x + E against $10.. / $F0+2E (the game's test is unsigned)
  //   (plus the sprite visibility range below)
  const WIDE = [
    [0x03DF4C, 'df3a01c01004bf3a01c0df3c01c09004bf3c01c08dfa126b'],
    [0x03DD49, 'bf3a01c0acb810f004bf3c01c0'],
    [0x009B9E, 'bde404851038edfa12'],
  ];
  //   $83DE8E  ActorScreenPos visibility -32..287 -> -32-E..287+E (immediates, patched in place)
  const WIDE_VIS = [0x03DE8E, 'c920019005c9e0ff'];   // cmp #$0120; bcc +5; cmp #$FFE0
  //   $80954A  jump/dash direction: opponent sx - own sx tested with bcs (unsigned), which flips once a fighter's
  //            screen x goes negative in the side columns -> bpl (signed)
  const WIDE_DIR = 0x00954A;
  const MEGA_VIS = 0x3FDB1D;
  const WIDE_CODE = 0x017F50, WIDE_END = 0x018000;                        // $C1:7F50 (free in v1.1 and the MegaPatch)
  function widescreen(rom, E) {
    E = Math.max(0, Math.min(127, E | 0));
    const sameAt = (o, h) => hex(h).every((v, i) => rom[o + i] === v);
    const ours = (o) => rom[o] === 0x5C && rom[o + 3] === 0xC1;
    if (!WIDE.every(([o, h]) => sameAt(o, h) || ours(o))) return false;
    if (!(rom[WIDE_DIR] === 0xB0 || rom[WIDE_DIR] === 0x10) || rom[WIDE_DIR + 1] !== 0x0A) return false;
    // the MegaPatch replaces the first compare with `jml $FFDB1D` (fighters: < $0120 or the $FFE0 test; other
    // objects: < $0100 only)
    const megaVis = rom[WIDE_VIS[0]] === 0x5C && sameAt(WIDE_VIS[0] + 1, '1ddbff') && rom[WIDE_VIS[0] + 5] === 0xC9 &&
      sameAt(MEGA_VIS, 'b00dc9') && (sameAt(MEGA_VIS + 15, 'c90001b022') || ours(MEGA_VIS + 15));
    if (!megaVis && !(sameAt(...WIDE_VIS) || (rom[WIDE_VIS[0]] === 0xC9 && rom[WIDE_VIS[0] + 3] === 0x90 && rom[WIDE_VIS[0] + 5] === 0xC9))) return false;
    if (!E) { for (const [o, h] of WIDE) rom.set(hex(h), o); rom.fill(0xFF, WIDE_CODE, WIDE_END); rom[WIDE_DIR] = 0xB0;
      if (megaVis) { rom.set([0x20, 0x01], MEGA_VIS + 3); rom.set(hex('c90001b022'), MEGA_VIS + 15); rom.set([0xE0, 0xFF], WIDE_VIS[0] + 6); }
      else rom.set(hex(WIDE_VIS[1]), WIDE_VIS[0]);
      return true; }
    rom[WIDE_DIR] = 0x10;
    { const hi = 0x0120 + E, lo = (0xFFE0 - E) & 0xFFFF;
      rom.set([lo & 0xFF, lo >> 8], WIDE_VIS[0] + 6);
      if (megaVis) rom.set([hi & 0xFF, hi >> 8], MEGA_VIS + 3);
      else rom.set([hi & 0xFF, hi >> 8], WIDE_VIS[0] + 1); }
    const b2 = (v) => [v & 0xFF, (v >> 8) & 0xFF];
    const code = [], at = () => 0xC10000 | (WIDE_CODE + code.length);
    const tab = at() + 0;                              // ScreenEdgeClamp table: [lo, lo set, hi, hi set] x 3 cases
    for (const [lo, ls, hi, hs] of [[0x10, 0x10, 0xF1, 0xF0], [0x0F, 0x0F, 0xF2, 0xF1], [0x0E, 0x0E, 0xF3, 0xF2]])
      code.push(...b2(lo), ...b2(ls), ...b2(hi + 2 * E), ...b2(hs + 2 * E));
    const T = (k) => [(tab + k) & 0xFF, ((tab + k) >> 8) & 0xFF, 0xC1];
    const h1 = at();
    code.push(0xBD, 0xE4, 0x04, 0x85, 0x10,          // lda act_x,X; sta $10
      0x38, 0xED, 0xFA, 0x12, 0x18, 0x69, ...b2(E),  // sec; sbc camera_x; clc; adc #E
      0x10, 0x01, 0x7B,                              // bpl +1; tdc
      0xDA, 0xBB,                                    // phx; tyx
      0xDF, ...T(0), 0xB0, 0x04, 0xBF, ...T(2),      // cmp lo,X; bcs; lda lo set,X
      0xDF, ...T(4), 0x90, 0x04, 0xBF, ...T(6),      // cmp hi,X; bcc; lda hi set,X
      0xFA, 0x38, 0xE9, ...b2(E),                    // plx; sec; sbc #E
      0x18, 0x6D, 0xFA, 0x12,                        // clc; adc camera_x
      0x5C, 0xBE, 0x9B, 0x80);                       // jml $809BBE (sta act_x,X)
    const h2 = at();
    code.push(0x38, 0xE9, ...b2(E),                  // sec; sbc #E
      0xDF, 0x3A, 0x01, 0xC0, 0x10, 0x04, 0xBF, 0x3A, 0x01, 0xC0,   // max(.., min)
      0x18, 0x69, ...b2(2 * E),                      // clc; adc #2E
      0xDF, 0x3C, 0x01, 0xC0, 0x90, 0x04, 0xBF, 0x3C, 0x01, 0xC0,   // min(.., max)
      0x38, 0xE9, ...b2(E),                          // sec; sbc #E
      0x8D, 0xFA, 0x12, 0x6B);                       // sta camera_x; rtl
    const h3 = at();
    code.push(0xBF, 0x3A, 0x01, 0xC0, 0x18, 0x69, ...b2(E),   // lda min; clc; adc #E
      0xAC, 0xB8, 0x10, 0xF0, 0x08,                  // ldy winner_slot; beq +8
      0xBF, 0x3C, 0x01, 0xC0, 0x38, 0xE9, ...b2(E),  // lda max; sec; sbc #E
      0x5C, 0x56, 0xDD, 0x83);                       // jml $83DD56 (sta camera)
    if (megaVis) {                                   // objects: visible for sx in -E .. 255+E
      const h4 = at();
      code.push(0x18, 0x69, ...b2(E), 0xC9, ...b2(0x100 + 2 * E), 0xB0, 0x04,   // clc; adc #E; cmp #$100+2E; bcs hide
        0x5C, 0x31, 0xDB, 0xFF, 0x5C, 0x53, 0xDB, 0xFF);                       // jml $FFDB31 (visible) / jml $FFDB53
      rom.set([0x5C, h4 & 0xFF, (h4 >> 8) & 0xFF, 0xC1, 0xEA], MEGA_VIS + 15);
    }
    if (WIDE_CODE + code.length > WIDE_END) return false;
    rom.set(code, WIDE_CODE);
    const jml = (o, a) => rom.set([0x5C, a & 0xFF, (a >> 8) & 0xFF, a >> 16], o);
    jml(0x03DF4C, h2); jml(0x03DD49, h3); jml(0x009B9E, h1);
    return true;
  }

  globalThis.KIRomFix = { stageHook, selectableEyedol, eyedolFinishers, widescreen };
})();
