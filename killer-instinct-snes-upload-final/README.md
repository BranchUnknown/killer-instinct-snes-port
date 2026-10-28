# Killer Instinct — SNES browser port

A JavaScript browser port for the USA v1.1 SNES version of Killer Instinct. Supply your own headerless 4 MB cartridge dump (CRC32 `09E9A04E`). Game ROMs and optional media are not included.

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

Optional MegaPatch/MSU-1 files and arcade fighter art must be supplied separately through the application's selectors. The Windows server's automatic arcade-art lookup expects the original research workspace layout; use the folder picker in a standalone checkout.

## Contents and status

`js/` contains the runtime, `build.py` the single-file bundler, and `serve.ps1` the Windows launcher server. `MANIFEST.json` records SHA-256 checksums of the packaged files (excluding itself). Research tools, reference captures, tests requiring external fixtures, ROMs, patches, music, extracted sprites, and bundled toolchains are excluded.

`DEVELOPMENT.md` preserves the original development notes, including historical verification results and paths into the larger research workspace. Those reference fixtures and scripts are not part of this standalone package. Packaging checks verify syntax and contents; they do not revalidate gameplay.

## Upload to GitHub

Extract the ZIP, then upload the **contents** of the extracted folder to your repository, including `.gitignore` and `.gitattributes`. Or run these commands inside that folder after creating an empty GitHub repository:

```sh
git init
git add .
git commit -m "Package SNES browser port"
git branch -M main
git remote add origin YOUR_REPOSITORY_URL
git push -u origin main
```

Original software contributions are MIT licensed; see `LICENSE`. Third-party terms and attribution are in `THIRD_PARTY_NOTICES.md`.

