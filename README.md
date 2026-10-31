# Quad Cortex Web Editor

Browse and edit presets on a Neural DSP **Quad Cortex** from a web browser, over USB, without Cortex Control.

**Unofficial: not affiliated with or endorsed by Neural DSP.** It is built on the community's reverse-engineered USB protocol,
for interoperability with hardware you own. Quad Cortex and Cortex Control are trademarks of Neural DSP.

> ⚠️ **Early software.** It writes to a real device. Everything is live and unsaved until you press **Save**, and **Discard**
> reloads the saved version, but the protocol has no version number and has only been checked on **CorOS 4.1.0** (by the author)
> and **4.0.1** (by the community). Back up presets you care about with Cortex Control first, and try new features on a scratch preset.

## What it does

**Verified on a real unit (CorOS 4.1.0):**
- Connect over USB from desktop Chrome/Edge (WebHID); one click to reconnect.
- Browse the library (user and factory presets, 32 banks × A–H, search), load a preset, switch scenes.
- Show the 4×8 grid with block names from the unit's own catalog, scene names and colours, and parameter values in on-screen units (dB, %, Hz, list options, `C` / `10 R` for pan).
- Edit parameters (slider, ± buttons, list dropdowns, per-scene values) and bypass. Each edit is read back from the unit, and one it silently refused is reported.
- Pick up changes made on the unit itself, **Discard** unsaved changes, **Save** to any slot in your own preset folders, with a confirmation naming what gets replaced. When you overwrite the preset you loaded, a snapshot of its stored version is kept in your browser first; for any other occupied slot the app can't back it up and says so.
- Lane routing: choose each lane's input and output.

**Built and tested against a fake unit, not yet confirmed on hardware** (see [PLAN.md](PLAN.md) for the exact open questions):
- Add, replace, move and remove blocks; rename, recolour, copy and swap scenes.
- Undo / redo (the unit's own history).
- Lane input gate and output level (volume, pan, mute, solo); lane branching (split/rejoin columns) with splitter and mixer parameters.
- **Rebuild a snapshot** onto the unit's current preset (Diagnostics → Snapshots → *Rebuild…*), then review and Save.
- Global settings tab: input gain, ground lift, output levels, mute, master volume.

**Not supported yet:**
- **Phones and tablets.** Browsers on iOS/Android can't use USB. A small bridge program (Raspberry Pi or an old computer) is planned; it isn't built.
- Placing Neural Capture blocks, changing IR/cab text choices, and footswitch/expression assignments, MIDI, the tempo block and tags. None of these can be edited here, and *Rebuild* doesn't restore them.
- Other firmware versions are untested, and the app does not yet warn about them (Diagnostics shows the CorOS version it connected to).

**Safety rails:** the one block known to crash the unit (`NC_Recorder`) can never be placed; port numbers the unit doesn't define are never written; edits to a lane that can't branch are refused; the unit's factory, downloads and cloud folders are read-only here.

## Using it

You need desktop **Chrome, Edge or Opera** (WebHID), a Quad Cortex connected by USB and fully booted, and **Cortex Control closed** (it holds the USB interface exclusively).

1. Open the app and click **Connect Quad Cortex…**, then choose the device in the browser's prompt.
2. Wait for the current preset to appear; it can take up to ~25 seconds. The **Library** works meanwhile.
3. Tabs: **Preset** (grid, scenes, undo), **Library**, **Settings** (global I/O), **Diagnostics** (device info, log, snapshots).
4. Tap a block for its parameters, an empty cell to add a block, a row number for that lane's routing and levels.

No unit handy? Add `?demo` to the address for a fake unit with synthetic presets (it uses the real block catalog captured from a unit).
`?cc=<version>` overrides the Cortex Control version the app announces to the unit (default `4.1.0`; CorOS 4.1.0 rejects `4.0.1`).

## Develop

Requires Node.js 22+ (CI uses 22).

```sh
npm install
npm run gen         # generates the protobuf TypeScript (not committed) — run once after cloning
npm test            # unit tests; no hardware needed (they use a fake unit)
npm run typecheck
npm run dev         # http://localhost:5173
npm run build       # production build in apps/web/dist
```

Layout:
- `packages/protocol` — HID framing and reassembly, `Session` (handshake, keepalive, request correlation), message registry, block catalog parser, wire ⇄ display value conversion. Transport-agnostic.
- `packages/transport-webhid` — the WebHID transport (it swallows the unit's harmless write-STALL error).
- `packages/domain` — `DeviceStore` (the unit's pushes → UI state, plus every edit action with read-back verification), grid/slot helpers, routing and I/O tables, the snapshot restore planner and executor.
- `apps/web` — React + Vite app, including the `?demo` fake unit.
- `docs/protocol-notes.md` — what was observed on real hardware. [PLAN.md](PLAN.md) — design, progress, and the lists of things still unverified.

## Hosting on GitHub Pages

`.github/workflows/pages.yml` runs the tests and deploys on every push to `main`.

1. In the repo: **Settings → Pages → Build and deployment → Source: GitHub Actions** (one-time).
2. Push to `main`. The site is served at `https://<user>.github.io/quad-cortex-web-editor/`.

Notes:
- Pages is HTTPS, which WebHID requires, so USB mode works there too. The first visit asks you to grant the device to that site.
- Pages only serves the app. The browser talks to your unit over USB; nothing about your unit or presets is sent anywhere. The one exception is analytics: the copy hosted at `caique-lima.github.io` loads Google Analytics (page views only, and the app says so). It is loaded only on that hostname, so local runs and forks send nothing. To use your own property, change the measurement ID and hostname in `apps/web/index.html` (and the hostname in `apps/web/src/views/Connect.tsx`), or delete that block.
- A future phone/tablet bridge has to serve the app itself over plain HTTP on your network: an HTTPS page isn't allowed to open a `ws://` connection to a device on your LAN.
- The workflow sets `BASE_PATH` (the app lives under `/<repo>/`) and `VITE_REPO_URL` (the "Source code" link the app shows). To reproduce locally: `BASE_PATH=/quad-cortex-web-editor/ npm run build`, then `BASE_PATH=/quad-cortex-web-editor/ npm run preview -w @qc/web` (preview needs the same variable).
- Snapshots live in the browser's IndexedDB for the site's address; `localhost` and the Pages site each have their own.

## Credits and license

Licensed **AGPL-3.0-or-later** (see `LICENSE`). The protocol schema and the wire-format knowledge come from
[stokes-audio/pyquadcortex](https://github.com/stokes-audio/pyquadcortex) (MIT, see `docs/LICENSE-pyquadcortex-MIT` and `NOTICE`):
`packages/protocol/proto-upstream/` is vendored from it, and `packages/protocol/test/fixtures/model_repo_coros_4_0_1.bin`
is a block-catalog capture from its test suite.
