import { isPluginFolder, type Folder } from './store';

const PLUGIN_PATH = /^(\/opt\/neuraldsp\/Plugins\/([^/]+))/i;

/** A plugin and its preset folders (Ambient, Creative… or one per artist), as the Library shows them. */
export interface PluginGroup {
  name: string;
  folders: Folder[];
}

/**
 * The plugin a folder belongs to, or undefined for anything that isn't a plugin folder.
 * Taken from the `/opt/neuraldsp/Plugins/<plugin>/…` path (named after that folder when the unit lists it),
 * else from the topmost plugin folder above it.
 */
export function pluginName(folder: Folder, folders: ReadonlyMap<string, Folder>): string | undefined {
  if (!isPluginFolder(folder)) return undefined;
  const m = PLUGIN_PATH.exec(folder.key);
  if (m) return folders.get(m[1]!)?.name || m[2]!;
  let top = folder;
  const seen = new Set<string>([folder.key]);
  while (top.parentKey && !seen.has(top.parentKey)) {
    const parent = folders.get(top.parentKey);
    if (!parent || !isPluginFolder(parent)) break;
    seen.add(parent.key);
    top = parent;
  }
  return top === folder ? 'Plugins' : top.name;
}

const hasPresets = (f: Folder) => f.kind !== 'captures' && f.kind !== 'irs' && [...f.slots.values()].some((s) => s.name);

/** Plugin preset folders grouped by plugin, both sorted by name. Folders with no presets are left out. */
export function pluginGroups(folders: ReadonlyMap<string, Folder>): PluginGroup[] {
  const groups = new Map<string, Folder[]>();
  for (const f of folders.values()) {
    const name = pluginName(f, folders);
    if (!name || !hasPresets(f)) continue;
    groups.set(name, [...(groups.get(name) ?? []), f]);
  }
  return [...groups]
    .map(([name, fs]) => ({ name, folders: fs.sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
