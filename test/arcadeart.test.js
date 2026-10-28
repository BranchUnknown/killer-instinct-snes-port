const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const sandbox = { console };
vm.runInNewContext(fs.readFileSync(require.resolve('../js/arcadeart.js'), 'utf8'), sandbox);
const ArcadeArt = sandbox.KIArcadeArt;

function render({ meta, frame = 1, bitmap = null }) {
  const layers = [];
  const arcadeImages = [];
  const scratchContext = {
    createImageData: (width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }),
    putImageData: image => layers.push(new Uint32Array(image.data.buffer).slice()),
  };
  const scratch = { width: 0, height: 0, getContext: () => scratchContext };
  const art = new ArcadeArt();
  art.canvas = { width: 1, height: 224 };
  art.tmp = scratch;
  art.ctx = {
    setTransform() {}, clearRect() {}, save() {}, restore() {},
    drawImage(image) { if (image !== scratch) arcadeImages.push(image); },
  };
  art.state = {
    W: 1, E: 0, first: 1,
    f: [{ ok: true, type: 1, anim: 7, frame, costume: 0, sx: 0, sy: 0 }, { ok: false }],
  };
  // A pending metadata request has no obj; failed/absent animations have empty maps.
  art.meta.set(1, meta);
  art.image = () => bitmap;
  const fighterBuf = new Uint32Array(224);
  fighterBuf[0] = 0xff123456;
  const fighterId = new Uint8Array(224);
  fighterId[0] = 1;
  art.draw({ split: [true, false], fighterBuf, fighterId, frontBuf: new Uint32Array(224) });
  return { layers, arcadeImages };
}

const emptyMeta = () => ({ obj: { main: new Map(), x: new Map() } });
const validMeta = () => ({ obj: { main: new Map([[7, [{ file: 'frame.png', w: 4, y: 0 }]]]), x: new Map() } });

for (const [name, options] of [
  ['pending metadata', { meta: { obj: null } }],
  ['failed metadata or missing animation', { meta: emptyMeta() }],
  ['missing frame', { meta: validMeta(), frame: 2 }],
  ['frame zero', { meta: validMeta(), frame: 0 }],
  ['pending bitmap', { meta: validMeta(), bitmap: null }],
  ['failed bitmap', { meta: validMeta(), bitmap: false }],
]) {
  test(`keeps the SNES fighter visible with ${name}`, () => {
    const { layers, arcadeImages } = render(options);
    assert.equal(layers[0][0], 0xff123456);
    assert.equal(arcadeImages.length, 0);
  });
}

test('draws a loaded arcade frame without duplicating the SNES fighter', () => {
  const bitmap = { width: 16, height: 16 };
  const { layers, arcadeImages } = render({ meta: validMeta(), bitmap });
  assert.deepEqual(arcadeImages, [bitmap]);
  assert.equal(layers.length, 1); // Foreground only; no SNES fallback layer.
  assert.equal(layers[0][0], 0);
});
