// Wire <-> display conversion for preset parameters.
// Rules (all hardware-verified upstream by stokes-audio/pyquadcortex, MIT; see docs/protocol-notes.md):
//   * float params travel normalized 0..1:  real = min + (max - min) * wire^(1/skew)
//   * list params (comboBox/switch/rotarySwitch/empty): wire = option / (count - 1)
//   * NaN / out-of-range wire values have no meaning: report "no value", never clamp
// Conversion REFUSES (returns undefined) for parameters whose bounds/taper the catalog names but we can't decode.
import type { CatalogParam } from './catalog';

const LIST_TYPES = new Set(['comboBox', 'switch', 'rotarySwitch', 'empty']);

/** Number of options for a list parameter, or undefined if it isn't one / the count is unknowable. */
export function optionCount(p: CatalogParam): number | undefined {
  if (p.options.length > 0 && !p.dynamic) return p.options.length;
  if (LIST_TYPES.has(p.type) && p.steps) return p.steps;
  return undefined;
}

/** Option names of a list parameter. Two-option switches the catalog doesn't name (MUTE, SOLO, BYPASS…) are Off/On. */
export function optionNames(p: CatalogParam): string[] {
  const n = optionCount(p);
  if (n === undefined) return [];
  if (p.options.length > 0 && !p.dynamic && p.options.length === n) return p.options;
  if (n === 2 && p.options.length === 0) return ['Off', 'On'];
  return Array.from({ length: n }, (_, i) => p.options[i] ?? `Option ${i + 1}`);
}

export const isListParam = (p: CatalogParam) => optionCount(p) !== undefined;

/** wire (0..1) -> value in the parameter's own units. undefined if unconvertible or wire is NaN/out of range. */
export function toReal(p: CatalogParam, wire: number): number | undefined {
  if (!(wire >= 0 && wire <= 1)) return undefined; // also rejects NaN
  if (p.min === null || p.max === null || p.skew === null) return undefined;
  const span = p.max - p.min;
  return span === 0 ? p.min : p.min + span * wire ** (1 / p.skew);
}

/** value in the parameter's own units -> wire (0..1). Throws RangeError for a value the knob has no position for. */
export function toWire(p: CatalogParam, real: number): number {
  if (p.min === null || p.max === null || p.skew === null) throw new Error(`${p.name}: range not known, refusing to convert`);
  if (!Number.isFinite(real)) throw new RangeError(`${p.name}: ${real} is not a number`);
  const lo = Math.min(p.min, p.max);
  const hi = Math.max(p.min, p.max);
  // small tolerance for float noise at the ends, otherwise refuse rather than clamp
  const eps = (hi - lo) * 1e-9;
  if (real < lo - eps || real > hi + eps) throw new RangeError(`${p.name}: ${real} is outside ${p.min}..${p.max}`);
  const span = p.max - p.min;
  if (span === 0) return 0;
  return Math.min(1, Math.max(0, (real - p.min) / span)) ** p.skew;
}

export function optionToWire(p: CatalogParam, option: number): number {
  const n = optionCount(p);
  if (n === undefined) throw new Error(`${p.name}: not a list parameter`);
  if (!Number.isInteger(option) || option < 0 || option >= n) throw new RangeError(`${p.name}: option must be 0..${n - 1}, got ${option}`);
  return n === 1 ? 0 : option / (n - 1);
}

export function wireToOption(p: CatalogParam, wire: number): number | undefined {
  const n = optionCount(p);
  if (n === undefined || !(wire >= 0 && wire <= 1)) return undefined;
  return n === 1 ? 0 : Math.round(wire * (n - 1));
}

function decimals(p: CatalogParam): number {
  if (p.showAsInteger) return 0;
  if (p.min !== null && p.max !== null && p.steps && p.steps > 1) {
    const step = Math.abs(p.max - p.min) / (p.steps - 1);
    if (step > 0) return Math.min(3, Math.max(0, Math.ceil(-Math.log10(step) - 1e-9)));
  }
  const span = p.min !== null && p.max !== null ? Math.abs(p.max - p.min) : 1;
  return span >= 100 ? 0 : span >= 10 ? 1 : 2;
}

