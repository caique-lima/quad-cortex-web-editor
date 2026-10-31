import { useSyncExternalStore } from 'react';
import { Session, TimeoutError, type InboundMessage } from '@qc/protocol';
import { DeviceStore, type DeviceState } from '@qc/domain';
import { addSnapshot } from './snapshots';
import {
  WebHidTransport, describeDevice, grantedQuadCortexes, looksLikeControlInterface, requestQuadCortex,
} from '@qc/transport-webhid';

/** Cortex Control version we announce. CorOS 4.1.0 rejects "4.0.1" (GenericError VERSION_IS_OLDER). Override with ?cc= */
export const CC_VERSION = new URLSearchParams(location.search).get('cc') ?? '4.1.0';

export type Phase = 'disconnected' | 'connecting' | 'connected';

export interface ConnState {
  phase: Phase;
  step?: string;
  error?: string;
  log: readonly string[];
  counts: Readonly<Record<string, number>>;
  writeErrors: number;
  /** A device the user already granted to this origin (allows one-tap reconnect without the picker). */
  granted: boolean;
}

const LOG_LIMIT = 400;
// Chatty types (GlobalTempo's metronome clock, ~9/s) would flood the log: show only the first few of each; counts cover the rest.
const LOG_FIRST_N: Record<string, number> = { GlobalTempo: 3, KeepAlive: 3, File: 5, ModuleStats: 3 };
const LOG_DEFAULT_N = 40;

class Connection {
  readonly store = new DeviceStore({ snapshotSink: addSnapshot });
  private state: ConnState = { phase: 'disconnected', log: [], counts: {}, writeErrors: 0, granted: false };
  private listeners = new Set<() => void>();
  private session?: Session;
  private transport?: WebHidTransport;
  private seen: Record<string, number> = {};
  private counts: Record<string, number> = {};
  private log: string[] = [];
  private detach?: () => void;
  private timer?: ReturnType<typeof setTimeout>;

  subscribe = (cb: () => void) => { this.listeners.add(cb); return () => this.listeners.delete(cb); };
  getSnapshot = () => this.state;

  private addLog(line: string) {
    this.log.push(`${new Date().toISOString().slice(11, 23)} ${line}`);
    if (this.log.length > LOG_LIMIT) this.log.splice(0, this.log.length - LOG_LIMIT);
    this.publishSoon();
  }

  private publishSoon() {
    this.timer ??= setTimeout(() => this.publish(), 250);
  }

  private publish(patch: Partial<ConnState> = {}) {
    clearTimeout(this.timer); this.timer = undefined;
    this.state = { ...this.state, ...patch, log: [...this.log], counts: { ...this.counts } };
    for (const l of [...this.listeners]) l();
  }

  /** `?demo`: run the UI against a fake unit (no hardware). */
  async startDemo() {
    const { startDemo } = await import('./demo');
    this.log = []; this.counts = {};
    this.addLog('DEMO MODE — synthetic data, nothing is sent to a real unit');
    await startDemo(this.store);
    this.publish({ phase: 'connected' });
  }

  async refreshGranted() {
    try { this.publish({ granted: (await grantedQuadCortexes()).length > 0 }); } catch { /* WebHID unavailable */ }
  }

