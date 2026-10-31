import { fromBinary, toBinary } from '@bufbuild/protobuf';
import { pa } from '@qc/protocol';
import { create } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';
import { bypassEditMessage, paramEditMessage, readBypass, readParam, withBypass, withParam } from '../src/edits';
import { bypassRow, model, preset } from './helpers';

const roundTrip = (init: ReturnType<typeof paramEditMessage>) =>
  fromBinary(pa.GridMessageSchema, toBinary(pa.GridMessageSchema, create(pa.GridMessageSchema, init)));

describe('edit messages are sparse and exactly shaped', () => {
  it('param edit: only row, column, index and ONE float value (no other fields leak onto the wire)', () => {
    const m = roundTrip(paramEditMessage(2, 3, 5, 0.25));
    expect(m.action).toBe(pa.MessageAction_Enum.UPDATE);
    expect(m.preset!.chains).toHaveLength(1);
    const chain = m.preset!.chains[0]!;
    expect(chain).toMatchObject({ row: 2 });
    expect(chain.inPortid).toBeUndefined();
    expect(chain.outPortid).toBeUndefined();
    expect(chain.models).toHaveLength(1);
    const model = chain.models[0]!;
    expect(model.column).toBe(3);
    expect(model.hash).toBeUndefined(); // must not re-specify the block
    expect(model.params).toHaveLength(1);
    const p = model.params[0]!;
    expect(p.index).toBe(5);
    expect(p.sceneMode).toBeUndefined(); // not host-writable, must stay absent
    expect(p.paramValues).toHaveLength(1);
    expect(p.paramValues[0]!.value).toEqual({ case: 'floatValue', value: 0.25 });
    expect(m.preset!.bypass).toHaveLength(0);
    expect(m.preset!.name).toBeUndefined();
  });

  it('a value of exactly 0 is still encoded (oneof members always are)', () => {
    const p = roundTrip(paramEditMessage(0, 0, 0, 0)).preset!.chains[0]!.models[0]!.params[0]!;
    expect(p.paramValues[0]!.value).toEqual({ case: 'floatValue', value: 0 });
  });

  it('bypass edit carries NO chains, and bypass=false still yields one entry', () => {
    for (const b of [true, false]) {
      const m = roundTrip(bypassEditMessage(1, 4, b));
      expect(m.preset!.chains).toHaveLength(0);
      const cb = m.preset!.bypass[0]!;
      expect(cb.row).toBe(1);
      expect(cb.colBypass[0]!.column).toBe(4);
      expect(cb.colBypass[0]!.sceneMode).toBeUndefined();
      expect(cb.colBypass[0]!.sceneBypass).toHaveLength(1);
      expect(cb.colBypass[0]!.sceneBypass[0]!.bypass).toBe(b);
    }
  });

  it('rejects values the wire cannot carry', () => {
    for (const bad of [-0.01, 1.01, Number.NaN, Infinity]) expect(() => paramEditMessage(0, 0, 0, bad)).toThrow(RangeError);
  });
});

describe('optimistic patches', () => {
  const base = () => preset({ '0,0': model(1, { params: [[1, 2, 3, 4, 5, 6, 7, 8], [0.5]], sceneModeParams: [0] }) });

  it('per-scene param changes only the active scene; plain param changes its single value; input untouched', () => {
    const p = base();
    const a = withParam(p, 0, 0, 0, 0.9, 3)!;
    expect(readParam(a, 0, 0, 0, 3)).toBe(0.9);
    expect(readParam(a, 0, 0, 0, 2)).toBe(3); // other scenes keep their values
    const b = withParam(p, 0, 0, 1, 0.1, 6)!;
    expect(readParam(b, 0, 0, 1, 0)).toBe(0.1);
    expect(readParam(p, 0, 0, 0, 3)).toBe(4); // original not mutated
    expect(readParam(p, 0, 0, 1, 0)).toBe(0.5);
  });

  it('returns undefined for a target that does not exist', () => {
    expect(withParam(base(), 0, 5, 0, 0.5, 0)).toBeUndefined();
    expect(withParam(base(), 0, 0, 9, 0.5, 0)).toBeUndefined();
    expect(withBypass(base(), 0, 0, true, 0)).toBeUndefined(); // no bypass table
  });

  it('bypass: per-scene blocks change one scene; global blocks change every slot', () => {
    const p = preset({ '0,0': model(1), '0,1': model(2) }, {
      bypass: [bypassRow(0, { 0: { states: [false] }, 1: { perScene: true, states: Array(8).fill(false) } }), bypassRow(1, {}), bypassRow(2, {}), bypassRow(3, {})],
    });
    const g = withBypass(p, 0, 0, true, 5)!;
    expect(readBypass(g, 0, 0, 5)).toBe(true);
    expect(readBypass(g, 0, 0, 0)).toBe(true);
    const s = withBypass(p, 0, 1, true, 5)!;
    expect(readBypass(s, 0, 1, 5)).toBe(true);
    expect(readBypass(s, 0, 1, 4)).toBe(false);
    expect(readBypass(p, 0, 0, 5)).toBe(false); // original untouched
  });
});

