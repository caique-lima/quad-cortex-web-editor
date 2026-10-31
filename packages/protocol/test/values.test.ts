import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseModelRepoPayload, parseModelRepoXml, type CatalogParam } from '../src/catalog';
import { displayStep, formatValue, isListParam, stepWire, optionCount, optionToWire, toReal, toWire, wireToOption } from '../src/values';

/** Build one catalog parameter from XML attributes, exactly as the unit would send it. */
function param(attrs: string): CatalogParam {
  const cat = parseModelRepoXml(`<Models><Category id="0" name="T"><Model id="1" name="M"><Parameter name="P" type="float" defaultValue="0" ${attrs}/></Model></Category></Models>`);
  return { ...cat.models.get(1)!.params[0]!, _warnings: cat.warnings } as CatalogParam & { _warnings: string[] };
}
const warningsOf = (p: CatalogParam) => (p as unknown as { _warnings: string[] })._warnings;

describe('wire -> real, against readings measured on hardware (pyquadcortex docs)', () => {
  it('cab LEVEL: symbolic MIN/MAX_CABSIM_DB with skew 4.9594844 (wire 0.01/0.50/1.00 read -21.8/0.0/6.0 dB)', () => {
    const p = param('min="MIN_CABSIM_DB" max="MAX_CABSIM_DB" skew="4.9594844" units="dB"');
    expect(toReal(p, 0.01)!).toBeCloseTo(-21.8, 1);
    expect(toReal(p, 0.5)!).toBeCloseTo(0.0, 1);
    expect(toReal(p, 1)!).toBeCloseTo(6.0, 5);
    expect(formatValue(p, 0.5).text).toBe('0.0 dB');
  });

  it('parametric EQ gain: MIN/MAX_EQ_DB, steps=241 (wire 0/0.1/0.5/1 read -12.0/-9.6/0.0/+12.0)', () => {
    const p = param('min="MIN_EQ_DB" max="MAX_EQ_DB" steps="241" units="dB"');
    expect([0, 0.1, 0.5, 1].map((w) => formatValue(p, w).text)).toEqual(['-12.0 dB', '-9.6 dB', '0.0 dB', '12.0 dB']);
  });

  it('tempo: steps=201 (wire 0.095/0.355/0.4 read 59/111/120 bpm)', () => {
    const p = param('min="MIN_TEMPO" max="MAX_TEMPO" steps="201" showAsInteger="true"');
    expect([0.095, 0.355, 0.4].map((w) => toReal(p, w)!.toFixed(0))).toEqual(['59', '111', '120']);
  });

  it('skew 0.3 (HPF FREQ 20..20000 wire 0.25 reads 217 Hz); LOG_SKEW is the same law, not a log sweep', () => {
    expect(toReal(param('min="20" max="20000" skew="0.3" units="Hz"'), 0.25)!).toBeCloseTo(216.8, 0);
    const freq = param('min="100" max="10000" skew="LOG_SKEW" units="Hz"');
    const reso = param('min="1" max="10" skew="LOG_SKEW"');
    expect(toReal(freq, 0.25)!).toBeCloseTo(197, 0); // a true log sweep would give 316
    expect(toReal(reso, 0.75)!).toBeCloseTo(4.45, 2); // linear would give 7.75
  });

  it('labelled-end knobs (min+mid+max strings) are drawn on a ±50 scale, default stays at the same position', () => {
    const p = param('min="0" max="1" defaultValue="0.6" min_string="L" mid_string="C" max_string="R"');
    expect([p.min, p.max]).toEqual([-50, 50]);
    expect(p.defaultValue).toBeCloseTo(10, 6); // "10 R"
  });

  it('a knob whose bottom is a word shows the word at the bottom only', () => {
    const p = param('min="0" max="10" min_string="OFF"');
    expect(formatValue(p, 0).text).toBe('OFF');
    expect(formatValue(p, 0.5).text).toBe('5.0');
  });

  it('units and decimals', () => {
    expect(formatValue(param('min="0" max="100" units="%" showAsInteger="true"'), 0.5).text).toBe('50%');
    expect(formatValue(param('min="20" max="20000" units="Hz"'), 1).text).toBe('20000 Hz');
    expect(formatValue(param('min="-60" max="12" units="dB"'), 0.0).text).toBe('-60.0 dB');
  });
});

