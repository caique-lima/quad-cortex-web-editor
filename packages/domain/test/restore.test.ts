import { create } from '@bufbuild/protobuf';
import { preset as P } from '@qc/protocol';
import { describe, expect, it } from 'vitest';
import { diffPresets, planSize, planStructure, planValues, sceneVector, unsupportedInSnapshot } from '../src/restore';
import { bypassRow, catalog, model, preset, withLaneControls } from './helpers';

const bypassAll = (rows: Record<number, Record<number, { perScene?: boolean; states: boolean[] }>> = {}) =>
  [0, 1, 2, 3].map((r) => bypassRow(r, rows[r] ?? {}));
const withPorts = (p: ReturnType<typeof preset>, ports: Array<[number?, number?]>) => { ports.forEach(([i, o], r) => { if (i !== undefined) p.chains[r]!.inPortid = i; if (o !== undefined) p.chains[r]!.outPortid = o; }); return p; };

describe('sceneVector', () => {
  it('per-scene params give their 8 values; global ones repeat; non-float values are refused', () => {
    const p = model(1, { params: [[1, 2, 3, 4, 5, 6, 7, 8], [0.5]], sceneModeParams: [0] });
    expect(sceneVector(p.params[0]!)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(sceneVector(p.params[1]!)).toEqual(Array(8).fill(0.5));
    const str = create(P.ParamSchema, { index: 0, paramValues: [create(P.ParamValueSchema, { value: { case: 'stringValue', value: 'x' } })] });
    expect(sceneVector(str)).toBeUndefined();
  });
});

describe('planStructure', () => {
  it('identical presets need nothing', () => {
    const p = withPorts(preset({ '0,0': model(1) }), [[1, 1]]);
    expect(planStructure(p, p, catalog)).toEqual({ steps: [], skipped: [] });
  });

  it('ports and branches first, then removals, then placements; only what differs', () => {
    const snap = withPorts(preset({ '0,1': model(2), '1,0': model(1) }), [[1, 16], [undefined, undefined], [2, 19]]);
    snap.chains[0]!.splitControlPoints = [create(P.SplitControlPointsSchema, { split: 1, mix: 5 })];
    const live = withPorts(preset({ '0,1': model(1), '2,2': model(2) }), [[1, 1], [undefined, undefined], [2, 19]]);
    const { steps, skipped } = planStructure(live, snap, catalog);
    expect(skipped).toEqual([]);
    expect(steps.map((s) => s.kind)).toEqual(['lanePort', 'split', 'remove', 'place', 'place']);
    expect(steps[0]).toEqual({ kind: 'lanePort', row: 0, side: 'out', id: 16 });
    expect(steps[1]).toEqual({ kind: 'split', row: 0, split: 1, mix: 5 });
    expect(steps[2]).toEqual({ kind: 'remove', row: 2, column: 2 });
    expect(steps.slice(3)).toMatchObject([{ kind: 'place', row: 0, column: 1, hash: 2 }, { kind: 'place', row: 1, column: 0, hash: 1, name: 'Myth Drive' }]);
  });

  it('a block that cannot be placed (NC_Recorder, captures, unknown ids) is skipped with a reason, and the cell is not left holding something else', () => {
    const capture = [...catalog.models.values()].find((m) => m.categoryId === 14 || /neural capture/i.test(m.category))!;
    const snap = preset({ '0,0': model(20000), '0,1': model(capture.id), '0,2': model(99999999) });
    const live = preset({ '0,0': model(1) });
    const { steps, skipped } = planStructure(live, snap, catalog);
    expect(skipped).toHaveLength(3);
    expect(skipped[0]).toMatch(/crashes the unit/);
    expect(skipped[1]).toMatch(/Neural Capture/);
    expect(skipped[2]).toMatch(/not in this unit's catalog/);
    expect(steps).toEqual([{ kind: 'remove', row: 0, column: 0 }]); // live's Myth Drive must not stay where the snapshot has another block
  });

  it('a port this app cannot set is reported, not written', () => {
    const snap = withPorts(preset({}), [[14, 99]]);
    const { steps, skipped } = planStructure(withPorts(preset({}), [[1, 1]]), snap, catalog);
    expect(steps).toEqual([]);
    expect(skipped).toHaveLength(2);
  });
});

describe('planValues', () => {
  const blk = (vals: number[][], sceneModeParams: number[] = []) => model(1, { params: vals, sceneModeParams });

  it('nothing to do when the unit already matches (float noise ignored)', () => {
    const snap = preset({ '0,0': blk([[0.3]]) }, { bypass: bypassAll() });
    const live = preset({ '0,0': blk([[0.3 + 1e-7]]) }, { bypass: bypassAll() });
    expect(planSize(planValues(live, snap))).toBe(0);
  });

  it('a global parameter that differs is one global write', () => {
    const plan = planValues(preset({ '0,0': blk([[0.5]]) }), preset({ '0,0': blk([[0.9]]) }));
    expect(plan.global).toEqual([{ kind: 'param', target: { kind: 'block', row: 0, column: 0 }, index: 0, wire: 0.9, label: 'row 1, column 1 #0' }]);
    expect(plan.promotes).toEqual([]);
    expect(plan.perScene.every((l) => l.length === 0)).toBe(true);
  });

  it('values that vary by scene on a block that is NOT per-scene yet: promote first, then write only the scenes that differ', () => {
    const snap = preset({ '0,0': blk([[0.5, 0.5, 0.9, 0.5, 0.5, 0.5, 0.2, 0.5]], [0]) });
    const live = preset({ '0,0': blk([[0.5]]) });
    const plan = planValues(live, snap);
    expect(plan.promotes).toEqual([{ target: { kind: 'block', row: 0, column: 0 }, index: 0 }]);
    expect(plan.global).toEqual([]);
    expect(plan.perScene.map((l) => l.length)).toEqual([0, 0, 1, 0, 0, 0, 1, 0]);
    expect(plan.perScene[2]![0]).toMatchObject({ kind: 'param', wire: 0.9 });
  });

  it('values that vary by scene on a block that already follows scenes: no promotion', () => {
    const snap = preset({ '0,0': blk([[0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]], [0]) });
    const live = preset({ '0,0': blk([[0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.1]], [0]) });
    const plan = planValues(live, snap);
    expect(plan.promotes).toEqual([]);
    expect(plan.perScene.map((l) => l.length)).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
  });

  it('a per-scene parameter that is uniform in the snapshot is NOT promoted (one global write), but a per-scene target is written scene by scene', () => {
    const snap = preset({ '0,0': blk([Array(8).fill(0.4)], [0]) });
    const liveGlobal = preset({ '0,0': blk([[0.5]]) });
    expect(planValues(liveGlobal, snap)).toMatchObject({ promotes: [], global: [{ wire: 0.4 }] });
    const livePerScene = preset({ '0,0': blk([[0.5, 0.5, 0.4, 0.5, 0.5, 0.5, 0.5, 0.5]], [0]) });
    const plan = planValues(livePerScene, snap);
    expect(plan.global).toEqual([]);
    expect(plan.perScene.map((l) => l.length)).toEqual([1, 1, 0, 1, 1, 1, 1, 1]);
  });

  it('skips blocks whose placement did not take, text parameters, NaN and out-of-range values — and says so', () => {
    const str = create(P.ParamSchema, { index: 1, paramValues: [create(P.ParamValueSchema, { value: { case: 'stringValue', value: 'cab.ir' } })] });
    const m = blk([[0.9], [Number.NaN], [1.7]]);
    m.params[1]!.paramValues = [m.params[1]!.paramValues[0]!];
    m.params.push(str);
    const snap = preset({ '0,0': m, '0,1': model(2, { params: [[0.9]] }) });
    const live = preset({ '0,0': blk([[0.1], [0.5], [0.5]]), '0,1': model(1, { params: [[0.1]] }) }); // 0,1 holds a different block
    const plan = planValues(live, snap);
    expect(plan.global).toHaveLength(1); // only block 0,0 param 0
    expect(plan.notes.some((n) => /outside 0\.\.1/.test(n))).toBe(true);
    expect(plan.notes.some((n) => /text\/integer parameter/.test(n))).toBe(true);
  });

  it('lane controls restore; mixer and splitter only when the snapshot has an active branch', () => {
    const snap = withLaneControls(preset({}), { out: [0.5, 0.5, 1, 0] });
    const live = withLaneControls(preset({}));
    const targets = (p: ReturnType<typeof planValues>) => p.global.map((o) => (o.kind === 'param' ? `${o.target.kind}${o.target.row}#${o.index}` : ''));
    const lanePlan = planValues(live, snap);
    expect(targets(lanePlan).filter((t) => t.startsWith('laneOut0'))).toEqual(['laneOut0#2']); // MUTE: a global parameter
    // VOLUME follows scenes on the unit, so its change is written once per scene
    expect(lanePlan.perScene.every((l) => l.some((o) => o.kind === 'param' && o.target.kind === 'laneOut' && o.target.row === 0 && o.index === 0))).toBe(true);
    // mixer value differs but no branch -> not planned
    const snap2 = withLaneControls(preset({}), { mixer: [0.1, 0.5, 0.76923077, 0.5, 0, 0.76923077, 0] });
    expect(targets(planValues(withLaneControls(preset({})), snap2)).some((t) => t.startsWith('mixer'))).toBe(false);
    snap2.chains[0]!.splitControlPoints = [create(P.SplitControlPointsSchema, { split: 1, mix: 4 })];
    const live2 = withLaneControls(preset({})); live2.chains[0]!.splitControlPoints = [create(P.SplitControlPointsSchema, { split: 1, mix: 4 })];
    expect(targets(planValues(live2, snap2)).some((t) => t.startsWith('mixer0'))).toBe(true);
  });

  it('bypass: global when the unit block is not per-scene; per-scene when it is; a per-scene snapshot on a global block is reported', () => {
    const snap = preset({ '0,0': model(1), '0,1': model(2), '0,2': model(1) }, { bypass: bypassAll({ 0: {
      0: { states: [true] },
      1: { perScene: true, states: [false, true, false, false, false, false, false, false] },
      2: { perScene: true, states: [false, true, false, false, false, false, false, false] },
    } }) });
    const live = preset({ '0,0': model(1), '0,1': model(2), '0,2': model(1) }, { bypass: bypassAll({ 0: {
      0: { states: [false] },
      1: { perScene: true, states: Array(8).fill(false) },
      2: { states: [false] }, // global on the unit
    } }) });
    const plan = planValues(live, snap);
    expect(plan.global).toEqual([
      { kind: 'bypass', row: 0, column: 0, bypassed: true },
      { kind: 'bypass', row: 0, column: 2, bypassed: false }, // scene 1's state
    ]);
    expect(plan.perScene[1]).toEqual([{ kind: 'bypass', row: 0, column: 1, bypassed: true }]);
    expect(plan.notes.some((n) => /only the unit itself can switch that on/.test(n))).toBe(true);
  });

  it('scene names and colours that differ are queued; blank names compare as blank', () => {
    const snap = preset({}, { sceneLabels: ['A', ' ', 'C', ' ', ' ', ' ', ' ', ' '], sceneColors: [1, 0, 3, 0, 0, 0, 0, 0] });
    const live = preset({}, { sceneLabels: ['A', '', 'X', ' ', ' ', ' ', ' ', ' '], sceneColors: [1, 0, 0, 0, 0, 0, 0, 0] });
    const plan = planValues(live, snap);
    expect(plan.labels).toEqual([{ index: 2, label: 'C' }]);
    expect(plan.colors).toEqual([{ index: 2, argb: 3 }]);
  });
});

describe('unsupportedInSnapshot', () => {
  it('lists what the app does not restore, and is empty for a plain preset', () => {
    expect(unsupportedInSnapshot(preset({ '0,0': model(1, { params: [[0.5]] }) }))).toEqual([]);
    const p = preset({ '0,0': model(1, { params: [[0.5]] }) });
    p.stompModeAssignments = [create(P.StompModeAssignmentSchema, { row: 0, column: 0, stompIndex: 1 })];
    p.chains[0]!.models[0]!.params[0]!.expression = 1;
    p.tags = ['x'];
    expect(unsupportedInSnapshot(p)).toEqual(['footswitch assignments (1)', 'expression pedal assignments (1)', 'tags and description']);
  });
});

describe('diffPresets', () => {
  it('is empty for equal presets and names every kind of difference otherwise', () => {
    const snap = withLaneControls(withPorts(preset({ '0,0': model(1, { params: [[0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2]], sceneModeParams: [0] }) }, { bypass: bypassAll({ 0: { 0: { states: [true] } } }), sceneLabels: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] }), [[1, 1]]));
    expect(diffPresets(snap, snap, catalog)).toEqual([]);
    const live = withLaneControls(withPorts(preset({ '0,0': model(2, { params: [[0.9]] }), '1,1': model(1) }, { bypass: bypassAll({ 0: { 0: { states: [false] } } }), sceneLabels: ['A', 'B', 'X', 'D', 'E', 'F', 'G', 'H'] }), [[2, 1]]));
    const d = diffPresets(snap, live, catalog);
    expect(d.some((x) => /lane 1 input differs/.test(x))).toBe(true);
    expect(d.some((x) => /row 1, column 1: snapshot has Myth Drive, the unit has Obsessive Drive/.test(x))).toBe(true);
    expect(d.some((x) => /row 2, column 2: snapshot has nothing/.test(x))).toBe(true);
    expect(d.some((x) => /scene 3 name differs/.test(x))).toBe(true);
    // the block at 0,0 differs, so its params/bypass are not compared (the placement itself is the difference)
    expect(d.some((x) => /#0/.test(x))).toBe(false);
  });

  it('reports a parameter that differs, in which scene', () => {
    const mk = (v: number) => preset({ '0,0': model(1, { params: [[v, v, v, 0.5, v, v, v, v]], sceneModeParams: [0] }) });
    const d = diffPresets(mk(0.2), mk(0.8), catalog);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatch(/row 1, column 1 #0: scene 1 is 0\.8000, the snapshot has 0\.2000/);
  });
});
