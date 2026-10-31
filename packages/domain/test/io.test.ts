import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { Reassembler, Session, pa, schemaFor, typeName, typeFor, type InboundMessage, type Transport } from '@qc/protocol';
import { describe, expect, it, vi } from 'vitest';
import { INPUT_LEVEL_STEP, dbToInputLevel, emptyIo, inputLevelToDb, ioMessage, masterVolumeMessage, masterVolumeShown, mergeIoSettings } from '../src/io';
import { DeviceStore } from '../src/store';

const A = pa.MessageAction_Enum;
const rt = (init: any) => fromBinary(pa.IOSettingsMessageSchema, toBinary(pa.IOSettingsMessageSchema, create(pa.IOSettingsMessageSchema, init)));

describe('input gain conversion (dB = -12 + 72 * level, measured upstream)', () => {
  it('matches the four readings taken on a real unit', () => {
    for (const [w, db] of [[0.4055555462837219, 17.2], [0.40042707324028015, 16.8], [0.5000885725021362, 24.0], [0.1666666716337204, 0.0]] as const) {
      expect(inputLevelToDb(w)).toBeCloseTo(db, 1);
    }
    expect(inputLevelToDb(0)).toBe(-12);
    expect(inputLevelToDb(1)).toBe(60);
  });
  it('round-trips and refuses values outside -12..+60 rather than clamping', () => {
    for (const db of [-12, -3.5, 0, 17.2, 60]) expect(inputLevelToDb(dbToInputLevel(db))).toBeCloseTo(db, 6);
    for (const bad of [-12.5, 61, Number.NaN]) expect(() => dbToInputLevel(bad)).toThrow(RangeError);
    expect(INPUT_LEVEL_STEP * 72).toBeCloseTo(0.1, 9);
  });
  it('master volume shows as round(volume * 100) (wire 0.566115677 displays 57)', () => {
    expect(masterVolumeShown(0.566115677)).toBe(57);
    expect(masterVolumeShown(0)).toBe(0);
    expect(() => masterVolumeMessage(1.2)).toThrow(RangeError);
  });
});

describe('IOSettings messages: sparse, port-keyed, ONE field each', () => {
  it('input level: only the port id and level', () => {
    const p = rt(ioMessage('in.level', 2, 0.4)).settings!.inPort;
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ inputPortId: 2, level: expect.closeTo(0.4, 5) });
    expect(p[0]!.groundLift).toBeUndefined();
    expect(p[0]!.inputZmode).toBeUndefined();
  });
  it('ground lift and mute are written alone; false is still encoded (presence matters)', () => {
    expect(rt(ioMessage('in.groundLift', 1, true)).settings!.inPort[0]).toMatchObject({ inputPortId: 1, groundLift: 1 });
    expect(rt(ioMessage('out.groundLift', 4, false)).settings!.outPort[0]).toMatchObject({ outputPortId: 4, groundLift: 0 });
    const mute = rt(ioMessage('out.mute', 4, false)).settings!.outPort[0]!;
    expect(mute.mute).toBe(false); // present-and-false, not absent
    expect(mute.level).toBeUndefined();
    expect(rt(ioMessage('out.mute', 4, true)).settings!.outPort[0]!.mute).toBe(true);
  });
  it('refuses levels outside 0..1 and bad port ids', () => {
    for (const bad of [-0.1, 1.1, Number.NaN]) expect(() => ioMessage('out.level', 4, bad)).toThrow(RangeError);
    expect(() => ioMessage('in.level', -1, 0.5)).toThrow(RangeError);
    expect(() => ioMessage('in.level', 1.5, 0.5)).toThrow(RangeError);
  });
  it('merging pushes keeps what was not mentioned (the unit sends only changes)', () => {
    let io = mergeIoSettings(emptyIo(), { settings: { inPort: [{ inputPortId: 1, level: 0.2, groundLift: 0, plugged: true }], outPort: [{ outputPortId: 4, level: 0.7, mute: false }] } });
    io = mergeIoSettings(io, { settings: { inPort: [{ inputPortId: 1, level: 0.3 }] } });
    expect(io.inputs.get(1)).toEqual({ id: 1, level: 0.3, groundLift: false, plugged: true });
    expect(io.outputs.get(4)).toEqual({ id: 4, level: 0.7, mute: false });
  });
});

