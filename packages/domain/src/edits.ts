import { clone, create } from '@bufbuild/protobuf';
import { pa, preset as P } from '@qc/protocol';
import { GRID_COLS, GRID_ROWS } from './grid';
import { isKnownInput, isKnownOutput } from './ports';

// Sparse, row/column-keyed edits — the only form the unit applies (a full-preset write is ignored).
// Wire shapes per pyquadcortex protocol.md / client.set_param / set_bypass (verified there on CorOS 4.0.1):
//   param:  Grid{UPDATE, preset{chains{row, models{column, params{index, param_values[0]{float_value}}}}}}
//   bypass: Grid{UPDATE, preset{bypass{row, colBypass{column, sceneBypass[0]{bypass}}}}}   (no `chains` beside it)
// Entry [0] means "the ACTIVE scene" on the wire; for params/blocks that aren't per-scene it is the one global value.

type GridInit = Parameters<typeof create<typeof pa.GridMessageSchema>>[1];

// ---- parameter targets ---------------------------------------------------------------------------
// Parameters live in several containers on a chain. They are keyed differently on the wire (pyquadcortex targets.py):
//   block -> models[{column}]   lane output -> output_control[{hash 23000}]   input gate -> input_control[{hash 28000}]
//   mixer -> mixer[{hash 11000}] (rows 0 and 2)   splitter -> combined_splitter[{}] (rows 0 and 2; carries neither key)

export const LANE_OUTPUT_MODEL = 23000;
export const INPUT_GATE_MODEL = 28000;
export const MIXER_MODEL = 11000;
export const SPLITTER_MODEL = 10004;

export type ParamTarget =
  | { kind: 'block'; row: number; column: number }
  | { kind: 'laneOut'; row: number }
  | { kind: 'laneIn'; row: number }
  | { kind: 'mixer'; row: number }
  | { kind: 'splitter'; row: number };

export const blockTarget = (row: number, column: number): ParamTarget => ({ kind: 'block', row, column });

/** Stable key. Blocks keep the historical `row:column` form. */
export function targetKey(t: ParamTarget): string {
  return t.kind === 'block' ? `${t.row}:${t.column}` : `${t.kind}:${t.row}`;
}

export function describeTarget(t: ParamTarget): string {
  switch (t.kind) {
    case 'block': return `row ${t.row + 1}, column ${t.column + 1}`;
    case 'laneOut': return `lane ${t.row + 1} output`;
    case 'laneIn': return `lane ${t.row + 1} input gate`;
    case 'mixer': return `lane ${t.row + 1} mixer`;
    case 'splitter': return `lane ${t.row + 1} splitter`;
  }
}

function checkTarget(t: ParamTarget) {
  if (!Number.isInteger(t.row) || t.row < 0 || t.row >= GRID_ROWS) throw new RangeError(`row must be 0..${GRID_ROWS - 1}, got ${t.row}`);
  if (t.kind === 'block' && (!Number.isInteger(t.column) || t.column < 0 || t.column >= GRID_COLS)) throw new RangeError(`column must be 0..${GRID_COLS - 1}, got ${t.column}`);
  // A branch can only start on an even row: rows 1 and 3 report an empty splitter/mixer and a write there does nothing.
  if ((t.kind === 'mixer' || t.kind === 'splitter') && t.row % 2 !== 0) throw new RangeError(`lane ${t.row + 1} has no ${t.kind}: only lanes 1 and 3 can branch`);
}

/** The container (a Model entry) holding this target's params, within a chain; undefined if absent. */
export function findContainer(chain: P.Chain | undefined, t: ParamTarget): P.Model | undefined {
  if (!chain) return undefined;
  const pick = (list: P.Model[], hash: number) => list.find((m) => m.hash === hash) ?? list[0];
  switch (t.kind) {
    case 'block': return byPos(chain.models, 'column', t.column);
    case 'laneOut': return pick(chain.outputControl, LANE_OUTPUT_MODEL);
    case 'laneIn': return pick(chain.inputControl, INPUT_GATE_MODEL);
    case 'mixer': return pick(chain.mixer, MIXER_MODEL);
    case 'splitter': return pick(chain.combinedSplitter, SPLITTER_MODEL);
  }
}

/** The model id of a target's container, as found in the preset (block hash, or the lane-control model). */
export function containerHash(preset: P.BinaryPreset, t: ParamTarget): number | undefined {
  return findContainer(byPos(preset.chains, 'row', t.row), t)?.hash;
}