describe('refusals (never guess)', () => {
  it('NaN and out-of-range wire values have no value; they are not clamped', () => {
    const p = param('min="0" max="10"');
    expect(toReal(p, Number.NaN)).toBeUndefined();
    expect(toReal(p, -0.1)).toBeUndefined();
    expect(toReal(p, 1.1)).toBeUndefined();
    expect(formatValue(p, Number.NaN)).toMatchObject({ text: 'no value', converted: false });
  });

  it('unmeasured bound (MIN_INPUT_TRIM) and unknown bound/skew disable conversion and are reported', () => {
    for (const attrs of ['min="MIN_INPUT_TRIM" max="MAX_INPUT_TRIM"', 'min="MIN_FUTURE_THING" max="1"', 'min="0" max="1" skew="EXP_SKEW"']) {
      const p = param(attrs);
      expect(toReal(p, 0.5), attrs).toBeUndefined();
      expect(() => toWire(p, 0.5), attrs).toThrow();
      expect(warningsOf(p).length, attrs).toBeGreaterThanOrEqual(1);
      expect(formatValue(p, 0.5)).toMatchObject({ converted: false });
    }
  });

  it('toWire refuses values outside the range rather than clamping', () => {
    const p = param('min="-60" max="12"');
    expect(() => toWire(p, 13)).toThrow(RangeError);
    expect(() => toWire(p, -61)).toThrow(RangeError);
    expect(() => toWire(p, Number.NaN)).toThrow(RangeError);
    expect(toWire(p, 12)).toBe(1);
  });
});

describe('list parameters', () => {
  it('wire = option / (count - 1) (NOTELENGTH steps=4 opt 1 = 1/3; TIME SIGNATURE steps=21 opt 1 = 1/20; ROUTING steps=5 opt 3 = 3/4)', () => {
    expect(optionToWire(param('type="comboBox" steps="4"'), 1)).toBeCloseTo(1 / 3, 10);
    expect(optionToWire(param('type="comboBox" steps="21"'), 1)).toBeCloseTo(0.05, 10);
    expect(optionToWire(param('type="comboBox" steps="5"'), 3)).toBeCloseTo(0.75, 10);
  });

  it('names come from stepNames (padding trimmed); out-of-range options are refused', () => {
    const p = param('steps="3" stepNames="Flat,   -6, -12"');
    expect(p.options).toEqual(['Flat', '-6', '-12']);
    expect(optionCount(p)).toBe(3);
    expect(formatValue(p, 0.5)).toMatchObject({ text: '-6', option: 1 });
    expect(wireToOption(p, 1)).toBe(2);
    expect(() => optionToWire(p, 3)).toThrow(RangeError);
    expect(() => optionToWire(param('min="0" max="1"'), 0)).toThrow();
  });

  it('dynamic lists have an unknowable count from the catalog alone', () => {
    const p = param('type="comboBox" steps="45" dynamic="true" stepNames="A,B"');
    expect(isListParam(p)).toBe(true); // steps fallback, flagged dynamic
    expect(p.dynamic).toBe(true);
  });
});

