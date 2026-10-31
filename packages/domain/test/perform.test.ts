import { describe, expect, it } from 'vitest';
import { neighbourSlot } from '../src/perform';
import type { Folder, Slot } from '../src/store';

const folder = (named: number[], total = 256): Folder => {
  const slots = new Map<number, Slot>();
  for (let i = 0; i < total; i++) slots.set(i, named.includes(i) ? { index: i, name: `P${i}` } : { index: i });
  return { key: 'k', name: 'My Presets', isFactory: false, isDownloads: false, isCloud: false, isFavorites: false, isPlugin: false, kind: 'presets', slots };
};

describe('neighbourSlot', () => {
  it('skips empty slots in both directions', () => {
    const f = folder([2, 5, 9]);
    expect(neighbourSlot(f, 2, 1)!.index).toBe(5);
    expect(neighbourSlot(f, 5, 1)!.index).toBe(9);
    expect(neighbourSlot(f, 9, -1)!.index).toBe(5);
    expect(neighbourSlot(f, 5, -1)!.index).toBe(2);
  });
  it('wraps round at the ends', () => {
    const f = folder([2, 5, 9]);
    expect(neighbourSlot(f, 9, 1)!.index).toBe(2);
    expect(neighbourSlot(f, 2, -1)!.index).toBe(9);
  });
  it('works from a slot that has no preset (e.g. an empty slot the unit sits on)', () => {
    const f = folder([2, 5, 9]);
    expect(neighbourSlot(f, 6, 1)!.index).toBe(9);
    expect(neighbourSlot(f, 6, -1)!.index).toBe(5);
    expect(neighbourSlot(f, 200, 1)!.index).toBe(2);
    expect(neighbourSlot(f, 0, -1)!.index).toBe(9);
  });
  it('has nowhere to go with fewer than two presets, or no folder', () => {
    expect(neighbourSlot(folder([4]), 4, 1)).toBeUndefined();
    expect(neighbourSlot(folder([]), 0, 1)).toBeUndefined();
    expect(neighbourSlot(undefined, 0, 1)).toBeUndefined();
    expect(neighbourSlot(folder([4]), 7, 1)!.index).toBe(4); // one preset, but we are elsewhere: go to it
  });
});
