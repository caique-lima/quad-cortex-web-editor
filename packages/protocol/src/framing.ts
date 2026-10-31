// HID framing for the Quad Cortex control protocol.
// Wire format reverse-engineered by stokes-audio/pyquadcortex (MIT) — see docs/protocol-notes.md.
//
// A "body" here is the 128 bytes of an HID report WITHOUT the leading report-ID byte
// (WebHID and node-hid both let the transport handle the ID separately):
//   [len u8][flags u8][data ... up to 126 bytes, zero padded]
// A logical message is  protobuf ++ trailer(8)  split into 126-byte chunks.
// Trailer: [message type u32 LE][encrypted u8][compressed u8][2 device bytes].

export const REPORT_BODY_SIZE = 128;
export const CHUNK_SIZE = REPORT_BODY_SIZE - 2;
export const OUT_REPORT_ID = 0x02;
export const IN_REPORT_ID = 0x01;
export const FLAG_FIRST = 0x40;
export const FLAG_LAST = 0x80;
export const TRAILER_SIZE = 8;
/** Safety cap in case a LAST flag is lost. */
export const MAX_MESSAGE_SIZE = 1024 * 1024;

export interface Frame {
  messageType: number;
  /** Still gzipped if `compressed`, still opaque if `encrypted`. */
  payload: Uint8Array;
  encrypted: boolean;
  compressed: boolean;
  deviceBytes: Uint8Array;
}

/** Frame one logical message into one or more 128-byte report bodies. */
export function encodeMessage(messageType: number, payload: Uint8Array): Uint8Array[] {
  const body = new Uint8Array(payload.length + TRAILER_SIZE);
  body.set(payload, 0);
  new DataView(body.buffer).setUint32(payload.length, messageType, true);

  const reports: Uint8Array[] = [];
  for (let off = 0; off < body.length; off += CHUNK_SIZE) {
    const chunk = body.subarray(off, Math.min(off + CHUNK_SIZE, body.length));
    const first = off === 0;
    const last = off + CHUNK_SIZE >= body.length;
    const report = new Uint8Array(REPORT_BODY_SIZE);
    report[0] = chunk.length;
    report[1] = (first ? FLAG_FIRST : 0) | (last ? FLAG_LAST : 0);
    report.set(chunk, 2);
    reports.push(report);
  }
  return reports;
}

export class FramingError extends Error {}

/** Incremental reassembler: feed it report bodies as they arrive. */
export class Reassembler {
  private parts: Uint8Array[] = [];
  private size = 0;

  /** Returns a Frame when `body` completes a message, otherwise null. Throws FramingError on junk (state is reset). */
  push(body: Uint8Array): Frame | null {
    if (body.length < 2) throw this.fail(`report too short (${body.length} bytes)`);
    const len = body[0]!;
    const flags = body[1]!;
    if (len > CHUNK_SIZE || 2 + len > body.length) throw this.fail(`bad chunk length ${len}`);

    if (flags & FLAG_FIRST) {
      // A new message starts; anything half-assembled was lost.
      this.parts = [];
      this.size = 0;
    } else if (this.parts.length === 0) {
      throw this.fail(`continuation report without FIRST (flags=0x${flags.toString(16)})`);
    }

    this.parts.push(body.slice(2, 2 + len));
    this.size += len;
    if (this.size > MAX_MESSAGE_SIZE) throw this.fail('message exceeds reassembly cap');
    if (!(flags & FLAG_LAST)) return null;

    const all = new Uint8Array(this.size);
    let o = 0;
    for (const p of this.parts) {
      all.set(p, o);
      o += p.length;
    }
    this.parts = [];
    this.size = 0;
    if (all.length < TRAILER_SIZE) throw new FramingError(`message shorter than trailer (${all.length} bytes)`);
    const n = all.length - TRAILER_SIZE;
    const dv = new DataView(all.buffer, all.byteOffset + n, TRAILER_SIZE);
    return {
      messageType: dv.getUint32(0, true),
      payload: all.subarray(0, n),
      encrypted: dv.getUint8(4) === 1,
      compressed: dv.getUint8(5) === 1,
      deviceBytes: all.slice(n + 6, n + 8),
    };
  }

  private fail(msg: string): FramingError {
    this.parts = [];
    this.size = 0;
    return new FramingError(msg);
  }
}
