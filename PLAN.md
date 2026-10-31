# Quad Cortex Web Editor — Plan

## Context
The user owns a Neural DSP Quad Cortex and wants to edit presets and browse the device from phones/tablets (iOS + Android) and from an old computer that can no longer run Cortex Control. The project started greenfield. The user's unit runs **CorOS 4.1.x+**; project will be **open source, AGPL-3.0**.

### What we know about the device protocol (community reverse-engineering)
- **stokes-audio/pyquadcortex** (MIT, Python) — the main protocol reference; `docs/protocol.md` documents everything; recovered `.proto` schema. Verified on CorOS 4.0.1.
- **pacharanero/cortex** (AGPL, Rust + Tauri) — builds on the above; hardware-verified on Linux. AGPL-compatible, so we can borrow from it.
- Transport: USB **HID**, VID `0x152A` / PID `0x880A`, interface 5, usage page `0x0001` usage `0x0000`. 128-byte reports: ID `0x02` host→device, `0x01` device→host. Frame = `[len][flags 0x40 FIRST|0x80 LAST][payload ≤126]`, reassembled until LAST.
- Message = `protobuf ++ 8-byte trailer` (u32 LE message type, ENCRYPTED, COMPRESSED=gzip, 2 ignored bytes).
- **Gotcha:** every output report "fails" (status-stage STALL) even though the unit acted on it → transport must ignore write errors.
- Handshake: `ResetCommsBuffers{session_id}` → `Version{READ}` → `Version{UPDATE, cortex_control_version}` (opens the push gate) → `Connection{connected:true}` + about 22 subscription READs → `KeepAlive` every ~5 s (4.1.0 shape differs: `request_id:0, is_online:true`). Wait about 2 s before sending commands.
- Editing model: recall preset (`SetlistPosition{UPDATE}`) → sparse `Grid{UPDATE}` keyed by row/col (4×8 grid) → save = `File{CREATE}` (it saves a snapshot of the live grid). Preset contents arrive as a `RecallPreset` push (gzip, about 20 KB, can take 10–25 s); `RecallPreset{READ}` reads the live grid with no side effects.
- Cortex Control holds the device exclusively → it must be closed.
- The protocol has **no version number** → each new firmware needs checking again.

### Platform reality
| Client | Direct USB? | Path |
|---|---|---|
| Desktop Chrome/Edge/Opera 89+ (Win/mac/Linux/ChromeOS, incl. old Win7/8.1 via Chrome 109, macOS 10.13 via Chrome 116) | **WebHID** | Direct mode |
| iPhone / iPad (any browser) | No | Bridge mode |
| Android Chrome | No (no WebHID; WebUSB blocks the HID class) | Bridge mode (later: optional native Android wrapper) |
| Computer too old for Chrome 89 | No | Bridge mode, or it *is* the bridge |

## Architecture
TypeScript monorepo (pnpm workspaces), one protocol core used in both modes:

```
packages/
  protocol/   framing, trailer, gzip, protobuf codecs (from vendored .proto via protobuf-es),
              Session (handshake, keepalive, request_id correlation, push routing), Transport interface
  domain/     typed model + reducers: Preset/Grid/Chains/Models/Params, Scenes, Setlists/Files,
              ModelRepo catalog (block names + param metadata), DeviceClient API (recall, setParam,
              setBypass, placeBlock, moveBlock, scene ops, saveAs)
  transport-webhid/   navigator.hid → Transport (filters 152a:880a, suppresses write-STALL errors)
  transport-ws/       browser side of the bridge link (envelope = {type, flags, protobuf bytes})
apps/
  web/        React + Vite + TS PWA, Tailwind, Zustand; mobile-first touch UI
  bridge/     Node.js: node-hid transport + Session owner + WebSocket server + serves the built web app;
              several clients at once (phone + tablet), caches the latest pushes so late joiners get state
deploy/pi/    Raspberry Pi image notes: systemd unit, udev rule for 152a:880a, hostapd hotspot, mDNS (qc.local)
```

Key decision: **in bridge mode the bridge owns the HID session** (handshake + keepalive), because mobile browsers pause background tabs and would miss keepalives. The browser runs the same `domain` layer in both modes; only the envelope source differs (`Session(WebHID)` vs `WebSocket→bridge`).

