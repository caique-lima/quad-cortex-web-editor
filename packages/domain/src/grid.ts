import type { preset as P } from '@qc/protocol';
import { CABSIM_CATEGORIES, formatValue, wireModel, type Catalog, type CatalogModel, type CatalogParam, type Display } from '@qc/protocol';

export const GRID_ROWS = 4;
export const GRID_COLS = 8;
export const SCENE_COUNT = 8;

export interface GridParam {
  index: number;
  /** Name from the catalog, if known. */
  name?: string;
  /** Raw wire value for the requested scene (normalized 0..1 for continuous/list params). */
  value?: number | string;
  /** What the unit's screen would show ("-9.6 dB", "BLOCK"…). `converted: false` = fell back to the raw value. */
  display: Display;
  /** Catalog metadata (range, taper, options) when known. */
  meta?: CatalogParam;
  hidden: boolean;
  sceneMode: boolean;
  expression?: number;
}

export interface GridCell {
  row: number;
  column: number;
  /** Model hash == catalog model id. undefined / 0 means empty. */
  hash?: number;
  empty: boolean;
  name: string;
  category?: string;
  /** True if the catalog has no entry for this hash (e.g. newer firmware/blocks). */
  unknown: boolean;
  bypassed: boolean;
  /** Bypass differs per scene for this block. */
  bypassPerScene: boolean;
  params: GridParam[];
}

export interface GridRow {
  row: number;
  cells: GridCell[];
  inPort?: number;
  outPort?: number;
  splitColumn?: number;
  mixColumn?: number;
}

function paramValue(p: P.Param, scene: number): number | string | undefined {
  const vals = p.paramValues;
  if (!vals?.length) return undefined;
  // In a stored/recalled preset, param_values[N] is scene N. Params that aren't scene-aware carry one entry.
  const v = vals[p.sceneMode ? Math.min(scene, vals.length - 1) : 0] ?? vals[0]!;
  switch (v.value.case) {
    case 'intValue':
    case 'floatValue':
    case 'stringValue':
      return v.value.value;
    default:
      return undefined;
  }
}

function lookupBypass(preset: P.BinaryPreset, row: number, column: number, scene: number) {
  const r = preset.bypass.find((b, i) => (b.row ?? i) === row) ?? preset.bypass[row];
  const c = r?.colBypass.find((cb, i) => (cb.column ?? i) === column) ?? r?.colBypass[column];
  if (!c || c.sceneBypass.length === 0) return { bypassed: false, perScene: false };
  const perScene = c.sceneMode === true;
  const entry = perScene ? (c.sceneBypass[Math.min(scene, c.sceneBypass.length - 1)] ?? c.sceneBypass[0]) : c.sceneBypass[0];
  return { bypassed: entry?.bypass === true, perScene };
}

/** Convert a container's wire params into displayable ones (shared by blocks and lane controls). */
export function toGridParams(params: P.Param[], cat: CatalogModel | undefined, scene: number, catalog?: Catalog): GridParam[] {
  // A cab's wire indices follow a shared layout, not the block's own short entry (see wireModel).
  const wm = wireModel(catalog, cat);
  // Cabs carry every setting once per mic, and a Dual IR loader once per IR: tell the copies apart by number. Only when both
  // copies are actually shown (a Single loader keeps its plain names).
  const prefix = cat && CABSIM_CATEGORIES.has(cat.category) ? 'MIC' : cat?.category === 'IRLoaders' ? 'IR' : undefined;
  const out = params.map((p, i) => {
    const index = p.index ?? i;
    let meta = wm?.params[index];
    if (meta && prefix) {
      // numbered by position in the layout, so a short or partial list can never call copy 2 "copy 1"
      const same = wm!.params.map((q, qi) => ({ q, qi })).filter((x) => x.q.name === meta!.name && !x.q.hidden);
      const n = same.findIndex((x) => x.qi === index) + 1;
      if (same.length > 1 && n > 0) meta = { ...meta, name: `${prefix} ${n} ${meta.name}` };
    }
    const value = paramValue(p, scene);
    return {
      index,
      name: meta?.name,
      value,
      display: formatValue(meta, value),
      meta,
      // Meters (e.g. GAIN REDUCTION) are sampled by the unit, not controls.
      hidden: (meta?.hidden ?? false) || meta?.type === 'grMeter',
      sceneMode: p.sceneMode === true,
      expression: p.expression && p.expression > 0 ? p.expression : undefined,
    };
  });
  return cat?.category === 'IRLoaders' && wm ? surfaceIrSlots(out, wm) : out;
}

