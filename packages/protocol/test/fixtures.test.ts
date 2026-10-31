import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseModelRepoPayload } from '../src/catalog';

// Real model_repo_payload captured from CorOS 4.0.1 by pyquadcortex (MIT) — validates our catalog parser against real data.
describe('real captured ModelRepo payload', () => {
  const cat = parseModelRepoPayload(new Uint8Array(readFileSync(new URL('./fixtures/model_repo_coros_4_0_1.bin', import.meta.url))));

  it('parses the full catalog (533 models / 32 categories, cross-checked with Python ElementTree)', () => {
    expect(cat.models.size).toBe(533);
    expect(cat.categories.length).toBe(32);
  });

  it('reads a known model with its parameters', () => {
    const m = cat.models.get(1)!;
    expect(m.name).toBe('Myth Drive');
    expect(m.category).toBe('Guitar Overdrive');
    expect(m.params.map((p) => p.name)).toEqual(['GAIN', 'TREBLE', 'LEVEL']);
    expect(m.params[0]).toMatchObject({ min: 0, max: 10, defaultValue: 5, type: 'float' });
    const od = cat.models.get(2)!;
    expect(od.params[1]).toMatchObject({ name: 'PEAK', type: 'switch', steps: 2, options: ['LP', 'HP'] });
  });
});

// ---- cab wire layout ----
import { CABSIM_CATEGORIES, wireModel } from '../src/catalog';

const cat = parseModelRepoPayload(new Uint8Array(readFileSync(new URL('./fixtures/model_repo_coros_4_0_1.bin', import.meta.url))));

describe('cab wire layout (a cab\'s own entry is a short local list)', () => {
  const cabs = [...cat.models.values()].filter((m) => CABSIM_CATEGORIES.has(m.category));

  it('169 of the 174 cab models use the shared 21-entry layout; 5 describe the wire themselves (as pyquadcortex measured)', () => {
    expect(cabs).toHaveLength(174);
    const borrowing = cabs.filter((m) => wireModel(cat, m) !== m);
    expect(borrowing).toHaveLength(169);
    for (const m of borrowing) {
      const l = wireModel(cat, m)!;
      expect(l.params).toHaveLength(21);
      expect([12000, 32000]).toContain(l.id);
    }
    const own = cabs.filter((m) => wireModel(cat, m) === m);
    expect(own).toHaveLength(5);
    for (const m of own) expect(m.params.length).toBeGreaterThanOrEqual(21);
  });

  it('mono cabs get the mono layout (PAN) and stereo cabs the stereo one (BALANCE); wire index 2 is LEVEL either way', () => {
    const mono = cat.models.get(12002)!; // 412 D-Cell Front V30 04 (M)
    const stereo = cabs.find((m) => m.category === 'Cabsim Guitar (ST)' && m.params.length < 21)!;
    expect(wireModel(cat, mono)!.params[3]!.name).toBe('PAN');
    expect(wireModel(cat, stereo)!.params[3]!.name).toBe('BALANCE');
    for (const m of [mono, stereo]) expect(wireModel(cat, m)!.params[2]!.name).toBe('LEVEL');
  });

  it('nothing else is remapped: IR loaders, amps and effects are wire-indexed by their own entry', () => {
    for (const m of cat.models.values()) if (!CABSIM_CATEGORIES.has(m.category)) expect(wireModel(cat, m), m.name).toBe(m);
    expect(wireModel(undefined, cabs[0])).toBe(cabs[0]); // no catalog: nothing to borrow from
    expect(wireModel(cat, undefined)).toBeUndefined();
  });
});
