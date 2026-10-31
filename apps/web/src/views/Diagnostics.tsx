import { useCallback, useEffect, useState } from 'react';
import { deleteSnapshot, downloadSnapshot, listSnapshots, type StoredSnapshot } from '../snapshots';
import { isDownloadsFolder, isPluginFolder, pluginName, slotLabel, type Folder } from '@qc/domain';
import { RestoreSheet } from './RestoreSheet';
import { Support } from './Support';
import { CC_VERSION, connection, useConnection, useDevice } from '../connection';

/** One line per folder the unit listed: key, name, flags, presets — for checking how the Library sorts real listings. */
function folderLines(folders: ReadonlyMap<string, Folder>): string[] {
  return [...folders.values()].sort((a, b) => a.key.localeCompare(b.key)).map((f) => {
    const named = [...f.slots.values()].filter((s) => s.name).length;
    const flags = [f.isFactory && 'factory', f.isPlugin && 'plugin-flag', isPluginFolder(f) && 'plugin', isDownloadsFolder(f) && 'downloads', f.isCloud && 'cloud', f.isFavorites && 'favorites'].filter(Boolean).join(',');
    const sample = [...f.slots.values()].find((s) => s.name);
    return `${f.key} | “${f.name}” | ${f.kind}${flags ? ` ${flags}` : ''}${f.parentKey ? ` | parent ${f.parentKey}` : ''} | ${named}/${f.slots.size} named${pluginName(f, folders) ? ` | plugin “${pluginName(f, folders)}”` : ''}${sample ? ` | e.g. ${sample.key ?? '(no key)'}` : ''}`;
  });
}

export function Diagnostics() {
  const c = useConnection();
  const dev = useDevice();
  const [snaps, setSnaps] = useState<StoredSnapshot[]>([]);
  const [snapError, setSnapError] = useState<string>();
  const [restoring, setRestoring] = useState<StoredSnapshot | null>(null);
  const reload = useCallback(() => { listSnapshots().then(setSnaps, (e) => setSnapError(String(e))); }, []);
  useEffect(reload, [reload, dev.verifiedReadBacks]);
  return (
    <div className="stack">
      <div className="card">
        <h2>Device</h2>
        <dl>
          <dt>CorOS</dt><dd>{dev.info?.coros ?? '…'}</dd>
          <dt>Firmware</dt><dd>{dev.info?.firmware ?? '…'}</dd>
          <dt>Name</dt><dd>{dev.info?.name ?? '—'}</dd>
          <dt>Announced as</dt><dd>Cortex Control {CC_VERSION}</dd>
          <dt>Block catalog</dt><dd>{dev.catalog ? `${dev.catalog.models.size} blocks` : 'not received yet'}</dd>
          <dt>Folders</dt><dd>{dev.folders.size}</dd>
          <dt>Write errors (expected)</dt><dd>{c.writeErrors}</dd>
        </dl>
        <button onClick={() => connection.disconnect()}>Disconnect</button>
      </div>
      <div className="card">
        <h2>Snapshots</h2>
        <p className="muted small">Taken in this browser before a preset is overwritten. The unit ignores whole presets sent to it, so “Rebuild…” recreates one on the unit's current preset step by step (live, unsaved). Export keeps the raw data.</p>
        {snapError && <div className="inline-err">{snapError}</div>}
        {snaps.length === 0 ? <p className="muted">None yet.</p> : (
          <ul className="results">
            {snaps.map((x) => (
              <li key={x.id} className="snap">
                <span><b>{x.name}</b> · {x.folderName} {slotLabel(x.index)}<br /><small className="muted">{new Date(x.savedAt).toLocaleString()}</small></span>
                <span><button disabled={!dev.preset || dev.loadingPreset} onClick={() => setRestoring(x)}>Rebuild…</button> <button onClick={() => downloadSnapshot(x)}>Export</button> <button onClick={() => { if (confirm(`Delete the snapshot of “${x.name}”?`)) deleteSnapshot(x.id).then(reload); }}>Delete</button></span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="card">
        <h2>Folders ({dev.folders.size})</h2>
        <button onClick={() => navigator.clipboard.writeText(folderLines(dev.folders).join('\n'))}>Copy</button>
        <pre className="log">{folderLines(dev.folders).join('\n')}</pre>
      </div>
      <div className="card">
        <h2>Messages received</h2>
        <dl>
          {Object.entries(c.counts).sort().map(([k, n]) => (<div key={k} style={{ display: 'contents' }}><dt>{k}</dt><dd>{n}</dd></div>))}
        </dl>
      </div>
      <div className="card">
        <h2>Log</h2>
        <button onClick={() => navigator.clipboard.writeText(c.log.join('\n'))}>Copy</button>
        <pre className="log">{c.log.join('\n')}</pre>
      </div>
      <div className="card"><Support /></div>
      {restoring && <RestoreSheet snapshot={restoring} onClose={() => setRestoring(null)} />}
    </div>
  );
}
