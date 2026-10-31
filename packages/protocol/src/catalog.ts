import { XMLParser } from 'fast-xml-parser';
import { gunzipSync } from 'fflate';

// The unit sends its block catalog as ModelRepoMessage.model_repo_payload = gzip(tar(ModelRepo.xml)).
// Container format and XML shape per stokes-audio/pyquadcortex (MIT).

export interface CatalogParam {
  index: number;
  name: string;
  /** Device-defined: 'float' | 'switch' | 'comboBox' | 'rotarySwitch' | 'string' | 'int' | 'fader' | ... */
  type: string;
  /** Range bounds in display units. `null` = the catalog names a bound nobody has measured: do NOT convert. */
  min: number | null;
  max: number | null;
  defaultValue: number;
  units: string;
  /** Taper: real = min + (max-min) * wire^(1/skew). `null` = a taper name we can't decode: do NOT convert. */
  skew: number | null;
  steps?: number;
  /** List parameter option names (trimmed). */
  options: string[];
  /** Options depend on the preset (e.g. block pickers); `steps` overstates them. */
  dynamic: boolean;
  minLabel: string;
  midLabel: string;
  maxLabel: string;
  showAsInteger: boolean;
  hidden: boolean;
  expAssignable: boolean;
}

export interface CatalogModel {
  id: number;
  name: string;
  category: string;
  categoryId: number;
  basedOn: string;
  style: string;
  hidden: boolean;
  internal: boolean;
  params: CatalogParam[];
}

export interface Catalog {
  models: Map<number, CatalogModel>;
  categories: Array<{ id: number; name: string; hidden: boolean }>;
  /** Things we could not interpret (new firmware may introduce some). Affected params refuse conversion. */
  warnings: string[];
}

// ---- cabs -----------------------------------------------------------------------------------------------------
// A cab's OWN catalog entry is a short local list (2, 4 or 6 parameters), but the parameters the unit sends are indexed by a
// shared layout ("Default Cabsim", 21 entries: 0 bypass, 1 ir selector, 2 LEVEL, 3 PAN, 4 DISTANCE, 5 POSITION, ... for mic 1,
// then the same for mic 2, then HPF, LPF, OUTPUT VOLUME). Settled on hardware by pyquadcortex (writing wire index 2 on a cab
// moved LEVEL, not the block's own entry 2). 169 of the 174 cab models are like this; the other 5 describe 21 or 31 parameters
// themselves and are left alone. Everything else (IR loaders, amps, effects) is wire-indexed by its own entry.

export const CABSIM_CATEGORIES: ReadonlySet<string> = new Set(['Cabsim Guitar (M)', 'Cabsim Guitar (ST)', 'Cabsim Bass (M)', 'Cabsim Bass (ST)']);
export const CABSIM_LAYOUT_MONO = 12000;
/** Same layout with PAN replaced by BALANCE (-1..1). Using it for stereo cabs is a reasonable reading, not verified upstream. */
export const CABSIM_LAYOUT_STEREO = 32000;

/** The catalog model whose parameter list is wire-indexed for `model` (usually the model itself; a cab's shared layout otherwise). */
export function wireModel(catalog: Catalog | undefined, model: CatalogModel | undefined): CatalogModel | undefined {
  if (!model || !catalog || !CABSIM_CATEGORIES.has(model.category)) return model;
  const layout = catalog.models.get(model.category.endsWith('(ST)') ? CABSIM_LAYOUT_STEREO : CABSIM_LAYOUT_MONO);
  if (!layout || model.params.length >= layout.params.length) return model;
  return layout;
}

/** Minimal ustar reader: returns the first member whose name ends with `.xml`. */
export function extractXmlFromTar(tar: Uint8Array): Uint8Array {
  const dec = new TextDecoder();
  let off = 0;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const name = dec.decode(header.subarray(0, 100)).replace(/\0.*$/, '').trim();
    const size = parseInt(dec.decode(header.subarray(124, 136)).replace(/\0.*$/, '').trim() || '0', 8);
    const start = off + 512;
    if (name.endsWith('.xml')) return tar.subarray(start, start + size);
    off = start + Math.ceil(size / 512) * 512;
  }
  throw new Error('ModelRepo payload contains no .xml member');
}

/** Accepts gzip(tar), tar, or bare XML. */
export function parseModelRepoPayload(payload: Uint8Array): Catalog {
  let bytes = payload;
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
  const firstNonWs = bytes.find((b) => b !== 0x20 && b !== 0x0a && b !== 0x0d && b !== 0x09);
  const xml = firstNonWs === 0x3c /* < */ ? bytes : extractXmlFromTar(bytes);
  return parseModelRepoXml(new TextDecoder().decode(xml));
}

const arr = <T>(x: T | T[] | undefined): T[] => (x === undefined ? [] : Array.isArray(x) ? x : [x]);
const num = (v: unknown, d = 0) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : d;
};

