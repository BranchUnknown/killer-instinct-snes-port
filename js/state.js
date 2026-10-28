// Machine snapshots: copies every number / typed array reachable from the system object (skipping
// the ROM, lookup tables and callbacks) and writes them back into the same live objects.
// Taken between frames only. The MSU-1 player is saved through its own snap()/restoreSnap().
(function () {
  'use strict';
  const SKIP = new Set(['rom', 'rgb', 'bus', 'onBreak', 'hvSource', 'dspWrite', 'files', 'ring', 'lpix', 'lpri', 'win',
    'tmpRow', 'msu', 'mixBuf', 'frame', 'wramRef', 'pxState', 'parallax']);

  function save(o, seen) {
    seen.add(o);
    const r = {};
    for (const k of Object.keys(o)) {
      if (k === 'msu' && o[k] && o[k].snap) { if (!seen.has(o[k])) { seen.add(o[k]); r.__msu = o[k].snap(); } continue; }
      if (SKIP.has(k)) continue;
      const v = o[k];
      if (typeof v === 'function') continue;
      if (v === null || typeof v !== 'object') { r[k] = v; continue; }
      if (seen.has(v)) continue;
      if (ArrayBuffer.isView(v)) { seen.add(v); r[k] = v.slice(); continue; }
      r[k] = save(v, seen);
      r[k].__arr = Array.isArray(v);
    }
    return r;
  }
  function restore(o, r) {
    for (const k of Object.keys(r)) {
      if (k === '__arr') continue;
      if (k === '__msu') { if (o.msu && o.msu.restoreSnap) o.msu.restoreSnap(r[k]); continue; }
      const v = r[k], cur = o[k];
      if (v === null || typeof v !== 'object') { o[k] = v; continue; }
      if (ArrayBuffer.isView(v)) { if (cur && cur.length === v.length) cur.set(v); else o[k] = v.slice(); continue; }
      if (cur && typeof cur === 'object') restore(cur, v);
      else { const n = v.__arr ? [] : {}; restore(n, v); o[k] = n; }
    }
  }
  globalThis.KIState = { save: (s) => save(s, new Set()), restore };
})();
