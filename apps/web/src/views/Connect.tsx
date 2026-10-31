import { useEffect } from 'react';
import { CC_VERSION, connection, useConnection } from '../connection';

const REPO_URL = import.meta.env.VITE_REPO_URL as string | undefined;

export function ConnectScreen() {
  const c = useConnection();
  useEffect(() => { void connection.refreshGranted(); }, []);
  const busy = c.phase === 'connecting';

  return (
    <main className="page">
      <h1>Quad Cortex Web Editor</h1>
      <p className="muted">Unofficial — not affiliated with Neural DSP. Early version: browse presets, load them and switch scenes.</p>

      <div className="card warn">
        <h2>Before you connect</h2>
        <ul>
          <li>Quit <b>Cortex Control</b> — it holds the USB connection exclusively.</li>
          <li>Plug in the Quad Cortex by USB and let it finish booting (about 20 s).</li>
          <li>This page only reads from the unit, except <i>Load preset</i> and <i>scene</i> switching, which do what the unit's own screen does. Nothing is saved.</li>
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
      {c.log.length > 0 && (
        <details className="card">
          <summary>Log</summary>
          <pre className="log">{c.log.join('\n')}</pre>
        </details>
      )}
    </main>
  );
}
