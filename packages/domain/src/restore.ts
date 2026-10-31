// Rebuilding a preset on the unit from a snapshot (a BinaryPreset). The unit ignores whole-preset writes, so this is a PLAN:
// compare the snapshot (S) with the unit's live preset (L) and issue the same sparse edits the rest of the app uses.
//
//   phase 1 (structure):  lane ports, branches, blocks (remove / place)           -> read back
//   phase 2 (values):     promote params to per-scene, params, bypass, scene names/colours -> read back -> report
//
// Pure functions only: nothing here talks to the unit. See restore-exec.ts for the executor.
import type { Catalog, preset as PT } from '@qc/protocol';
import { toBinary } from '@bufbuild/protobuf';
import { preset as PS } from '@qc/protocol';
import { findContainer, placeRefusal, readSplit, type ParamTarget } from './edits';
import { GRID_COLS, GRID_ROWS } from './grid';
import { isKnownInput, isKnownOutput } from './ports';

type Preset = PT.BinaryPreset;
const EPS = 1e-5;
const SCENES = 8;

export const targetName = (t: ParamTarget): string =>
  t.kind === 'block' ? `row ${t.row + 1}, column ${t.column + 1}` : `lane ${t.row + 1} ${t.kind === 'laneIn' ? 'input gate' : t.kind === 'laneOut' ? 'output' : t.kind}`;

// ---- reading -------------------------------------------------------------------------------------

const chainOf = (p: Preset, row: number) => p.chains.find((c, i) => (c.row ?? i) === row) ?? p.chains[row];

const hashAt = (p: Preset, row: number, column: number): number => {
  const c = chainOf(p, row);
  return (c?.models.find((m, i) => (m.column ?? i) === column) ?? c?.models[column])?.hash ?? 0;
};

const paramAt = (p: Preset, t: ParamTarget, index: number): PT.Param | undefined => {
  const c = findContainer(chainOf(p, t.row), t);
  return c?.params.find((q, i) => (q.index ?? i) === index) ?? c?.params[index];
};

/** The eight per-scene wire values of a float parameter (a global one repeats). undefined if any value isn't a plain float. */
export function sceneVector(p: PT.Param): number[] | undefined {
  const raw = p.paramValues.map((v) => (v.value.case === 'floatValue' ? v.value.value : undefined));
  if (raw.length === 0 || raw.some((v) => v === undefined)) return undefined;
  const vals = raw as number[];
  return Array.from({ length: SCENES }, (_, s) => (p.sceneMode ? (vals[Math.min(s, vals.length - 1)] as number) : (vals[0] as number)));
}

const bypassEntry = (p: Preset, row: number, column: number) => {
  const r = p.bypass.find((b, i) => (b.row ?? i) === row) ?? p.bypass[row];
  const c = r?.colBypass.find((x, i) => (x.column ?? i) === column) ?? r?.colBypass[column];
  if (!c || c.sceneBypass.length === 0) return undefined;
  const perScene = c.sceneMode === true;
  return { perScene, states: Array.from({ length: SCENES }, (_, s) => (perScene ? (c.sceneBypass[Math.min(s, c.sceneBypass.length - 1)]?.bypass ?? false) : (c.sceneBypass[0]?.bypass ?? false))) };
};

const same = (a: number, b: number) => Math.abs(a - b) <= EPS;
const allEqual = (v: number[]) => v.every((x) => same(x, v[0]!));

/** Every container whose parameters we can restore, for a preset. Mixer/splitter only where a branch is active. */
export function restorableTargets(p: Preset, branchOf: Preset = p): ParamTarget[] {
  const out: ParamTarget[] = [];
  for (let row = 0; row < GRID_ROWS; row++) {
    for (let column = 0; column < GRID_COLS; column++) if (hashAt(p, row, column)) out.push({ kind: 'block', row, column });
    out.push({ kind: 'laneIn', row }, { kind: 'laneOut', row });
    if (row % 2 === 0 && (readSplit(branchOf, row)?.split ?? -1) >= 0) out.push({ kind: 'mixer', row }, { kind: 'splitter', row });
  }
  return out;
}

