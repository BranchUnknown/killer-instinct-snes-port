# Killer Instinct — SNES browser port

A JavaScript browser port for the USA v1.1 SNES version of Killer Instinct. Supply your own headerless 4 MB cartridge dump (CRC32 `09E9A04E`). Game ROMs and optional media are not included.

**Optional download:** [Killer Instinct Arcade MegaPatch / MSU-1 — gizaha's release thread on Zeldix](https://www.zeldix.net/t2002-killer-instinct-arcade-mega-patch). The first post links the patch and sound/data files. These are separate downloads, not included in this repository.

## Play

On Windows, extract this repository and double-click **Play Killer Instinct.bat**. Select or drag your ROM onto the page. The launcher runs a local server at http://localhost:8642; close its console to stop it. Chrome or Edge is recommended.

Alternatively, open **index.html** or **dist/ki-port.html** directly. Browser storage behavior differs for local files. Press a key, click, or tap once to enable audio.

WASD moves; N/J/I are quick/medium/fierce punch; M/K/O are quick/medium/fierce kick. Enter starts, Esc opens the menu. Controllers, a second player, touch controls, and remapping are supported.

## Build

Python 3, with no extra packages:

```sh
python build.py
```

This regenerates `dist/ki-port.html` from `index.html` and `js/*.js`. No ROM is needed to build. The included bundle was regenerated for this package; all JavaScript source files passed `node --check`.

## Optional extras (not included)

**Arcade MegaPatch / MSU-1:** use the release link above and supply your own base ROM. In the port's menu, choose the folder containing `ki.msu`, the `ki-N.pcm` tracks, and `patch.ips` (or `ki.sfc`). On a phone, use **Choose files** and select the required files together. The Windows launcher can also discover a supplied MegaPatch folder inside the repository folder.

**4× arcade fighter sprites (experimental):** the optional renderer is included, but the sprite images, metadata, alternate-colour packs, and extraction/upscaling tools are not. The MegaPatch download is separate from this renderer's sprite collection. Without that collection, use the normal SNES sprites. If you already have compatible art, choose the folder containing `fighters_4x` and any `fighters_c1_4x` through `fighters_c5_4x` folders in the menu. The Windows server's automatic arcade-art lookup expects the original research workspace layout and will not find art in a plain checkout. Missing metadata, animation frames, or images fall back to SNES fighter pixels. This fallback has regression coverage; the complete arcade-art workflow has not been revalidated in-browser for this upload.

## Contents and status

`js/` contains the runtime, `build.py` the single-file bundler, and `serve.ps1` the Windows launcher server. `MANIFEST.json` records SHA-256 checksums of the packaged files (excluding itself). Research tools, reference captures, tests requiring external fixtures, ROMs, patches, music, extracted sprites, and bundled toolchains are excluded.

`DEVELOPMENT.md` includes development notes, historical verification results, and paths into the larger research workspace. Those reference fixtures and scripts are not part of this standalone package. Packaging checks verify syntax and contents; they do not revalidate gameplay.

## Repository layout

The port files are at the repository root; no additional upload-folder level is needed. This upload does not contain `.gitignore` or `.gitattributes`. Keep your ROMs, downloaded MegaPatch/MSU-1 files, and external sprite collections out of commits.

Original software contributions are MIT licensed; see `LICENSE`. Third-party terms and attribution are in `THIRD_PARTY_NOTICES.md`.

