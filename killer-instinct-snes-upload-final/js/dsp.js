// S-DSP: JavaScript port of the LakeSnes dsp.c used as the audio oracle (decomp/tools/spcref).
(function () {
  'use strict';
  const GAUSS = new Uint16Array([0x000,0x000,0x000,0x000,0x000,0x000,0x000,0x000,0x000,0x000,0x000,0x000,0x000,0x000,0x000,0x000,0x001,0x001,0x001,0x001,0x001,0x001,0x001,0x001,0x001,0x001,0x001,0x002,0x002,0x002,0x002,0x002,0x002,0x002,0x003,0x003,0x003,0x003,0x003,0x004,0x004,0x004,0x004,0x004,0x005,0x005,0x005,0x005,0x006,0x006,0x006,0x006,0x007,0x007,0x007,0x008,0x008,0x008,0x009,0x009,0x009,0x00A,0x00A,0x00A,0x00B,0x00B,0x00B,0x00C,0x00C,0x00D,0x00D,0x00E,0x00E,0x00F,0x00F,0x00F,0x010,0x010,0x011,0x011,0x012,0x013,0x013,0x014,0x014,0x015,0x015,0x016,0x017,0x017,0x018,0x018,0x019,0x01A,0x01B,0x01B,0x01C,0x01D,0x01D,0x01E,0x01F,0x020,0x020,0x021,0x022,0x023,0x024,0x024,0x025,0x026,0x027,0x028,0x029,0x02A,0x02B,0x02C,0x02D,0x02E,0x02F,0x030,0x031,0x032,0x033,0x034,0x035,0x036,0x037,0x038,0x03A,0x03B,0x03C,0x03D,0x03E,0x040,0x041,0x042,0x043,0x045,0x046,0x047,0x049,0x04A,0x04C,0x04D,0x04E,0x050,0x051,0x053,0x054,0x056,0x057,0x059,0x05A,0x05C,0x05E,0x05F,0x061,0x063,0x064,0x066,0x068,0x06A,0x06B,0x06D,0x06F,0x071,0x073,0x075,0x076,0x078,0x07A,0x07C,0x07E,0x080,0x082,0x084,0x086,0x089,0x08B,0x08D,0x08F,0x091,0x093,0x096,0x098,0x09A,0x09C,0x09F,0x0A1,0x0A3,0x0A6,0x0A8,0x0AB,0x0AD,0x0AF,0x0B2,0x0B4,0x0B7,0x0BA,0x0BC,0x0BF,0x0C1,0x0C4,0x0C7,0x0C9,0x0CC,0x0CF,0x0D2,0x0D4,0x0D7,0x0DA,0x0DD,0x0E0,0x0E3,0x0E6,0x0E9,0x0EC,0x0EF,0x0F2,0x0F5,0x0F8,0x0FB,0x0FE,0x101,0x104,0x107,0x10B,0x10E,0x111,0x114,0x118,0x11B,0x11E,0x122,0x125,0x129,0x12C,0x130,0x133,0x137,0x13A,0x13E,0x141,0x145,0x148,0x14C,0x150,0x153,0x157,0x15B,0x15F,0x162,0x166,0x16A,0x16E,0x172,0x176,0x17A,0x17D,0x181,0x185,0x189,0x18D,0x191,0x195,0x19A,0x19E,0x1A2,0x1A6,0x1AA,0x1AE,0x1B2,0x1B7,0x1BB,0x1BF,0x1C3,0x1C8,0x1CC,0x1D0,0x1D5,0x1D9,0x1DD,0x1E2,0x1E6,0x1EB,0x1EF,0x1F3,0x1F8,0x1FC,0x201,0x205,0x20A,0x20F,0x213,0x218,0x21C,0x221,0x226,0x22A,0x22F,0x233,0x238,0x23D,0x241,0x246,0x24B,0x250,0x254,0x259,0x25E,0x263,0x267,0x26C,0x271,0x276,0x27B,0x280,0x284,0x289,0x28E,0x293,0x298,0x29D,0x2A2,0x2A6,0x2AB,0x2B0,0x2B5,0x2BA,0x2BF,0x2C4,0x2C9,0x2CE,0x2D3,0x2D8,0x2DC,0x2E1,0x2E6,0x2EB,0x2F0,0x2F5,0x2FA,0x2FF,0x304,0x309,0x30E,0x313,0x318,0x31D,0x322,0x326,0x32B,0x330,0x335,0x33A,0x33F,0x344,0x349,0x34E,0x353,0x357,0x35C,0x361,0x366,0x36B,0x370,0x374,0x379,0x37E,0x383,0x388,0x38C,0x391,0x396,0x39B,0x39F,0x3A4,0x3A9,0x3AD,0x3B2,0x3B7,0x3BB,0x3C0,0x3C5,0x3C9,0x3CE,0x3D2,0x3D7,0x3DC,0x3E0,0x3E5,0x3E9,0x3ED,0x3F2,0x3F6,0x3FB,0x3FF,0x403,0x408,0x40C,0x410,0x415,0x419,0x41D,0x421,0x425,0x42A,0x42E,0x432,0x436,0x43A,0x43E,0x442,0x446,0x44A,0x44E,0x452,0x455,0x459,0x45D,0x461,0x465,0x468,0x46C,0x470,0x473,0x477,0x47A,0x47E,0x481,0x485,0x488,0x48C,0x48F,0x492,0x496,0x499,0x49C,0x49F,0x4A2,0x4A6,0x4A9,0x4AC,0x4AF,0x4B2,0x4B5,0x4B7,0x4BA,0x4BD,0x4C0,0x4C3,0x4C5,0x4C8,0x4CB,0x4CD,0x4D0,0x4D2,0x4D5,0x4D7,0x4D9,0x4DC,0x4DE,0x4E0,0x4E3,0x4E5,0x4E7,0x4E9,0x4EB,0x4ED,0x4EF,0x4F1,0x4F3,0x4F5,0x4F6,0x4F8,0x4FA,0x4FB,0x4FD,0x4FF,0x500,0x502,0x503,0x504,0x506,0x507,0x508,0x50A,0x50B,0x50C,0x50D,0x50E,0x50F,0x510,0x511,0x511,0x512,0x513,0x514,0x514,0x515,0x516,0x516,0x517,0x517,0x517,0x518,0x518,0x518,0x518,0x518,0x519,0x519]);
  const RATE = [0, 2048, 1536, 1280, 1024, 768, 640, 512, 384, 320, 256, 192, 160, 128, 96, 80,
    64, 48, 40, 32, 24, 20, 16, 12, 10, 8, 6, 5, 4, 3, 2, 1];
  const s8 = (v) => (v << 24) >> 24, s16 = (v) => (v << 16) >> 16;
  const clamp16 = (v) => v < -0x8000 ? -0x8000 : v > 0x7FFF ? 0x7FFF : v;

  function Channel() {
    this.pitch = 0; this.pitchCounter = 0; this.pitchModulation = false;
    this.decodeBuffer = new Int16Array(19); this.srcn = 0; this.decodeOffset = 0; this.previousFlags = 0;
    this.old = 0; this.older = 0; this.useNoise = false;
    this.adsrRates = new Uint16Array(4); this.rateCounter = 0; this.adsrState = 0; this.sustainLevel = 0;
    this.useGain = false; this.gainMode = 0; this.directGain = false; this.gainValue = 0; this.gain = 0;
    this.keyOn = false; this.keyOff = false; this.sampleOut = 0; this.volumeL = 0; this.volumeR = 0; this.echoEnable = false;
  }

  class DSP {
    constructor(aram) { this.aram = aram; this.reset(); }
    reset() {
      this.ram = new Uint8Array(0x80); this.ram[0x7C] = 0xFF;
      this.ch = []; for (let i = 0; i < 8; i++) this.ch.push(new Channel());
      this.dirPage = 0; this.evenCycle = false; this.mute = true; this.resetF = true;
      this.masterVolumeL = 0; this.masterVolumeR = 0;
      this.noiseSample = -0x4000; this.noiseRate = 0; this.noiseCounter = 0;
      this.echoWrites = false; this.echoVolumeL = 0; this.echoVolumeR = 0; this.feedbackVolume = 0;
      this.echoBufferAdr = 0; this.echoDelay = 1; this.echoRemain = 1; this.echoBufferIndex = 0;
      this.firBufferIndex = 0; this.firValues = new Int8Array(8);
      this.firBufferL = new Int16Array(8); this.firBufferR = new Int16Array(8);
      this.outL = 0; this.outR = 0;
    }

    // one 32 kHz sample -> this.outL / this.outR
    cycle() {
      let totalL = 0, totalR = 0;
      for (let i = 0; i < 8; i++) {
        this.cycleChannel(i);
        const c = this.ch[i];
        totalL = clamp16(totalL + ((c.sampleOut * c.volumeL) >> 6));
        totalR = clamp16(totalR + ((c.sampleOut * c.volumeR) >> 6));
      }
      totalL = clamp16((totalL * this.masterVolumeL) >> 7);
      totalR = clamp16((totalR * this.masterVolumeR) >> 7);
      const o = this.handleEcho(totalL, totalR);
      totalL = o[0]; totalR = o[1];
      if (this.mute) { totalL = 0; totalR = 0; }
      this.handleNoise();
      this.outL = totalL; this.outR = totalR;
      this.evenCycle = !this.evenCycle;
    }

    handleEcho(outputL, outputR) {
      const ar = this.aram;
      const adr = (this.echoBufferAdr + this.echoBufferIndex * 4) & 0xFFFF;
      const fi = this.firBufferIndex;
      this.firBufferL[fi] = s16(ar[adr] + (ar[(adr + 1) & 0xFFFF] << 8)) >> 1;
      this.firBufferR[fi] = s16(ar[(adr + 2) & 0xFFFF] + (ar[(adr + 3) & 0xFFFF] << 8)) >> 1;
      let sumL = 0, sumR = 0;
      for (let i = 0; i < 8; i++) {
        sumL += (this.firBufferL[(fi + i + 1) & 7] * this.firValues[i]) >> 6;
        sumR += (this.firBufferR[(fi + i + 1) & 7] * this.firValues[i]) >> 6;
        if (i === 6) { sumL = s16(sumL & 0xFFFF); sumR = s16(sumR & 0xFFFF); }
      }
      sumL = clamp16(sumL); sumR = clamp16(sumR);
      const oL = clamp16(outputL + ((sumL * this.echoVolumeL) >> 7));
      const oR = clamp16(outputR + ((sumR * this.echoVolumeR) >> 7));
      let inL = 0, inR = 0;
      for (let i = 0; i < 8; i++) {
        const c = this.ch[i];
        if (c.echoEnable) {
          inL = clamp16(inL + ((c.sampleOut * c.volumeL) >> 6));
          inR = clamp16(inR + ((c.sampleOut * c.volumeR) >> 6));
        }
      }
      inL = clamp16(inL + ((sumL * this.feedbackVolume) >> 7));
      inR = clamp16(inR + ((sumR * this.feedbackVolume) >> 7));
      inL &= 0xFFFE; inR &= 0xFFFE;
      if (this.echoWrites) {
        ar[adr] = inL & 0xFF; ar[(adr + 1) & 0xFFFF] = (inL >> 8) & 0xFF;
        ar[(adr + 2) & 0xFFFF] = inR & 0xFF; ar[(adr + 3) & 0xFFFF] = (inR >> 8) & 0xFF;
      }
      this.firBufferIndex = (fi + 1) & 7;
      this.echoBufferIndex = (this.echoBufferIndex + 1) & 0xFFFF;
      this.echoRemain = (this.echoRemain - 1) & 0xFFFF;
      if (this.echoRemain === 0) { this.echoRemain = this.echoDelay; this.echoBufferIndex = 0; }
      return [oL, oR];
    }

    cycleChannel(n) {
      const c = this.ch[n];
      let pitch = c.pitch;
      if (n > 0 && c.pitchModulation) {
        const factor = (this.ch[n - 1].sampleOut >> 4) + 0x400;
        pitch = ((pitch * factor) >> 10) & 0xFFFF;
        if (pitch > 0x3FFF) pitch = 0x3FFF;
      }
      const newCounter = c.pitchCounter + pitch;
      if (newCounter > 0xFFFF) this.decodeBrr(n);
      c.pitchCounter = newCounter & 0xFFFF;
      let sample;
      if (c.useNoise) sample = this.noiseSample;
      else sample = this.getSample(c, c.pitchCounter >> 12, (c.pitchCounter >> 4) & 0xFF);
      if (this.resetF) { c.adsrState = 4; c.gain = 0; }
      const doingDirectGain = c.adsrState !== 4 && c.useGain && c.directGain;
      const rate = c.adsrState === 4 ? 0 : c.adsrRates[c.adsrState];
      if (c.adsrState !== 4 && !doingDirectGain && rate !== 0) c.rateCounter = (c.rateCounter + 1) & 0xFFFF;
      if (c.adsrState === 4 || (!doingDirectGain && c.rateCounter >= rate && rate !== 0)) {
        if (c.adsrState !== 4) c.rateCounter = 0;
        this.handleGain(c);
      }
      if (doingDirectGain) c.gain = c.gainValue;
      this.ram[(n << 4) | 8] = c.gain >> 4;
      sample = s16((sample * c.gain) >> 11);
      this.ram[(n << 4) | 9] = (sample >> 7) & 0xFF;
      c.sampleOut = sample;
    }

    handleGain(c) {
      switch (c.adsrState) {
        case 0: {
          const rate = c.adsrRates[0];
          c.gain = (c.gain + (rate === 1 ? 1024 : 32)) & 0xFFFF;
          if (c.gain >= 0x7E0) c.adsrState = 1;
          if (c.gain > 0x7FF) c.gain = 0x7FF;
          break;
        }
        case 1:
          c.gain = (c.gain - (((c.gain - 1) >> 8) + 1)) & 0xFFFF;
          if (c.gain < c.sustainLevel) c.adsrState = 2;
          break;
        case 2:
          c.gain = (c.gain - (((c.gain - 1) >> 8) + 1)) & 0xFFFF;
          break;
        case 3:
          switch (c.gainMode) {
            case 0: c.gain = (c.gain - 32) & 0xFFFF; if (c.gain > 0x7FF) c.gain = 0; break;
            case 1: c.gain = (c.gain - (((c.gain - 1) >> 8) + 1)) & 0xFFFF; break;
            case 2: c.gain += 32; if (c.gain > 0x7FF) c.gain = 0x7FF; break;
            case 3: c.gain += c.gain < 0x600 ? 32 : 8; if (c.gain > 0x7FF) c.gain = 0x7FF; break;
          }
          break;
        case 4:
          c.gain = (c.gain - 8) & 0xFFFF; if (c.gain > 0x7FF) c.gain = 0;
          break;
      }
    }

    getSample(c, sampleNum, offset) {
      const b = c.decodeBuffer;
      const news = b[sampleNum + 3], olds = b[sampleNum + 2], olders = b[sampleNum + 1], oldests = b[sampleNum];
      let out = (GAUSS[0xFF - offset] * oldests) >> 10;
      out += (GAUSS[0x1FF - offset] * olders) >> 10;
      out += (GAUSS[0x100 + offset] * olds) >> 10;
      out = s16(out & 0xFFFF);
      out += (GAUSS[offset] * news) >> 10;
      return clamp16(out) >> 1;
    }

    decodeBrr(n) {
      const c = this.ch[n], ar = this.aram, b = c.decodeBuffer;
      b[0] = b[16]; b[1] = b[17]; b[2] = b[18];
      if (c.previousFlags === 1 || c.previousFlags === 3) {
        const sp = (this.dirPage + 4 * c.srcn) & 0xFFFF;
        c.decodeOffset = ar[(sp + 2) & 0xFFFF] | (ar[(sp + 3) & 0xFFFF] << 8);
        if (c.previousFlags === 1) { c.adsrState = 4; c.gain = 0; }
        this.ram[0x7C] |= 1 << n;
      }
      const header = ar[c.decodeOffset]; c.decodeOffset = (c.decodeOffset + 1) & 0xFFFF;
      const shift = header >> 4, filter = (header & 0xC) >> 2;
      c.previousFlags = header & 3;
      let cur = 0, old = c.old, older = c.older;
      for (let i = 0; i < 16; i++) {
        let s;
        if (i & 1) s = cur & 0xF;
        else { cur = ar[c.decodeOffset]; c.decodeOffset = (c.decodeOffset + 1) & 0xFFFF; s = cur >> 4; }
        if (s > 7) s -= 16;
        if (shift <= 0xC) s = (s << shift) >> 1; else s = (s >> 3) << 12;
        switch (filter) {
          case 1: s += old + (-old >> 4); break;
          case 2: s += 2 * old + ((3 * -old) >> 5) - older + (older >> 4); break;
          case 3: s += 2 * old + ((13 * -old) >> 6) - older + ((3 * older) >> 4); break;
        }
        s = clamp16(s);
        s = s16((s & 0x7FFF) << 1) >> 1;
        older = old; old = s;
        b[i + 3] = s;
      }
      c.older = older; c.old = old;
    }

    handleNoise() {
      if (this.noiseRate !== 0) this.noiseCounter++;
      if (this.noiseCounter >= this.noiseRate && this.noiseRate !== 0) {
        const bit = (this.noiseSample & 1) ^ ((this.noiseSample >> 1) & 1);
        this.noiseSample = ((this.noiseSample >> 1) & 0x3FFF) | (bit << 14);
        this.noiseSample = s16((this.noiseSample & 0x7FFF) << 1) >> 1;
        this.noiseCounter = 0;
      }
    }

    read(a) { return this.ram[a & 0x7F]; }

    write(adr, val) {
      adr &= 0x7F;
      const n = adr >> 4, c = this.ch[n & 7];
      switch (adr & 0x0F) {
        case 0x00: c.volumeL = s8(val); break;
        case 0x01: c.volumeR = s8(val); break;
        case 0x02: c.pitch = (c.pitch & 0x3F00) | val; break;
        case 0x03: c.pitch = ((c.pitch & 0x00FF) | (val << 8)) & 0x3FFF; break;
        case 0x04: c.srcn = val; break;
        case 0x05:
          c.adsrRates[0] = RATE[(val & 0xF) * 2 + 1];
          c.adsrRates[1] = RATE[((val & 0x70) >> 4) * 2 + 16];
          c.useGain = (val & 0x80) === 0;
          break;
        case 0x06:
          c.adsrRates[2] = RATE[val & 0x1F];
          c.sustainLevel = (((val & 0xE0) >> 5) + 1) * 0x100;
          break;
        case 0x07:
          c.directGain = (val & 0x80) === 0;
          if (val & 0x80) { c.gainMode = (val & 0x60) >> 5; c.adsrRates[3] = RATE[val & 0x1F]; }
          else c.gainValue = (val & 0x7F) * 16;
          break;
        case 0x0F: this.firValues[n] = s8(val); break;
        case 0x0C:
          switch (adr) {
            case 0x0C: this.masterVolumeL = s8(val); break;
            case 0x1C: this.masterVolumeR = s8(val); break;
            case 0x2C: this.echoVolumeL = s8(val); break;
            case 0x3C: this.echoVolumeR = s8(val); break;
            case 0x4C:
              for (let i = 0; i < 8; i++) {
                if (val & (1 << i)) {
                  const k = this.ch[i];
                  k.previousFlags = 0;
                  const sp = (this.dirPage + 4 * k.srcn) & 0xFFFF;
                  k.decodeOffset = this.aram[sp] | (this.aram[(sp + 1) & 0xFFFF] << 8);
                  k.decodeBuffer.fill(0);
                  k.gain = 0;
                  k.adsrState = k.useGain ? 3 : 0;
                }
              }
              break;
            case 0x5C:
              for (let i = 0; i < 8; i++) if (val & (1 << i)) this.ch[i].adsrState = 4;
              break;
            case 0x6C:
              this.resetF = (val & 0x80) !== 0; this.mute = (val & 0x40) !== 0;
              this.echoWrites = (val & 0x20) === 0; this.noiseRate = RATE[val & 0x1F];
              break;
            case 0x7C: val = 0; break;
          }
          break;
        case 0x0D:
          switch (adr) {
            case 0x0D: this.feedbackVolume = s8(val); break;
            case 0x2D: for (let i = 0; i < 8; i++) this.ch[i].pitchModulation = (val & (1 << i)) !== 0; break;
            case 0x3D: for (let i = 0; i < 8; i++) this.ch[i].useNoise = (val & (1 << i)) !== 0; break;
            case 0x4D: for (let i = 0; i < 8; i++) this.ch[i].echoEnable = (val & (1 << i)) !== 0; break;
            case 0x5D: this.dirPage = val << 8; break;
            case 0x6D: this.echoBufferAdr = val << 8; break;
            case 0x7D: this.echoDelay = (val & 0xF) * 512; if (this.echoDelay === 0) this.echoDelay = 1; break;
          }
          break;
      }
      this.ram[adr] = val;
    }
  }
  globalThis.KIDSP = DSP;
})();