export function parseModelRepoXml(xml: string): Catalog {
  const doc = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@',
    parseAttributeValue: false,
    isArray: (name) => name === 'Category' || name === 'Model' || name === 'Parameter',
  }).parse(xml);
  const catalog: Catalog = { models: new Map(), categories: [], warnings: [] };
  for (const c of arr<any>(doc.Models?.Category)) {
    const categoryId = num(c['@id'], -1);
    const category = String(c['@name'] ?? '');
    catalog.categories.push({ id: categoryId, name: category, hidden: c['@hidden'] === 'true' });
    for (const m of arr<any>(c.Model)) {
      const id = Number.parseInt(m['@id'], 10);
      if (Number.isNaN(id)) continue;
      catalog.models.set(id, {
        id,
        name: String(m['@name'] ?? ''),
        category,
        categoryId,
        basedOn: String(m['@tm'] ?? ''),
        style: String(m['@style'] ?? ''),
        hidden: m['@hidden'] === 'true' || c['@hidden'] === 'true',
        internal: m['@internal'] === 'true',
        params: arr<any>(m.Parameter).map((p, index) => parseParam(p, index, `${m['@name']} ${p['@name']}`, catalog.warnings)),
      });
    }
  }
  return catalog;
}

/** Numeric bounds the catalog names symbolically. Each was measured on hardware by pyquadcortex (MIT) — see docs/protocol-notes.md. */
export const FIRMWARE_CONSTANTS: Record<string, number> = {
  MIN_CABSIM_DB: -40, MAX_CABSIM_DB: 6,
  MIN_EQ_DB: -12, MAX_EQ_DB: 12,
  MIN_MIXER_DB: -40, MAX_MIXER_DB: 12,
  MIN_FXLOOP_OUT_GAIN_DB: -40, MAX_FXLOOP_OUT_GAIN_DB: 0,
  MIN_FXLOOP_IN_GAIN_DB: -40, MAX_FXLOOP_IN_GAIN_DB: 12,
  MIN_TEMPO: 40, MAX_TEMPO: 240,
  MIN_EQ_FREQ: 20, MAX_EQ_FREQ: 20000,
};
/** "LOG_SKEW" is NOT logarithmic: it is the same power law at skew 0.3 (solved on hardware upstream). */
export const LOG_SKEW = 0.3;
/** Knobs whose both ends and middle carry labels draw a ±50 scale the catalog doesn't state (36 parameters). */
export const LABELLED_END_SPAN: readonly [number, number] = [-50, 50];

function bound(raw: unknown, fallback: number, where: string, warnings: string[]): number | null {
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const text = String(raw).trim();
  const n = Number(text);
  if (Number.isFinite(n)) return n;
  const c = FIRMWARE_CONSTANTS[text];
  if (c !== undefined) return c;
  warnings.push(`${where}: unknown bound "${text}" (conversion disabled for this parameter)`);
  return null; // refuse rather than guess (MIN_INPUT_TRIM etc. are known-unmeasured)
}

function skewOf(raw: unknown, where: string, warnings: string[]): number | null {
  const text = raw === undefined ? '' : String(raw).trim();
  if (!text || text === 'LIN_SKEW') return 1;
  if (text === 'LOG_SKEW') return LOG_SKEW;
  const n = Number(text);
  if (Number.isFinite(n) && n > 0) return n;
  warnings.push(`${where}: unknown skew "${text}" (conversion disabled for this parameter)`);
  return null;
}

function parseParam(p: any, index: number, where: string, warnings: string[]): CatalogParam {
  let min = bound(p['@min'], 0, where, warnings);
  let max = bound(p['@max'], 1, where, warnings);
  const skew = skewOf(p['@skew'], where, warnings);
  let defaultValue = num(p['@defaultValue']);
  const minLabel = String(p['@min_string'] ?? '');
  const midLabel = String(p['@mid_string'] ?? '');
  const maxLabel = String(p['@max_string'] ?? '');
  if (minLabel && midLabel && maxLabel && skew === 1 && min !== null && max !== null && max !== min) {
    // The default is a position on the stated scale; keep it at the same position on the replacement scale.
    const wire = (defaultValue - min) / (max - min);
    [min, max] = LABELLED_END_SPAN;
    defaultValue = min + (max - min) * wire;
  }
  return {
    index,
    name: String(p['@name'] ?? ''),
    type: String(p['@type'] ?? 'float'),
    min,
    max,
    defaultValue,
    units: String(p['@units'] ?? ''),
    skew,
    steps: p['@steps'] !== undefined ? num(p['@steps']) : undefined,
    options: p['@stepNames'] !== undefined ? String(p['@stepNames']).split(',').map((o) => o.trim()) : [],
    dynamic: p['@dynamic'] === 'true',
    minLabel,
    midLabel,
    maxLabel,
    showAsInteger: p['@showAsInteger'] === 'true',
    hidden: p['@hidden'] === 'true',
    expAssignable: p['@expAssignable'] !== 'false',
  };
}