// ---- phase 1: structure ----------------------------------------------------------------------------

export type StructureStep =
  | { kind: 'lanePort'; row: number; side: 'in' | 'out'; id: number }
  | { kind: 'split'; row: number; split: number; mix: number }
  | { kind: 'remove'; row: number; column: number }
  | { kind: 'place'; row: number; column: number; hash: number; name: string };

export interface StructurePlan { steps: StructureStep[]; skipped: string[] }

export function planStructure(live: Preset, snap: Preset, catalog: Catalog | undefined): StructurePlan {
  const steps: StructureStep[] = [];
  const skipped: string[] = [];

  for (let row = 0; row < GRID_ROWS; row++) {
    const sc = chainOf(snap, row);
    const lc = chainOf(live, row);
    for (const side of ['in', 'out'] as const) {
      const want = side === 'in' ? sc?.inPortid : sc?.outPortid;
      const have = side === 'in' ? lc?.inPortid : lc?.outPortid;
      if (want === undefined || want === have) continue;
      if (side === 'in' ? !isKnownInput(want) : !isKnownOutput(want)) { skipped.push(`lane ${row + 1} ${side}put: port ${want} is not one this app can set`); continue; }
      steps.push({ kind: 'lanePort', row, side, id: want });
    }
    if (row % 2 === 0) {
      const ws = readSplit(snap, row);
      const hs = readSplit(live, row);
      if (ws && (ws.split !== hs?.split || ws.mix !== hs?.mix)) steps.push({ kind: 'split', row, split: ws.split, mix: ws.mix });
    }
  }

  const removes: StructureStep[] = [];
  const places: StructureStep[] = [];
  for (let row = 0; row < GRID_ROWS; row++) {
    for (let column = 0; column < GRID_COLS; column++) {
      const want = hashAt(snap, row, column);
      const have = hashAt(live, row, column);
      if (want === have) continue;
      if (want === 0) { removes.push({ kind: 'remove', row, column }); continue; }
      const name = catalog?.models.get(want)?.name ?? `block #${want}`;
      const why = placeRefusal(catalog, want);
      if (why) {
        skipped.push(`${name} at row ${row + 1}, column ${column + 1}: ${why}`);
        if (have !== 0) removes.push({ kind: 'remove', row, column }); // don't leave a different block where the snapshot has something else
        continue;
      }
      places.push({ kind: 'place', row, column, hash: want, name });
    }
  }
  return { steps: [...steps, ...removes, ...places], skipped };
}

// ---- phase 2: values ------------------------------------------------------------------------------------

export type ValueOp =
  | { kind: 'param'; target: ParamTarget; index: number; wire: number; label: string }
  | { kind: 'bypass'; row: number; column: number; bypassed: boolean };

export interface ValuePlan {
  /** Parameters to switch to per-scene mode first (the flag is sent alone). */
  promotes: Array<{ target: ParamTarget; index: number }>;
  /** Writes that don't depend on the active scene (a global parameter, a global bypass). */
  global: ValueOp[];
  /** Writes per scene; the executor switches to the scene, then writes. */
  perScene: ValueOp[][];
  labels: Array<{ index: number; label: string }>;
  colors: Array<{ index: number; argb: number }>;
  /** Things we deliberately did not or could not restore. */
  notes: string[];
}

