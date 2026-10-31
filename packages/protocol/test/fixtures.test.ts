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
