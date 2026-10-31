# Quad Cortex Web Editor

Edit and browse a Neural DSP **Quad Cortex** from a browser. **Unofficial — not affiliated with or endorsed by Neural DSP.**
Built on the community's reverse-engineered USB protocol, for interoperability with hardware you own.

> ⚠️ Early development (Phase 0). Writes to your device are not implemented yet. The protocol has no version number;
> only CorOS 4.0.1 has been verified by the community. Back up your presets with Cortex Control before experimenting.

## Status
See [PLAN.md](PLAN.md). Done: protocol core, WebHID transport, Phase 0 (works on CorOS 4.1.0), read-only app (library, preset grid, scenes).
Live editing (parameters, bypass) is verified on CorOS 4.1.0. Saving is verified too. Also built, not yet tried on a real unit: block and scene editing, lane routing and levels, branching, undo/redo, restore-from-snapshot and global settings. See PLAN.md for what is verified. `npm run dev` then open `/?demo` to try the UI without a unit.

## Run
```sh
npm install
npm run gen        # generate protobuf TS from the vendored schema
npm test           # unit tests (no hardware needed)
npm run dev        # http://localhost:5173 in desktop Chrome/Edge
```
Quit Cortex Control first (it holds the USB interface exclusively), plug in the Quad Cortex, open the page, follow steps 1–3.

## Hosting on GitHub Pages
`.github/workflows/pages.yml` builds and deploys on every push to `main`:
1. In the repo: **Settings → Pages → Build and deployment → Source: GitHub Actions** (one-time).
2. Push to `main`. The site appears at `https://<user>.github.io/quad-cortex-web-editor/`.

Notes:
- GitHub Pages is HTTPS, which WebHID requires, so direct USB mode works there (desktop Chrome/Edge). The first visit asks you to grant the device to that site.
- Pages is static: it serves the app, the app talks to the unit from *your* browser over USB. Nothing about your unit or presets is sent anywhere.
- Phones/tablets cannot use USB from a browser. A future bridge must serve the app itself over plain HTTP on your network: an HTTPS page (like Pages) is not allowed to open a `ws://` connection to a device on your LAN.
- The workflow sets `BASE_PATH` (the app lives under `/<repo>/`) and `VITE_REPO_URL` (the "Source code" link the app shows, as the AGPL asks of hosted copies). To build the same thing locally: `BASE_PATH=/quad-cortex-web-editor/ npm run build`, then `BASE_PATH=/quad-cortex-web-editor/ npm run preview -w @qc/web` (preview needs the same variable).
- Snapshots are stored in the browser's IndexedDB for the site's origin (`<user>.github.io`); a different address (local dev, another host) has its own, separate set.

## Layout
- `packages/protocol` — framing, message registry, `Session` (handshake, keepalive, correlation), catalog parser. Transport-agnostic.
- `packages/transport-webhid` — WebHID `Transport` (swallows the unit's benign write-STALL error).
- `packages/domain` — `DeviceStore` (unit pushes → UI state), grid + slot helpers.
- `apps/web` — React + Vite app (`?demo` = fake unit).

## Credits & license
AGPL-3.0-or-later (see `LICENSE`). The protocol schema and wire-format knowledge come from
[stokes-audio/pyquadcortex](https://github.com/stokes-audio/pyquadcortex) (MIT, see `docs/LICENSE-pyquadcortex-MIT`);
`packages/protocol/proto-upstream/` is vendored from it, and `packages/protocol/test/fixtures/model_repo_coros_4_0_1.bin` is a capture from its test suite.
