import { describe, expect, it } from 'vitest';
import { parseSlotLabel, slotLabel } from '../src/slots';

describe('slots', () => {
  it('matches the documented example: 28C = position 218', () => {
    expect(slotLabel(218)).toBe('28C');
    expect(parseSlotLabel('28C')).toBe(218);
  });
  it('covers the ends', () => {
    expect(slotLabel(0)).toBe('1A');
    expect(slotLabel(255)).toBe('32H');
    expect(parseSlotLabel('1a')).toBe(0);
    expect(parseSlotLabel(' 32h ')).toBe(255);
  });
  it('round-trips all 256', () => {
    for (let i = 0; i < 256; i++) expect(parseSlotLabel(slotLabel(i))).toBe(i);
  });
  it('rejects bad labels', () => {
    for (const bad of ['', '0A', '33A', '1I', 'A1', '1', '1AA']) expect(parseSlotLabel(bad)).toBeUndefined();
  });
});
