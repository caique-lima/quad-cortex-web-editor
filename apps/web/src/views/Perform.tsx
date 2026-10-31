import { useMemo, type CSSProperties } from 'react';
import { SCENE_COUNT, buildGrid, masterVolumeShown, neighbourSlot, slotLabel, type GridCell, type Slot } from '@qc/domain';
import { connection, useDevice } from '../connection';
import { useWakeLock } from '../hooks';
import { defaultPins, type Pin } from '../perform';
import { familyOf, sceneColor } from '../theme';

/** Stage mode: big targets, nothing that edits the preset. Scenes, a few pinned on/off buttons, master volume, previous/next preset. */
export function Perform({ pins, onError }: { pins: Pin[]; onError: (e: unknown) => void }) {
  const dev = useDevice();
  useWakeLock(true);
  const preset = dev.preset;
  const grid = useMemo(() => (preset ? buildGrid(preset, dev.catalog, dev.selectedScene) : undefined), [preset, dev.catalog, dev.selectedScene]);
  const chosen = pins.length > 0 ? pins : grid ? defaultPins(grid) : [];
  const pinCells = chosen.map((p) => grid?.[p.row]?.cells[p.column]).filter((c): c is GridCell => !!c && !c.empty);

  const pos = dev.position;
  const folder = pos ? dev.folders.get(pos.folderKey) : undefined;
  const prev = pos ? neighbourSlot(folder, pos.position, -1) : undefined;
  const next = pos ? neighbourSlot(folder, pos.position, 1) : undefined;
  const go = (slot: Slot | undefined) => {
    if (!slot || !pos || !folder) return;
    if (dev.dirty && !confirm('The current preset has unsaved changes. Loading another preset discards them. Continue?')) return;
    connection.store.recallSlot(folder, slot).catch(onError);
  };
  const vol = dev.io.masterVolume;

  return (
    <div className="perform">
      <div className="pf-scenes" role="group" aria-label="Scenes">
        {Array.from({ length: SCENE_COUNT }, (_, i) => (
          <button
            key={i}
            className={`pf-scene ${dev.selectedScene === i ? 'on' : ''}`}
            style={{ '--sc': sceneColor(preset?.sceneColors[i]) } as CSSProperties}
            disabled={!preset}
            aria-pressed={dev.selectedScene === i}
            onClick={() => connection.store.selectScene(i).catch(onError)}
          >
            <b>{i + 1}</b>
            <span>{preset?.sceneLabels[i]?.trim() || `Scene ${i + 1}`}</span>
          </button>
        ))}
      </div>

      <div className="pf-right">
        <div>
          <div className="pf-label">Pinned</div>
          {pinCells.length === 0 ? (
            <p className="pf-hint">Nothing pinned. In Edit mode, open a block and choose “Pin to Perform”.</p>
          ) : (
            <div className="pf-pins">
              {pinCells.map((c) => (
                <button
                  key={`${c.row}:${c.column}`}
                  className={`pf-pin ${c.bypassed ? '' : 'on'}`}
                  style={{ '--fam': familyOf(c.category).color } as CSSProperties}
                  aria-pressed={!c.bypassed}
                  onClick={() => connection.store.setBypass(c.row, c.column, !c.bypassed).catch(onError)}
                >
                  <b>{c.name}</b>
                  <span>{c.bypassed ? 'Bypassed' : 'On'}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div>
          <div className="pf-label">Master volume</div>
          {vol === undefined ? <p className="pf-hint">The unit has not reported its master volume.</p> : (
            <div className="pf-vol">
              <button aria-label="Master volume down" onClick={() => connection.store.nudgeMasterVolume(-0.02).catch(onError)}>−</button>
              <div className="mid">
                <div className="big">{masterVolumeShown(vol)}</div>
                <div className="meter"><i style={{ width: `${Math.round(vol * 100)}%` }} /></div>
              </div>
              <button aria-label="Master volume up" onClick={() => connection.store.nudgeMasterVolume(0.02).catch(onError)}>+</button>
            </div>
          )}
        </div>

        <div className="pf-nav">
          <button disabled={!prev} title={prev?.name} onClick={() => go(prev)}>Previous{prev ? ` · ${slotLabel(prev.index)}` : ''}</button>
          <button disabled={!next} title={next?.name} onClick={() => go(next)}>Next{next ? ` · ${slotLabel(next.index)}` : ''}</button>
        </div>
      </div>
    </div>
  );
}
