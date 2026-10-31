import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { buildGrid, inputLabel, outputLabel, type GridCell } from '@qc/domain';
import { optionCount } from '@qc/protocol';
import { connection, useDevice } from '../connection';
import { useMediaQuery } from '../hooks';
import { samePin, type Pin } from '../perform';
import { familyOf } from '../theme';
import { BlockInspector } from './BlockInspector';
import { BlockPicker } from './BlockPicker';
import { LaneSheet } from './LaneSheet';
import { SceneSheet } from './SceneSheet';

const two = (n: number) => String(n).padStart(2, '0');

function summary(c: GridCell): string {
  if (c.bypassed) return c.bypassPerScene ? 'Bypassed in this scene' : 'Bypassed';
  return c.params.filter((p) => !p.hidden).slice(0, 3).map((p) => `${p.name ?? `#${p.index}`} ${p.display.text}`).join(' · ');
}

/** Position bars for the first few continuous parameters (0..1 on the knob), shown for the selected block. */
function bars(c: GridCell): number[] {
  return c.params
    .filter((p) => !p.hidden && typeof p.value === 'number' && p.display.converted && p.meta && optionCount(p.meta) === undefined && p.meta.type !== 'string' && p.meta.type !== 'int')
    .slice(0, 3)
    .map((p) => Math.max(0, Math.min(1, p.value as number)));
}

export function PresetView({ pins, onTogglePin }: { pins: Pin[]; onTogglePin: (p: Pin) => void }) {
  const dev = useDevice();
  const desktop = useMediaQuery('(min-width: 1000px)');
  const [lane, setLane] = useState(0);
  const [picked, setPicked] = useState<Pin | null>(null);
  const [picking, setPicking] = useState<{ row: number; column: number; replacing?: string } | null>(null);
  const [moving, setMoving] = useState<{ row: number; column: number; name: string } | null>(null);
  const [scenes, setScenes] = useState(false);
  const [laneSheet, setLaneSheet] = useState(false);
  const [error, setError] = useState<string>();
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  const grid = useMemo(
    () => (dev.preset ? buildGrid(dev.preset, dev.catalog, dev.selectedScene) : undefined),
    [dev.preset, dev.catalog, dev.selectedScene],
  );
  useEffect(() => setPicked(null), [lane]);

  if (!grid) {
    return (
      <div className="pad">
        <div className="card" role="status">
          <h2>Waiting for the current preset</h2>
          <p className="muted">The unit sends the loaded preset a few seconds after connecting (it can take up to about 25 seconds). You can already use the Library.</p>
        </div>
      </div>
    );
  }

  const row = grid[lane]!;
  const busy = dev.loadingPreset || dev.structuralPending;
  const pickedCell = picked && picked.row === lane ? row.cells[picked.column] : undefined;
  // On a desktop the inspector always has something to show: the picked block, else the first block in the lane.
  const selCell = pickedCell && !pickedCell.empty ? pickedCell : desktop ? row.cells.find((c) => !c.empty) : undefined;
  const isSel = (c: GridCell) => !!selCell && selCell.row === c.row && selCell.column === c.column && !c.empty;
  const isPinned = (c: GridCell) => pins.some((p) => samePin(p, c));

  const tap = (c: GridCell) => {
    setError(undefined);
    if (moving) {
      if (!c.empty) return;
      connection.store.moveBlock(moving.row, moving.column, c.row, c.column).catch(fail);
      setMoving(null);
      setPicked({ row: c.row, column: c.column });
      return;
    }
    if (c.empty) { setPicking({ row: c.row, column: c.column }); return; }
    setPicked(!desktop && picked && samePin(picked, c) ? null : { row: c.row, column: c.column });
  };
  const toggle = (c: GridCell) => connection.store.setBypass(c.row, c.column, !c.bypassed).catch(fail);
  const inspector = (c: GridCell, compact: boolean) => (
    <BlockInspector
      cell={c} compact={compact} pinned={isPinned(c)} onPin={() => onTogglePin({ row: c.row, column: c.column })}
      onReplace={() => setPicking({ row: c.row, column: c.column, replacing: c.name })}
      onMove={() => { setMoving({ row: c.row, column: c.column, name: c.name }); if (!desktop) setPicked(null); }}
      onRemove={() => { if (confirm(`Remove ${c.name}? This is live and unsaved until you save.`)) { connection.store.removeBlock(c.row, c.column).catch(fail); setPicked(null); } }}
    />
  );

  const laneBar = (
    <div className="lanebar">
      <div className="lanetabs" role="tablist" aria-label="Lanes">
        {[0, 1, 2, 3].map((i) => (
          <button key={i} role="tab" aria-selected={lane === i} className={lane === i ? 'on' : ''} onClick={() => setLane(i)}>Lane {i + 1}</button>
        ))}
      </div>
      <div className="lanetools">
        <span className="route">{inputLabel(row.inPort)} → {outputLabel(row.outPort)}</span>
        <button onClick={() => setLaneSheet(true)}>Lane settings</button>
        <button onClick={() => setScenes(true)}>Scenes</button>
      </div>
    </div>
  );
  const banners = (
    <>
      {moving && (
        <div className="movebar" role="status">
          <span>Choose an empty slot to move “{moving.name}” to. Other lanes: use the lane tabs.</span>
          <button onClick={() => setMoving(null)}>Cancel</button>
        </div>
      )}
      {error && <div className="errbar" role="alert">{error}</div>}
    </>
  );

  const list = (
    <div className={`chain ${busy ? 'loading' : ''}`}>
      {row.cells.map((c) => {
        const fam = familyOf(c.category);
        const style = { '--fam': fam.color } as CSSProperties;
        if (c.empty) {
          return (
            <div key={c.column} className={`blk empty ${moving ? 'target' : ''}`}>
              <div className="blk-row">
                <button className="blk-open" onClick={() => tap(c)} disabled={busy} aria-label={`Empty slot ${c.column + 1}, add a block`}>
                  <span className="col">{two(c.column + 1)}</span>
                  <span>{moving ? `Move “${moving.name}” here` : 'Add a block'}</span>
                </button>
              </div>
            </div>
          );
        }
        const open = isSel(c);
        return (
          <div key={c.column} className={`blk ${open ? 'sel' : ''} ${c.bypassed ? 'byp' : ''} ${c.unknown ? 'unknown' : ''}`} style={style}>
            <div className="blk-row">
              <button className="blk-open" onClick={() => tap(c)} aria-expanded={open} disabled={busy || !!moving}>
                <span className="col">{two(c.column + 1)}</span>
                <span className="meta">
                  <span className="fam">{fam.label}</span>
                  <span className="nm">{c.name}</span>
                  <span className="sum">{summary(c)}</span>
                </span>
              </button>
              <button className={`sw ${c.bypassed ? '' : 'on'}`} aria-pressed={!c.bypassed} aria-label={`${c.bypassed ? 'Turn on' : 'Bypass'} ${c.name}`} disabled={busy || !!moving} onClick={() => toggle(c)}>
                <span className="track"><i /></span>
              </button>
            </div>
            {open && <div className="inline-insp">{inspector(c, true)}</div>}
          </div>
        );
      })}
    </div>
  );

  const cards = (
    <div className={`cards ${busy ? 'loading' : ''}`}>
      {row.cells.map((c) => {
        if (c.empty) {
          return (
            <div key={c.column} className={`bcard emptycard ${moving ? 'target' : ''}`}>
              <button className="open" onClick={() => tap(c)} disabled={busy} aria-label={`Empty slot ${c.column + 1}, add a block`}>
                {moving ? 'Move here' : `${two(c.column + 1)} · Empty`}
              </button>
            </div>
          );
        }
        const fam = familyOf(c.category);
        const sel = isSel(c);
        const b = sel ? bars(c) : [];
        return (
          <div key={c.column} className={`bcard ${sel ? 'sel' : ''} ${c.bypassed ? 'byp' : ''}`} style={{ '--fam': fam.color } as CSSProperties}>
            <button className="open" onClick={() => tap(c)} aria-pressed={sel} disabled={busy || !!moving}>
              <span className="col">{two(c.column + 1)}</span>
              <span className="fam">{fam.label}</span>
              <span className="nm">{c.name}</span>
              <span className="foot">
                {b.map((v, i) => <span key={i} className="bar"><i style={{ width: `${Math.round(v * 100)}%` }} /></span>)}
                <span className="note">{c.bypassed ? (c.bypassPerScene ? 'Bypassed in this scene' : 'Bypassed') : sel ? '' : summary(c).split(' · ')[0]}</span>
              </span>
            </button>
            <button className={`sw ${c.bypassed ? '' : 'on'}`} aria-pressed={!c.bypassed} aria-label={`${c.bypassed ? 'Turn on' : 'Bypass'} ${c.name}`} disabled={busy || !!moving} onClick={() => toggle(c)}>
              <span className="track"><i /></span>
            </button>
          </div>
        );
      })}
    </div>
  );

  return (
    <>
      {desktop ? (
        <div className="preset">
          <div>
            {laneBar}
            {banners}
            {cards}
          </div>
          <aside className="inspector" aria-label="Block details">
            {selCell ? inspector(selCell, false) : <p className="insp-empty">Select a block to see and change its parameters.</p>}
          </aside>
        </div>
      ) : (
        <>
          {laneBar}
          {banners}
          {list}
        </>
      )}
      {picking && <BlockPicker {...picking} onClose={() => setPicking(null)} />}
      {scenes && <SceneSheet onClose={() => setScenes(false)} />}
      {laneSheet && <LaneSheet row={lane} onClose={() => setLaneSheet(false)} />}
    </>
  );
}
