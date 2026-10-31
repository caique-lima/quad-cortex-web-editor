// Perform mode: which blocks are pinned as big on/off buttons, remembered per preset slot in this browser.
import { familyOf } from './theme';

export interface Pin { row: number; column: number }

interface CellLike { row: number; column: number; empty: boolean; category?: string }
interface RowLike { cells: CellLike[] }

export const MAX_PINS = 3;

/** If nothing is pinned yet: the first drive, delay and reverb in the preset, which is what most people reach for on stage. */
export function defaultPins(grid: RowLike[]): Pin[] {
  const out: Pin[] = [];
  for (const code of ['DRV', 'DLY', 'RVB']) {
    for (const row of grid) {
      const hit = row.cells.find((c) => !c.empty && familyOf(c.category).code === code);
      if (hit) { out.push({ row: hit.row, column: hit.column }); break; }
    }
  }
  return out.slice(0, MAX_PINS);
}

const KEY = (slotKey: string) => `qc.pins.${slotKey}`;

/** Saved pins for a slot, or undefined if the person never chose any. Storage can be unavailable (private windows): never throws. */
export function loadPins(slotKey: string): Pin[] | undefined {
  try {
    const raw = localStorage.getItem(KEY(slotKey));
    if (!raw) return undefined;
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return undefined;
    return v.filter((p) => Number.isInteger(p?.row) && Number.isInteger(p?.column)).slice(0, MAX_PINS);
  } catch { return undefined; }
}

export function savePins(slotKey: string, pins: Pin[]): void {
  try { localStorage.setItem(KEY(slotKey), JSON.stringify(pins.slice(0, MAX_PINS))); } catch { /* storage unavailable: pins last for this session only */ }
}

export const samePin = (a: Pin, b: Pin) => a.row === b.row && a.column === b.column;