export function planValues(live: Preset, snap: Preset): ValuePlan {
  const plan: ValuePlan = { promotes: [], global: [], perScene: Array.from({ length: SCENES }, () => []), labels: [], colors: [], notes: [] };
  let skippedParams = 0;

  for (const t of restorableTargets(snap)) {
    const sc = findContainer(chainOf(snap, t.row), t);
    const lc = findContainer(chainOf(live, t.row), t);
    if (!sc) continue;
    if (!lc) { plan.notes.push(`${targetName(t)}: not present on the unit, parameters skipped`); continue; }
    if (t.kind === 'block' && sc.hash !== lc.hash) continue; // the placement didn't take (reported by the structure step)

    sc.params.forEach((sp, i) => {
      const index = sp.index ?? i;
      const lp = paramAt(live, t, index);
      const vs = sceneVector(sp);
      if (!lp) return;
      if (!vs) { skippedParams++; return; }
      if (vs.some((v) => !(v >= 0 && v <= 1))) { plan.notes.push(`${targetName(t)} #${index}: value outside 0..1 (not restored)`); return; }
      const vl0 = sceneVector(lp);
      if (!vl0) { skippedParams++; return; }
      const label = `${targetName(t)} #${index}`;
      const varies = sp.sceneMode === true && !allEqual(vs);

      if (!varies) {
        const want = vs[0]!;
        if (vl0.every((x) => same(x, want))) return;
        if (lp.sceneMode === true) vl0.forEach((x, s) => { if (!same(x, want)) plan.perScene[s]!.push({ kind: 'param', target: t, index, wire: want, label }); });
        else plan.global.push({ kind: 'param', target: t, index, wire: want, label });
        return;
      }
      // per-scene values: the parameter has to follow scenes first (a promoted parameter starts with its current value everywhere)
      let have = vl0;
      if (lp.sceneMode !== true) { plan.promotes.push({ target: t, index }); have = Array(SCENES).fill(vl0[0]!); }
      vs.forEach((x, s) => { if (!same(x, have[s]!)) plan.perScene[s]!.push({ kind: 'param', target: t, index, wire: x, label }); });
    });
  }
  if (skippedParams > 0) plan.notes.push(`${skippedParams} text/integer parameter${skippedParams === 1 ? '' : 's'} (cab/IR choices, capture names…) are not restored`);

  // bypass
  for (let row = 0; row < GRID_ROWS; row++) {
    for (let column = 0; column < GRID_COLS; column++) {
      if (!hashAt(snap, row, column) || hashAt(snap, row, column) !== hashAt(live, row, column)) continue;
      const ws = bypassEntry(snap, row, column);
      const hl = bypassEntry(live, row, column);
      if (!ws) continue;
      const states = ws.states.map((b) => (b ? 1 : 0));
      const varies = ws.perScene && !allEqual(states);
      const have = hl?.states.map((b) => (b ? 1 : 0)) ?? Array(SCENES).fill(-1);
      if (!varies) {
        const want = states[0]! === 1;
        if (hl && have.every((x) => (x === 1) === want)) continue;
        if (hl?.perScene) have.forEach((x, s) => { if ((x === 1) !== want) plan.perScene[s]!.push({ kind: 'bypass', row, column, bypassed: want }); });
        else plan.global.push({ kind: 'bypass', row, column, bypassed: want });
        continue;
      }
      if (hl?.perScene) states.forEach((x, s) => { if (x !== have[s]) plan.perScene[s]!.push({ kind: 'bypass', row, column, bypassed: x === 1 }); });
      else {
        plan.global.push({ kind: 'bypass', row, column, bypassed: states[0] === 1 });
        plan.notes.push(`row ${row + 1}, column ${column + 1}: the snapshot bypasses this block per scene, but the unit's block isn't in scene mode (only the unit itself can switch that on); scene 1's state was used for all scenes`);
      }
    }
  }

  // scene names and colours
  for (let i = 0; i < SCENES; i++) {
    const wl = (snap.sceneLabels[i] ?? ' ').trim();
    if (wl !== (live.sceneLabels[i] ?? ' ').trim()) plan.labels.push({ index: i, label: wl });
    const wc = snap.sceneColors[i] ?? 0;
    if (wc !== (live.sceneColors[i] ?? 0)) plan.colors.push({ index: i, argb: wc });
  }
  return plan;
}

export const planSize = (p: ValuePlan) => p.promotes.length + p.global.length + p.perScene.reduce((n, l) => n + l.length, 0) + p.labels.length + p.colors.length;

// ---- what we cannot restore at all ---------------------------------------------------------------------------