// ---- structural edits ----
import { GridMoveMessageSchema, SceneCopyMessageSchema, SceneLabelMessageSchema, SceneColorMessageSchema } from '@qc/protocol/src/gen/ProductionAutomation_pb';
import {
  moveBlockMessage, placeBlockMessage, placeRefusal, readCellHash, removeBlockMessage, sceneColorMessage, sceneCopyMessage,
  sceneLabelMessage, withoutBlock, withSceneColor, withSceneLabel, SCENE_UNLABELLED,
} from '../src/edits';
import { catalog } from './helpers';

const wire = (schema: any, init: any) => fromBinary(schema, toBinary(schema, create(schema, init))) as any;

describe('block messages', () => {
  it('place: Grid UPDATE with only row, column and hash', () => {
    const m = roundTrip(placeBlockMessage(1, 6, 4242));
    expect(m.action).toBe(pa.MessageAction_Enum.UPDATE);
    expect(m.preset!.chains).toHaveLength(1);
    expect(m.preset!.chains[0]!.row).toBe(1);
    expect(m.preset!.chains[0]!.models).toHaveLength(1);
    expect(m.preset!.chains[0]!.models[0]).toMatchObject({ column: 6, hash: 4242 });
    expect(m.preset!.chains[0]!.models[0]!.params).toHaveLength(0);
  });

  it('remove: the ACTION is DELETE and hash is explicitly 0 on the wire (an UPDATE with hash 0 is ignored by the unit)', () => {
    const m = roundTrip(removeBlockMessage(2, 0));
    expect(m.action).toBe(pa.MessageAction_Enum.DELETE);
    const model = m.preset!.chains[0]!.models[0]!;
    expect(model.column).toBe(0); // column 0 must still be encoded (optional field with presence)
    expect(model.hash).toBe(0); // present-and-zero, not absent
    expect(m.preset!.chains[0]!.row).toBe(2);
  });

  it('move: GridMove with the four coordinates and is_drop', () => {
    const m = wire(GridMoveMessageSchema, moveBlockMessage(0, 6, 1, 6));
    expect(m.move).toHaveLength(1);
    expect(m.move[0]).toMatchObject({ fromRow: 0, fromCol: 6, toRow: 1, toCol: 6, isDrop: true });
  });

  it('rejects cells off the grid, bad ids and no-op moves before building anything', () => {
    for (const [r, c] of [[-1, 0], [4, 0], [0, 8], [0, -1], [0.5, 0]]) expect(() => placeBlockMessage(r!, c!, 1)).toThrow(RangeError);
    for (const h of [0, -3, 1.5, Number.NaN]) expect(() => placeBlockMessage(0, 0, h)).toThrow(RangeError);
    expect(() => removeBlockMessage(4, 0)).toThrow(RangeError);
    expect(() => moveBlockMessage(0, 0, 0, 0)).toThrow(/same cell/);
    expect(() => moveBlockMessage(0, 0, 9, 0)).toThrow(RangeError);
  });

  it('readCellHash and withoutBlock (optimistic removal) work and do not mutate', () => {
    const p = preset({ '1,2': model(1, { params: [[0.5]] }) });
    expect(readCellHash(p, 1, 2)).toBe(1);
    expect(readCellHash(p, 0, 0)).toBe(0);
    const q = withoutBlock(p, 1, 2)!;
    expect(readCellHash(q, 1, 2)).toBe(0);
    expect(q.chains[1]!.models[2]!.params).toHaveLength(0);
    expect(readCellHash(p, 1, 2)).toBe(1);
    expect(withoutBlock(p, 9, 9)).toBeUndefined();
  });
});

