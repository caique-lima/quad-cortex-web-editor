# Protocol notes — findings on real hardware

Record here everything observed on the owner's unit that differs from (or confirms) pyquadcortex's `docs/protocol.md`,
which was verified on CorOS 4.0.1 only. The owner's unit runs **CorOS 4.1.x+**.

## Phase 0 checklist (fill in)
- [x] CorOS 4.1.0, fw d14e (QC)
- [x] Browser + OS used: desktop Chrome (WebHID) — exact versions not recorded
- [x] `requestDevice` offered two entries for 152a:880a, both reporting `usagePage=0x1 usage=0x0 [in#1 out#2]`; the first matching one worked.
- [x] Yes — opens fine.
- [x] Writes reject with `NotAllowedError: Failed to write the report.` (as upstream predicted); the unit acts on them anyway (handshake completed, replies arrived).
- [ ] `Version` READ answered without handshake? (two replies expected) ______
- [x] Handshake completes with ccVersion "4.0.1" and the full-shape KeepAlive. BUT the unit sent a `GenericError` right after the subscription burst began (code not yet decoded; suspect VERSION_IS_OLDER). Unresolved: which ccVersion string 4.1.x expects.
- [x] ModelRepo, ModuleStats, License(enc), UndoRedo, IOSettings, GeneralSettings, ShowGigView, Mode, GlobalEQ, MasterVolume, File(many, some gz), RecentsFavorites, CompilerInhibitedModules, RecallPreset(17.5KB gz), NewModels, PinnedModels, DefaultParameters, GlobalTempo, SetlistPosition, PresetDirty, Scene, BulkOperation, Updater, Connection, GenericError.
- [x] None observed.
- [x] `KeepAlive{UPDATE, request_id:0, is_online:true}` every 5 s: no errors; session stayed alive.

## Things to remember
- Quit Cortex Control first; it holds the interface exclusively.
- Right after boot the unit can be "openable but silent" for ~9–17 s.
- A dead USB link mid-session may only recover after a full power cycle (upstream troubleshooting.md).

## Observations
- `GlobalTempo` (metronome clock) is pushed ~9×/s, even before the handshake. Don't log it or re-render on it.
- The seed `RecallPreset` push arrived ~10 s after the first TX in one run (consistent with upstream's 10–25 s), not instantly. Don't block UI on it.
- Still to confirm: CorOS value from the `Version` read (the app now reads it automatically after the handshake).
- CONFIRMED: announcing Cortex Control "4.0.1" to CorOS 4.1.0 makes the unit send `GenericError{VERSION_IS_OLDER}` (everything else still worked). Default is now "4.1.0"; override with `?cc=` in the URL. Result: announcing "4.1.0" → unit replies `Version{cortex_control_version_valid:true}` and no GenericError. **Phase 0 complete on CorOS 4.1.0.**