describe('the real catalog (533 models, CorOS 4.0.1 capture)', () => {
  const cat = parseModelRepoPayload(new Uint8Array(readFileSync(new URL('./fixtures/model_repo_coros_4_0_1.bin', import.meta.url))));
  const params = [...cat.models.values()].flatMap((m) => m.params.map((p) => ({ m, p })));

  it('only the known-unmeasured bound is unconvertible, and nothing throws while parsing', () => {
    const refused = params.filter(({ p }) => p.min === null || p.max === null || p.skew === null);
    expect(new Set(refused.map(({ m }) => m.name))).toEqual(new Set(['NC_Recorder']));
    expect(cat.warnings.every((w) => /MIN_INPUT_TRIM|MAX_INPUT_TRIM/.test(w))).toBe(true);
  });

  it('wire -> real -> wire round-trips for every continuous parameter', () => {
    let checked = 0;
    for (const { m, p } of params) {
      if (isListParam(p) || p.type === 'string' || p.type === 'int') continue;
      if (p.min === null || p.max === null || p.skew === null || p.min === p.max) continue;
      for (const w of [0, 0.01, 0.25, 0.5, 0.75, 1]) {
        const r = toReal(p, w)!;
        expect(Number.isFinite(r), `${m.name}/${p.name}`).toBe(true);
        expect(toWire(p, r), `${m.name}/${p.name} @${w}`).toBeCloseTo(w, 6);
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(2000);
  });

  it('every list parameter has a usable option count', () => {
    for (const { m, p } of params) {
      if (!isListParam(p) || p.dynamic) continue;
      const n = optionCount(p)!;
      expect(n, `${m.name}/${p.name}`).toBeGreaterThan(0);
      expect(wireToOption(p, 1)).toBe(n - 1);
    }
  });
});

describe('± steps move by the display resolution, through the taper', () => {
  it('integer, catalog-stepped and default-precision knobs', () => {
    expect(displayStep(param('min="40" max="240" steps="201" showAsInteger="true"'))).toBe(1);
    expect(displayStep(param('min="MIN_EQ_DB" max="MAX_EQ_DB" steps="241"'))).toBeCloseTo(0.1, 10);
    expect(displayStep(param('min="0" max="10"'))).toBeCloseTo(0.1, 10);
  });

  it('a tap changes the SHOWN value by one step, on linear and tapered knobs, and clamps at the ends', () => {
    const lin = param('min="0" max="10"');
    expect(formatValue(lin, stepWire(lin, 0.2, 1)!).text).toBe('2.1');
    expect(formatValue(lin, stepWire(lin, 0.2, -1)!).text).toBe('1.9');
    expect(stepWire(lin, 1, 1)).toBe(1);
    expect(stepWire(lin, 0, -1)).toBe(0);
    const tapered = param('min="20" max="20000" skew="0.3" units="Hz"');
    const w = 0.25; // 216.8 Hz
    expect(toReal(tapered, stepWire(tapered, w, 1)!)! - toReal(tapered, w)!).toBeCloseTo(1, 6);
    const eq = param('min="MIN_EQ_DB" max="MAX_EQ_DB" steps="241" units="dB"');
    expect(formatValue(eq, stepWire(eq, 0.5, 1)!).text).toBe('0.1 dB');
  });

  it('refuses to step an unconvertible parameter', () => {
    expect(stepWire(param('min="MIN_INPUT_TRIM" max="MAX_INPUT_TRIM"'), 0.5, 1)).toBeUndefined();
  });
});

describe('labelled-end knobs (PAN) read like the unit: C in the middle, "10 R" either side', () => {
  const pan = () => param('min="0" max="1" defaultValue="0.5" min_string="L" mid_string="C" max_string="R" steps="101"');
  it('formats centre, right and left; ends are 50 on each side', () => {
    const p = pan();
    expect(formatValue(p, 0.5).text).toBe('C');
    expect(formatValue(p, 0.6).text).toBe('10 R'); // upstream: wire 0.6 reads "10 R" on the screen
    expect(formatValue(p, 0.4).text).toBe('10 L');
    expect(formatValue(p, 0).text).toBe('50 L');
    expect(formatValue(p, 1).text).toBe('50 R');
    expect(formatValue(p, Number.NaN).text).toBe('no value');
  });
  it('the real catalog PAN knobs (lane output, mixer, cabs) all use it', () => {
    const cat = parseModelRepoPayload(new Uint8Array(readFileSync(new URL('./fixtures/model_repo_coros_4_0_1.bin', import.meta.url))));
    const lanePan = cat.models.get(23000)!.params[1]!;
    expect([formatValue(lanePan, 0.5).text, formatValue(lanePan, 0.75).text]).toEqual(['C', '25 R']);
    const mixerPanA = cat.models.get(11000)!.params[1]!;
    expect(formatValue(mixerPanA, 0.5).text).toBe('C');
  });
});