The web app detects its mode: if `navigator.hid` exists, it offers "Connect via USB"; otherwise it connects to the bridge that served it.

## Phases

### Phase 0 — Hardware spike (do first; it can kill or reshape the plan)
1. Read the user's CorOS version and device info.
2. Minimal WebHID page: open device, send handshake, log decoded trailers. Confirm (a) Chrome lets us open usage `0x0001/0x0000`, and (b) `sendReport` rejections from the STALL can be safely swallowed.
3. Run pyquadcortex (Python) against the unit on 4.1.x: handshake, list presets, recall, set one param, read back. Note any differences from the 4.0.1 docs (keepalive shape, new message types/fields).
4. If anything differs: capture Cortex Control traffic (Wireshark + USBPcap on Windows, or Linux usbmon) and update the vendored schema.

### Phase 1 — Protocol core (`packages/protocol`)
- Port framing/reassembly (1 MiB cap), trailer, gzip (`DecompressionStream`, falling back to `fflate` for old browsers and Node), protobuf codecs.
- Session: handshake state machine, keepalive timer, correlation (match by type, then by request_id), "seed push" handling, timeouts in place of write errors.
- Unit tests (Vitest) using captured frame fixtures (reuse pyquadcortex fixtures where they exist, plus our own 4.1.x captures).

### Phase 2 — Read-only app (WebHID direct mode)
- Connect screen, device info, firmware warning if the version is untested.
- Setlist/preset browser (File enumeration, 256 slots, bank/letter `position = (bank-1)*8 + letter`), recall.
- Grid view (4×8, splits/mixers on rows 0 and 2), block names from ModelRepo, scene switcher (8 scenes, labels/colors).

### Phase 3 — Editing
- Block detail with touch-friendly param controls (typed values: dB/Hz/%/list), bypass toggle, per-scene values (`scene_mode`).
- Add/replace/remove/move blocks from the catalog; **read back after each write** to catch silent refusals (DSP limit, port conflict).
- Scene label/color/copy; IO routing per chain.
- **Save safety:** edits are live and unsaved until an explicit Save / Save As with a confirm dialog; before overwriting, back up the original preset to IndexedDB and allow export/import as JSON; undo stack in the UI.

### Phase 4 — Bridge + mobile
- `apps/bridge` with node-hid (hidapi; ignore the write STALL), WebSocket fan-out, serves the PWA.
- Raspberry Pi setup (Pi Zero 2 W / Pi 4): udev rule, systemd, optional own Wi-Fi hotspot for gigs, `qc.local` via mDNS. The same bridge also runs on the old computer (`npx`/standalone binary).
- PWA install, offline shell, responsive phone vs tablet layouts, handling of reconnects.

### Phase 5 — Extras (as needed)
Global settings (GeneralSettings, IOSettings, Global EQ, master volume), footswitch/stomp assignments, expression pedal assignment, tuner, captures/IR selection, favorites/recents, preset move/delete, multi-client edit conflict handling, optional native Android wrapper (Capacitor + USB host API).

