# Killer Instinct (SNES) - browser port

Plays Killer Instinct in a web browser from **your own cartridge dump** (USA v1.1, 4 MB,
CRC32 `09E9A04E`). The ROM is read locally and never leaves the device; nothing from the
cartridge is shipped with the port.

## Play

* **Windows (recommended):** put your v1.1 ROM (`.sfc`/`.smc`) in this folder, and the MegaPatch
  folder (`ki_msu`, with `ki.msu`, the `ki-N.pcm` tracks and `ki.sfc` or `patch.ips`) next to it,
  then double-click **`Play Killer Instinct.bat`**. It starts a tiny local web server
  (`serve.ps1`, http://localhost:8642/) and opens the browser; the port finds the ROM and the
  MegaPatch by itself. Running from the server is also what lets the browser keep saved data
  (battery saves, stage pictures, the remembered ROM). Close the black window to stop it.
* You can also double-click `index.html` (or `dist/ki-port.html`, the same thing in one file).
  Chrome or Edge recommended. Choose the ROM (or drag it onto the page); some saved data (battery
  saves are kept, the remembered ROM and stage pictures are not) does not survive when opened this way.
* Menu settings and the game's own Options screen (difficulty, combo breakers, timer, button
  layouts) are kept between sessions.
* **Press a key, click or tap** on the start screen. This also switches the sound on; browsers do
  not count a gamepad press for that, so if you start with the controller and hear nothing, press
  any key or click once (a hint appears at the bottom of the screen).
* **Arcade fighters** (Menu, under the screen filter): in fights the fighters are drawn with the arcade
  game's own sprites, 4x upscaled (`ki-arcade/out/art/kinst/fighters_4x` and `fighters_c1_4x` ..
  `fighters_c5_4x` for the other colours). From `Play Killer Instinct.bat` the art is found by itself
  (`serve.ps1` serves `ki-arcade/out/art` as `/arcade/`); opened as a file, choose the
  `ki-arcade/out/art/kinst` folder. The HUD and foreground stay in front, frames still loading show
  the SNES sprite for that frame. Not carried over: palette flashes (hit flash, Shadow glow), the
  fighters' floor reflections, and the screen filters (the arcade fighters are drawn sharp on top).
  How it is placed: js/arcadeart.js (fitted with test/arcade_probe.js + test/arcade_fit2.py).
* **Esc** (or the Menu button, or the controller's Guide button) opens the menu: volume, 4:3 /
  square pixels, fullscreen (F11), reset, and **button remapping** for keyboard and controller.

### Controls (from `KI Web controls.txt`)

| SNES | Keyboard | Xbox controller | KI |
|---|---|---|---|
| D-pad | W A S D | D-pad / left stick | move |
| R | N | RB | quick punch |
| Y | J | X | medium punch |
| X | I | Y | fierce punch |
| L | M | LB | quick kick |
| B | K | A | medium kick |
| A | O | B | fierce kick |
| Start | Enter | Start | |
| Select | Right Shift / Backspace | View | |

Player 2: a second controller, or arrow keys + numpad (4/5/6 = Y/X/R, 1/2/3 = B/A/L,
Numpad Enter = Start). Phones/tablets get on-screen buttons (switchable in the menu).

On Android the Xbox pad's X/Y may arrive swapped (see the BFPort notes); if so, swap them in the
menu once; the mapping is saved in the browser.

## How it works

| part | file | what |
|---|---|---|
| CPU | `js/cpu.js` | 65816 core running the game's code from the ROM |
| system | `js/snes.js` | HiROM/FastROM map, I/O, multiply/divide, DMA + HDMA, joypads, scanline timing (NMI at line 225, HDMA at H=1104) |
| video | `js/ppu.js` | scanline PPU: modes 0-7, mode 7 matrix, sprites (32/34 limits), windows, colour math, mosaic, brightness |
| sound driver | `js/driver.js` | KI's SPC700 driver reimplemented natively (1:1 with `decomp/tools/kidriver.py`) |
| sound chip | `js/dsp.js` | S-DSP, JavaScript port of the LakeSnes DSP used by the PS2 ports |
| APU ports | `js/apu.js` | boot-ROM / loader / driver handshakes, with the real SPC timing (measured) |
| app | `js/main.js`, `js/input.js` | ROM check + IndexedDB, start screen, audio worklet, frame pacing on the audio clock, input, menu |

## Verification (`test/`, Node 18+)

* `node test/driver_test.js`: the JS driver against 85 reference logs of the real driver on
  LakeSnes (songs, all SFX, sub-songs, uploads, song changes): identical DSP writes.
* `node test/dsp_test.js`: the JS DSP against LakeSnes, every 32 kHz sample of 21 s of music:
  0 mismatches.
* `node test/cmpref.js 600`: WRAM/OAM/VRAM/CGRAM against a BizHawk run with the same input
  (`decomp/lua/port_ref.lua`): OAM, VRAM, CGRAM identical at the main menu.
* `node test/pixcmp.js ...`: pixel comparison with BizHawk screenshots at WRAM-aligned frames
  (Mode 7 Nintendo zoom, VS screen: 0 pixels differ).
* `node test/stages.js`: all forced stages at the end of FightInit: CGRAM identical.
* `node test/sheet.js`, `test/tour.js`: contact sheets (all 17 stages, attract mode).
* `node test/mash.js 30000`: random-input stress (fights, SFX, on-demand samples, song changes).
* `node test/timeline.js 1400`: screen-change frames vs BizHawk (loading times match within 1 frame).

`python build.py` rebuilds `dist/ki-port.html`.
