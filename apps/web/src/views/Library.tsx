import { useMemo, useState } from 'react';
import { LETTERS, SLOT_COUNT, SLOTS_PER_BANK, isPluginFolder, pluginGroups, pluginName, slotLabel, type Folder, type Slot } from '@qc/domain';
import { connection, useDevice } from '../connection';

const PLUGIN = 'plugin:';

export function Library({ onLoaded }: { onLoaded: () => void }) {
  const dev = useDevice();
  const [showAll, setShowAll] = useState(false);
  const [folderKey, setFolderKey] = useState<string>();
  const [query, setQuery] = useState('');
  const [confirm, setConfirm] = useState<{ folder: Folder; slot: Slot } | null>(null);
  const [error, setError] = useState<string>();

  // Plugin folders (Ambient, Creative…) are shown as one entry per plugin; the rest as they are listed.
  const folders = useMemo(() => {
    const all = [...dev.folders.values()].filter((f) => !isPluginFolder(f) && (showAll || f.kind === 'presets'));
    return all.sort((a, b) => Number(a.isFactory) - Number(b.isFactory) || a.name.localeCompare(b.name));
  }, [dev.folders, showAll]);
  const plugins = useMemo(() => pluginGroups(dev.folders), [dev.folders]);

  const loadedFolder = dev.position ? dev.folders.get(dev.position.folderKey) : undefined;
  const loadedPlugin = loadedFolder && pluginName(loadedFolder, dev.folders);
  const currentKey = folderKey ?? (loadedPlugin ? PLUGIN + loadedPlugin : loadedFolder?.key) ?? folders[0]?.key;
  const plugin = currentKey?.startsWith(PLUGIN) ? plugins.find((p) => PLUGIN + p.name === currentKey) : undefined;
  const folder = currentKey && !plugin ? dev.folders.get(currentKey) : undefined;

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !folder) return undefined;
    return [...folder.slots.values()].filter((s) => s.name?.toLowerCase().includes(q)).sort((a, b) => a.index - b.index);
  }, [query, folder]);

  // A plugin's presets, one section per folder; the search filters across all of them.
  const sections = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (plugin?.folders ?? [])
      .map((f) => ({ folder: f, slots: [...f.slots.values()].filter((s) => s.name && (!q || s.name.toLowerCase().includes(q))).sort((a, b) => a.index - b.index) }))
      .filter((sec) => sec.slots.length > 0);
  }, [plugin, query]);

  const load = async (f: Folder, s: Slot) => {
    setError(undefined);
    try {
      await connection.store.recallSlot(f, s);
      setConfirm(null);
      onLoaded();
    } catch (e) { setError(String(e)); }
  };
  const choose = (f: Folder, s: Slot) => (dev.dirty ? setConfirm({ folder: f, slot: s }) : void load(f, s));

  if (dev.folders.size === 0) return <div className="card" role="status"><h2>Loading the library…</h2><p className="muted">The unit is still listing its folders.</p></div>;

  const isCurrent = (s: Slot, f = folder) => dev.position?.folderKey === f?.key && dev.position?.position === s.index;

  return (
    <div className="stack">
      <div className="card">
        <label className="field">Folder
          <select value={currentKey ?? ''} onChange={(e) => { setFolderKey(e.target.value); setQuery(''); }}>
            {folders.map((f) => <option key={f.key} value={f.key}>{f.isFactory ? 'Factory · ' : ''}{f.name}</option>)}
            {plugins.length > 0 && (
              <optgroup label="Plugins">
                {plugins.map((p) => <option key={p.name} value={PLUGIN + p.name}>{p.name}</option>)}
              </optgroup>
            )}
          </select>
        </label>
        <label className="field">Search {plugin ? 'this plugin' : 'this folder'}
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="preset name" />
        </label>
        <label className="check"><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> show all folders (captures, IRs, other)</label>
      </div>

      {error && <div className="card err">{error}</div>}

      {folder && matches && (
        <div className="card">
          <h2>{matches.length} match{matches.length === 1 ? '' : 'es'}</h2>
          <ul className="results">
            {matches.map((s) => (
              <li key={s.index}><button className={isCurrent(s) ? 'on' : ''} onClick={() => choose(folder, s)}><b>{slotLabel(s.index)}</b> {s.name}</button></li>
            ))}
          </ul>
        </div>
      )}

      {folder && !matches && (
        <div className="banks">
          {Array.from({ length: SLOT_COUNT / SLOTS_PER_BANK }, (_, b) => (
            <div className="bank" key={b}>
              <span className="banknum">{b + 1}</span>
              {LETTERS.map((L, i) => {
                const s = folder.slots.get(b * SLOTS_PER_BANK + i);
                return (
                  <button
                    key={L}
                    className={`slot ${s?.name ? '' : 'empty'} ${s && isCurrent(s) ? 'on' : ''}`}
                    disabled={!s?.name}
                    onClick={() => s && choose(folder, s)}
                    title={`${b + 1}${L}`}
                  >
                    <small>{L}</small>
                    <span>{s?.name ?? ''}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}

      {plugin && sections.length === 0 && <div className="card"><p className="muted">{query.trim() ? 'No presets match.' : 'This plugin has no presets on the unit.'}</p></div>}

      {sections.map(({ folder: f, slots }) => (
        <div className="card" key={f.key}>
          <h2>{f.name}</h2>
          <ul className="results">
            {slots.map((s) => (
              <li key={s.index}><button className={isCurrent(s, f) ? 'on' : ''} onClick={() => choose(f, s)}>{s.name}</button></li>
            ))}
          </ul>
        </div>
      ))}

      {confirm && (
        <div className="sheet-backdrop" onClick={() => setConfirm(null)}>
          <div className="sheet" role="alertdialog" onClick={(e) => e.stopPropagation()}>
            <strong>Load “{confirm.slot.name}”?</strong>
            <p>The current preset has <b>unsaved changes on the unit</b>. Loading another preset discards them.</p>
            <button className="primary" onClick={() => load(confirm.folder, confirm.slot)}>Discard changes and load</button>
            <button onClick={() => setConfirm(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