export function paramEditMessageFor(target: ParamTarget, paramIndex: number, wire: number): GridInit {
  checkTarget(target);
  if (!(wire >= 0 && wire <= 1)) throw new RangeError(`wire value must be within 0..1, got ${wire}`);
  const params = [create(P.ParamSchema, {
    index: paramIndex,
    paramValues: [create(P.ParamValueSchema, { value: { case: 'floatValue', value: wire } })],
  })];
  const row = target.row;
  const chain = (() => {
    switch (target.kind) {
      case 'block': return create(P.ChainSchema, { row, models: [create(P.ModelSchema, { column: target.column, params })] });
      case 'laneOut': return create(P.ChainSchema, { row, outputControl: [create(P.ModelSchema, { hash: LANE_OUTPUT_MODEL, params })] });
      case 'laneIn': return create(P.ChainSchema, { row, inputControl: [create(P.ModelSchema, { hash: INPUT_GATE_MODEL, params })] });
      case 'mixer': return create(P.ChainSchema, { row, mixer: [create(P.ModelSchema, { hash: MIXER_MODEL, params })] });
      case 'splitter': return create(P.ChainSchema, { row, combinedSplitter: [create(P.ModelSchema, { params })] });
    }
  })();
  return { action: pa.MessageAction_Enum.UPDATE, preset: create(P.BinaryPresetSchema, { chains: [chain] }) };
}

/** Block parameter edit (kept for the common case). */
export function paramEditMessage(row: number, column: number, paramIndex: number, wire: number): GridInit {
  return paramEditMessageFor(blockTarget(row, column), paramIndex, wire);
}

export function bypassEditMessage(row: number, column: number, bypassed: boolean): GridInit {
  return {
    action: pa.MessageAction_Enum.UPDATE,
    preset: create(P.BinaryPresetSchema, {
      bypass: [create(P.BypassSchema, {
        row,
        colBypass: [create(P.ColBypassSchema, { column, sceneBypass: [create(P.SceneBypassSchema, { bypass: bypassed })] })],
      })],
    }),
  };
}

// ---- optimistic local patches (same lookup rules as buildGrid; never mutate the input) ----

const byPos = <T extends { row?: number; column?: number; index?: number }>(list: T[], key: 'row' | 'column' | 'index', want: number) =>
  list.find((x, i) => (x[key] ?? i) === want) ?? list[want];

/** Returns a copy of `preset` with one parameter's value for `scene` replaced, or undefined if the target doesn't exist. */
export function withParamAt(preset: P.BinaryPreset, t: ParamTarget, paramIndex: number, wire: number, scene: number): P.BinaryPreset | undefined {
  const next = clone(P.BinaryPresetSchema, preset);
  const params = findContainer(byPos(next.chains, 'row', t.row), t)?.params;
  const p = params && byPos(params, 'index', paramIndex);
  if (!p) return undefined;
  const slot = p.sceneMode ? scene : 0;
  const v = create(P.ParamValueSchema, { value: { case: 'floatValue', value: wire } });
  while (p.paramValues.length <= slot) p.paramValues.push(clone(P.ParamValueSchema, p.paramValues[p.paramValues.length - 1] ?? v));
  p.paramValues[slot] = v;
  return next;
}

/** Read back one parameter's stored wire value for `scene` (for verifying an edit). */
export function readParamAt(preset: P.BinaryPreset, t: ParamTarget, paramIndex: number, scene: number): number | undefined {
  const params = findContainer(byPos(preset.chains, 'row', t.row), t)?.params;
  const p = params && byPos(params, 'index', paramIndex);
  const v = p?.paramValues[p.sceneMode ? Math.min(scene, p.paramValues.length - 1) : 0];
  return v?.value.case === 'floatValue' ? v.value.value : undefined;
}

export const withParam = (preset: P.BinaryPreset, row: number, column: number, paramIndex: number, wire: number, scene: number) =>
  withParamAt(preset, blockTarget(row, column), paramIndex, wire, scene);

export const readParam = (preset: P.BinaryPreset, row: number, column: number, paramIndex: number, scene: number) =>
  readParamAt(preset, blockTarget(row, column), paramIndex, scene);