  /** `useGranted`: reuse a device already permitted to this site instead of showing the browser picker. */
  async connect(useGranted: boolean) {
    if (this.state.phase !== 'disconnected') return;
    this.log = []; this.seen = {}; this.counts = {};
    this.publish({ phase: 'connecting', step: 'Choosing device…', error: undefined, writeErrors: 0 });
    try {
      // requestDevice needs a user gesture, so it must be the first await.
      const picked = useGranted ? await grantedQuadCortexes() : await requestQuadCortex();
      picked.forEach((d) => this.addLog(`found: ${describeDevice(d)}`));
      const device = picked.find(looksLikeControlInterface) ?? picked[0];
      if (!device) throw new Error('No device selected.');
      if (!looksLikeControlInterface(device)) this.addLog('WARNING: no HID interface exposes report IDs in#1/out#2');

      this.publish({ step: 'Opening USB…' });
      const t = await WebHidTransport.open(device, {
        onWriteError: (err, n) => {
          this.publish({ writeErrors: n });
          if (n <= 3) this.addLog(`(expected) output report error #${n}: ${String(err)}`);
        },
      });
      this.transport = t;
      const s = new Session(t, { ccVersion: CC_VERSION, log: (l) => this.sessionLog(l) });
      this.session = s;
      s.onClose((r) => { this.addLog(`connection closed: ${String(r)}`); this.teardown(); this.publish({ phase: 'disconnected', step: undefined, error: 'The unit disconnected.' }); });
      s.on((m) => this.onMessage(m));
      this.detach = this.store.attach(s);
      let lastNotice: string | undefined;
      let lastVerified = 0;
      const offNotice = this.store.subscribe(() => {
        const e = this.store.getSnapshot().lastError;
        if (e && e !== lastNotice) this.addLog(`NOTICE: ${e}`);
        lastNotice = e;
        const v = this.store.getSnapshot().verifiedReadBacks;
        if (v !== lastVerified) { lastVerified = v; this.addLog('edit verified: the unit applied the change(s)'); }
      });
      const detachStore = this.detach;
      this.detach = () => { offNotice(); detachStore(); };

      this.publish({ step: 'Handshaking (about 2 s)…' });
      this.addLog(`announcing Cortex Control version ${CC_VERSION}`);
      await s.connect();
      this.publish({ phase: 'connected', step: undefined });
      this.addLog('handshake complete (keepalive running)');
      void this.refreshGranted();
    } catch (e) {
      const msg = e instanceof TimeoutError
        ? `${e.message}. The unit did not answer — is Cortex Control quit, and is the unit fully booted (give it ~20 s)?`
        : (e as Error)?.name === 'NotAllowedError' || /Failed to open/i.test(String(e))
          ? `Could not open the USB device (${String(e)}). Is Cortex Control (or another tab) holding it? Quit it and try again.`
          : String(e);
      this.addLog(`ERROR ${msg}`);
      await this.session?.close().catch(() => {});
      this.teardown();
      this.publish({ phase: 'disconnected', step: undefined, error: msg });
    }
  }

  async disconnect() {
    await this.session?.close();
    this.teardown();
    this.addLog('closed');
    this.publish({ phase: 'disconnected', step: undefined });
  }

  private teardown() {
    this.detach?.(); this.detach = undefined;
    this.session = undefined; this.transport = undefined;
  }

  private sessionLog(l: string) {
    const m = /^(RX|TX) (\w+)/.exec(l);
    if (!m) return this.addLog(l);
    const key = `${m[1]} ${m[2]}`;
    const n = (this.seen[key] = (this.seen[key] ?? 0) + 1);
    const limit = LOG_FIRST_N[m[2]!] ?? LOG_DEFAULT_N;
    if (n <= limit) this.addLog(l);
    else if (n === limit + 1) this.addLog(`… further ${key} messages not logged (see counts)`);
  }

  private onMessage(m: InboundMessage) {
    this.counts[m.typeName] = (this.counts[m.typeName] ?? 0) + 1;
    this.publishSoon();
    if (m.typeName === 'GenericError') {
      const code = (m.message as { errorCode?: number } | undefined)?.errorCode;
      this.addLog(`GenericError from unit: code ${code ?? '(none)'}`);
    }
    const valid = (m.message as { cortexControlVersionValid?: boolean } | undefined)?.cortexControlVersionValid;
    if (m.typeName === 'Version' && valid !== undefined) this.addLog(`unit says Cortex Control version ${CC_VERSION} is ${valid ? 'VALID' : 'NOT valid'}`);
  }
}

export const connection = new Connection();
export const useConnection = () => useSyncExternalStore(connection.subscribe, connection.getSnapshot);
export const useDevice = (): DeviceState => useSyncExternalStore(connection.store.subscribe, connection.store.getSnapshot);
