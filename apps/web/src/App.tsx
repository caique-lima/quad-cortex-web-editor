import { useEffect, useMemo, useState } from 'react';
import { buildGrid, slotLabel } from '@qc/domain';
import { isWebHidSupported } from '@qc/transport-webhid';
import { connection, useConnection, useDevice } from './connection';
import { useMediaQuery } from './hooks';
import { defaultPins, loadPins, MAX_PINS, samePin, savePins, type Pin } from './perform';
import { ConnectScreen } from './views/Connect';
import { Diagnostics } from './views/Diagnostics';
import { Library } from './views/Library';
import { Perform } from './views/Perform';
import { PresetView } from './views/PresetView';
import { SaveSheet } from './views/SaveSheet';
import { Scenes } from './views/Scenes';
import { Settings } from './views/Settings';

type Tab = 'preset' | 'library' | 'settings' | 'diagnostics';
type Mode = 'edit' | 'perform';
const TABS: Array<[Tab, string]> = [['preset', 'Preset'], ['library', 'Library'], ['settings', 'Settings'], ['diagnostics', 'Diagnostics']];

export function App() {
  const conn = useConnection();
  if (!isWebHidSupported() && conn.phase !== 'connected') {
    return (
      <main className="page">
        <h1>Quad Cortex Web Editor</h1>
        <div className="card err">
          <h2>WebHID is not available in this browser</h2>
          Direct USB mode needs desktop Chrome, Edge or Opera (not Safari or Firefox, and not iOS/Android). A bridge for phones and tablets is planned.
        </div>
      </main>
    );
  }
  if (conn.phase !== 'connected') return <ConnectScreen />;
  return <Shell />;
}

const Undo = () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="square" aria-hidden="true"><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></svg>;
const Redo = () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="square" aria-hidden="true"><path d="m15 14 5-5-5-5" /><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" /></svg>;

function Shell() {
  const dev = useDevice();
  const desktop = useMediaQuery('(min-width: 1000px)');
  const [tab, setTab] = useState<Tab>('preset');
  const [mode, setMode] = useState<Mode>(() => {
    try { return localStorage.getItem('qc.mode') === 'perform' ? 'perform' : 'edit'; } catch { return 'edit'; }
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  const chooseMode = (m: Mode) => { setMode(m); setError(undefined); try { localStorage.setItem('qc.mode', m); } catch { /* not persisted */ } };

  const preset = dev.preset;
  const slot = dev.position ? slotLabel(dev.position.position) : undefined;
  const folderName = dev.position ? dev.folders.get(dev.position.folderKey)?.name : undefined;
  const discard = () => { if (confirm('Discard all unsaved changes and reload this preset from the unit?')) connection.store.discardChanges().catch(fail); };

  // Pinned blocks (for Perform mode) are remembered per preset slot in this browser.
  const slotKey = dev.position ? `${dev.position.folderKey}|${dev.position.position}` : 'unknown';
  const [savedPins, setSavedPins] = useState<Pin[] | undefined>(() => loadPins(slotKey));
  useEffect(() => setSavedPins(loadPins(slotKey)), [slotKey]);
  const grid = useMemo(() => (preset ? buildGrid(preset, dev.catalog, dev.selectedScene) : undefined), [preset, dev.catalog, dev.selectedScene]);
  const pins = savedPins ?? (grid ? defaultPins(grid) : []);
  const togglePin = (p: Pin) => {
    const next = pins.some((q) => samePin(q, p)) ? pins.filter((q) => !samePin(q, p)) : [...pins, p].slice(-MAX_PINS);
    setSavedPins(next);
    savePins(slotKey, next);
  };

  const canEdit = !!preset && !dev.loadingPreset;
  const err = error ?? dev.lastError;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="tb-title">
          <strong>{dev.loadingPreset ? 'Loading…' : (preset?.name ?? '—')}</strong>
          <span>{[slot, folderName].filter(Boolean).join(' · ')}{mode === 'edit' && dev.dirty && <> · <span className="unsaved" style={{ display: 'inline' }}>Unsaved</span></>}</span>
        </div>
        <div className="tb-actions">
          {mode === 'edit' ? (
            <>
              <button className="icon" aria-label="Undo" disabled={!dev.undoCount || !canEdit} onClick={() => connection.store.undo().catch(fail)}><Undo /></button>
              <button className="icon" aria-label="Redo" disabled={!dev.redoCount || !canEdit} onClick={() => connection.store.redo().catch(fail)}><Redo /></button>
              {desktop && dev.dirty && <button onClick={discard}>Discard</button>}
              <button className="primary" disabled={!canEdit} onClick={() => setSaving(true)}>Save</button>
            </>
          ) : (
            <div className="tb-status"><i />Connected</div>
          )}
        </div>
        <div className="mode" role="group" aria-label="Mode">
          <button className={mode === 'edit' ? 'on' : ''} aria-pressed={mode === 'edit'} onClick={() => chooseMode('edit')}>Edit</button>
          <button className={mode === 'perform' ? 'on' : ''} aria-pressed={mode === 'perform'} onClick={() => chooseMode('perform')}>Perform</button>
        </div>
      </header>

      {mode === 'edit' && !desktop && dev.dirty && (
        <div className="dirtybar"><span>Unsaved changes on the unit</span><button onClick={discard}>Discard</button></div>
      )}
      {err && <div className="errbar" role="alert">{err}</div>}

      {mode === 'perform' ? (
        <div className="body perform-body">
          <main className="main"><Perform pins={savedPins ?? []} onError={fail} /></main>
        </div>
      ) : (
        <div className="body">
          <aside className="side">
            <Scenes onError={fail} />
            <nav className="nav" aria-label="Sections">
              {TABS.map(([t, label]) => (
                <button key={t} className={tab === t ? 'on' : ''} aria-current={tab === t ? 'page' : undefined} onClick={() => setTab(t)}>{label}</button>
              ))}
            </nav>
          </aside>
          <main className="main">
            {tab === 'preset' && <PresetView pins={pins} onTogglePin={togglePin} />}
            {tab === 'library' && <div className="pad"><Library onLoaded={() => setTab('preset')} /></div>}
            {tab === 'settings' && <div className="pad"><Settings /></div>}
            {tab === 'diagnostics' && <div className="pad"><Diagnostics /></div>}
          </main>
        </div>
      )}

      {saving && <SaveSheet onClose={() => setSaving(false)} />}
    </div>
  );
}
