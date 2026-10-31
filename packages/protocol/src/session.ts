import { create, fromBinary, toBinary, type DescMessage, type MessageShape } from '@bufbuild/protobuf';
import { gunzipSync } from 'fflate';
import { encodeMessage, FramingError, Reassembler } from './framing';
import * as pa from './gen/ProductionAutomation_pb';
import { schemaFor, typeFor, typeName } from './registry';
import type { Transport } from './transport';

export interface InboundMessage {
  type: number;
  typeName: string;
  /** Decoded protobuf, or undefined if encrypted/unknown/undecodable. */
  message?: unknown;
  schema?: DescMessage;
  encrypted: boolean;
  compressed: boolean;
  /** Raw (decompressed) protobuf bytes, kept for capture/debugging. */
  raw: Uint8Array;
  receivedAt: number;
}

export type Listener = (msg: InboundMessage) => void;

export interface SessionOptions {
  /** Cortex Control version string announced to the unit; it gates state pushes on a valid one. */
  ccVersion?: string;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
  /** Pause after the subscription burst before the unit treats us as connected. */
  settleMs?: number;
  keepAliveMs?: number;
  /** Skip the initial File{READ} (folder-tree dump). */
  initialFileListing?: boolean;
  log?: (line: string) => void;
}

/** State types Cortex Control subscribes to by READ after connecting (pyquadcortex `_SUBSCRIBE_TYPES`). */
export const SUBSCRIBE_TYPES = [
  'ModuleStats', 'License', 'UndoRedo', 'IOSettings', 'GeneralSettings',
  'ShowGigView', 'Mode', 'GlobalEQ', 'MasterVolume', 'File',
  'RecentsFavorites', 'CompilerInhibitedModules', 'RecallPreset',
  'NewModels', 'PinnedModels', 'DefaultParameters', 'GlobalTempo',
  'SetlistPosition', 'PresetDirty', 'Scene', 'BulkOperation', 'Updater',
] as const;

const READ = pa.MessageAction_Enum.READ;
const UPDATE = pa.MessageAction_Enum.UPDATE;

export class TimeoutError extends Error {}

interface Waiter {
  type: number;
  match: (m: unknown) => boolean;
  resolve: (m: InboundMessage) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class Session {
  readonly opts: Required<Omit<SessionOptions, 'log'>> & { log: (l: string) => void };
  private reassembler = new Reassembler();
  private listeners = new Set<Listener>();
  private waiters = new Set<Waiter>();
  private unsub: Array<() => void> = [];
  private keepAliveTimer?: ReturnType<typeof setInterval>;
  private nextRequestId = 1;
  private sendChain: Promise<void> = Promise.resolve();
  private closed = false;
  private closeCbs = new Set<(reason?: unknown) => void>();

  constructor(private transport: Transport, opts: SessionOptions = {}) {
    this.opts = {
      ccVersion: opts.ccVersion ?? '4.1.0',
      timeoutMs: opts.timeoutMs ?? 5000,
      settleMs: opts.settleMs ?? 2000,
      keepAliveMs: opts.keepAliveMs ?? 5000,
      initialFileListing: opts.initialFileListing ?? true,
      log: opts.log ?? (() => {}),
    };
    this.unsub.push(transport.onReport((b) => this.handleReport(b)));
    this.unsub.push(transport.onClose((r) => this.handleClose(r)));
  }

  // ---- subscriptions -----------------------------------------------------

  /** Listen to every decoded inbound message. */
  on(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  onClose(cb: (reason?: unknown) => void): () => void {
    this.closeCbs.add(cb);
    return () => this.closeCbs.delete(cb);
  }

  // ---- sending -----------------------------------------------------------

  /** Encode and send a message. Sends are serialized so reports of different messages never interleave. */
  send<S extends DescMessage>(schema: S, init?: Parameters<typeof create<S>>[1]): Promise<void> {
    const msg = create(schema, init);
    const payload = toBinary(schema, msg);
    const reports = encodeMessage(typeFor(schema), payload);
    this.opts.log(`TX ${typeName(typeFor(schema))} ${payload.length}B`);
    const run = async () => {
      for (const r of reports) await this.transport.send(r);
    };
    this.sendChain = this.sendChain.then(run, run);
    return this.sendChain;
  }

  /** Allocate a request_id for messages that carry one. */
  newRequestId(): bigint {
    return BigInt(this.nextRequestId++);
  }

  /** Resolve with the next inbound message of `schema`'s type for which `match` is true. */
  waitFor<S extends DescMessage>(
    schema: S,
    match: (m: MessageShape<S>) => boolean = () => true,
    timeoutMs = this.opts.timeoutMs,
  ): Promise<InboundMessage & { message: MessageShape<S> }> {
    const type = typeFor(schema);
    return new Promise((resolve, reject) => {
      const w: Waiter = {
        type,
        match: match as (m: unknown) => boolean,
        resolve: resolve as (m: InboundMessage) => void,
        timer: setTimeout(() => {
          this.waiters.delete(w);
          reject(new TimeoutError(`timed out waiting for ${typeName(type)}`));
        }, timeoutMs),
      };
      this.waiters.add(w);
    });
  }

  /** Send, then wait for a matching reply. The waiter is registered before sending so a fast reply can't be missed. */
  async request<S extends DescMessage, R extends DescMessage>(
    schema: S,
    init: Parameters<typeof create<S>>[1],
    replySchema: R,
    match: (m: MessageShape<R>) => boolean = () => true,
    timeoutMs = this.opts.timeoutMs,
  ) {
    const reply = this.waitFor(replySchema, match, timeoutMs);
    reply.catch(() => {}); // avoid unhandled rejection if send throws first
    await this.send(schema, init);
    return reply;
  }

  // ---- high-level operations --------------------------------------------

  /**
   * Version READ. Safe without the handshake. The unit answers twice (full reply, then its own bare READ
   * ~1 ms later), so only a reply carrying identity fields counts.
   */
  async readVersion(timeoutMs = 10000): Promise<MessageShape<typeof pa.VersionMessageSchema>> {
    const r = await this.request(
      pa.VersionMessageSchema, { action: READ },
      pa.VersionMessageSchema,
      (m) => m.deviceSerialNumber !== undefined || m.appFwVersion !== undefined,
      timeoutMs,
    );
    return r.message;
  }

  /** The full connect handshake (mirrors Cortex Control / pyquadcortex `_hello`). */
  async connect(): Promise<void> {
    const sessionId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
    await this.request(
      pa.ResetCommsBuffersMessageSchema, { sessionId },
      pa.ResetCommsBuffersMessageSchema,
    );
    await this.send(pa.VersionMessageSchema, { action: UPDATE, cortexControlVersion: this.opts.ccVersion });
    await this.send(pa.ModelRepoMessageSchema, { action: READ });
    await this.send(pa.ConnectionMessageSchema, { connected: true });
    for (const name of SUBSCRIBE_TYPES) {
      if (name === 'File' && !this.opts.initialFileListing) continue;
      const schema = (pa as Record<string, unknown>)[`${name}MessageSchema`] as DescMessage;
      await this.send(schema, { action: READ } as never);
    }
    await new Promise((r) => setTimeout(r, this.opts.settleMs));
    this.startKeepAlive();
  }

  private startKeepAlive() {
    this.stopKeepAlive();
    const tick = () => {
      this.send(pa.KeepAliveMessageSchema, { action: UPDATE, requestId: 0n, isOnline: true }).catch(() => {});
    };
    this.keepAliveTimer = setInterval(tick, this.opts.keepAliveMs);
  }

  private stopKeepAlive() {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = undefined;
  }

  /** Courtesy goodbye + release. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.stopKeepAlive();
    try {
      await this.send(pa.ConnectionMessageSchema, { connected: false });
    } catch {
      /* best effort */
    }
    await this.dispose();
    await this.transport.close();
  }

