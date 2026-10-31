import type { Folder, Slot } from './store';

/**
 * The next (dir = 1) or previous (dir = -1) NAMED preset slot in a folder, wrapping round at the ends — for Previous/Next
 * buttons on stage. Empty slots are skipped. Undefined if there is nowhere else to go.
 */
export function neighbourSlot(folder: Folder | undefined, index: number, dir: 1 | -1): Slot | undefined {
  if (!folder) return undefined;
  const named = [...folder.slots.values()].filter((s) => s.name).sort((a, b) => a.index - b.index);
  if (named.length === 0 || (named.length === 1 && named[0]!.index === index)) return undefined;
  if (dir === 1) return named.find((s) => s.index > index) ?? named[0];
  return [...named].reverse().find((s) => s.index < index) ?? named[named.length - 1];
}