/** Smallest meaningful change in display units (what a ± button should move by): whole numbers, the catalog's step size, or the shown precision. */
export function displayStep(p: CatalogParam): number {
  if (p.showAsInteger) return 1;
  if (p.min !== null && p.max !== null && p.steps && p.steps > 1) {
    const step = Math.abs(p.max - p.min) / (p.steps - 1);
    if (step > 0) return step;
  }
  return 10 ** -decimals(p);
}

/** New wire value after moving `direction` (+1/-1) display steps from `wire`; clamped to the knob's range. undefined if unconvertible. */
export function stepWire(p: CatalogParam, wire: number, direction: 1 | -1): number | undefined {
  const real = toReal(p, wire);
  if (real === undefined || p.min === null || p.max === null) return undefined;
  const lo = Math.min(p.min, p.max);
  const hi = Math.max(p.min, p.max);
  const target = Math.min(hi, Math.max(lo, real + direction * displayStep(p) * Math.sign(p.max - p.min || 1)));
  return toWire(p, target);
}

const UNIT_SUFFIX: Record<string, string> = { '%': '%', dB: ' dB', Hz: ' Hz', ms: ' ms', s: ' s', Semitones: ' st', Cents: ' ct', cents: ' ct', 'dB/oct': ' dB/oct', x: 'x' };

export interface Display {
  /** Human text, e.g. "-9.6 dB", "BLOCK", "OFF". */
  text: string;
  /** Value in the parameter's units (float params). */
  real?: number;
  /** Selected option index (list params). */
  option?: number;
  /** False when we could not convert (unknown range/taper, NaN) and `text` is a raw fallback. */
  converted: boolean;
}

/** What the unit's screen would show for a stored value. */
export function formatValue(p: CatalogParam | undefined, wire: number | string | undefined): Display {
  if (wire === undefined) return { text: '—', converted: false };
  if (typeof wire === 'string') return { text: wire, converted: true };
  if (!p) return { text: String(Number(wire.toFixed(4))), converted: false };

  if (p.type === 'string') return { text: String(wire), converted: true };
  if (p.type === 'int') return { text: String(wire), real: wire, converted: true };

  const n = optionCount(p);
  if (n !== undefined) {
    const o = wireToOption(p, wire);
    if (o === undefined) return { text: 'no value', converted: false };
    return { text: optionNames(p)[o] ?? `Option ${o + 1}`, option: o, converted: true };
  }

  const real = toReal(p, wire);
  if (real === undefined) return { text: Number.isNaN(wire) ? 'no value' : `${Number(wire.toFixed(4))} (raw)`, converted: false };
  // Labelled-end knobs (PAN: L / C / R) are drawn on a ±50 scale: the unit shows the centre label, and a distance plus a side
  // otherwise ("10 R" — measured upstream on a Minivoicer PAN at wire 0.6). The left side is the symmetric reading.
  if (p.minLabel && p.midLabel && p.maxLabel && p.skew === 1) {
    const d = decimals(p);
    if (Math.abs(real) < 0.5 * 10 ** -d) return { text: p.midLabel, real, converted: true };
    return { text: `${Math.abs(real).toFixed(d)} ${real < 0 ? p.minLabel : p.maxLabel}`, real, converted: true };
  }
  // A knob whose bottom is a word (OFF, -Inf...) shows it at the very bottom.
  if (wire === 0 && p.minLabel && !p.midLabel) return { text: p.minLabel, real, converted: true };
  const d = decimals(p);
  const shown = real.toFixed(d).replace(/^-0(\.0+)?$/, (m) => m.slice(1));
  return { text: `${shown}${UNIT_SUFFIX[p.units] ?? (p.units ? ' ' + p.units : '')}`, real, converted: true };
}
