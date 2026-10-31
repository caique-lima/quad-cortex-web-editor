import { readFileSync } from 'node:fs';
import { parseModelRepoPayload } from '@qc/protocol';
import { describe, expect, it } from 'vitest';
import { defaultPins, MAX_PINS } from '../src/perform';
import { familyOf, sceneColor } from '../src/theme';

const cat = parseModelRepoPayload(new Uint8Array(readFileSync(new URL('../../../packages/protocol/test/fixtures/model_repo_coros_4_0_1.bin', import.meta.url))));

describe('block families', () => {
  it('every category of the real catalog maps to the family a player would expect', () => {
    const expected: Record<string, string> = {
      'Guitar Overdrive': 'DRV', 'Bass Overdrive': 'DRV', 'Guitar Amplifier': 'AMP', 'Bass Amplifier': 'AMP',
      'Cabsim Guitar (M)': 'CAB', 'Cabsim Guitar (ST)': 'CAB', 'Cabsim Bass (M)': 'CAB', 'Cabsim Bass (ST)': 'CAB', IRLoaders: 'CAB',
      Compressor: 'CMP', Delay: 'DLY', Reverb: 'RVB', Modulation: 'MOD', Wah: 'MOD', Pitch: 'MOD', Filter: 'MOD', Morph: 'MOD',
      Synth: 'SYN', 'Neural Capture': 'CAP', Equalizer: 'UTL', Utility: 'UTL', 'FX Loop': 'UTL', Loopers: 'UTL',
    };
    const visible = cat.categories.filter((c) => !c.hidden).map((c) => c.name);
    for (const name of visible) expect(expected[name], `category "${name}" has no expectation: add it`).toBeDefined();
    for (const [name, code] of Object.entries(expected)) expect(familyOf(name).code, name).toBe(code);
  });
  it('unknown or missing categories are Utility, and every family has a distinct colour and a code', () => {
    expect(familyOf(undefined).code).toBe('UTL');
    expect(familyOf('Something New').code).toBe('UTL');
    const fams = ['Guitar Overdrive', 'Guitar Amplifier', 'Cabsim Guitar (M)', 'Compressor', 'Delay', 'Reverb', 'Modulation', 'Synth', 'Neural Capture', 'Utility'].map(familyOf);
    expect(new Set(fams.map((f) => f.color)).size).toBe(fams.length);
  });
});

describe('scene colours', () => {
  it('converts ARGB and gives a scene with no colour a neutral', () => {
    expect(sceneColor(0xff3a7bff)).toBe('#3a7bff');
    expect(sceneColor(0xffe53935)).toBe('#e53935');
    expect(sceneColor(0)).toBe('#55555e');
    expect(sceneColor(undefined)).toBe('#55555e');
    expect(sceneColor(0x00ff0000)).toBe('#55555e'); // alpha 0 means "no colour"
  });
});

describe('default pins', () => {
  const cell = (row: number, column: number, category?: string) => ({ row, column, empty: !category, category });
  it('picks the first drive, delay and reverb, in that order, wherever they are', () => {
    const grid = [
      { cells: [cell(0, 0, 'Compressor'), cell(0, 1, 'Reverb'), cell(0, 2, 'Guitar Overdrive'), cell(0, 3, 'Guitar Amplifier')] },
      { cells: [cell(1, 0, 'Delay'), cell(1, 1), cell(1, 2, 'Delay')] },
    ];
    expect(defaultPins(grid)).toEqual([{ row: 0, column: 2 }, { row: 1, column: 0 }, { row: 0, column: 1 }]);
  });
  it('skips what is missing and never exceeds the maximum', () => {
    expect(defaultPins([{ cells: [cell(0, 0, 'Guitar Amplifier')] }])).toEqual([]);
    expect(defaultPins([{ cells: [cell(0, 0, 'Reverb')] }])).toEqual([{ row: 0, column: 0 }]);
    expect(defaultPins([]).length).toBeLessThanOrEqual(MAX_PINS);
  });
});
