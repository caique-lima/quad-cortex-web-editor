import { clone, create } from '@bufbuild/protobuf';
import { Session, preset as P, type Transport } from '@qc/protocol';
import { describe, expect, it } from 'vitest';
import { DeviceStore } from '../src/store';
import { restoreSnapshot } from '../src/restore-exec';
import { FakeUnit } from './fake-unit';
import { bypassRow, catalog, model, preset, withLaneControls } from './helpers';

/** A preset as the unit reports it: 4x8 explicit cells, a bypass table, lane controls, labels, ports, dormant branches. */
function blank() {
  const p = withLaneControls(preset({}, {
    bypass: [0, 1, 2, 3].map((r) => bypassRow(r, {})),
    sceneLabels: Array(8).fill(' '),
    sceneColors: Array(8).fill(0),
  }));
  [[1, 1], [0, 0], [2, 2], [0, 0]].forEach(([i, o], r) => { p.chains[r]!.inPortid = i; p.chains[r]!.outPortid = o; });
  for (const r of [0, 2]) p.chains[r]!.splitControlPoints = [create(P.SplitControlPointsSchema, { split: -1, mix: -1 })];
  return p;
}

const fv = (v: number) => create(P.ParamValueSchema, { value: { case: 'floatValue', value: v } });
const setParams = (m: P.Model, vals: number[][], sceneModeIdx: number[] = []) => {
  m.params = vals.map((vs, index) => create(P.ParamSchema, { index, sceneMode: sceneModeIdx.includes(index), paramValues: vs.map(fv) }));
};
/** Put a block (with params) into a preset cell, like the unit stores it. */
const putBlock = (p: P.BinaryPreset, row: number, column: number, hash: number, vals: number[][], sceneModeIdx: number[] = []) => {
  const m = p.chains[row]!.models[column]!;
  m.hash = hash;
  setParams(m, vals, sceneModeIdx);
};

function rig(live: P.BinaryPreset) {
  const t: Transport = { async send() {}, onReport: () => () => {}, onClose: () => () => {}, async close() {} };
  const session = new Session(t);
  const store = new DeviceStore({ notifyDelayMs: 0, editThrottleMs: 2, verifyDelayMs: 10, structuralVerifyDelayMs: 10, structuralRetryDelayMs: 20 });
  store.attach(session);
  const unit = new FakeUnit(store, session, live);
  return { store, unit };
}
async function connect(store: DeviceStore, unit: FakeUnit) {
  const { pa } = await import('@qc/protocol');
  const { readFileSync } = await import('node:fs');
  const bin = new Uint8Array(readFileSync(new URL('../../protocol/test/fixtures/model_repo_coros_4_0_1.bin', import.meta.url)));
  const msg = (schema: any, init: any) => ({ type: 0, typeName: '', message: create(schema, init), schema, encrypted: false, compressed: false, raw: new Uint8Array(), receivedAt: 0 });
  const { typeFor, typeName } = await import('@qc/protocol');
  const send = (schema: any, init: any) => { const m: any = msg(schema, init); m.type = typeFor(schema); m.typeName = typeName(m.type); store.handle(m); };
  send(pa.ModelRepoMessageSchema, { action: pa.MessageAction_Enum.UPDATE, modelRepoPayload: bin });
  send(pa.RecallPresetMessageSchema, { action: pa.MessageAction_Enum.UPDATE, preset: clone(P.BinaryPresetSchema, unit.live) });
}

