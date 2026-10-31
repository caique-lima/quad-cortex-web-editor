import { useMemo, useState } from 'react';
import { fromBinary } from '@bufbuild/protobuf';
import { planStructure, restoreSnapshot, slotLabel, unsupportedInSnapshot, type RestoreProgress, type RestoreReport } from '@qc/domain';
import { preset as PS } from '@qc/protocol';
import { connection, useDevice } from '../connection';
import type { StoredSnapshot } from '../snapshots';

/** Rebuild a stored snapshot on the unit. The result is live and UNSAVED; the person decides whether to save it. */
export function RestoreSheet({ snapshot, onClose }: { snapshot: StoredSnapshot; onClose: () => void }) {
  const dev = useDevice();
  const [understood, setUnderstood] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<RestoreProgress>();
  const [report, setReport] = useState<RestoreReport>();
  const [error, setError] = useState<string>();

  const snap = useMemo(() => {
    try { return fromBinary(PS.BinaryPresetSchema, snapshot.preset); } catch { return undefined; }
  }, [snapshot]);
  const preview = useMemo(() => (snap && dev.preset ? planStructure(dev.preset, snap, dev.catalog) : undefined), [snap, dev.preset, dev.catalog]);
  const unsupported = snap ? unsupportedInSnapshot(snap) : [];
  const count = (k: string) => preview?.steps.filter((s) => s.kind === k).length ?? 0;

  const start = async () => {
    if (!snap) return;
    setRunning(true); setError(undefined);
    try { setReport(await restoreSnapshot(connection.store, snap, setProgress)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setRunning(false); }
  };

  return (
    <div className="sheet-backdrop" onClick={running ? undefined : onClose}>
      <div className="sheet" role="dialog" aria-label="Rebuild preset" onClick={(e) => e.stopPropagation()}>
        <strong>Rebuild “{snapshot.name}” on the unit</strong>
        <p className="muted small">Snapshot of {snapshot.folderName} {slotLabel(snapshot.index)}, taken {new Date(snapshot.savedAt).toLocaleString()}.</p>
        {!snap && <div className="card err">This snapshot could not be read.</div>}

        {snap && !report && (
          <>
            <div className="card warn">
              <b>This changes the unit's CURRENT preset</b> to match the snapshot. It is live and <b>not saved</b>: check it, then use Save (to an empty slot is safest).
              Load an empty or scratch preset first.
              {dev.dirty && <p style={{ margin: '6px 0 0' }}><b>The current preset has unsaved changes. They will be overwritten.</b></p>}
            </div>
            {preview && (
              <p className="small">
                Plan: {count('place')} block{count('place') === 1 ? '' : 's'} to place, {count('remove')} to remove, {count('lanePort') + count('split')} routing/branch change{count('lanePort') + count('split') === 1 ? '' : 's'}; then every parameter, bypass, scene name and colour that differs.
              </p>
            )}
            {(unsupported.length > 0 || (preview?.skipped.length ?? 0) > 0) && (
              <div className="small">
                <b>Will not be restored:</b>
                <ul>
                  {unsupported.map((u) => <li key={u}>{u}</li>)}
                  {preview?.skipped.map((u) => <li key={u}>{u}</li>)}
                  <li>text parameters such as cab/IR choices, and the preset's name (you name it when you save)</li>
                </ul>
              </div>
            )}
            {running && progress && (
              <div role="status">
                <progress value={progress.done} max={Math.max(1, progress.total)} style={{ width: '100%' }} />
                <div className="muted small">{progress.phase}… {progress.done}/{progress.total}. Don't touch the unit or close this page.</div>
              </div>
            )}
            {error && <div className="inline-err" role="alert">{error}</div>}
            <label className="check"><input type="checkbox" checked={understood} disabled={running} onChange={(e) => setUnderstood(e.target.checked)} /> I understand the current preset on the unit will be changed</label>
            <div className="actions">
              <button className="primary" disabled={!understood || running || !dev.preset || dev.loadingPreset} onClick={start}>{running ? 'Rebuilding…' : 'Rebuild'}</button>
              <button disabled={running} onClick={onClose}>Cancel</button>
            </div>
          </>
        )}

        {report && (
          <>
            <div className={`card ${report.mismatches.length === 0 && report.errors.length === 0 ? 'ok' : 'warn'}`}>
              {report.mismatches.length === 0 && report.errors.length === 0
                ? <b>Everything this app restores now matches the snapshot.</b>
                : <b>Rebuilt, with {report.mismatches.length + report.errors.length} difference{report.mismatches.length + report.errors.length === 1 ? '' : 's'} listed below.</b>}
              <div className="small">It is live and unsaved. Listen to it on the unit, then use Save.</div>
            </div>
            <Group title="Still different from the snapshot" items={report.mismatches} />
            <Group title="Edits that failed" items={report.errors} />
            <Group title="Not placed" items={report.skipped} />
            <Group title="Notes" items={report.notes} />
            <Group title="Never restored by this app" items={report.unsupported} />
            <button className="primary" onClick={onClose}>Done</button>
          </>
        )}
      </div>
    </div>
  );
}

function Group({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  const shown = items.slice(0, 12);
  return (
    <div className="small">
      <b>{title}</b>
      <ul>{shown.map((x) => <li key={x}>{x}</li>)}{items.length > shown.length && <li>…and {items.length - shown.length} more</li>}</ul>
    </div>
  );
}
