import type { CSSProperties } from 'react';
import { SCENE_COUNT } from '@qc/domain';
import { connection, useDevice } from '../connection';
import { sceneColor } from '../theme';

/** The eight scenes. A strip along the top on a phone, a list down the left on a desktop (the stylesheet decides). */
export function Scenes({ onError }: { onError: (e: unknown) => void }) {
  const dev = useDevice();
  const preset = dev.preset;
  return (
    <>
      <div className="side-label">Scenes</div>
      <div className="scenes" role="group" aria-label="Scenes">
        {Array.from({ length: SCENE_COUNT }, (_, i) => {
          const label = preset?.sceneLabels[i]?.trim();
          return (
            <button
              key={i}
              className={`scene ${dev.selectedScene === i ? 'on' : ''}`}
              style={{ '--sc': sceneColor(preset?.sceneColors[i]) } as CSSProperties}
              disabled={!preset}
              aria-pressed={dev.selectedScene === i}
              onClick={() => connection.store.selectScene(i).catch(onError)}
              title={label || `Scene ${i + 1}`}
            >
              <i />
              <b>{i + 1}</b>
              <span>{label || `Scene ${i + 1}`}</span>
            </button>
          );
        })}
      </div>
    </>
  );
}
