import { useEffect, useRef, useState } from 'react';
import { MAX_SCENE_LABEL, SCENE_COUNT } from '@qc/domain';
import { connection, useDevice } from '../connection';

/** Colours offered; the unit may snap to its own palette — whatever it confirms is what is shown. 0 = none. */
const PALETTE = [0xffe53935, 0xffff6a2b, 0xffffcc00, 0xff2ee64d, 0xff19f0d0, 0xff3a7bff, 0xff6a3dff, 0xffaa77ff, 0xffff1fa5, 0xffffffff, 0];
const css = (c: number | undefined) => (c && c >>> 24 !== 0 ? `#${(c & 0xffffff).toString(16).padStart(6, '0')}` : 'transparent');

export function SceneSheet({ onClose }: { onClose: () => void }) {
  const dev = useDevice();
  const preset = dev.preset;
  const [error, setError] = useState<string>();
  const [openColor, setOpenColor] = useState<number>();
  const [from, setFrom] = useState(0);
  const [to, setTo] = useState(1);
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label="Scenes" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head"><strong>Scenes</strong><button onClick={onClose}>Close</button></div>
        {(error || dev.lastError) && <div className="inline-err" role="alert">{error ?? dev.lastError}</div>}
        <div className="scenelist">
          {Array.from({ length: SCENE_COUNT }, (_, i) => (
            <div key={i} className="scenerow">
              <button className="swatch" style={{ background: css(preset?.sceneColors[i]) }} aria-label={`Scene ${i + 1} colour`} onClick={() => setOpenColor(openColor === i ? undefined : i)}>
                <span>{i + 1}</span>
              </button>
              <LabelField value={(preset?.sceneLabels[i] ?? '').trim()} index={i} onError={fail} />
              {openColor === i && (
                <div className="palette">
                  {PALETTE.map((c) => (
                    <button key={c} className="chip" style={{ background: css(c) }} aria-label={c ? css(c) : 'no colour'} onClick={() => { setOpenColor(undefined); connection.store.setSceneColor(i, c).catch(fail); }}>{c === 0 ? '∅' : ''}</button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="copyrow">
          <label className="field">From
            <select value={from} onChange={(e) => setFrom(Number(e.target.value))}>{Array.from({ length: 8 }, (_, i) => <option key={i} value={i}>{i + 1}</option>)}</select>
          </label>
          <label className="field">To
            <select value={to} onChange={(e) => setTo(Number(e.target.value))}>{Array.from({ length: 8 }, (_, i) => <option key={i} value={i}>{i + 1}</option>)}</select>
          </label>
          <button disabled={from === to} onClick={() => { if (confirm(`Copy scene ${from + 1} onto scene ${to + 1}? Scene ${to + 1} will be overwritten (unsaved until you save).`)) connection.store.copyScene(from, to, false).catch(fail); }}>Copy</button>
          <button disabled={from === to} onClick={() => connection.store.copyScene(from, to, true).catch(fail)}>Swap</button>
        </div>
        <p className="muted small">Copying also copies the scene’s name and colour. Changes are live and unsaved until you use Save.</p>
      </div>
    </div>
  );
}

/** Text field that commits on blur / Enter, and follows the unit's value when it changes. */
function LabelField({ value, index, onError }: { value: string; index: number; onError: (e: unknown) => void }) {
  const [text, setText] = useState(value);
  const sent = useRef<string | undefined>(undefined);
  useEffect(() => { setText(value); sent.current = undefined; }, [value]);
  const commit = () => {
    const t = text.trim();
    if (t === value || t === sent.current) return; // unchanged, or already sent and waiting for the unit's confirmation
    sent.current = t;
    connection.store.setSceneLabel(index, t).catch((e) => { sent.current = undefined; onError(e); });
  };
  return (
    <input type="text" value={text} maxLength={MAX_SCENE_LABEL} placeholder={`Scene ${index + 1}`} aria-label={`Scene ${index + 1} name`}
      onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') { commit(); (e.target as HTMLInputElement).blur(); } }} />
  );
}
