import { useState, type CSSProperties } from 'react';
import type { GridCell, GridParam } from '@qc/domain';
import { connection, useDevice } from '../connection';
import { familyOf } from '../theme';
import { ParamControl } from './ParamControl';

/** Everything about one block: on/bypassed, its parameters, and what you can do to it. Used inline on a phone and as the right-hand panel on a desktop. */
export function BlockInspector({ cell, pinned, onPin, onReplace, onMove, onRemove, compact }: {
  cell: GridCell; pinned: boolean; onPin: () => void; onReplace: () => void; onMove: () => void; onRemove: () => void; compact?: boolean;
}) {
  const dev = useDevice();
  const [error, setError] = useState<string>();
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  const locked = dev.loadingPreset;
  const fam = familyOf(cell.category);
  // Settings the catalog names get controls; values it has no name for are listed quietly, read-only, so nothing is hidden.
  const named = cell.params.filter((p) => !p.hidden && p.meta);
  const unnamed = cell.params.filter((p) => !p.hidden && !p.meta);
  const model = cell.hash !== undefined ? dev.catalog?.models.get(cell.hash) : undefined;
  const setBypass = (b: boolean) => { if (b !== cell.bypassed) connection.store.setBypass(cell.row, cell.column, b).catch(fail); };

  return (
    <div className="insp-wrap" style={{ '--fam': fam.color } as CSSProperties}>
      <div className="insp-body">
      {!compact && (
        <>
          <div className="insp-cat"><i />{fam.label}{cell.category && cell.category !== fam.label ? ` · ${cell.category}` : ''}</div>
          <div className="insp-name">{cell.name}</div>
          <div className="insp-based">{model?.basedOn ?? ''}</div>
        </>
      )}
      <div className="seg" role="group" aria-label="Block state">
        <button className={!cell.bypassed ? 'on' : ''} aria-pressed={!cell.bypassed} disabled={locked} onClick={() => setBypass(false)}>On</button>
        <button className={cell.bypassed ? 'on' : ''} aria-pressed={cell.bypassed} disabled={locked} onClick={() => setBypass(true)}>Bypassed</button>
      </div>
      {cell.bypassed && !cell.bypassPerScene && <div className="muted small">This block's bypass applies to all scenes.</div>}
      {error && <div className="inline-err" role="alert">{error}</div>}
      {cell.category === 'IRLoaders' && <div className="muted small">Choosing a different IR is not supported yet. Change it on the unit or in Cortex Control; the loaded IR is shown below.</div>}
      {named.length === 0 && unnamed.length === 0 ? <p className="muted">No parameters sent for this block.</p> : (
        <div className="params">
          {named.map((p) => <ParamRow key={p.index} cell={cell} p={p} disabled={locked} onError={fail} />)}
        </div>
      )}
      {unnamed.length > 0 && (
        <details className="unnamed">
          <summary>{unnamed.length} unnamed value{unnamed.length === 1 ? '' : 's'} the unit sends (read-only)</summary>
          {unnamed.map((p) => <div key={p.index} className="paramhead"><span>#{p.index}</span><b>{p.display.text}</b></div>)}
        </details>
      )}
      <p className="muted small" style={{ marginTop: 10 }}>
        Live on the unit and not saved until you press Save. Per-scene values change scene {dev.selectedScene + 1} only.
      </p>
      </div>
      <div className="insp-actions">
        <button disabled={locked} onClick={onReplace}>Replace</button>
        <button disabled={locked} onClick={onMove}>Move</button>
        <button className="danger" disabled={locked} onClick={onRemove}>Remove</button>
        <button className={pinned ? 'on' : ''} aria-pressed={pinned} onClick={onPin} title="Show this block as a big button in Perform mode">{pinned ? 'Pinned' : 'Pin to Perform'}</button>
      </div>
    </div>
  );
}

function ParamRow({ cell, p, disabled, onError }: { cell: GridCell; p: GridParam; disabled: boolean; onError: (e: unknown) => void }) {
  const label = `${cell.name} ${p.name ?? `#${p.index}`}`;
  return (
    <ParamControl p={p} label={label} disabled={disabled} onError={onError}
      onSet={(w) => connection.store.setParam(cell.row, cell.column, p.index, w, label)}
      onNudge={(next) => connection.store.nudgeParam(cell.row, cell.column, p.index, next, label)} />
  );
}