/**
 * An IR loader keeps its IR fields hidden in the catalog (IR PATH and IR NAME, two slots each). Show what is loaded in each slot
 * the model really uses (Single: 1, Dual: 2) as a read-only "IR n" row at the top. The IR NAME is the readable one; if it is
 * empty the path is shown instead. Choosing a different IR is a text write, which this app does not do.
 */
function surfaceIrSlots(list: GridParam[], wm: CatalogModel): GridParam[] {
  const named = (n: string) => list.filter((p) => p.meta?.name === n);
  const names = named('IR NAME');
  const paths = named('IR PATH');
  const levels = wm.params.filter((q) => q.name === 'LEVEL'); // a slot is in use if its LEVEL is not hidden
  const text = (p: GridParam | undefined) => (typeof p?.value === 'string' ? p.value.trim() : '');
  const rows: GridParam[] = [];
  for (let k = 0; k < 2; k++) {
    if (levels[k]?.hidden) continue;
    const chosen = text(names[k]) ? names[k] : text(paths[k]) ? paths[k] : (names[k] ?? paths[k]);
    if (!chosen) continue;
    chosen.hidden = false;
    chosen.name = `IR ${k + 1}`;
    if (!text(chosen)) chosen.display = { text: 'None loaded', converted: true };
    rows.push(chosen);
  }
  return [...rows, ...list.filter((p) => !rows.includes(p))];
}

export interface LaneControls {
  row: number;
  /** Input gate control (noise reduction, gate bypass, input gain). */
  inputGate: GridParam[];
  /** Lane output control (volume, pan, mute, solo). */
  output: GridParam[];
  /** Present on lanes 1 and 3 only. */
  mixer: GridParam[];
  splitter: GridParam[];
  /** Branch columns, or -1 when the lane doesn't branch. undefined = not reported. */
  split?: number;
  mix?: number;
}

/** The controls that belong to a lane rather than to a block. Pure; tolerant of missing data. */
export function buildLaneControls(preset: P.BinaryPreset, catalog: Catalog | undefined, row: number, scene: number): LaneControls {
  const chain = preset.chains.find((c, i) => (c.row ?? i) === row) ?? preset.chains[row];
  const of = (list: P.Model[] | undefined, id: number): GridParam[] => {
    const m = list?.find((x) => x.hash === id) ?? list?.[0];
    return m ? toGridParams(m.params, catalog?.models.get(m.hash ?? id), scene) : [];
  };
  const sp = chain?.splitControlPoints[0];
  return {
    row,
    inputGate: of(chain?.inputControl, 28000),
    output: of(chain?.outputControl, 23000),
    mixer: of(chain?.mixer, 11000),
    splitter: of(chain?.combinedSplitter, 10004),
    split: sp?.split,
    mix: sp?.mix,
  };
}

/** Turn a BinaryPreset into a 4×8 grid view for one scene (0..7). Pure; tolerant of missing data. */
export function buildGrid(preset: P.BinaryPreset, catalog: Catalog | undefined, scene: number): GridRow[] {
  const rows: GridRow[] = [];
  for (let r = 0; r < GRID_ROWS; r++) {
    // Recalled chains carry no explicit row: position in the list is the row (use `row` when present).
    const chain = preset.chains.find((c, i) => (c.row ?? i) === r) ?? preset.chains[r];
    const cells: GridCell[] = [];
    for (let col = 0; col < GRID_COLS; col++) {
      const model = chain?.models.find((m, i) => (m.column ?? i) === col) ?? chain?.models[col];
      const hash = model?.hash;
      const empty = !model || !hash;
      const cat: CatalogModel | undefined = !empty ? catalog?.models.get(hash!) : undefined;
      const { bypassed, perScene } = empty ? { bypassed: false, perScene: false } : lookupBypass(preset, r, col, scene);
      cells.push({
        row: r,
        column: col,
        hash: empty ? undefined : hash,
        empty,
        name: empty ? '' : (cat?.name ?? `Block #${hash}`),
        category: cat?.category,
        unknown: !empty && !cat,
        bypassed,
        bypassPerScene: perScene,
        params: empty
          ? []
          : toGridParams(model!.params, cat, scene, catalog),
      });
    }
    const sp = chain?.splitControlPoints[0];
    rows.push({
      row: r,
      cells,
      inPort: chain?.inPortid,
      outPort: chain?.outPortid,
      splitColumn: sp?.split,
      mixColumn: sp?.mix,
    });
  }
  return rows;
}