/** Returns a copy with a block's bypass changed: this scene if the block is per-scene, otherwise every scene slot (as the unit does). */
export function withBypass(preset: P.BinaryPreset, row: number, column: number, bypassed: boolean, scene: number): P.BinaryPreset | undefined {
  const next = clone(P.BinaryPresetSchema, preset);
  const r = byPos(next.bypass, 'row', row);
  const c = r && byPos(r.colBypass, 'column', column);
  if (!c) return undefined;
  const state = (b: boolean) => create(P.SceneBypassSchema, { bypass: b });
  if (c.sceneMode === true) {
    while (c.sceneBypass.length <= scene) c.sceneBypass.push(state(false));
    c.sceneBypass[scene] = state(bypassed);
  } else {
    c.sceneBypass = Array.from({ length: Math.max(1, c.sceneBypass.length) }, () => state(bypassed));
  }
  return next;
}

export function readBypass(preset: P.BinaryPreset, row: number, column: number, scene: number): boolean | undefined {
  const r = byPos(preset.bypass, 'row', row);
  const c = r && byPos(r.colBypass, 'column', column);
  if (!c || c.sceneBypass.length === 0) return undefined;
  return (c.sceneMode === true ? c.sceneBypass[Math.min(scene, c.sceneBypass.length - 1)] : c.sceneBypass[0])?.bypass === true;
}

/**
 * Make one parameter follow scenes (set its scene_mode flag). The unit accepts EITHER the flag OR a value in one message,
 * never both — sent together the flag is silently dropped — so this carries the flag alone.
 */
export function paramPromoteMessage(target: ParamTarget, paramIndex: number): GridInit {
  checkTarget(target);
  const params = [create(P.ParamSchema, { index: paramIndex, sceneMode: true })];
  const row = target.row;
  const chain = (() => {
    switch (target.kind) {
      case 'block': return create(P.ChainSchema, { row, models: [create(P.ModelSchema, { column: target.column, params })] });
      case 'laneOut': return create(P.ChainSchema, { row, outputControl: [create(P.ModelSchema, { hash: LANE_OUTPUT_MODEL, params })] });
      case 'laneIn': return create(P.ChainSchema, { row, inputControl: [create(P.ModelSchema, { hash: INPUT_GATE_MODEL, params })] });
      case 'mixer': return create(P.ChainSchema, { row, mixer: [create(P.ModelSchema, { hash: MIXER_MODEL, params })] });
      case 'splitter': return create(P.ChainSchema, { row, combinedSplitter: [create(P.ModelSchema, { params })] });
    }
  })();
  return { action: pa.MessageAction_Enum.UPDATE, preset: create(P.BinaryPresetSchema, { chains: [chain] }) };
}

// ---- structural edits: blocks ------------------------------------------------------------------
// place/replace: Grid{UPDATE, preset{chains{row, models{column, hash}}}}   (the unit makes no distinction)
// remove:        Grid{DELETE, preset{chains{row, models{column, hash:0}}}} (an UPDATE with hash 0 is IGNORED by the firmware)
// move:          GridMove{move{from_row, from_col, to_row, to_col, is_drop}}  (a cross-row move creates a parallel path)
// A refused placement (e.g. not enough DSP) is accepted on the wire and silently not applied — verify by reading back.

/**
 * Models that must never be placed. NC_Recorder is the Neural Capture wizard's internal recorder, not a block:
 * placing it CRASHED the unit and needed a reboot (pyquadcortex, 2026-08-26).
 */
export const UNPLACEABLE_MODELS: Readonly<Record<number, string>> = {
  20000: 'NC_Recorder is the internal Neural Capture recorder, not a block. Placing it crashes the unit.',
};
/** Capture categories: a capture block needs a specific capture chosen (a dialog on the unit); not supported yet. */
export const CAPTURE_CATEGORY_IDS: ReadonlySet<number> = new Set([14, 20]);

/** Why a model can't be offered/placed from here, or undefined if it can. */
export function placeRefusal(catalog: import('@qc/protocol').Catalog | undefined, hash: number): string | undefined {
  if (UNPLACEABLE_MODELS[hash]) return UNPLACEABLE_MODELS[hash];
  if (!catalog) return 'The unit has not sent its block catalog yet.';
  const m = catalog.models.get(hash);
  if (!m) return `Model ${hash} is not in this unit's catalog.`;
  if (CAPTURE_CATEGORY_IDS.has(m.categoryId) || /neural capture/i.test(m.category)) return 'Neural Capture blocks are not supported yet.';
  if (m.hidden || m.internal) return `${m.name} is an internal block.`;
  return undefined;
}

