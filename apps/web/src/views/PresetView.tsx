import { useMemo, useState } from 'react';
import { buildGrid, type GridCell, type GridParam } from '@qc/domain';
import { connection, useDevice } from '../connection';
import { BlockPicker } from './BlockPicker';
import { SceneSheet } from './SceneSheet';
import { LaneSheet } from './LaneSheet';
import { ParamControl } from './ParamControl';
import { inputLabel, outputLabel } from '@qc/domain';

export function PresetView() {
  const dev = useDevice();
  const [picked, setPicked] = useState<{ row: number; column: number } | null>(null);
  const [picking, setPicking] = useState<{ row: number; column: number; replacing?: string } | null>(null);
  const [moving, setMoving] = useState<{ row: number; column: number; name: string } | null>(null);
  const [scenes, setScenes] = useState(false);
  const [lane, setLane] = useState<number | null>(null);
  const [error, setError] = useState<string>();
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  const grid = useMemo(
    () => (dev.preset ? buildGrid(dev.preset, dev.catalog, dev.selectedScene) : undefined),
    [dev.preset, dev.catalog, dev.selectedScene],
  );

  if (!grid) {
    return (
      <div className="card" role="status">
        <h2>Waiting for the current preset…</h2>
        <p className="muted">The unit sends the loaded preset a few seconds after connecting (it can take up to ~25 s). You can already browse the Library.</p>
      </div>
    );
  }
  const cell = picked ? grid[picked.row]?.cells[picked.column] : undefined;
  const tapCell = (c: GridCell) => {
    setError(undefined);
    if (moving) {
      if (!c.empty) return;
      connection.store.moveBlock(moving.row, moving.column, c.row, c.column).catch(fail);
      setMoving(null);
    } else if (c.empty) setPicking({ row: c.row, column: c.column });
    else setPicked({ row: c.row, column: c.column });
  };

  return (
    <>
      <div className="toolbar">
        <button onClick={() => setScenes(true)}>Scenes…</button>
        <button disabled={!dev.undoCount || dev.loadingPreset} onClick={() => connection.store.undo().catch(fail)} aria-label="Undo">↶ Undo</button>
        <button disabled={!dev.redoCount || dev.loadingPreset} onClick={() => connection.store.redo().catch(fail)} aria-label="Redo">↷ Redo</button>
        {moving && <span className="movebar" role="status">Tap an empty cell to move “{moving.name}” there. <button onClick={() => setMoving(null)}>Cancel</button></span>}
      </div>
      {error && <div className="inline-err" role="alert">{error}</div>}
      <div className={`grid ${dev.loadingPreset || dev.structuralPending ? 'loading' : ''}`}>
        {grid.map((row) => (
          <div className="row" key={row.row}>
            <button className="rowlabel" onClick={() => setLane(row.row)} aria-label={`Lane ${row.row + 1} routing`}
              title={`Lane ${row.row + 1}: ${inputLabel(row.inPort)} → ${outputLabel(row.outPort)}`}>{row.row + 1}</button>
            {row.cells.map((c) => (
              <button
                key={c.column}
                className={`cell ${c.empty ? 'empty' : ''} ${c.bypassed ? 'bypassed' : ''} ${c.unknown ? 'unknown' : ''} ${moving && c.empty ? 'target' : ''}`}
                disabled={dev.loadingPreset || (moving ? !c.empty : false)}
                onClick={() => tapCell(c)}
                title={c.empty ? 'Add a block' : c.category}
                aria-label={c.empty ? `Empty, row ${c.row + 1} column ${c.column + 1}` : undefined}
              >
                {c.empty ? <span className="plus">+</span> : <><span className="name">{c.name}</span>{c.bypassed && <small>bypassed{c.bypassPerScene ? ' (scene)' : ''}</small>}</>}
              </button>
            ))}
          </div>
        ))}
      </div>
      {cell && !cell.empty && (
        <BlockSheet cell={cell} onClose={() => setPicked(null)}
          onReplace={() => { setPicking({ row: cell.row, column: cell.column, replacing: cell.name }); setPicked(null); }}
          onMove={() => { setMoving({ row: cell.row, column: cell.column, name: cell.name }); setPicked(null); }}
          onRemove={() => { if (confirm(`Remove ${cell.name}? This is live and unsaved until you save.`)) { connection.store.removeBlock(cell.row, cell.column).catch(fail); setPicked(null); } }} />
      )}
      {picking && <BlockPicker {...picking} onClose={() => setPicking(null)} />}
      {scenes && <SceneSheet onClose={() => setScenes(false)} />}
      {lane !== null && <LaneSheet row={lane} onClose={() => setLane(null)} />}
    </>
  );
}

function BlockSheet({ cell, onClose, onReplace, onMove, onRemove }: { cell: GridCell; onClose: () => void; onReplace: () => void; onMove: () => void; onRemove: () => void }) {
  const dev = useDevice();
  const [error, setError] = useState<string>();
  const model = cell.hash !== undefined ? dev.catalog?.models.get(cell.hash) : undefined;
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  const locked = dev.loadingPreset;
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label={cell.name} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <div>
            <strong>{cell.name}</strong>
            <div className="muted small">{[cell.category, model?.basedOn].filter(Boolean).join(' · ')} · row {cell.row + 1}, col {cell.column + 1}</div>
          </div>
          <button onClick={onClose}>Close</button>
        </div>
        <div className="actions">
          <button className={cell.bypassed ? '' : 'on'} disabled={locked}
            onClick={() => connection.store.setBypass(cell.row, cell.column, !cell.bypassed).catch(fail)}>
            {cell.bypassed ? 'Bypassed — tap to enable' : 'Enabled — tap to bypass'}
          </button>
          {cell.bypassed && !cell.bypassPerScene && <small className="muted">bypass applies to all scenes for this block</small>}
        </div>
        <div className="actions">
          <button disabled={locked} onClick={onReplace}>Replace…</button>
          <button disabled={locked} onClick={onMove}>Move…</button>
          <button disabled={locked} onClick={onRemove}>Remove</button>
        </div>
        {error && <div className="inline-err" role="alert">{error}</div>}
        {cell.params.length === 0 ? <p className="muted">No parameters sent for this block.</p> : (
          <div className="params">
            {cell.params.filter((p) => !p.hidden).map((p) => <ParamRow key={p.index} cell={cell} p={p} disabled={locked} onError={fail} />)}
          </div>
        )}
        <p className="muted small">
          Changes are applied live on the unit and are <b>not saved</b> — use “Discard changes” in the header to go back to the saved preset.
          Per-scene parameters change the active scene ({dev.selectedScene + 1}) only.
        </p>
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
