import { create, fromBinary, toBinary, type DescMessage } from '@bufbuild/protobuf';
import { gzipSync } from 'fflate';
import { encodeMessage, Reassembler } from '../src/framing';
import { schemaFor, typeFor, typeName } from '../src/registry';
import type { Transport } from '../src/transport';

export interface Sent {
  type: number;
  name: string;
  msg: any;
}

/** In-memory Transport that behaves like a (very) minimal unit. */
export class FakeDevice implements Transport {
  sent: Sent[] = [];
  private rx = new Reassembler();
  private reportCbs = new Set<(b: Uint8Array) => void>();
  private closeCbs = new Set<(r?: unknown) => void>();
  closed = false;
  /** If set, replies are handled here; return true to suppress default behaviour. */
  silent = false;
  versionReplies: Array<Record<string, unknown>> = [
    { action: 3, appFwVersion: 'd14e', deviceSerialNumber: 'SN1', zenosGitHash: '4.1.0' },
    { action: 3 }, // the unit's own bare READ question
  ];

  async send(body: Uint8Array) {
    const frame = this.rx.push(body);
    if (!frame) return;
    const schema = schemaFor(frame.messageType)!;
    const msg: any = fromBinary(schema, frame.payload);
    this.sent.push({ type: frame.messageType, name: typeName(frame.messageType), msg });
    if (this.silent) return;
    queueMicrotask(() => this.respond(frame.messageType, msg));
  }

  private respond(type: number, msg: any) {
    const name = typeName(type);
    if (name === 'ResetCommsBuffers') this.emit(schemaFor(type)!, { sessionId: msg.sessionId });
    if (name === 'Version' && msg.action === 3) {
      for (const v of this.versionReplies) this.emit(schemaFor(type)!, v);
    }
  }

  emit(schema: DescMessage, init: Record<string, unknown>, opts: { gzip?: boolean; chunk?: number } = {}) {
    let payload = toBinary(schema, create(schema, init as never));
    if (opts.gzip) payload = gzipSync(payload);
    const reports = encodeMessage(typeFor(schema), payload);
    if (opts.gzip) for (const r of reports) void r; // flag is informational; session detects by magic
    for (const r of reports) for (const cb of this.reportCbs) cb(r);
  }

  onReport(cb: (b: Uint8Array) => void) {
    this.reportCbs.add(cb);
    return () => this.reportCbs.delete(cb);
  }
  onClose(cb: (r?: unknown) => void) {
    this.closeCbs.add(cb);
    return () => this.closeCbs.delete(cb);
  }
  async close() {
    this.closed = true;
  }
  unplug() {
    for (const cb of this.closeCbs) cb('unplugged');
  }
}
