import { describe, expect, it } from 'vitest';
import { CHUNK_SIZE, encodeMessage, FLAG_FIRST, FLAG_LAST, FramingError, Reassembler, REPORT_BODY_SIZE } from '../src/framing';

function roundtrip(type: number, payload: Uint8Array) {
  const r = new Reassembler();
  let frame = null;
  for (const rep of encodeMessage(type, payload)) frame = r.push(rep);
  return frame;
}

describe('framing', () => {
  it('encodes a small message as one 0xC0 report', () => {
    const reps = encodeMessage(52, new Uint8Array([1, 2, 3]));
    expect(reps).toHaveLength(1);
    expect(reps[0]!.length).toBe(REPORT_BODY_SIZE);
    expect(reps[0]![0]).toBe(3 + 8); // payload + trailer
    expect(reps[0]![1]).toBe(FLAG_FIRST | FLAG_LAST);
    expect(Array.from(reps[0]!.subarray(2, 5))).toEqual([1, 2, 3]);
    expect(Array.from(reps[0]!.subarray(5, 9))).toEqual([52, 0, 0, 0]); // type LE
  });

  it('round-trips payloads at chunk boundaries', () => {
    for (const n of [0, 1, CHUNK_SIZE - 8, CHUNK_SIZE - 7, CHUNK_SIZE, CHUNK_SIZE + 1, 3 * CHUNK_SIZE, 5000]) {
      const payload = Uint8Array.from({ length: n }, (_, i) => (i * 7) & 0xff);
      const f = roundtrip(1234, payload);
      expect(f, `n=${n}`).not.toBeNull();
      expect(f!.messageType).toBe(1234);
      expect(Array.from(f!.payload)).toEqual(Array.from(payload));
      expect(f!.encrypted).toBe(false);
      expect(f!.compressed).toBe(false);
    }
  });

  it('non-final fragments are full and carry only the right flags', () => {
    const reps = encodeMessage(1, new Uint8Array(300));
    expect(reps.length).toBeGreaterThan(2);
    expect(reps[0]![0]).toBe(CHUNK_SIZE);
    expect(reps[0]![1]).toBe(FLAG_FIRST);
    expect(reps[1]![1]).toBe(0);
    expect(reps.at(-1)![1]).toBe(FLAG_LAST);
  });

  it('reads trailer flags from device frames', () => {
    const rep = new Uint8Array(REPORT_BODY_SIZE);
    rep.set([10, 0xc0, 0xaa, 0xbb, 15, 0, 0, 0, 0, 1, 0xee, 0xff], 0);
    // len=10 -> payload [aa bb] + trailer [15,0,0,0, enc=0, gz=1, ee, ff]
    const f = new Reassembler().push(rep)!;
    expect(f.messageType).toBe(15);
    expect(f.compressed).toBe(true);
    expect(f.encrypted).toBe(false);
    expect(Array.from(f.payload)).toEqual([0xaa, 0xbb]);
    expect(Array.from(f.deviceBytes)).toEqual([0xee, 0xff]);
  });

  it('ignores stale bytes after len', () => {
    const rep = encodeMessage(3, new Uint8Array([9]))[0]!;
    rep.fill(0xff, 2 + rep[0]!); // device leaves stale content past len
    const f = new Reassembler().push(rep)!;
    expect(Array.from(f.payload)).toEqual([9]);
  });

  it('rejects junk and resets state', () => {
    const r = new Reassembler();
    const mid = new Uint8Array(REPORT_BODY_SIZE);
    mid[0] = 10;
    mid[1] = 0; // continuation with no FIRST
    expect(() => r.push(mid)).toThrow(FramingError);
    const bad = new Uint8Array(REPORT_BODY_SIZE);
    bad[0] = 200;
    bad[1] = 0xc0;
    expect(() => r.push(bad)).toThrow(FramingError);
    const short = new Uint8Array(REPORT_BODY_SIZE);
    short[0] = 3;
    short[1] = 0xc0; // shorter than trailer
    expect(() => r.push(short)).toThrow(FramingError);
  });

  it('a new FIRST discards a half-assembled message', () => {
    const r = new Reassembler();
    const lost = encodeMessage(1, new Uint8Array(400));
    r.push(lost[0]!);
    r.push(lost[1]!); // never gets LAST
    const f = r.push(encodeMessage(2, new Uint8Array([7]))[0]!)!;
    expect(f.messageType).toBe(2);
    expect(Array.from(f.payload)).toEqual([7]);
  });
});
