// Preset slots are addressed on the unit as bank (1..32) + letter (A..H); on the wire as a 0..255 position.
// position = (bank - 1) * 8 + letterIndex   (per pyquadcortex protocol.md)

export const SLOTS_PER_BANK = 8;
export const SLOT_COUNT = 256;
export const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as const;

export function slotLabel(position: number): string {
  return `${Math.floor(position / SLOTS_PER_BANK) + 1}${LETTERS[position % SLOTS_PER_BANK]}`;
}

/** "28C" -> 218. Returns undefined for anything that isn't bank 1..32 + A..H. */
export function parseSlotLabel(label: string): number | undefined {
  const m = /^(\d{1,2})([A-Ha-h])$/.exec(label.trim());
  if (!m) return undefined;
  const bank = Number(m[1]);
  if (bank < 1 || bank > SLOT_COUNT / SLOTS_PER_BANK) return undefined;
  return (bank - 1) * SLOTS_PER_BANK + LETTERS.indexOf(m[2]!.toUpperCase() as (typeof LETTERS)[number]);
}
