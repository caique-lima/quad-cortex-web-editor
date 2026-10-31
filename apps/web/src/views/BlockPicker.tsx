import { useMemo, useState } from 'react';
import { placeRefusal } from '@qc/domain';
import { connection, useDevice } from '../connection';

const MAX_SHOWN = 80;

/** Choose a block for a cell. Only models the guard allows are listed (no Neural Capture, no internal blocks). */
export function BlockPicker({ row, column, replacing, onClose }: { row: number; column: number; replacing?: string; onClose: () => void }) {
  const dev = useDevice();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [error, setError] = useState<string>();

  const models = useMemo(
    () => [...(dev.catalog?.models.values() ?? [])].filter((m) => placeRefusal(dev.catalog, m.id) === undefined),
    [dev.catalog],
  );
  const categories = useMemo(() => [...new Set(models.map((m) => m.category))].sort(), [models]);
  const q = query.trim().toLowerCase();
  const shown = models
    .filter((m) => (!category || m.category === category) && (!q || m.name.toLowerCase().includes(q) || m.basedOn.toLowerCase().includes(q)))
    .sort((a, b) => a.name.localeCompare(b.name));

  const pick = async (id: number) => {
    setError(undefined);
    try { await connection.store.placeBlock(row, column, id); onClose(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label="Choose a block" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <div>
            <strong>{replacing ? `Replace ${replacing}` : 'Add a block'}</strong>
            <div className="muted small">row {row + 1}, column {column + 1}</div>
          </div>
          <button onClick={onClose}>Cancel</button>
        </div>
        {!dev.catalog && <div className="inline-err">The unit has not sent its block list yet.</div>}
        <input type="search" placeholder="Search blocks or the gear they are based on" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search blocks" />
        <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
          <option value="">All categories ({models.length})</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        {error && <div className="inline-err" role="alert">{error}</div>}
        <ul className="results picker">
          {shown.slice(0, MAX_SHOWN).map((m) => (
            <li key={m.id}>
              <button onClick={() => pick(m.id)}>
                <b>{m.name}</b>
                <small className="muted">{[m.category, m.basedOn].filter(Boolean).join(' · ')}</small>
              </button>
            </li>
          ))}
        </ul>
        {shown.length > MAX_SHOWN && <p className="muted small">Showing {MAX_SHOWN} of {shown.length}. Narrow it with the search or a category.</p>}
        {shown.length === 0 && dev.catalog && <p className="muted">No blocks match.</p>}
        <p className="muted small">Placing a block can be refused by the unit if the preset runs out of processing power. You will be told if so.</p>
      </div>
    </div>
  );
}