describe('what may be placed', () => {
  it('NC_Recorder (20000) is refused outright — placing it crashed a real unit', () => {
    expect(placeRefusal(catalog, 20000)).toMatch(/crashes the unit/);
    expect(placeRefusal(undefined, 20000)).toMatch(/crashes the unit/); // even before the catalog is known
  });

  it('refuses unknown ids, a missing catalog, internal blocks and Neural Capture categories', () => {
    expect(placeRefusal(undefined, 1)).toMatch(/catalog/);
    expect(placeRefusal(catalog, 99999999)).toMatch(/not in this unit's catalog/);
    expect(placeRefusal(catalog, 1)).toBeUndefined(); // Myth Drive
    const capture = [...catalog.models.values()].filter((m) => /neural capture/i.test(m.category) || m.categoryId === 14 || m.categoryId === 20);
    expect(capture.length).toBeGreaterThan(0);
    for (const m of capture) expect(placeRefusal(catalog, m.id), m.name).toBeDefined();
    const internal = [...catalog.models.values()].filter((m) => m.hidden || m.internal);
    expect(internal.length).toBeGreaterThan(0);
    for (const m of internal) expect(placeRefusal(catalog, m.id), m.name).toBeDefined();
  });

  it('a healthy share of the real catalog is placeable', () => {
    const ok = [...catalog.models.values()].filter((m) => placeRefusal(catalog, m.id) === undefined);
    expect(ok.length).toBeGreaterThan(300);
  });
});

describe('scene messages', () => {
  it('label: trimmed; blank becomes a single space like the unit stores it; limits enforced', () => {
    expect(wire(SceneLabelMessageSchema, sceneLabelMessage(3, '  Lead  '))).toMatchObject({ index: 3, label: 'Lead' });
    expect(wire(SceneLabelMessageSchema, sceneLabelMessage(0, '   '))).toMatchObject({ index: 0, label: SCENE_UNLABELLED });
    expect(() => sceneLabelMessage(8, 'x')).toThrow(RangeError);
    expect(() => sceneLabelMessage(0, 'x'.repeat(21))).toThrow(RangeError);
    expect(() => sceneLabelMessage(0, 'a\u0007b')).toThrow(RangeError);
  });

  it('colour: ARGB uint32 round-trips exactly (including high alpha bits); invalid values refused', () => {
    expect(wire(SceneColorMessageSchema, sceneColorMessage(2, 0xff3aa0ff)).color).toBe(0xff3aa0ff);
    expect(wire(SceneColorMessageSchema, sceneColorMessage(2, 0xffffffff)).color).toBe(0xffffffff);
    for (const bad of [-1, 2 ** 32, 1.5, Number.NaN]) expect(() => sceneColorMessage(0, bad)).toThrow(RangeError);
  });

  it('copy / swap: UPDATE with from, to and the swap flag (not action COPY)', () => {
    expect(wire(SceneCopyMessageSchema, sceneCopyMessage(1, 3, false))).toMatchObject({ action: pa.MessageAction_Enum.UPDATE, fromIndex: 1, toIndex: 3, isSwap: false });
    expect(wire(SceneCopyMessageSchema, sceneCopyMessage(1, 3, true)).isSwap).toBe(true);
    expect(() => sceneCopyMessage(2, 2, false)).toThrow(/different/);
  });

  it('local patches pad short arrays to 8 and never mutate the input', () => {
    const p = preset({}, { sceneLabels: ['A'], sceneColors: [1] });
    const q = withSceneLabel(p, 5, 'Solo');
    expect(q.sceneLabels).toEqual(['A', ' ', ' ', ' ', ' ', 'Solo', ' ', ' ']);
    expect(p.sceneLabels).toEqual(['A']);
    expect(withSceneColor(p, 2, 0xff112233).sceneColors).toEqual([1, 0, 0xff112233, 0, 0, 0, 0, 0]);
  });
});

// ---- lane routing ----
import { lanePortMessage, readLanePort, withLanePort } from '../src/edits';
import { INPUT_PORTS, OUTPUT_PORTS, inputLabel, isKnownInput, isKnownOutput, outputLabel } from '../src/ports';

describe('lane port messages', () => {
  it('input: only row and in_portid on the wire (no out_portid, no models); output likewise', () => {
    const i = roundTrip(lanePortMessage(2, 'in', 2)).preset!.chains[0]!;
    expect(i).toMatchObject({ row: 2, inPortid: 2 });
    expect(i.outPortid).toBeUndefined();
    expect(i.models).toHaveLength(0);
    const o = roundTrip(lanePortMessage(1, 'out', 19)).preset!.chains[0]!;
    expect(o).toMatchObject({ row: 1, outPortid: 19 });
    expect(o.inPortid).toBeUndefined();
  });

  it('port 0 (unrouted / not fed) is still encoded: it is a value, not an absent field', () => {
    expect(roundTrip(lanePortMessage(0, 'out', 0)).preset!.chains[0]!.outPortid).toBe(0);
    expect(roundTrip(lanePortMessage(0, 'in', 0)).preset!.chains[0]!.inPortid).toBe(0);
  });

  it('refuses ids the unit does not define (it would store them and silence the lane), and bad rows', () => {
    for (const bad of [14, 15, 23, 99, -1, 1.5, Number.NaN]) expect(() => lanePortMessage(0, 'in', bad), `in ${bad}`).toThrow(RangeError);
    for (const bad of [23, 24, 99, -1, 2.5, Number.NaN]) expect(() => lanePortMessage(0, 'out', bad), `out ${bad}`).toThrow(RangeError);
    for (const row of [-1, 4, 0.5]) expect(() => lanePortMessage(row, 'in', 1)).toThrow(RangeError);
  });

  it('every offered port is writable, labels are unique within each list, and unknown ids are labelled honestly', () => {
    for (const p of INPUT_PORTS) expect(() => lanePortMessage(0, 'in', p.id)).not.toThrow();
    for (const p of OUTPUT_PORTS) expect(() => lanePortMessage(0, 'out', p.id)).not.toThrow();
    expect(new Set(INPUT_PORTS.map((p) => p.label)).size).toBe(INPUT_PORTS.length);
    expect(new Set(OUTPUT_PORTS.map((p) => p.label)).size).toBe(OUTPUT_PORTS.length);
    expect(new Set(INPUT_PORTS.map((p) => p.id)).size).toBe(INPUT_PORTS.length);
    expect(new Set(OUTPUT_PORTS.map((p) => p.id)).size).toBe(OUTPUT_PORTS.length);
    expect(isKnownInput(14)).toBe(false); // the internal sidechain source is displayed, never offered
    expect(inputLabel(14)).toBe('Port 14 (unrecognised)');
    expect(outputLabel(19)).toBe('Multi-Out');
    expect(inputLabel(undefined)).toBe('Not set');
    expect(isKnownOutput(16)).toBe(true);
  });

  it('patch and read-back work and do not mutate the input', () => {
    const p = preset({});
    p.chains[1]!.inPortid = 1;
    const q = withLanePort(p, 1, 'in', 2)!;
    expect(readLanePort(q, 1, 'in')).toBe(2);
    expect(readLanePort(p, 1, 'in')).toBe(1);
    expect(readLanePort(q, 1, 'out')).toBeUndefined();
    expect(withLanePort(p, 9, 'in', 2)).toBeUndefined();
  });
});

import { lanesFeeding } from '../src/ports';
describe('lanesFeeding (explains an internally fed lane)', () => {
  const outs = (o: Array<number | undefined>) => (l: number) => o[l];
  it('the Brit 2203 pattern: lane 1 output 16 feeds lane 3', () => {
    expect(lanesFeeding(2, outs([16, 0, 19, 0]))).toEqual([0]);
    expect(lanesFeeding(3, outs([16, 0, 19, 0]))).toEqual([]);
  });
  it('17 feeds lane 4, 18 feeds both, and physical outputs feed nothing', () => {
    expect(lanesFeeding(3, outs([0, 17, 0, 0]))).toEqual([1]);
    expect(lanesFeeding(2, outs([18, 0, 0, 0]))).toEqual([0]);
    expect(lanesFeeding(3, outs([18, 0, 0, 0]))).toEqual([0]);
    expect(lanesFeeding(2, outs([1, 4, 19, 3]))).toEqual([]);
    expect(lanesFeeding(2, outs([undefined, undefined, undefined, undefined]))).toEqual([]);
  });
  it('never reports a lane as feeding itself', () => {
    expect(lanesFeeding(2, outs([0, 0, 16, 0]))).toEqual([]);
  });
});

// ---- parameter targets ----
import { blockTarget, containerHash, paramEditMessageFor, readParamAt, targetKey, withParamAt } from '../src/edits';
import { buildLaneControls } from '../src/grid';
import { withLaneControls } from './helpers';

describe('parameter targets: how each container is keyed on the wire', () => {
  const chainOf = (t: Parameters<typeof paramEditMessageFor>[0]) => roundTrip(paramEditMessageFor(t, 2, 0.25)).preset!.chains[0]!;

  it('block: models[{column}] with no hash', () => {
    const c = chainOf(blockTarget(1, 4));
    expect(c.row).toBe(1);
    expect(c.models[0]).toMatchObject({ column: 4 });
    expect(c.models[0]!.hash).toBeUndefined();
    expect(c.outputControl).toHaveLength(0);
  });

  it('lane output: output_control[{hash 23000}] — keyed by hash, no column', () => {
    const c = chainOf({ kind: 'laneOut', row: 3 });
    expect(c.row).toBe(3);
    expect(c.outputControl).toHaveLength(1);
    expect(c.outputControl[0]).toMatchObject({ hash: 23000 });
    expect(c.outputControl[0]!.column).toBeUndefined();
    expect(c.outputControl[0]!.params[0]).toMatchObject({ index: 2 });
    expect(c.models).toHaveLength(0);
  });

  it('input gate: input_control[{hash 28000}]; mixer: mixer[{hash 11000}]', () => {
    expect(chainOf({ kind: 'laneIn', row: 1 }).inputControl[0]).toMatchObject({ hash: 28000 });
    expect(chainOf({ kind: 'mixer', row: 2 }).mixer[0]).toMatchObject({ hash: 11000 });
  });

  it('splitter: combined_splitter[{}] carries NEITHER hash nor column (the unit broadcasts it bare)', () => {
    const c = chainOf({ kind: 'splitter', row: 0 });
    expect(c.combinedSplitter).toHaveLength(1);
    expect(c.combinedSplitter[0]!.hash).toBeUndefined();
    expect(c.combinedSplitter[0]!.column).toBeUndefined();
    expect(c.combinedSplitter[0]!.params[0]).toMatchObject({ index: 2 });
  });

  it('refuses a mixer/splitter on lanes 2 and 4 (no branch can start there) and any off-grid target', () => {
    for (const kind of ['mixer', 'splitter'] as const) {
      expect(() => paramEditMessageFor({ kind, row: 1 }, 0, 0.5)).toThrow(/only lanes 1 and 3 can branch/);
      expect(() => paramEditMessageFor({ kind, row: 3 }, 0, 0.5)).toThrow(/only lanes 1 and 3/);
      expect(() => paramEditMessageFor({ kind, row: 0 }, 0, 0.5)).not.toThrow();
    }
    expect(() => paramEditMessageFor({ kind: 'laneOut', row: 4 }, 0, 0.5)).toThrow(RangeError);
    expect(() => paramEditMessageFor({ kind: 'block', row: 0, column: 8 }, 0, 0.5)).toThrow(RangeError);
    expect(() => paramEditMessageFor({ kind: 'laneOut', row: 0 }, 0, 1.5)).toThrow(RangeError);
  });

  it('keys: blocks keep the historical form, other containers are namespaced', () => {
    expect(targetKey(blockTarget(1, 2))).toBe('1:2');
    expect(targetKey({ kind: 'laneOut', row: 1 })).toBe('laneOut:1');
  });

  it('reading and patching work per container, per scene where flagged, without mutating the input', () => {
    const p = withLaneControls(preset({}));
    const out = { kind: 'laneOut' as const, row: 2 };
    expect(readParamAt(p, out, 1, 0)).toBe(0.5);
    const q = withParamAt(p, out, 1, 0.1, 0)!;
    expect(readParamAt(q, out, 1, 0)).toBe(0.1);
    expect(readParamAt(p, out, 1, 0)).toBe(0.5);
    // VOLUME (index 0) is per-scene in the fixture: editing scene 3 grows the list without touching scene 0
    const r = withParamAt(p, out, 0, 0.9, 3)!;
    expect(readParamAt(r, out, 0, 3)).toBe(0.9);
    expect(readParamAt(r, out, 0, 0)).toBeCloseTo(0.76923077, 6);
    expect(withParamAt(p, { kind: 'splitter', row: 1 }, 0, 0.5, 0)).toBeUndefined(); // odd lane has none
    expect(containerHash(p, out)).toBe(23000);
    expect(containerHash(p, { kind: 'mixer', row: 0 })).toBe(11000);
  });
});

describe('buildLaneControls (real catalog)', () => {
  it('names and converts lane controls: VOLUME in dB with unity at 0.769, MUTE as Off/On, meters hidden', () => {
    const p = withLaneControls(preset({}));
    const lc = buildLaneControls(p, catalog, 0, 0);
    const byName = (list: typeof lc.output, n: string) => list.find((x) => x.name === n)!;
    expect(byName(lc.output, 'VOLUME').display.text).toBe('0.0 dB');
    expect(byName(lc.output, 'PAN').display.converted).toBe(true);
    expect(byName(lc.output, 'MUTE').display.text).toBe('Off');
    expect(byName(lc.output, 'SOLO').display.text).toBe('Off');
    expect(byName(lc.inputGate, 'INPUT GAIN').display.text).toBe('0.0 dB'); // wire 0.5 on -24..+24
    expect(byName(lc.inputGate, 'GAIN REDUCTION').hidden).toBe(true); // a meter, not a control
    expect(byName(lc.inputGate, 'BYPASS').display.text).toBe('On');
    expect(lc.mixer.length).toBeGreaterThan(0);
    expect(lc.splitter.length).toBeGreaterThan(0);
  });

  it('lanes 2 and 4 have no mixer or splitter; missing data yields empty lists, not errors', () => {
    const p = withLaneControls(preset({}));
    expect(buildLaneControls(p, catalog, 1, 0).mixer).toEqual([]);
    expect(buildLaneControls(preset({}), catalog, 0, 0)).toMatchObject({ inputGate: [], output: [], mixer: [], splitter: [] });
    expect(buildLaneControls(p, undefined, 0, 0).output[0]!.display.converted).toBe(false);
  });
});

// ---- branching ----
import { readSplit, splitMessage, withSplit } from '../src/edits';
describe('split / mix columns', () => {
  const sp = (row: number, a: number, b: number) => roundTrip(splitMessage(row, a, b)).preset!.chains[0]!;
  it('sends row + split_control_points only; -1 (clear) survives the wire', () => {
    const c = sp(0, 2, 6);
    expect(c.row).toBe(0);
    expect(c.splitControlPoints[0]).toMatchObject({ split: 2, mix: 6 });
    expect(c.models).toHaveLength(0);
    expect(sp(2, -1, -1).splitControlPoints[0]).toMatchObject({ split: -1, mix: -1 });
    expect(sp(0, 3, -1).splitControlPoints[0]).toMatchObject({ split: 3, mix: -1 }); // never rejoins
  });
  it('refuses odd lanes, off-range columns and nonsense branches', () => {
    expect(() => splitMessage(1, 0, 7)).toThrow(/only lanes 1 and 3/);
    expect(() => splitMessage(3, 0, 7)).toThrow(/only lanes 1 and 3/);
    expect(() => splitMessage(0, 8, 9)).toThrow(RangeError);
    expect(() => splitMessage(0, -2, 3)).toThrow(RangeError);
    expect(() => splitMessage(0, -1, 4)).toThrow(/needs a split column/);
    expect(() => splitMessage(0, 4, 4)).toThrow(/rejoin after/);
    expect(() => splitMessage(0, 5, 2)).toThrow(/rejoin after/);
  });
  it('patch/read', () => {
    const p = preset({});
    const q = withSplit(p, 0, 1, 5)!;
    expect(readSplit(q, 0)).toEqual({ split: 1, mix: 5 });
    expect(readSplit(p, 0)).toBeUndefined();
  });
});
