// MSU-1 (for the Arcade MegaPatch): data port + CD-quality audio tracks.
//   write $2000-$2003 data seek (seek on $2003), $2004-$2005 track (load on $2005),
//         $2006 volume, $2007 control (bit 0 play, bit 1 repeat, bit 2 resume)
//   read  $2000 status (7 data busy, 6 audio busy, 5 repeat, 4 playing, 3 track missing, 0-2 revision)
//         $2001 data byte (auto-increment), $2002-$2007 "S-MSU1"
// Tracks: <name>-<n>.pcm = "MSU1", u32 loop sample, then 44.1 kHz 16-bit stereo LE.
(function () {
  'use strict';
  const ID = [0x53, 0x2D, 0x4D, 0x53, 0x55, 0x31];

  class MSU1 {
    constructor(files) {
      // files: { data: Uint8Array|null, track(n) -> Promise<ArrayBuffer|null> }
      this.files = files;
      this.reset();
    }
    reset() {
      this.seek = 0; this.offset = 0; this.seekLatch = 0;
      this.trackLatch = 0; this.track = -1; this.pcm = null; this.loop = 0;
      this.vol = 255; this.playing = false; this.repeat = false; this.missing = false;
      this.audioBusy = false; this.pos = 0; this.frac = 0; this.resumePos = new Map();
      this.req = 0;
    }
    read(a) {
      switch (a & 7) {
        case 0: return (this.audioBusy ? 0x40 : 0) | (this.repeat ? 0x20 : 0) | (this.playing ? 0x10 : 0) | (this.missing ? 0x08 : 0) | 2;
        case 1: {
          const d = this.files.data;
          const v = d && this.offset < d.length ? d[this.offset] : 0;
          this.offset++;
          return v;
        }
        default: return ID[(a & 7) - 2];
      }
    }
    write(a, v) {
      switch (a & 7) {
        case 0: this.seekLatch = (this.seekLatch & 0xFFFFFF00) | v; break;
        case 1: this.seekLatch = (this.seekLatch & 0xFFFF00FF) | (v << 8); break;
        case 2: this.seekLatch = (this.seekLatch & 0xFF00FFFF) | (v << 16); break;
        case 3: this.seekLatch = ((this.seekLatch & 0x00FFFFFF) | (v << 24)) >>> 0; this.offset = this.seekLatch; break;
        case 4: this.trackLatch = (this.trackLatch & 0xFF00) | v; break;
        case 5: this.trackLatch = (this.trackLatch & 0x00FF) | (v << 8); this.loadTrack(this.trackLatch); break;
        case 6: this.vol = v; break;
        case 7: {
          if (this.audioBusy) break;
          const play = (v & 1) !== 0;
          if (this.playing && !play && this.track >= 0) this.resumePos.set(this.track, this.pos);
          this.repeat = (v & 2) !== 0;
          if (play && !this.playing && (v & 4) && this.resumePos.has(this.track)) this.pos = this.resumePos.get(this.track);
          this.playing = play && !!this.pcm;
          break;
        }
      }
    }
    loadTrack(n) {
      if (this.playing && this.track >= 0) this.resumePos.set(this.track, this.pos);
      this.playing = false; this.audioBusy = true; this.missing = false;
      this.track = n; this.pcm = null; this.pos = 0; this.frac = 0;
      const req = ++this.req;
      Promise.resolve(this.files.track(n)).then((buf) => {
        if (req !== this.req) return;
        if (buf && buf.byteLength >= 8 && new Uint8Array(buf, 0, 4).every((c, i) => c === [0x4D, 0x53, 0x55, 0x31][i])) {
          this.loop = new DataView(buf).getUint32(4, true);
          this.pcm = new Int16Array(buf, 8, ((buf.byteLength - 8) >> 2) * 2);
        } else this.missing = true;
        this.audioBusy = false;
      }).catch(() => { if (req === this.req) { this.missing = true; this.audioBusy = false; } });
    }
    // state for machine snapshots (KIState): the track is reloaded and seeked on restore, so Restart /
    // Reselect / Quit bring the music back to where the game was, not the track that was playing last
    snap() {
      return { seek: this.seek, offset: this.offset, seekLatch: this.seekLatch, trackLatch: this.trackLatch, track: this.track,
        vol: this.vol, playing: this.playing, repeat: this.repeat, missing: this.missing, pos: this.pos, frac: this.frac,
        resumePos: [...this.resumePos] };
    }
    restoreSnap(st) {
      const apply = () => {
        this.seek = st.seek; this.offset = st.offset; this.seekLatch = st.seekLatch; this.trackLatch = st.trackLatch;
        this.vol = st.vol; this.repeat = st.repeat; this.pos = st.pos; this.frac = st.frac;
        this.resumePos = new Map(st.resumePos); this.playing = st.playing && !!this.pcm;
      };
      if (st.track < 0) { this.req++; this.track = -1; this.pcm = null; this.audioBusy = false; this.missing = st.missing; apply(); this.playing = false; return; }
      if (st.track === this.track && this.pcm && !this.audioBusy) { apply(); return; }
      this.loadTrack(st.track); apply(); this.playing = false;
      const req = this.req, want = st.playing;
      const wait = () => {                      // finish once the track has loaded (loadTrack is async)
        if (req !== this.req) return;
        if (this.audioBusy) { setTimeout(wait, 5); return; }
        this.pos = st.pos; this.frac = st.frac; this.playing = want && !!this.pcm;
      };
      wait();
    }
    // one 32 kHz output sample -> [l, r] added into out (floats)
    mix(out) {
      if (!this.playing || !this.pcm) return;
      const p = this.pcm, n = p.length >> 1;
      const i = this.pos;
      if (i >= n) {
        if (this.repeat && this.loop < n) { this.pos = this.loop; this.frac = 0; }
        else { this.playing = false; return; }
      }
      const g = this.vol / 255 / 32768, f = this.frac, j = this.pos * 2, k = this.pos + 1 < n ? j + 2 : j;
      out[0] += (p[j] * (1 - f) + p[k] * f) * g; out[1] += (p[j + 1] * (1 - f) + p[k + 1] * f) * g;
      this.frac += 44100 / 32000;
      while (this.frac >= 1) { this.frac -= 1; this.pos++; }
    }
  }
  globalThis.KIMSU1 = MSU1;
})();
