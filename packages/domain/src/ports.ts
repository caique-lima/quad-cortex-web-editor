// Lane (grid row) routing: BinaryPreset.Chain.in_portid / out_portid. Numbering from pyquadcortex (MIT, verified on CorOS 4.0.1).
// The unit does NOT validate these fields: an unknown id is stored verbatim and the lane simply goes silent. So we only
// ever WRITE ids from these tables, and only DISPLAY (never rewrite) anything else.

export interface PortOption { id: number; label: string; group: string }

export const INPUT_PORTS: readonly PortOption[] = [
  { id: 0, label: 'Internal / none', group: 'Internal' },
  { id: 7, label: 'Previous row', group: 'Internal' },
  { id: 1, label: 'Input 1', group: 'Inputs' },
  { id: 2, label: 'Input 2', group: 'Inputs' },
  { id: 3, label: 'Input 1/2 (stereo)', group: 'Inputs' },
  { id: 4, label: 'Return 1', group: 'FX loop returns' },
  { id: 5, label: 'Return 2', group: 'FX loop returns' },
  { id: 6, label: 'Return 1/2 (stereo)', group: 'FX loop returns' },
  { id: 8, label: 'USB 5', group: 'USB' },
  { id: 9, label: 'USB 6', group: 'USB' },
  { id: 10, label: 'USB 7', group: 'USB' },
  { id: 11, label: 'USB 8', group: 'USB' },
  { id: 12, label: 'USB 5/6 (stereo)', group: 'USB' },
  { id: 13, label: 'USB 7/8 (stereo)', group: 'USB' },
];

export const OUTPUT_PORTS: readonly PortOption[] = [
  { id: 0, label: 'Unrouted (silent)', group: 'Internal' },
  { id: 16, label: 'To row 3', group: 'Internal' },
  { id: 17, label: 'To row 4', group: 'Internal' },
  { id: 18, label: 'To rows 3 and 4', group: 'Internal' },
  { id: 1, label: 'Output 1/2', group: 'Outputs' },
  { id: 4, label: 'Output 1', group: 'Outputs' },
  { id: 5, label: 'Output 2', group: 'Outputs' },
  { id: 2, label: 'Output 3/4', group: 'Outputs' },
  { id: 6, label: 'Output 3', group: 'Outputs' },
  { id: 7, label: 'Output 4', group: 'Outputs' },
  { id: 19, label: 'Multi-Out', group: 'Outputs' },
  { id: 3, label: 'Send 1/2', group: 'FX loop sends' },
  { id: 8, label: 'Send 1', group: 'FX loop sends' },
  { id: 9, label: 'Send 2', group: 'FX loop sends' },
  { id: 10, label: 'USB 5', group: 'USB' },
  { id: 11, label: 'USB 6', group: 'USB' },
  { id: 12, label: 'USB 7', group: 'USB' },
  { id: 13, label: 'USB 8', group: 'USB' },
  { id: 14, label: 'USB 5/6 (stereo)', group: 'USB' },
  { id: 15, label: 'USB 7/8 (stereo)', group: 'USB' },
  { id: 20, label: 'USB 3', group: 'USB' },
  { id: 21, label: 'USB 4', group: 'USB' },
  { id: 22, label: 'USB 3/4 (stereo)', group: 'USB' },
];

const INPUT_IDS = new Set(INPUT_PORTS.map((p) => p.id));
const OUTPUT_IDS = new Set(OUTPUT_PORTS.map((p) => p.id));

export const isKnownInput = (id: number) => INPUT_IDS.has(id);
export const isKnownOutput = (id: number) => OUTPUT_IDS.has(id);

/** Label for display; an id we don't know (e.g. new firmware, or the internal sidechain source) is shown honestly, not hidden. */
export const inputLabel = (id: number | undefined) => (id === undefined ? 'Not set' : (INPUT_PORTS.find((p) => p.id === id)?.label ?? `Port ${id} (unrecognised)`));
export const outputLabel = (id: number | undefined) => (id === undefined ? 'Not set' : (OUTPUT_PORTS.find((p) => p.id === id)?.label ?? `Port ${id} (unrecognised)`));

/**
 * Lanes whose output is set to an internal "to row N" value that targets `row` (0-based).
 * Inferred from the port names (16 = to row 3, 17 = to row 4, 18 = both): used only to EXPLAIN a lane whose input is
 * stored as 0 ("internal"), which is how the unit stores a row fed by another row (e.g. factory "Brit 2203").
 */
export function lanesFeeding(row: number, outputOf: (lane: number) => number | undefined, lanes = 4): number[] {
  const targets: Record<number, number[]> = { 16: [2], 17: [3], 18: [2, 3] };
  const out: number[] = [];
  for (let l = 0; l < lanes; l++) {
    if (l === row) continue;
    const t = targets[outputOf(l) ?? -1];
    if (t?.includes(row)) out.push(l);
  }
  return out;
}
