import type { CSSProperties } from 'react';
import { type GridParam } from '@qc/domain';
import { optionNames, optionToWire, optionCount, stepWire } from '@qc/protocol';

/** One parameter: name, shown value, and — when it can be converted safely — a slider with ± buttons or a list dropdown. */
export function ParamControl({ p, label, disabled, onSet, onNudge, onError }: {
  p: GridParam;
  label: string;
  disabled: boolean;
  onSet: (wire: number) => Promise<void>;
  onNudge: (next: (wire: number) => number | undefined) => Promise<void>;
  onError: (e: unknown) => void;
}) {
  const meta = p.meta;
  const wire = typeof p.value === 'number' ? p.value : undefined;
  const editable = meta !== undefined && wire !== undefined && p.display.converted && meta.type !== 'string' && meta.type !== 'int';
  const nOptions = meta ? optionCount(meta) : undefined;
  const step = meta?.steps && meta.steps > 1 ? 1 / (meta.steps - 1) : 0.005;
  const set = (w: number) => onSet(Math.min(1, Math.max(0, w))).catch(onError);
  const nudge = (dir: 1 | -1) => meta && onNudge((w) => stepWire(meta, w, dir)).catch(onError);

  return (
    <div className="param">
      <div className="paramhead">
        <span>{p.name ?? `#${p.index}`}{p.sceneMode && <small className="muted"> · per scene</small>}{p.expression ? <small className="muted"> · exp {p.expression}</small> : null}</span>
        <b title={wire !== undefined ? `wire ${wire}` : undefined}>{p.display.text}{!p.display.converted && meta && <small className="muted"> ⚠</small>}</b>
      </div>
      {editable && nOptions !== undefined && (
        <select disabled={disabled} value={p.display.option ?? 0} aria-label={label}
          onChange={(e) => { try { set(optionToWire(meta!, Number(e.target.value))); } catch (err) { onError(err); } }}>
          {optionNames(meta!).map((o, i) => <option key={i} value={i}>{o}</option>)}
        </select>
      )}
      {editable && nOptions === undefined && (
        <div className="slider">
          <button disabled={disabled} aria-label={`${label} down`} onClick={() => nudge(-1)}>−</button>
          <input type="range" min={0} max={1} step={step} value={wire} disabled={disabled} aria-label={label} style={{ '--pct': `${Math.round((wire ?? 0) * 100)}%` } as CSSProperties} onChange={(e) => set(Number(e.target.value))} />
          <button disabled={disabled} aria-label={`${label} up`} onClick={() => nudge(1)}>+</button>
        </div>
      )}
    </div>
  );
}
