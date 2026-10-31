import { useEffect } from 'react';
import { CC_VERSION, connection, useConnection } from '../connection';
import { Support } from './Support';

const REPO_URL = import.meta.env.VITE_REPO_URL as string | undefined;
/** Must match the hostname in index.html, where Google Analytics is loaded. */
const ANALYTICS_HOST = 'caique-lima.github.io';

export function ConnectScreen() {
  const c = useConnection();
  useEffect(() => { void connection.refreshGranted(); }, []);
  const busy = c.phase === 'connecting';

  return (
    <main className="page">
      <h1>Quad Cortex Web Editor</h1>
      <p className="muted">Unofficial — not affiliated with Neural DSP. Browse and edit presets, scenes, routing and settings over USB. Early software: try new features on a scratch preset.</p>

      <div className="card warn">
        <h2>Before you connect</h2>
        <ul>
          <li>Quit <b>Cortex Control</b> — it holds the USB connection exclusively.</li>
          <li>Plug in the Quad Cortex by USB and let it finish booting (about 20 s).</li>
          <li>Edits are applied <b>live on the unit</b> and are <b>not saved</b> until you press <i>Save</i>; <i>Discard</i> goes back to the saved version. Back up presets you care about with Cortex Control first.</li>
        </ul>
      </div>

      <div className="card">
        {c.granted && <button className="primary" disabled={busy} onClick={() => connection.connect(true)}>Connect</button>}
        <button className={c.granted ? '' : 'primary'} disabled={busy} onClick={() => connection.connect(false)}>
          {c.granted ? 'Choose another device…' : 'Connect Quad Cortex…'}
        </button>
        {busy && <p className="muted" role="status">{c.step}</p>}
        <p className="muted small">Announcing Cortex Control {CC_VERSION}. <a href="?demo" onClick={(e) => { e.preventDefault(); void connection.startDemo(); }}>Try the demo without a unit</a></p>
      </div>

      {c.error && <div className="card err" role="alert">{c.error}</div>}
      <p className="muted small">
        Free software under the GNU AGPL-3.0, built on community research into the Quad Cortex's USB protocol.
        {REPO_URL && <> <a href={REPO_URL} target="_blank" rel="noreferrer">Source code</a>.</>}
      </p>
      {location.hostname === ANALYTICS_HOST && (
        <p className="muted small">
          This site counts visits with Google Analytics (page views only). Nothing from your unit or your presets is sent: that stays in your browser.
        </p>
      )}
      <Support />
      {c.log.length > 0 && (
        <details className="card">
          <summary>Log</summary>
          <pre className="log">{c.log.join('\n')}</pre>
        </details>
      )}
    </main>
  );
}