## Risks
- Firmware updates may silently change the protocol → version gate + a fixture-based test suite + a documented capture workflow.
- Writing to a real device: never auto-save; avoid known crash paths (pyquadcortex's do-not-probe list, e.g. NC_Recorder); tuner writes can mute output.
- Unofficial: not affiliated with Neural DSP; reverse-engineering for interoperability only; no Neural DSP branding/assets.

## References (read before implementing)
- Protocol spec: https://github.com/stokes-audio/pyquadcortex/blob/main/docs/protocol.md (long; read all of it, including the part after ~100k chars)
- pyquadcortex (MIT, Python reference + `.proto` schema): https://github.com/stokes-audio/pyquadcortex
- cortex (AGPL, Rust `cortex-rs` + Tauri UI; reuse allowed since we are AGPL): https://github.com/pacharanero/cortex
- WebHID API: https://developer.mozilla.org/en-US/docs/Web/API/WebHID_API

## Implementer notes
- Start with Phase 0 on real hardware. Don't build UI until the handshake and one param write work on the user's CorOS 4.1.x unit.
- Put each step's hardware findings (version, differences from the 4.0.1 docs) in `docs/protocol-notes.md` in the repo.
- Add the AGPL-3.0 `LICENSE` and a README notice ("unofficial, not affiliated with Neural DSP") at repo init.

## Verification
- `pnpm test` — Vitest unit tests for framing, trailer, codecs, session state machine, reducers (fixture-based, no hardware).
- A mock device (replays captured sessions over the Transport interface) for UI dev and e2e tests (Playwright) with no hardware.
- Hardware checklist per phase, run on the user's QC: connect, list, recall, change a param and hear it, bypass, place/move block, scene switch, Save As to an empty slot then recall it, check the change with the QC screen.
- Bridge: Pi + QC, then iPhone Safari and Android Chrome over the hotspot; two clients at once stay in sync.

---
## Progress (updated 2026-10-31)
- [x] Monorepo (npm workspaces; pnpm wasn't installed), AGPL LICENSE, README, NOTICE
- [x] Phase 1 core: framing + reassembly, registry, `Session` (handshake/keepalive/correlation/gzip), catalog parser — 15 unit tests, fixture-verified (533 models / 32 categories)
- [x] WebHID transport + Phase 0 connect/diagnostics screen (`apps/web`)
- [x] **Phase 0 on real hardware** — done on CorOS 4.1.0 (needs ccVersion "4.1.0"); see `docs/protocol-notes.md`
- [x] Phase 2 read-only app built (unverified on hardware): `packages/domain` (DeviceStore, grid/slot helpers; 19 tests), connect screen, library browser (32 banks × A–H, search), 4×8 preset grid, block detail sheet (raw values), scene switching, diagnostics. `?demo` runs the UI against a fake unit.
- [ ] **Phase 2 hardware check (owner)** — see 'Unverified assumptions' below
- [x] Phase 3a live editing built (unverified on hardware): param slider/±/list select, bypass toggle, Discard changes. Sparse Grid UPDATE writes (`packages/domain/src/edits.ts`), throttled (40 ms), optimistic UI, read-back verification via `RecallPreset{READ}` that reports edits the unit silently refused. 71 tests; exercised end-to-end against `?demo`.
- [ ] **Phase 3a hardware check (owner)** — on a SCRATCH preset first; see 'Editing: unverified' below
- [x] Phase 3a hardware check DONE (owner, CorOS 4.1.0): edits applied + verified, scene/recall/discard work, on-unit changes resync.
- [x] Phase 3b-1 saving built (unverified on hardware): `DeviceStore.save()` — File CREATE into any slot of the user's own preset folders (factory/downloads/cloud/read-only refused in code), owner chose "overwrite anywhere with confirmation". Safeguards: pending edits confirmed by read-back first; confirmation names the preset being replaced; snapshot of the STORED version kept in IndexedDB before overwriting the loaded slot (only slot we hold a verified baseline for; other occupied slots can't be backed up and the UI says so); snapshot failure aborts the save; waits for the unit's ack + reads back the stored name (_N dedupe). 84 tests; exercised in `?demo`.
- [x] **Phase 3b-1 hardware check DONE (owner, CorOS 4.1.0)** — save works as expected; the 'Saving: unverified' items below are now confirmed in practice
- [x] Phase 3b-2 block + scene editing built (unverified on hardware): add/replace (picker with search + categories), remove, move to an empty cell, scene rename/colour/copy/swap. Guards: NC_Recorder (id 20000) can never be placed (it crashed a real unit upstream), Neural Capture and internal blocks are not offered. Results are confirmed by read-back with one retry (a placement can take ~0.3 s; a refused one — e.g. out of DSP — produces no echo). 109 tests; exercised end-to-end in `?demo` (including a refused placement).
- [ ] **Phase 3b-2 hardware check (owner)** — on a SCRATCH preset; see 'Block/scene editing: unverified' below
- [ ] Next candidates: undo; restore-from-snapshot (now possible in principle: rebuild a preset by placing blocks + setting params); routing/splits/IO; Phase 4 bridge for phones/tablets
- [ ] Phase 4 bridge, Phase 5 extras

### Unverified assumptions (check on the real unit; fix in `packages/domain`)
1. `folderKind()` guesses preset vs capture/IR folders from the key (`store.ts`). Real keys unseen — use Library → "show all folders".
2. Slot listing: a File message with ≥256 files replaces a folder, fewer merges (`store.ts mergeFolder`).
3. Model `hash` == catalog model id (`grid.ts`). Unknown ids show as "Block #id" (amber border).
4. ~~Param values shown raw~~ DONE: `packages/protocol/src/values.ts` converts wire→display (skew law, firmware constants, list options, ±50 labelled knobs, refuses unknown bounds/NaN). Formulas match pyquadcortex's hardware readings (tests). STILL UNVERIFIED vs your screen: number of decimals shown (my heuristic from `steps`/`showAsInteger`/range), unit suffixes, and that 4.1.0's catalog has no new symbolic bounds/skews (they'd show ⚠ and the Diagnostics tab lists catalog warnings once surfaced).
5. Recalling a FACTORY preset: upstream says the factory folder key has a trailing slash on recall; we pass the listed key as-is.
6. Recall + scene switching send real commands (SetlistPosition/Scene UPDATE). Recall discards unsaved edits on the unit (UI confirms when `PresetDirty`).
7. Block catalog tested against a 4.0.1 capture; 4.1.0 may add models/params.

### Editing: unverified (check on the real unit, on a scratch preset)
1. The write shapes come from pyquadcortex (verified there on CorOS 4.0.1) — never yet sent to YOUR 4.1.0 unit. A silent refusal shows as "The unit did not apply this change".
2. Incoming `Grid` pushes are ignored: a knob turned on the unit itself won't show here until the next read-back/recall. Diagnostics → "Messages received" shows whether the unit sends `Grid` at all after an edit.
3. Slider drags stream up to ~25 writes/s (coalesced per parameter). Upstream says the unit's own UI streams the same way; if the unit lags, raise `editThrottleMs` in `DeviceStore`.
4. `RecallPreset{READ}` is documented as side-effect-free; confirm audio doesn't glitch during the read-back (~0.7 s after the last edit).
5. Bypass on a block that is not per-scene changes ALL scenes (the unit's behaviour, per upstream); per-scene blocks change the active scene only.
6. Nothing is saved by this build: unsaved edits are lost on recall/power-off. "Discard changes" just re-loads the saved slot.

### Saving: unverified (check on the real unit; start with an EMPTY slot)
1. `File{CREATE, type:0, folder{key,isFactory:false,files[{index,name,instrument}]}}` is from pyquadcortex docs (CorOS 4.0.1) — never sent to your 4.1.0 unit. 
2. What counts as the unit's acknowledgement is a guess: a `File` push for that folder, `RecallPreset` with reason SAVE, or `PresetDirty` not-dirty. If none arrives in 15 s the UI says it could not confirm — check the unit before retrying.
3. `instrument` (1–5) is copied from the loaded slot (or 1); its meaning is unverified.
4. Name limit 20 chars and "no slashes" are my conservative rules (upstream: dedupe truncates to 20 total).
5. Snapshots are RECORDS, not restorable yet (the unit ignores full-preset writes). Export gives raw BinaryPreset bytes.
6. The "stored baseline" is trusted only when a fresh load is followed by PresetDirty=false and no local edit; verified order on your unit: RecallPreset → SetlistPosition → PresetDirty.

### Block/scene editing: unverified (check on the real unit, on a SCRATCH preset; nothing is saved until you Save)
1. Wire shapes (from pyquadcortex, CorOS 4.0.1) never sent to your 4.1.0 unit: place = `Grid UPDATE {row, models{column, hash}}`; remove = `Grid DELETE {…hash:0}` (an UPDATE with hash 0 is ignored); move = `GridMove {from/to row/col, is_drop}`.
2. Timing: first read-back 0.5 s after the edit, second 0.9 s later; a block still missing then is reported as refused. If your unit is slower, raise `structuralVerifyDelayMs`/`structuralRetryDelayMs` in `DeviceStore`.
3. Move targets must be EMPTY (what happens when dropping onto an occupied cell is unverified). A cross-row move creates a parallel path (the unit computes the split/mix columns); routing/splits/IO ports are not editable here yet.
4. A newly placed block gets the unit's default parameter values (we don't set any).
5. Scene names: 20-char limit is my guess; the unit stores a blank name as a single space. Colours: a fixed palette is offered; the unit may snap to its own — what it confirms is what is shown. Copy/swap: the unit copies name+colour+parameters; we re-read the live grid ~0.25 s after.
6. Not offered on purpose: Neural Capture blocks (need a capture chosen on the unit) and internal blocks. `NC_Recorder` is hard-refused even if offered.
7. Per-scene blocks vs bypass state after a move is whatever the unit does; we show what it reports.

### Lane routing: built; owner confirmed working on CorOS 4.1.0 (input/output changes, 'To row 3' feeding, labels)
Tap a row number in the grid -> choose that lane's input and output (`Grid UPDATE {row, in_portid | out_portid}`, one field per message; verified by read-back; undone by Discard; saved with Save). 118 tests; exercised in `?demo`.
1. Port numbering is from pyquadcortex (CorOS 4.0.1). Your 4.1.0 may define more ports; an id we don't list is DISPLAYED as "Port N (unrecognised)" and never written.
2. The unit does not validate ports: only listed ids can be written (enforced in code, tested), because an unknown id silences the lane.
3. Outputs 16-18 ("To row 3/4/3+4") are internal row-to-row routing; my labels for them are a guess at the unit's wording. Output 19 = Multi-Out is a real destination.
4. NOT included: per-lane input gain, output level, mute/solo, input gate (those are separate control blocks addressed by `hash`, not column), splitter/mixer/split points, and the global I/O settings (IOSettings message).

## Round 3 (built, ALL unverified on hardware; 181 tests; each exercised in `?demo`)
- **Undo / redo** — the unit's own history: `UndoRedo{UPDATE, undo|redo: true}` (confirmed upstream on 4.0.1 and by a contributor on 4.1.0). Buttons in the Preset toolbar; enabled from the unit's `undo_frames`/`redo_frames` counts.
- **Lane levels** — tap a row number: input gate (noise reduction, bypass, gain) and lane output (volume, pan, mute, solo). Parameters now go through "targets" (block / laneOut 23000 / laneIn 28000 / mixer 11000 / splitter 10004), keyed per upstream (hash vs column vs bare).
- **Branching** — split/mix columns for lanes 1 and 3 (`split_control_points`), plus splitter and mixer parameters once a branch exists.
- **Restore from snapshot** — Diagnostics -> Snapshots -> "Rebuild…". Plans against the unit's live preset, then: lane ports + branches + blocks -> read back -> per-scene promotion, parameters (incl. per-scene), bypass, scene names/colours -> final comparison report. Live and UNSAVED; you Save yourself.
- **Settings tab** — global input gain (dB = -12 + 72*level), ground lift, output level (as knob position), mute, master volume.
- **Display fixes** — PAN-style knobs show `C` / `10 R` / `10 L` (labelled-end rule, upstream-measured); Off/On for unnamed 2-option switches.
- **Bundle** — ~556 kB raw / ~170 kB gzip, split into cacheable chunks (React 222 kB, our code 108 kB, protobuf 152 kB, codecs 67 kB). Further cuts are not worth the risk.

### Round 3: unverified (test on a SCRATCH preset; nothing here saves anything)
1. **Undo**: enabling uses the unit's frame lists, whose exact meaning is unconfirmed; empty-history behaviour is unknown upstream.
2. **Lane controls**: SOLO's behaviour is unmeasured upstream; the input gate's index-4 and the output control's index-4 are hidden. Lane MUTE 1.0 = muted (by ear, upstream).
3. **Splitter/mixer**: the splitter is addressed as `combined_splitter` with neither hash nor column (as the unit broadcasts it). Setting a branch "takes over" the lane below.
4. **Restore** (riskiest — many writes): (a) the per-scene dance (`scene_mode` flag alone -> switch scene -> write) is from upstream; (b) it never writes text/integer parameters (cab/IR choices, captures) because IR-related probing has crashed units upstream, so cab IR choices are NOT restored; (c) per-scene BYPASS can't be restored on blocks the unit places fresh (only the unit can set scene mode) — reported; (d) not restored: footswitch assignments, expression assignments, MIDI, tempo block, scene tempos, tags, description, preset name; (e) the unit is left on the snapshot's default scene; (f) NC_Recorder and Neural Capture blocks are never placed.
5. **Settings**: the unit confirms each change by pushing IOSettings; if it doesn't you get a notice. Impedance/input type and output dB scales are not exposed (semantics unknown). Output level shows as knob position.
6. Wire formats are pyquadcortex's (CorOS 4.0.1); never sent to your 4.1.0 unit.