describe('restoreSnapshot against a fake unit', () => {
  it('rebuilds blocks, per-scene values, bypass, scene names/colours, ports, a branch and lane controls — and reports what it cannot do', async () => {
    // --- the snapshot: what we want ---
    const snap = blank();
    putBlock(snap, 0, 0, 1, [[0.2, 0.2, 0.9, 0.2, 0.2, 0.2, 0.7, 0.2], [0.4], [0.6]], [0]); // Myth Drive: GAIN varies by scene
    putBlock(snap, 0, 3, 2, [[0.3], [0.8], [0.5], [0.5]]); // Obsessive Drive
    putBlock(snap, 2, 1, 1, [[0.55], [0.5], [0.5]]);
    snap.bypass[0]!.colBypass[0]!.sceneBypass = [create(P.SceneBypassSchema, { bypass: true })]; // global bypass
    snap.bypass[0]!.colBypass[3]!.sceneMode = true; // per-scene bypass on a block the unit will have to PLACE (so it won't be per-scene there)
    snap.bypass[0]!.colBypass[3]!.sceneBypass = Array.from({ length: 8 }, (_, s) => create(P.SceneBypassSchema, { bypass: s === 1 }));
    snap.sceneLabels = ['CLEAN', 'LEAD', ' ', ' ', ' ', ' ', ' ', 'SOLO'];
    snap.sceneColors = [0xff3a7bff, 0xffe53935, 0, 0, 0, 0, 0, 0xffffcc00];
    snap.defaultScene = 1;
    snap.chains[0]!.outPortid = 16; // lane 1 feeds lane 3
    snap.chains[2]!.inPortid = 0;
    snap.chains[2]!.splitControlPoints = [create(P.SplitControlPointsSchema, { split: 2, mix: 6 })];
    snap.chains[1]!.outputControl[0]!.params[1]!.paramValues = [fv(0.25)]; // lane 2 PAN
    snap.stompModeAssignments = [create(P.StompModeAssignmentSchema, { row: 0, column: 0, stompIndex: 0 })]; // something we do not restore

    // --- the unit: something else entirely ---
    const live = blank();
    putBlock(live, 0, 1, 1, [[0.9], [0.1], [0.1]]); // stray block that must go
    putBlock(live, 0, 3, 1, [[0.1], [0.1], [0.1]]); // wrong block where Obsessive Drive belongs
    live.sceneLabels[0] = 'OLD';
    const { store, unit } = rig(live);
    await connect(store, unit);

    const progress: string[] = [];
    const report = await restoreSnapshot(store, snap, (p) => { if (!progress.includes(p.phase)) progress.push(p.phase); });

    expect(report.errors).toEqual([]);
    expect(report.skipped).toEqual([]);
    expect(report.unsupported).toEqual(['footswitch assignments (1)']);
    expect(progress).toEqual(['Reading the unit', 'Routing and blocks', 'Enabling per-scene values', 'Values', 'Checking the result', 'Done']);

    // blocks
    const hashes = unit.live.chains.map((c) => c.models.map((m) => m.hash ?? 0));
    expect(hashes[0]).toEqual([1, 0, 0, 2, 0, 0, 0, 0]);
    expect(hashes[2]).toEqual([0, 1, 0, 0, 0, 0, 0, 0]);
    // routing and branch
    expect(unit.live.chains[0]!.outPortid).toBe(16);
    expect(unit.live.chains[2]!.inPortid).toBe(0);
    expect(unit.live.chains[2]!.splitControlPoints[0]).toMatchObject({ split: 2, mix: 6 });
    // per-scene GAIN: promoted, then each scene written
    const gain = unit.live.chains[0]!.models[0]!.params[0]!;
    expect(gain.sceneMode).toBe(true);
    expect(gain.paramValues.map((v) => (v.value.case === 'floatValue' ? Number(v.value.value.toFixed(4)) : -1))).toEqual([0.2, 0.2, 0.9, 0.2, 0.2, 0.2, 0.7, 0.2]);
    // global values
    expect((unit.live.chains[0]!.models[3]!.params[1]!.paramValues[0]!.value as any).value).toBeCloseTo(0.8, 5);
    expect((unit.live.chains[1]!.outputControl[0]!.params[1]!.paramValues[0]!.value as any).value).toBeCloseTo(0.25, 5);
    // bypass: global state restored
    expect(unit.live.bypass[0]!.colBypass[0]!.sceneBypass.every((b) => b.bypass)).toBe(true);
    // scenes
    expect(unit.live.sceneLabels.map((l) => l.trim())).toEqual(['CLEAN', 'LEAD', '', '', '', '', '', 'SOLO']);
    expect(unit.live.sceneColors[1]).toBe(0xffe53935);
    expect(unit.scene).toBe(1); // left on the snapshot's default scene

    // what could not be done is said, not hidden: a per-scene bypass on a block the unit just created (only the unit can enable it)
    expect(report.notes.some((n) => /row 1, column 4: .*per scene.*scene mode/.test(n))).toBe(true);
    expect(report.mismatches).toEqual(['row 1, column 4: bypass differs in scene 2']);
  });

  it('a snapshot identical to the unit changes nothing and reports no differences', async () => {
    const same = blank();
    putBlock(same, 0, 0, 1, [[0.3], [0.4], [0.5]]);
    const { store, unit } = rig(clone(P.BinaryPresetSchema, same));
    await connect(store, unit);
    const report = await restoreSnapshot(store, same);
    expect(report).toMatchObject({ mismatches: [], skipped: [], errors: [], stepsRun: 1 }); // the one step: switching to the default scene
    expect(unit.writes).toBe(0);
  });

  it('blocks that cannot be placed are reported and left out; the rest is still restored', async () => {
    const snap = blank();
    putBlock(snap, 0, 0, 20000, [[0.5]]); // NC_Recorder: must never be placed
    putBlock(snap, 0, 1, 1, [[0.7], [0.5], [0.5]]);
    const live = blank();
    const { store, unit } = rig(live);
    await connect(store, unit);
    const report = await restoreSnapshot(store, snap);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]).toMatch(/crashes the unit/);
    expect(unit.live.chains[0]!.models[0]!.hash ?? 0).toBe(0); // never placed
    expect(unit.live.chains[0]!.models[1]!.hash).toBe(1);
    expect(report.errors).toEqual([]);
    expect(report.mismatches).toEqual(['row 1, column 1: snapshot has NC_Recorder, the unit has nothing']);
  });

  it('a block the unit refuses (out of DSP) shows up in the final comparison instead of being assumed', async () => {
    const snap = blank();
    putBlock(snap, 0, 0, 1, [[0.7], [0.5], [0.5]]);
    const { store, unit } = rig(blank());
    await connect(store, unit);
    // make the unit ignore placements
    const orig = (unit as any).grid.bind(unit);
    (unit as any).grid = (action: number, w: P.BinaryPreset) => { if (w.chains.some((c) => c.models.some((m) => m.hash))) return; orig(action, w); };
    const report = await restoreSnapshot(store, snap);
    expect(report.mismatches.some((m) => /row 1, column 1: snapshot has Myth Drive, the unit has nothing/.test(m))).toBe(true);
  });
});