function checkCell(row: number, column: number) {
  if (!Number.isInteger(row) || row < 0 || row >= GRID_ROWS || !Number.isInteger(column) || column < 0 || column >= GRID_COLS) {
    throw new RangeError(`cell must be row 0..${GRID_ROWS - 1}, column 0..${GRID_COLS - 1}; got row ${row}, column ${column}`);
  }
}

export function placeBlockMessage(row: number, column: number, hash: number): GridInit {
  checkCell(row, column);
  if (!Number.isInteger(hash) || hash <= 0) throw new RangeError(`model id must be a positive integer, got ${hash}`);
  return {
    action: pa.MessageAction_Enum.UPDATE,
    preset: create(P.BinaryPresetSchema, { chains: [create(P.ChainSchema, { row, models: [create(P.ModelSchema, { column, hash })] })] }),
  };
}

export function removeBlockMessage(row: number, column: number): GridInit {
  checkCell(row, column);
  return {
    action: pa.MessageAction_Enum.DELETE,
    preset: create(P.BinaryPresetSchema, { chains: [create(P.ChainSchema, { row, models: [create(P.ModelSchema, { column, hash: 0 })] })] }),
  };
}

type MoveInit = Parameters<typeof create<typeof pa.GridMoveMessageSchema>>[1];
export function moveBlockMessage(fromRow: number, fromCol: number, toRow: number, toCol: number): MoveInit {
  checkCell(fromRow, fromCol);
  checkCell(toRow, toCol);
  if (fromRow === toRow && fromCol === toCol) throw new RangeError('source and destination are the same cell');
  return { move: [{ fromRow, fromCol, toRow, toCol, isDrop: true }] };
}

/** The model id in a cell of a stored/live preset (0 = empty). */
export function readCellHash(preset: P.BinaryPreset, row: number, column: number): number {
  return byPos(byPos(preset.chains, 'row', row)?.models ?? [], 'column', column)?.hash ?? 0;
}

/** Optimistic local removal. Returns undefined if the cell doesn't exist. */
export function withoutBlock(preset: P.BinaryPreset, row: number, column: number): P.BinaryPreset | undefined {
  const next = clone(P.BinaryPresetSchema, preset);
  const m = byPos(byPos(next.chains, 'row', row)?.models ?? [], 'column', column);
  if (!m) return undefined;
  m.hash = undefined;
  m.params = [];
  return next;
}

// ---- scenes ------------------------------------------------------------------------------------

/** The unit stores an unlabelled scene as a single space, not an empty string. */
export const SCENE_UNLABELLED = ' ';
export const MAX_SCENE_LABEL = 20;

type SceneLabelInit = Parameters<typeof create<typeof pa.SceneLabelMessageSchema>>[1];
type SceneColorInit = Parameters<typeof create<typeof pa.SceneColorMessageSchema>>[1];
type SceneCopyInit = Parameters<typeof create<typeof pa.SceneCopyMessageSchema>>[1];

const checkScene = (i: number) => { if (!Number.isInteger(i) || i < 0 || i > 7) throw new RangeError(`scene must be 0..7, got ${i}`); };

export function sceneLabelMessage(index: number, label: string): SceneLabelInit {
  checkScene(index);
  const l = label.trim();
  if (l.length > MAX_SCENE_LABEL) throw new RangeError(`scene names can be at most ${MAX_SCENE_LABEL} characters`);
  if (/[\u0000-\u001f]/.test(l)) throw new RangeError('scene names cannot contain control characters');
  return { action: pa.MessageAction_Enum.UPDATE, index, label: l === '' ? SCENE_UNLABELLED : l };
}

/** `argb` is a uint32 0xAARRGGBB; 0 means no colour. */
export function sceneColorMessage(index: number, argb: number): SceneColorInit {
  checkScene(index);
  if (!Number.isInteger(argb) || argb < 0 || argb > 0xffffffff) throw new RangeError(`colour must be a 32-bit ARGB value, got ${argb}`);
  return { action: pa.MessageAction_Enum.UPDATE, index, color: argb };
}

export function sceneCopyMessage(from: number, to: number, swap: boolean): SceneCopyInit {
  checkScene(from); checkScene(to);
  if (from === to) throw new RangeError('pick two different scenes');
  return { action: pa.MessageAction_Enum.UPDATE, fromIndex: from, toIndex: to, isSwap: swap };
}

function padded<T>(list: T[], fill: T): T[] {
  const out = [...list];
  while (out.length < 8) out.push(fill);
  return out;
}