function rig() {
  const frames: Uint8Array[] = [];
  const t: Transport = { async send(b) { frames.push(b); }, onReport: () => () => {}, onClose: () => () => {}, async close() {} };
  const store = new DeviceStore({ notifyDelayMs: 0, editThrottleMs: 5 });
  store.attach(new Session(t));
  const inbound = (schema: any, init: any): InboundMessage => { const ty = typeFor(schema); return { type: ty, typeName: typeName(ty), message: create(schema, init), schema, encrypted: false, compressed: false, raw: new Uint8Array(), receivedAt: 0 }; };
  store.handle(inbound(pa.IOSettingsMessageSchema, { action: A.UPDATE, settings: { inPort: [{ inputPortId: 1, level: 0.2, groundLift: 0 }, { inputPortId: 2, level: 0.2 }], outPort: [{ outputPortId: 4, level: 0.5, mute: false }] } }));
  const sent = () => { const r = new Reassembler(); const out: any[] = []; for (const f of frames) { const fr = r.push(f); if (fr) out.push({ name: typeName(fr.messageType), msg: fromBinary(schemaFor(fr.messageType)!, fr.payload) }); } return out; };
  return { store, sent, inbound };
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('DeviceStore global settings', () => {
  it('reads what the unit reports', () => {
    const { store } = rig();
    expect([...store.getSnapshot().io.inputs.keys()]).toEqual([1, 2]);
    expect(store.getSnapshot().io.outputs.get(4)).toMatchObject({ level: 0.5, mute: false });
  });

  it('input level: immediate, one sparse write, drags coalesce to the last value', async () => {
    const { store, sent } = rig();
    for (let i = 1; i <= 10; i++) await store.setIo('in.level', 1, i / 20);
    expect(store.getSnapshot().io.inputs.get(1)!.level).toBe(0.5); // immediate
    expect(store.getSnapshot().io.inputs.get(2)!.level).toBe(0.2); // other ports untouched
    await wait(20);
    const w = sent().filter((m) => m.name === 'IOSettings');
    expect(w).toHaveLength(1);
    expect(w[0].msg.settings.inPort[0]).toMatchObject({ inputPortId: 1, level: expect.closeTo(0.5, 5) });
  });

  it('different fields of one port go out as separate messages', async () => {
    const { store, sent } = rig();
    await store.setIo('out.level', 4, 0.9);
    await store.setIo('out.mute', 4, true);
    await wait(20);
    const w = sent().filter((m) => m.name === 'IOSettings').map((m) => m.msg.settings.outPort[0]);
    expect(w).toHaveLength(2);
    expect(w.some((p: any) => p.level !== undefined && p.mute === undefined)).toBe(true);
    expect(w.some((p: any) => p.mute === true && p.level === undefined)).toBe(true);
  });

  it('refuses ports the unit never reported and bad values before sending anything', async () => {
    const { store, sent } = rig();
    await expect(store.setIo('in.level', 9, 0.5)).rejects.toThrow(/not reported port 9/);
    await expect(store.setIo('out.level', 4, 2)).rejects.toThrow(RangeError);
    await wait(20);
    expect(sent()).toHaveLength(0);
  });

  it('warns when the unit does not confirm, and stays quiet when its push arrives', async () => {
    vi.useFakeTimers();
    try {
      const { store, inbound } = rig();
      await store.setIo('out.mute', 4, true);
      await vi.advanceTimersByTimeAsync(3500);
      expect(store.getSnapshot().lastError).toMatch(/did not confirm the change to out mute of port 4/);
      await store.setIo('in.groundLift', 1, true); // a new edit clears the notice
      store.handle(inbound(pa.IOSettingsMessageSchema, { action: A.UPDATE, settings: { inPort: [{ inputPortId: 1, groundLift: 1 }] } }));
      await vi.advanceTimersByTimeAsync(3500);
      expect(store.getSnapshot().lastError).toBeUndefined();
    } finally { vi.useRealTimers(); }
  });

  it('master volume: sent as MasterVolume UPDATE, shown at once, and follows the knob', async () => {
    const { store, sent, inbound } = rig();
    await store.setMasterVolume(0.3);
    expect(store.getSnapshot().io.masterVolume).toBe(0.3);
    expect(sent().find((m) => m.name === 'MasterVolume')!.msg).toMatchObject({ action: A.UPDATE, volume: expect.closeTo(0.3, 5) });
    store.handle(inbound(pa.MasterVolumeMessageSchema, { action: A.UPDATE, volume: 0.62 })); // someone turned the knob
    expect(store.getSnapshot().io.masterVolume).toBeCloseTo(0.62, 5);
    await expect(store.setMasterVolume(-1)).rejects.toThrow(RangeError);
  });
});

describe('nudging settings accumulates from the latest value', () => {
  it('five quick taps on a level add up, and clamp at the ends', async () => {
    const { store } = rig();
    for (let i = 0; i < 5; i++) await store.nudgeIo('in.level', 1, 0.05);
    expect(store.getSnapshot().io.inputs.get(1)!.level).toBeCloseTo(0.45, 6);
    for (let i = 0; i < 30; i++) await store.nudgeIo('out.level', 4, 0.05);
    expect(store.getSnapshot().io.outputs.get(4)!.level).toBe(1);
    await expect(store.nudgeIo('in.level', 9, 0.1)).rejects.toThrow(/not reported a level/);
    await expect(store.nudgeMasterVolume(0.1)).rejects.toThrow(/not reported its master volume/);
  });
});
