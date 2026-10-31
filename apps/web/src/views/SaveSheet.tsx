import { useMemo, useState } from 'react';
import { DeviceStore, LETTERS, MAX_NAME_LENGTH, SLOTS_PER_BANK, slotLabel, type SaveResult } from '@qc/domain';
import { connection, useDevice } from '../connection';

export function SaveSheet({ onClose }: { onClose: () => void }) {
  const dev = useDevice();
  const folders = useMemo(
    () => [...dev.folders.values()].filter((f) => DeviceStore.whyNotWritable(f, 0) === undefined).sort((a, b) => a.name.localeCompare(b.name)),
    [dev.folders],
  );
  const loaded = dev.position;
  const [folderKey, setFolderKey] = useState(() => (loaded && folders.some((f) => f.key === loaded.folderKey) ? loaded.folderKey : folders[0]?.key ?? ''));
  const [index, setIndex] = useState(() => (loaded && loaded.folderKey === folderKey ? loaded.position : 0));
  const [name, setName] = useState(dev.preset?.name ?? '');
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<SaveResult>();

  const folder = dev.folders.get(folderKey);
  const occupant = folder?.slots.get(index);
  const replacing = occupant?.name;
  const snap = replacing ? connection.store.canSnapshot(folderKey, index) : false;
  const blocked = DeviceStore.whyNotWritable(folder, index);
  const bank = Math.floor(index / SLOTS_PER_BANK);
  const letter = index % SLOTS_PER_BANK;
  const nameOk = name.trim().length > 0 && name.trim().length <= MAX_NAME_LENGTH;
  const canSave = !busy && !blocked && nameOk && (!replacing || understood) && !dev.loadingPreset;

  const save = async () => {
    setBusy(true); setError(undefined);
    try { setResult(await connection.store.save({ folderKey, index, name })); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  if (result) {
    return (
      <Backdrop onClose={onClose}>
        <strong>Saved</strong>
        <p>“{result.savedName}” is now in <b>{folder?.name} {slotLabel(index)}</b>.{result.renamed && ' The unit changed the name because it was already in use.'}</p>
        {result.replaced && <p className="muted small">It replaced “{result.replaced}”.{result.snapshotted ? ' A snapshot of that preset was kept in this browser (Diagnostics → Snapshots).' : ' No snapshot of it could be kept.'}</p>}
        <button className="primary" onClick={onClose}>Done</button>
      </Backdrop>
    );
  }

  return (
    <Backdrop onClose={busy ? () => {} : onClose}>
      <strong>Save preset</strong>
      <p className="muted small">Saves what the unit is playing right now, including your changes, into a slot on the unit.</p>

      <label className="field">Folder
        <select value={folderKey} disabled={busy} onChange={(e) => { setFolderKey(e.target.value); setUnderstood(false); }}>
          {folders.map((f) => <option key={f.key} value={f.key}>{f.name}</option>)}
        </select>
      </label>
      <div className="slotpick">
        <label className="field">Bank
          <select value={bank} disabled={busy} onChange={(e) => { setIndex(Number(e.target.value) * SLOTS_PER_BANK + letter); setUnderstood(false); }}>
            {Array.from({ length: 32 }, (_, b) => <option key={b} value={b}>{b + 1}</option>)}
          </select>
        </label>
        <label className="field">Slot
          <select value={letter} disabled={busy} onChange={(e) => { setIndex(bank * SLOTS_PER_BANK + Number(e.target.value)); setUnderstood(false); }}>
            {LETTERS.map((L, i) => <option key={L} value={i}>{L}</option>)}
          </select>
        </label>
      </div>
      <label className="field">Name (max {MAX_NAME_LENGTH} characters)
        <input type="text" value={name} maxLength={MAX_NAME_LENGTH} disabled={busy} onChange={(e) => setName(e.target.value)} />
      </label>

      {blocked ? <div className="card err">{blocked}</div>
        : replacing ? (
          <div className="card err" role="alert">
            <b>{folder?.name} {slotLabel(index)} already holds “{replacing}”. Saving will replace it permanently.</b>
            <p className="small" style={{ margin: '6px 0' }}>
              {snap
                ? 'A snapshot of the stored version will be kept in this browser first (Diagnostics → Snapshots). You can rebuild it from Diagnostics → Snapshots, or export it.'
                : 'This app cannot keep a copy of that preset first. If you might want it back, export it with Cortex Control before saving.'}
            </p>
            <label className="check"><input type="checkbox" checked={understood} disabled={busy} onChange={(e) => setUnderstood(e.target.checked)} /> I understand “{replacing}” will be replaced</label>
          </div>
        ) : <p className="muted small">{folder?.name} {slotLabel(index)} is empty.</p>}

      {error && <div className="inline-err" role="alert">{error}</div>}
      <div className="actions">
        <button className="primary" disabled={!canSave} onClick={save}>{busy ? 'Saving…' : replacing ? 'Replace and save' : 'Save'}</button>
        <button disabled={busy} onClick={onClose}>Cancel</button>
      </div>
    </Backdrop>
  );
}

function Backdrop({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" onClick={(e) => e.stopPropagation()}>{children}</div>
    </div>
  );
}