export function withSceneLabel(preset: P.BinaryPreset, index: number, label: string): P.BinaryPreset {
  const next = clone(P.BinaryPresetSchema, preset);
  next.sceneLabels = padded(next.sceneLabels, SCENE_UNLABELLED);
  next.sceneLabels[index] = label;
  return next;
}

export function withSceneColor(preset: P.BinaryPreset, index: number, argb: number): P.BinaryPreset {
  const next = clone(P.BinaryPresetSchema, preset);
  next.sceneColors = padded(next.sceneColors, 0);
  next.sceneColors[index] = argb;
  return next;
}

// ---- lane routing --------------------------------------------------------------------------------
// Grid{UPDATE, preset{chains{row, in_portid}}}  or  {row, out_portid}  — one field per message, row-keyed.
// Confirmed upstream: this is the only shape that moves a port (a full-preset write is ignored), and it survives a save.

export type LaneSide = 'in' | 'out';

export function lanePortMessage(row: number, side: LaneSide, id: number): GridInit {
  if (!Number.isInteger(row) || row < 0 || row >= GRID_ROWS) throw new RangeError(`row must be 0..${GRID_ROWS - 1}, got ${row}`);
  if (side === 'in' ? !isKnownInput(id) : !isKnownOutput(id)) {
    // The unit stores any id without validating it and the lane just goes silent, so unknown ids are never written.
    throw new RangeError(`${id} is not a known ${side === 'in' ? 'input' : 'output'} port`);
  }
  const chain = side === 'in' ? create(P.ChainSchema, { row, inPortid: id }) : create(P.ChainSchema, { row, outPortid: id });
  return { action: pa.MessageAction_Enum.UPDATE, preset: create(P.BinaryPresetSchema, { chains: [chain] }) };
}

export function readLanePort(preset: P.BinaryPreset, row: number, side: LaneSide): number | undefined {
  const c = byPos(preset.chains, 'row', row);
  return side === 'in' ? c?.inPortid : c?.outPortid;
}

export function withLanePort(preset: P.BinaryPreset, row: number, side: LaneSide, id: number): P.BinaryPreset | undefined {
  const next = clone(P.BinaryPresetSchema, preset);
  const c = byPos(next.chains, 'row', row);
  if (!c) return undefined;
  if (side === 'in') c.inPortid = id; else c.outPortid = id;
  return next;
}

// ---- branching: split / mix columns ----------------------------------------------------------------
// Grid{UPDATE, preset{chains{row, split_control_points{split, mix}}}}  (pyquadcortex set_split; confirmed on hardware)
// Rows 0 and 2 can branch into the row below ("the row below a branch is spoken for"). -1/-1 clears it; mix -1 = never rejoins.

export function splitMessage(row: number, split: number, mix: number): GridInit {
  if (!Number.isInteger(row) || row < 0 || row >= GRID_ROWS || row % 2 !== 0) throw new RangeError(`only lanes 1 and 3 can branch, got lane ${row + 1}`);
  for (const [n, v] of [['split', split], ['mix', mix]] as const) {
    if (!Number.isInteger(v) || v < -1 || v >= GRID_COLS) throw new RangeError(`${n} column must be -1 (none) or 0..${GRID_COLS - 1}, got ${v}`);
  }
  if (split === -1 && mix !== -1) throw new RangeError('a branch needs a split column: use -1 for both to clear it');
  if (split >= 0 && mix !== -1 && mix <= split) throw new RangeError('the branch must rejoin after it splits (or never rejoin: -1)');
  return {
    action: pa.MessageAction_Enum.UPDATE,
    preset: create(P.BinaryPresetSchema, { chains: [create(P.ChainSchema, { row, splitControlPoints: [create(P.SplitControlPointsSchema, { split, mix })] })] }),
  };
}

export function readSplit(preset: P.BinaryPreset, row: number): { split: number; mix: number } | undefined {
  const sp = byPos(preset.chains, 'row', row)?.splitControlPoints[0];
  return sp ? { split: sp.split, mix: sp.mix } : undefined;
}

export function withSplit(preset: P.BinaryPreset, row: number, split: number, mix: number): P.BinaryPreset | undefined {
  const next = clone(P.BinaryPresetSchema, preset);
  const c = byPos(next.chains, 'row', row);
  if (!c) return undefined;
  c.splitControlPoints = [create(P.SplitControlPointsSchema, { split, mix })];
  return next;
}
