import { useState } from 'react';
import qr from '../assets/bmc-qr.png';

const SUPPORT_URL = 'https://buymeacoffee.com/caiquelima';

/** A small, optional "support the project" block. Collapsed by default; the QR image isn't even requested until it is opened. */
export function Support() {
  const [opened, setOpened] = useState(false);
  return (
    <details className="support" onToggle={(e) => { if (e.currentTarget.open) setOpened(true); }}>
      <summary>Support this project</summary>
      <p className="small">
        This is a free, open-source hobby project. If it saved you a trip back to the computer, you can buy its author a coffee.
        It's entirely optional.
      </p>
      <div className="supportbody">
        <a className="coffee" href={SUPPORT_URL} target="_blank" rel="noreferrer">Buy me a coffee</a>
        {opened && <img src={qr} width={140} height={140} decoding="async" alt={`QR code for ${SUPPORT_URL}`} />}
      </div>
    </details>
  );
}
