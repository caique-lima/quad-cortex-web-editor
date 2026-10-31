import { useState } from 'react';
import { INPUT_LEVEL_STEP, inputLabel, inputLevelToDb, masterVolumeShown, outputLabel } from '@qc/domain';
import { connection, useDevice } from '../connection';

/** Global input/output settings and master volume. These belong to the unit, not to a preset, and apply immediately. */
export function Settings() {
  const dev = useDevice();
  const [error, setError] = useState<string>();
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  const { inputs, outputs, masterVolume } = dev.io;
  const inList = [...inputs.values()].sort((a, b) => a.id - b.id);
  const outList = [...outputs.values()].sort((a, b) => a.id - b.id);
  const st = connection.store;

  return (
    <div className="stack">
      <div className="card warn small">
        These are the unit's <b>global</b> settings, not part of a preset. They take effect immediately and there is nothing to save.
        Raising an input gain or an output level can be loud: change it in small steps.
      </div>
      {(error || dev.lastError) && <div className="inline-err" role="alert">{error ?? dev.lastError}</div>}

      <div className="card">
        <h2>Master volume</h2>
        {masterVolume === undefined ? <p className="muted">The unit has not reported it yet.</p> : (
          <Level label="Master volume" shown={`${masterVolumeShown(masterVolume)}`} value={masterVolume} step={0.01}
            onSet={(v) => st.setMasterVolume(v).catch(fail)} onNudge={(d) => st.nudgeMasterVolume(d).catch(fail)} />
        )}
      </div>

      <div className="card">
        <h2>Inputs</h2>
        {inList.length === 0 && <p className="muted">The unit has not reported its inputs yet.</p>}
        {inList.map((p) => (
          <div key={p.id} className="iorow">
            <div className="paramhead"><span>{inputLabel(p.id)}{p.plugged === false && <small className="muted"> · nothing plugged in</small>}</span></div>
            {p.level !== undefined && (
              <Level label={`${inputLabel(p.id)} gain`} shown={`${inputLevelToDb(p.level) >= 0 ? '+' : ''}${inputLevelToDb(p.level).toFixed(1)} dB`} value={p.level} step={INPUT_LEVEL_STEP}
                onSet={(v) => st.setIo('in.level', p.id, v).catch(fail)} onNudge={(d) => st.nudgeIo('in.level', p.id, d).catch(fail)} />
            )}
            {p.groundLift !== undefined && (
              <label className="check"><input type="checkbox" checked={p.groundLift} onChange={(e) => st.setIo('in.groundLift', p.id, e.target.checked).catch(fail)} /> Ground lift</label>
            )}
          </div>
        ))}
      </div>

      <div className="card">
        <h2>Outputs</h2>
        {outList.length === 0 && <p className="muted">The unit has not reported its outputs yet.</p>}
        {outList.map((p) => (
          <div key={p.id} className="iorow">
            <div className="paramhead"><span>{outputLabel(p.id)}{p.plugged === false && <small className="muted"> · nothing plugged in</small>}</span></div>
            {p.level !== undefined && (
              <Level label={`${outputLabel(p.id)} level`} shown={`${Math.round(p.level * 100)}% of travel`} value={p.level} step={0.01}
                onSet={(v) => st.setIo('out.level', p.id, v).catch(fail)} onNudge={(d) => st.nudgeIo('out.level', p.id, d).catch(fail)} />
            )}
            <div className="actions">
              {p.mute !== undefined && <label className="check"><input type="checkbox" checked={p.mute} onChange={(e) => st.setIo('out.mute', p.id, e.target.checked).catch(fail)} /> Mute</label>}
              {p.groundLift !== undefined && <label className="check"><input type="checkbox" checked={p.groundLift} onChange={(e) => st.setIo('out.groundLift', p.id, e.target.checked).catch(fail)} /> Ground lift</label>}
            </div>
          </div>
        ))}
        <p className="muted small">Output levels are shown as a position on the knob: the unit's dB scale for outputs isn't known.</p>
      </div>
    </div>
  );
}

function Level({ label, shown, value, step, onSet, onNudge }: { label: string; shown: string; value: number; step: number; onSet: (v: number) => void; onNudge: (delta: number) => void }) {
  return (
    <div className="param">
      <div className="paramhead"><span className="muted small">{label}</span><b>{shown}</b></div>
      <div className="slider">
        <button aria-label={`${label} down`} onClick={() => onNudge(-step)}>−</button>
        <input type="range" min={0} max={1} step={step} value={value} aria-label={label} onChange={(e) => onSet(Number(e.target.value))} />
        <button aria-label={`${label} up`} onClick={() => onNudge(step)}>+</button>
      </div>
    </div>
  );
}