  // ---- inbound -----------------------------------------------------------

  private handleReport(body: Uint8Array) {
    let frame;
    try {
      frame = this.reassembler.push(body);
    } catch (e) {
      if (e instanceof FramingError) this.opts.log(`RX framing error: ${e.message}`);
      else throw e;
      return;
    }
    if (!frame) return;

    let raw = frame.payload;
    if (!frame.encrypted && raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
      // Detect gzip by magic bytes; the trailer flag has agreed with it on every observed message, but magic is authoritative.
      try {
        raw = gunzipSync(raw);
      } catch (e) {
        this.opts.log(`RX gunzip failed: ${String(e)}`);
        return;
      }
    }
    const schema = schemaFor(frame.messageType);
    const inbound: InboundMessage = {
      type: frame.messageType,
      typeName: typeName(frame.messageType),
      encrypted: frame.encrypted,
      compressed: frame.compressed,
      raw,
      receivedAt: Date.now(),
    };
    if (schema && !frame.encrypted) {
      try {
        inbound.message = fromBinary(schema, raw);
        inbound.schema = schema;
      } catch (e) {
        this.opts.log(`RX decode failed for ${inbound.typeName}: ${String(e)}`);
      }
    }
    this.opts.log(`RX ${inbound.typeName} ${raw.length}B${frame.compressed ? ' (gz)' : ''}${frame.encrypted ? ' (enc)' : ''}`);
    this.dispatch(inbound);
  }

  private dispatch(msg: InboundMessage) {
    if (msg.message !== undefined) {
      for (const w of [...this.waiters]) {
        if (w.type === msg.type && w.match(msg.message)) {
          clearTimeout(w.timer);
          this.waiters.delete(w);
          w.resolve(msg);
          break; // one waiter per message
        }
      }
    }
    for (const l of [...this.listeners]) {
      try {
        l(msg);
      } catch (e) {
        this.opts.log(`listener error: ${String(e)}`);
      }
    }
  }

  private handleClose(reason?: unknown) {
    if (this.closed) return;
    this.stopKeepAlive();
    void this.dispose();
    for (const cb of [...this.closeCbs]) cb(reason);
  }

  private async dispose() {
    this.closed = true;
    for (const u of this.unsub) u();
    this.unsub = [];
    for (const w of this.waiters) {
      clearTimeout(w.timer);
    }
    this.waiters.clear();
  }
}
