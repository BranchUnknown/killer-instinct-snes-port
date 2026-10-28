// Presents the 256x224 frame. WebGL with the screen filters from Battlemage (js/ui/scanlines.js):
//   off    - sharp pixels
//   soft   - dark scanline every SNES line (18%) + vignette
//   strong - same at 34% + stronger vignette
//   crt    - RGB phosphor mask that multiplies the picture (3x3 device-pixel tile, stripes 0.84,
//            gap row 0.8), phosphor glow (blurred, brightened copy at 26%), shimmer (mask cells
//            drifting ~9 times a second, soft-light, brighter centre), a faint band rolling down
//            every 9 s, brightness 1.16 / contrast 1.05 / saturation 1.06, rounded shaded tube corners.
// Everything happens in one fragment shader on the GPU (the CSS version is heavy on slow PCs).
// Falls back to a plain 2D canvas when WebGL is not available.
(function () {
  'use strict';

  const VS = `attribute vec2 p; varying vec2 uv;
    void main() { uv = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5); gl_Position = vec4(p, 0.0, 1.0); }`;

  const FS = `precision mediump float;
    varying vec2 uv;
    uniform sampler2D tex;
    uniform vec2 src;        // 256, 224
    uniform vec2 dst;        // output size in device pixels
    uniform int mode;        // 0 off, 1 soft, 2 strong, 3 crt
    uniform float time;      // seconds
    uniform float cell;      // device pixels per mask cell column (1..)
    float hash(vec2 v) { return fract(sin(dot(v, vec2(12.9898, 78.233))) * 43758.5453); }
    vec3 softlight(vec3 b, float s) {   // s: 0..1, 0.5 = no change (W3C soft-light)
      vec3 d = mix(sqrt(b), ((16.0 * b - 12.0) * b + 4.0) * b, step(b, vec3(0.25)));
      return s <= 0.5 ? b - (1.0 - 2.0 * s) * b * (1.0 - b) : b + (2.0 * s - 1.0) * (d - b);
    }
    void main() {
      vec2 st = uv * src;
      vec3 c = texture2D(tex, (floor(st) + 0.5) / src).rgb;
      if (mode == 0) { gl_FragColor = vec4(c, 1.0); return; }
      vec2 q = uv - 0.5;
      if (mode < 3) {
        // a dark line on the bottom third of every SNES scanline (CRT beam gap)
        float k = mode == 1 ? 0.18 : 0.34;
        float vig = mode == 1 ? 0.18 : 0.30;
        float row = fract(st.y);
        c *= 1.0 - k * smoothstep(0.62, 0.72, row);
        float r = length(q * vec2(1.0, 1.0)) / 0.7071;
        c *= 1.0 - vig * smoothstep(0.55, 1.0, r);
        gl_FragColor = vec4(c, 1.0); return;
      }
      // --- CRT ---
      // glow: blurred copy (2.5 css px ~ 0.9 source px), brightened 1.25, saturated 1.3, 26%
      vec2 o = 0.9 / src;
      vec3 g = vec3(0.0);
      g += texture2D(tex, uv + vec2(-o.x, -o.y)).rgb; g += texture2D(tex, uv + vec2(0.0, -o.y)).rgb * 2.0;
      g += texture2D(tex, uv + vec2(o.x, -o.y)).rgb;  g += texture2D(tex, uv + vec2(-o.x, 0.0)).rgb * 2.0;
      g += c * 4.0;                                   g += texture2D(tex, uv + vec2(o.x, 0.0)).rgb * 2.0;
      g += texture2D(tex, uv + vec2(-o.x, o.y)).rgb;  g += texture2D(tex, uv + vec2(0.0, o.y)).rgb * 2.0;
      g += texture2D(tex, uv + vec2(o.x, o.y)).rgb;
      g = g / 16.0 * 1.25;
      float gl = dot(g, vec3(0.299, 0.587, 0.114)); g = mix(vec3(gl), g, 1.3);
      c = mix(c, clamp(g, 0.0, 1.0), 0.26);
      // shimmer: one value per 3x3 mask cell, partly re-rolled ~9 times a second, hot centre
      vec2 fc = gl_FragCoord.xy;
      vec2 cellId = floor(fc / (3.0 * cell));
      float tick = floor(time * 9.0);
      float n = hash(cellId + floor(hash(cellId) * 13.0 + tick * 0.07) * 7.31) * 2.0 - 1.0;
      float rr = sqrt(q.x * q.x * 2.2 + q.y * q.y * 3.0);
      float wob = (hash(vec2(tick, 3.7)) * 2.0 - 1.0) * 2.5;
      float sh = (128.0 + 16.0 * max(0.0, 1.0 - rr * 1.4) - 6.0 * min(1.0, rr) + n * 14.0 + wob) / 255.0;
      c = softlight(clamp(c, 0.0, 1.0), clamp(sh, 0.0, 1.0));
      // phosphor mask, multiplied
      float mx = mod(floor(fc.x / cell), 3.0), my = mod(floor((dst.y - fc.y) / cell), 3.0);
      vec3 m = vec3(0.84);
      if (mx < 0.5) m.r = 1.0; else if (mx < 1.5) m.g = 1.0; else m.b = 1.0;
      if (my > 1.5) m *= 0.8;
      c *= m;
      // rolling band: 28% of the height, white 0.35 peak, soft-light, 9 s period
      float bandY = fract(time / 9.0) * 1.28 - 0.28;
      float bt = (uv.y - bandY) / 0.28;
      if (bt > 0.0 && bt < 1.0) { float a = 0.35 * (1.0 - abs(bt * 2.0 - 1.0)); c = softlight(c, 0.5 + 0.5 * a); }
      // tube: brightness / contrast / saturation boost
      c *= 1.16; c = (c - 0.5) * 1.05 + 0.5;
      float l = dot(c, vec3(0.299, 0.587, 0.114)); c = mix(vec3(l), c, 1.06);
      // rounded corners (4.5% / 6.5%) with inner edge shading
      vec2 rad = vec2(0.045, 0.065);
      vec2 d = max(abs(q) - (0.5 - rad), 0.0) / rad;
      float corner = length(d);
      if (corner > 1.0) { gl_FragColor = vec4(0.02, 0.02, 0.03, 1.0); return; }
      vec2 e = min(uv, 1.0 - uv) * dst;                     // distance to the edge in device px
      float edge = min(e.x, e.y);
      c *= 1.0 - 0.5 * (1.0 - smoothstep(0.0, 12.0, edge)) - 0.18 * (1.0 - smoothstep(0.0, 36.0, edge));
      c *= 1.0 - 0.5 * smoothstep(0.85, 1.0, corner);
      c += 0.04 * max(0.0, 1.0 - length((uv - vec2(0.28, 0.18)) / vec2(0.38, 0.38)));
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }`;

  class Video {
    constructor(canvas, opts) {
      opts = opts || {};
      this.canvas = canvas;
      this.mode = 0;
      this.t0 = performance.now();
      // refuse software WebGL: drawing the shader on the CPU costs far more than the whole emulator
      const gl = canvas.getContext('webgl', { alpha: false, antialias: false, preserveDrawingBuffer: false,
        powerPreference: 'high-performance', failIfMajorPerformanceCaveat: !opts.allowSoftware });
      this.gl = gl;
      if (gl) {
        try { this.initGL(); } catch (e) { console.warn('webgl', e); this.gl = null; }
      }
      this.renderer = 'canvas 2D';
      if (this.gl) {
        try {
          const ext = this.gl.getExtension('WEBGL_debug_renderer_info');
          this.renderer = 'WebGL: ' + (ext ? this.gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'GPU');
          this.software = /swiftshader|software|llvmpipe|basic render/i.test(this.renderer);
        } catch (e) { /* ignore */ }
      }
      if (!this.gl) {
        this.c2 = canvas.getContext('2d');
        this.img = this.c2.createImageData(256, 224);
      }
      this.bytes = null;
      this.srcW = 256;
    }
    initGL() {
      const gl = this.gl;
      const sh = (type, src) => {
        const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        return s;
      };
      const pr = gl.createProgram();
      gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(pr);
      if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
      gl.useProgram(pr);
      this.pr = pr;
      const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(pr, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      this.tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 224, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      this.u = {};
      for (const n of ['src', 'dst', 'mode', 'time', 'cell']) this.u[n] = gl.getUniformLocation(pr, n);
      gl.uniform2f(this.u.src, 256, 224);
    }
    // css size of the picture; the backing store follows the device pixel ratio
    resize(cssW, cssH) {
      const dpr = window.devicePixelRatio || 1;
      this.canvas.style.width = cssW + 'px'; this.canvas.style.height = cssH + 'px';
      this.cssW = cssW; this.cssH = cssH;
      if (this.gl && this.mode !== 0) {
        // filters need real device pixels; cap the size so big/HiDPI screens stay cheap
        const k = Math.min(dpr, (this.software ? 700 : 1200) / cssH);   // software GL: fewer pixels to shade
        this.canvas.width = Math.round(cssW * k); this.canvas.height = Math.round(cssH * k);
        this.dpr = k;
      } else {
        // no filter: draw the native picture and let the browser scale it (pixelated)
        this.canvas.width = this.srcW || 256; this.canvas.height = 224; this.dpr = 1;
      }
      if (this.gl) this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    }
    setSrc(w) {
      this.srcW = w;
      if (this.gl) {
        const gl = this.gl;
        gl.bindTexture(gl.TEXTURE_2D, this.tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, 224, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.uniform2f(this.u.src, w, 224);
      } else {
        this.img = this.c2.createImageData(w, 224);
        if (this.mode === 0 || !this.gl) { this.canvas.width = w; this.canvas.height = 224; }
      }
      if (this.cssW) this.resize(this.cssW, this.cssH);
    }
    draw(frame) {
      const w = (frame.length / 224) | 0;
      if (w !== this.srcW) this.setSrc(w);
      if (!this.gl) {
        this.img.data.set(new Uint8ClampedArray(frame.buffer, frame.byteOffset, frame.length * 4));
        this.c2.putImageData(this.img, 0, 0);
        return;
      }
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.srcW, 224, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(frame.buffer, frame.byteOffset, frame.length * 4));
      gl.uniform2f(this.u.dst, this.canvas.width, this.canvas.height);
      gl.uniform1i(this.u.mode, this.mode);
      gl.uniform1f(this.u.time, (performance.now() - this.t0) / 1000);
      gl.uniform1f(this.u.cell, Math.max(1, Math.round(this.dpr || 1)));
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }
  Video.MODES = ['off', 'soft', 'strong', 'crt'];
  globalThis.KIVideo = Video;
})();
