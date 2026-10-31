import { useState } from 'react';
import { isWebHidSupported } from '@qc/transport-webhid';
import { SCENE_COUNT } from '@qc/domain';
import { connection, useConnection, useDevice } from './connection';
import { ConnectScreen } from './views/Connect';
import { Diagnostics } from './views/Diagnostics';
import { Library } from './views/Library';
import { Settings } from './views/Settings';
import { SaveSheet } from './views/SaveSheet';
import { PresetView } from './views/PresetView';
import { slotLabel } from '@qc/domain';

type Tab = 'preset' | 'library' | 'settings' | 'diagnostics';

export function App() {
  const conn = useConnection();
  if (!isWebHidSupported() && conn.phase !== 'connected') {
    return (
      <main className="page">
        <h1>Quad Cortex Web Editor</h1>
        <div className="card err">
          <h2>WebHID is not available in this browser</h2>
          Direct USB mode needs desktop Chrome, Edge or Opera (not Safari or Firefox, and not iOS/Android). Bridge mode for phones and tablets is planned.
        </div>
      </main>
    );
  }
  if (conn.phase !== 'connected') return <ConnectScreen />;
  return <Shell />;
}

function sceneColor(c: number | undefined): string | undefined {
  return c && c >>> 24 !== 0 ? `#${(c & 0xffffff).toString(16).padStart(6, '0')}` : undefined;
}

function Shell() {
  const [tab, setTab] = useState<Tab>('preset');
  const dev = useDevice();
  const [sceneError, setSceneError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const preset = dev.preset;
  const slot = dev.position ? `${slotLabel(dev.position.position)}` : undefined;
  const folderName = dev.position ? dev.folders.get(dev.position.folderKey)?.name : undefined;

  return (
    <div className="shell">
      <header className="top">
        <div className="titlerow">
          <div className="title">
            <strong>{dev.loadingPreset ? 'Loading…' : (preset?.name ?? '—')}</strong>
            <span className="muted">{[slot, folderName].filter(Boolean).join(' · ')}</span>
          </div>
          {preset && (
            <span className="dirty">
              {dev.dirty && <span className="badge warn">unsaved</span>}
              <button className={dev.dirty ? 'primary' : ''} disabled={dev.loadingPreset} onClick={() => setSaving(true)}>Save…</button>
              {dev.dirty && (
              <button onClick={() => { if (confirm('Discard all unsaved changes and reload this preset from the unit?')) connection.store.discardChanges().catch((e) => setSceneError(String(e))); }}>Discard</button>)}
            </span>
          )}
        </div>
        <div className="scenes" role="group" aria-label="Scenes">
          {Array.from({ length: SCENE_COUNT }, (_, i) => {
            const label = preset?.sceneLabels[i]?.trim();
            const color = sceneColor(preset?.sceneColors[i]);
            return (
              <button
                key={i}
                className={`scene ${dev.selectedScene === i ? 'on' : ''}`}
                disabled={!preset}
                onClick={() => connection.store.selectScene(i).catch((e) => setSceneError(String(e)))}
                title={label || `Scene ${i + 1}`}
              >
                {color && <i style={{ background: color }} />}
                <b>{i + 1}</b>
                {label && <small>{label}</small>}
              </button>
            );
          })}
        </div>
        {(sceneError || dev.lastError) && <div className="inline-err">{sceneError ?? dev.lastError}</div>}
      </header>

      <main className="content">
        {tab === 'preset' && <PresetView />}
        {tab === 'library' && <Library onLoaded={() => setTab('preset')} />}
        {tab === 'settings' && <Settings />}
        {tab === 'diagnostics' && <Diagnostics />}
      </main>

      {saving && <SaveSheet onClose={() => setSaving(false)} />}

      <nav className="tabs">
        {(['preset', 'library', 'settings', 'diagnostics'] as const).map((t) => (
          <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
            {t === 'preset' ? 'Preset' : t === 'library' ? 'Library' : t === 'settings' ? 'Settings' : 'Diagnostics'}
          </button>
        ))}
      </nav>
    </div>
  );
}
