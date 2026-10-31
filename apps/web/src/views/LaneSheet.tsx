import { useState } from 'react';
import { INPUT_PORTS, OUTPUT_PORTS, buildLaneControls, inputLabel, lanesFeeding, outputLabel, readLanePort, type GridParam, type LaneSide, type ParamTarget, type PortOption } from '@qc/domain';
import { ParamControl } from './ParamControl';
import { connection, useDevice } from '../connection';

/** Pick where a lane (grid row) takes its signal from and where it sends it. Only ports the unit defines are offered. */
export function LaneSheet({ row, onClose }: { row: number; onClose: () => void }) {
  const dev = useDevice();
  const [error, setError] = useState<string>();
  const preset = dev.preset;
  const inId = preset ? readLanePort(preset, row, 'in') : undefined;
  const outId = preset ? readLanePort(preset, row, 'out') : undefined;
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  const set = (side: LaneSide, id: number) => { setError(undefined); connection.store.setLanePort(row, side, id).catch(fail); };
  const locked = dev.loadingPreset || !preset;
  const lc = preset ? buildLaneControls(preset, dev.catalog, row, dev.selectedScene) : undefined;
  const feeders = preset ? lanesFeeding(row, (l) => readLanePort(preset, l, 'out')) : [];
  // Stored input 0 only means "no jack feeds this lane". Say what is actually going on, so the text can't go stale
  // when another lane's output changes.
  const inputOptions = INPUT_PORTS.map((o) => (o.id === 0 ? { ...o, label: feeders.length ? `From lane ${feeders.map((l) => l + 1).join(' and ')} (internal)` : 'None (no jack, no lane)' } : o));

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label={`Lane ${row + 1} routing`} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <div><strong>Lane {row + 1} routing</strong><div className="muted small">Where this row takes its signal from, and where it goes.</div></div>
          <button onClick={onClose}>Close</button>
        </div>
        {(error || dev.lastError) && <div className="inline-err" role="alert">{error ?? dev.lastError}</div>}
        <PortSelect label="Input" value={inId} options={inputOptions} describe={inputLabel} disabled={locked} onChange={(id) => set('in', id)} />
        {inId === 0 && (
          <p className="muted small" style={{ marginTop: -4 }}>
            {feeders.length
              ? `Lane ${feeders.map((l) => l + 1).join(' and ')}'s output is routed here (${feeders.map((l) => `“${outputLabel(readLanePort(preset!, l, 'out'))}”`).join(', ')}). The unit stores that as an internal input.`
              : 'Nothing feeds this lane: no jack is selected and no other lane is routed to it.'}
          </p>
        )}
        <PortSelect label="Output" value={outId} options={OUTPUT_PORTS} describe={outputLabel} disabled={locked} onChange={(id) => set('out', id)} />
        {lc && (
          <>
            <Section title="Input gate" params={lc.inputGate} target={{ kind: 'laneIn', row }} disabled={locked} onError={fail} />
            <Section title="Lane output level" params={lc.output} target={{ kind: 'laneOut', row }} disabled={locked} onError={fail} />
            {row % 2 === 0 && (
              <>
                <Branch row={row} split={lc.split} mix={lc.mix} disabled={locked} onError={fail} />
                {lc.split !== undefined && lc.split >= 0 && (
                  <>
                    <Section title="Splitter" params={lc.splitter} target={{ kind: 'splitter', row }} disabled={locked} onError={fail} />
                    <Section title="Mixer" params={lc.mixer} target={{ kind: 'mixer', row }} disabled={locked} onError={fail} />
                  </>
                )}
              </>
            )}
          </>
        )}
        <p className="muted small">
          An output set to “Unrouted” (or an input that nothing feeds) makes the lane silent. Changes are live and <b>not saved</b> —
          use Discard in the header to undo, or Save to keep them.
        </p>
      </div>
    </div>
  );
}

function PortSelect({ label, value, options, describe, disabled, onChange }: {
  label: string; value: number | undefined; options: readonly PortOption[]; describe: (id: number | undefined) => string;
  disabled: boolean; onChange: (id: number) => void;
}) {
  const groups = [...new Set(options.map((o) => o.group))];
  const known = value !== undefined && options.some((o) => o.id === value);
  return (
    <label className="field">{label}
      <select value={value ?? ''} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} aria-label={label}>
        {/* A value we don't recognise (new firmware, internal source) is shown truthfully but can't be chosen again. */}
        {value !== undefined && !known && <option value={value} disabled>{describe(value)}</option>}
        {value === undefined && <option value="" disabled>Not set</option>}
        {groups.map((g) => (
          <optgroup key={g} label={g}>
            {options.filter((o) => o.group === g).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </optgroup>
        ))}
      </select>
    </label>
  );
}

function Section({ title, params, target, disabled, onError }: { title: string; params: GridParam[]; target: ParamTarget; disabled: boolean; onError: (e: unknown) => void }) {
  const shown = params.filter((p) => !p.hidden);
  if (shown.length === 0) return null;
  return (
    <div className="lanesection">
      <h3>{title}</h3>
      <div className="params">
        {shown.map((p) => {
          const label = `${title} ${p.name ?? `#${p.index}`}`;
          return (
            <ParamControl key={p.index} p={p} label={label} disabled={disabled} onError={onError}
              onSet={(w) => connection.store.setControlParam(target, p.index, w, label)}
              onNudge={(next) => connection.store.nudgeControlParam(target, p.index, next, label)} />
          );
        })}
      </div>
    </div>
  );
}

/** Where this lane branches into the lane below it, and where the branch rejoins. */
function Branch({ row, split, mix, disabled, onError }: { row: number; split: number | undefined; mix: number | undefined; disabled: boolean; onError: (e: unknown) => void }) {
  const sp = split ?? -1;
  const mx = mix ?? -1;
  const go = (s: number, m: number) => connection.store.setSplit(row, s, m).catch(onError);
  const cols = Array.from({ length: 8 }, (_, i) => i);
  return (
    <div className="lanesection">
      <h3>Parallel path</h3>
      <p className="muted small" style={{ marginTop: 0 }}>Lane {row + 2} becomes this lane's parallel path between the two columns. Setting a branch takes over lane {row + 2}.</p>
      <div className="slotpick">
        <label className="field">Splits at
          <select value={sp} disabled={disabled} aria-label="Split column" onChange={(e) => {
            const v = Number(e.target.value);
            go(v, v === -1 ? -1 : mx > v ? mx : v < 7 ? 7 : -1);
          }}>
            <option value={-1}>No branch</option>
            {cols.map((c) => <option key={c} value={c}>Column {c + 1}</option>)}
          </select>
        </label>
        <label className="field">Rejoins at
          <select value={mx} disabled={disabled || sp < 0} aria-label="Mix column" onChange={(e) => go(sp, Number(e.target.value))}>
            <option value={-1}>Never</option>
            {cols.filter((c) => c > sp).map((c) => <option key={c} value={c}>Column {c + 1}</option>)}
          </select>
        </label>
      </div>
    </div>
  );
}