/** Parts of the snapshot this app doesn't restore, worded for the person reading the report. */
export function unsupportedInSnapshot(snap: Preset): string[] {
  const out: string[] = [];
  if (snap.stompModeAssignments.length) out.push(`footswitch assignments (${snap.stompModeAssignments.length})`);
  if (snap.midiMessages.length || snap.midiMessagesGeneral.length || snap.midiMessagesGeneralV2.length) out.push('MIDI messages');
  if (snap.tempoProgramData.length) out.push('the preset tempo block');
  if (snap.sceneTempo.some((t) => t > 0)) out.push('scene tempos');
  let expr = 0;
  for (const t of restorableTargets(snap)) for (const p of findContainer(chainOf(snap, t.row), t)?.params ?? []) if ((p.expression ?? 0) > 0) expr++;
  if (expr) out.push(`expression pedal assignments (${expr})`);
  if (snap.tags.length || snap.description.length) out.push('tags and description');
  return out;
}

// ---- comparing ---------------------------------------------------------------------------------------------------

/** Differences between the snapshot and the unit's live preset, in the dimensions this app restores. Empty = a match. */
export function diffPresets(snap: Preset, live: Preset, catalog: Catalog | undefined): string[] {
  const out: string[] = [];
  const nm = (h: number) => catalog?.models.get(h)?.name ?? `block #${h}`;
  for (let row = 0; row < GRID_ROWS; row++) {
    for (const side of ['in', 'out'] as const) {
      const a = side === 'in' ? chainOf(snap, row)?.inPortid : chainOf(snap, row)?.outPortid;
      const b = side === 'in' ? chainOf(live, row)?.inPortid : chainOf(live, row)?.outPortid;
      if (a !== undefined && a !== b && (side === 'in' ? isKnownInput(a) : isKnownOutput(a))) out.push(`lane ${row + 1} ${side}put differs`);
    }
    if (row % 2 === 0) {
      const a = readSplit(snap, row), b = readSplit(live, row);
      if (a && (a.split !== b?.split || a.mix !== b?.mix)) out.push(`lane ${row + 1} branch differs`);
    }
    for (let column = 0; column < GRID_COLS; column++) {
      const a = hashAt(snap, row, column), b = hashAt(live, row, column);
      if (a !== b) out.push(`row ${row + 1}, column ${column + 1}: snapshot has ${a ? nm(a) : 'nothing'}, the unit has ${b ? nm(b) : 'nothing'}`);
    }
  }
  const compared = new Set<string>();
  for (const t of restorableTargets(snap)) {
    if (t.kind === 'block' && hashAt(snap, t.row, t.column) !== hashAt(live, t.row, t.column)) continue;
    const sc = findContainer(chainOf(snap, t.row), t);
    sc?.params.forEach((sp, i) => {
      const index = sp.index ?? i;
      const vs = sceneVector(sp);
      const lp = paramAt(live, t, index);
      const vl = lp && sceneVector(lp);
      if (!vs || !vl || vs.some((v) => !(v >= 0 && v <= 1))) return;
      const bad = vs.findIndex((v, s) => !same(v, vl[s]!));
      if (bad >= 0) { const key = `${targetName(t)} #${index}`; if (!compared.has(key)) { compared.add(key); out.push(`${key}: scene ${bad + 1} is ${vl[bad]!.toFixed(4)}, the snapshot has ${vs[bad]!.toFixed(4)}`); } }
    });
    if (t.kind === 'block') {
      const a = bypassEntry(snap, t.row, t.column), b = bypassEntry(live, t.row, t.column);
      if (a && b) { const bad = a.states.findIndex((x, s) => x !== b.states[s]); if (bad >= 0) out.push(`${targetName(t)}: bypass differs in scene ${bad + 1}`); }
    }
  }
  for (let i = 0; i < SCENES; i++) {
    if ((snap.sceneLabels[i] ?? ' ').trim() !== (live.sceneLabels[i] ?? ' ').trim()) out.push(`scene ${i + 1} name differs`);
    if ((snap.sceneColors[i] ?? 0) !== (live.sceneColors[i] ?? 0)) out.push(`scene ${i + 1} colour differs`);
  }
  return out;
}

/** Decode a stored snapshot. */
export const snapshotBytes = (p: Preset): Uint8Array => toBinary(PS.BinaryPresetSchema, p);
