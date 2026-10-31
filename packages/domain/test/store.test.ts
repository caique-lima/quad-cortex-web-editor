import { create } from '@bufbuild/protobuf';
import { pa, schemaFor, Session, typeFor, typeName, type InboundMessage, type Transport } from '@qc/protocol';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { DeviceStore, folderKind } from '../src/store';
import { pluginGroups } from '../src/library';
import { preset } from './helpers';

const A = pa.MessageAction_Enum;

function inbound(schema: Parameters<typeof typeFor>[0], init: Record<string, unknown>): InboundMessage {
  const message = create(schema, init as never);
  const type = typeFor(schema);
  return { type, typeName: typeName(type), message, schema, encrypted: false, compressed: false, raw: new Uint8Array(), receivedAt: 0 };
}
const store = () => new DeviceStore({ notifyDelayMs: 0 });
const files = (n: number, named: number[] = []) =>
  Array.from({ length: n }, (_, i) => ({ index: i, ...(named.includes(i) ? { name: `P${i}`, key: `k/${i}.pb` } : {}) }));

describe('DeviceStore inbound', () => {
  it('builds folders from File pushes: full listings replace, partial ones merge', () => {
    const s = store();
    s.handle(inbound(pa.FileMessageSchema, { action: A.UPDATE, folder: { key: '/media/p4/Presets/My Presets', name: 'My Presets', files: files(256, [0, 5]) } }));
    let f = s.getSnapshot().folders.get('/media/p4/Presets/My Presets')!;
    expect(f).toMatchObject({ name: 'My Presets', kind: 'presets', isFactory: false });
    expect(f.slots.size).toBe(256);
    expect(f.slots.get(5)).toMatchObject({ name: 'P5' });
    expect(f.slots.get(1)!.name).toBeUndefined(); // empty slot

    // a save announces one file -> merged, others kept
    s.handle(inbound(pa.FileMessageSchema, { action: A.CREATE, folder: { key: '/media/p4/Presets/My Presets', files: [{ index: 1, name: 'New', key: 'k/1.pb' }] } }));
    f = s.getSnapshot().folders.get('/media/p4/Presets/My Presets')!;
    expect(f.slots.get(1)!.name).toBe('New');
    expect(f.slots.get(5)!.name).toBe('P5');
    expect(f.name).toBe('My Presets'); // kept from before

    // delete removes by key
    s.handle(inbound(pa.FileMessageSchema, { action: A.DELETE, folder: { key: '/media/p4/Presets/My Presets', files: [{ key: 'k/5.pb' }] } }));
    expect(s.getSnapshot().folders.get('/media/p4/Presets/My Presets')!.slots.get(5)).toBeUndefined();
  });

  it('classifies folders', () => {
    expect(folderKind('/media/p4/Presets/My Presets')).toBe('presets');
    expect(folderKind('/opt/neuraldsp/Factory Library/')).toBe('presets');
    expect(folderKind('/media/p4/Neural Captures/x')).toBe('captures');
    expect(folderKind('/opt/neuraldsp/impulse_responses')).toBe('irs');
    expect(folderKind('/something')).toBe('other');
  });

  it('tracks preset, position, scene, dirty, info and clears loading on RecallPreset', () => {
    const s = store();
    const p = preset({});
    s.handle(inbound(pa.RecallPresetMessageSchema, { action: A.UPDATE, preset: p }));
    s.handle(inbound(pa.SetlistPositionMessageSchema, { action: A.UPDATE, folderKey: '/f', position: 218, isFactory: true }));
    s.handle(inbound(pa.SceneMessageSchema, { action: A.UPDATE, selectedScene: 4 }));
    s.handle(inbound(pa.PresetDirtyMessageSchema, { action: A.UPDATE, isDirty: true }));
    s.handle(inbound(pa.VersionMessageSchema, { action: A.READ, zenosGitHash: '4.1.0', appFwVersion: 'd14e', customName: 'Rig' }));
    const st = s.getSnapshot();
    expect(st.preset).toBe(p);
    expect(st.presetRevision).toBe(1);
    expect(st.position).toEqual({ folderKey: '/f', position: 218, isFactory: true });
    expect(st.selectedScene).toBe(4);
    expect(st.dirty).toBe(true);
    expect(st.info).toEqual({ coros: '4.1.0', firmware: 'd14e', name: 'Rig' });
  });

  it('ignores bare Version questions and empty RecallPreset', () => {
    const s = store();
    s.handle(inbound(pa.VersionMessageSchema, { action: A.READ }));
    s.handle(inbound(pa.RecallPresetMessageSchema, { action: A.READ }));
    expect(s.getSnapshot().info).toBeUndefined();
    expect(s.getSnapshot().preset).toBeUndefined();
  });

  it('parses the block catalog from ModelRepo', () => {
    const s = store();
    const bin = new Uint8Array(readFileSync(new URL('../../protocol/test/fixtures/model_repo_coros_4_0_1.bin', import.meta.url)));
    s.handle(inbound(pa.ModelRepoMessageSchema, { action: A.UPDATE, modelRepoPayload: bin }));
    expect(s.getSnapshot().catalog!.models.size).toBe(533);
    s.handle(inbound(pa.ModelRepoMessageSchema, { action: A.UPDATE, modelRepoPayload: new Uint8Array([1, 2, 3, 4]) }));
    expect(s.getSnapshot().lastError).toMatch(/block catalog/);
    expect(s.getSnapshot().catalog!.models.size).toBe(533); // previous catalog kept
  });

  it('batches notifications and keeps snapshots immutable', async () => {
    const s = new DeviceStore({ notifyDelayMs: 10 });
    let calls = 0;
    s.subscribe(() => calls++);
    const before = s.getSnapshot();
    for (let i = 0; i < 20; i++) s.handle(inbound(pa.SceneMessageSchema, { action: A.UPDATE, selectedScene: i % 8 }));
    expect(calls).toBe(0);
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toBe(1);
    expect(s.getSnapshot()).not.toBe(before);
    expect(before.selectedScene).toBe(0);
  });
});

/** A transport that records decoded outgoing messages. */
function recordingSession() {
  const sent: Array<{ name: string; msg: any }> = [];
  const frames: Uint8Array[] = [];
  const t: Transport = {
    async send(b) { frames.push(b); },
    onReport: () => () => {},
    onClose: () => () => {},
    async close() {},
  };
  return { session: new Session(t), frames, sent };
}

describe('DeviceStore actions', () => {
  it('recall sends SetlistPosition UPDATE and flags loading until the preset arrives', async () => {
    const { session, frames } = recordingSession();
    const s = store();
    s.attach(session);
    await s.recall({ folderKey: '/media/p4/Presets/My Presets', position: 218, isFactory: false });
    expect(s.getSnapshot().loadingPreset).toBe(true);

    // decode what went out
    const { Reassembler } = await import('@qc/protocol');
    const r = new Reassembler();
    const frame = frames.map((f) => r.push(f)).find(Boolean)!;
    expect(typeName(frame.messageType)).toBe('SetlistPosition');
    const m: any = (await import('@bufbuild/protobuf')).fromBinary(schemaFor(frame.messageType)!, frame.payload);
    expect(m).toMatchObject({ action: A.UPDATE, folderKey: '/media/p4/Presets/My Presets', position: 218, isFactory: false });
    expect(m.requestId).toBeGreaterThan(0n);

    s.handle(inbound(pa.RecallPresetMessageSchema, { action: A.UPDATE, preset: preset({}) }));
    expect(s.getSnapshot().loadingPreset).toBe(false);
  });

  it('recalls plugin and Downloads presets by key, not by folder + position', async () => {
    const { session, frames } = recordingSession();
    const s = store();
    s.attach(session);
    const plugin = '/opt/neuraldsp/Plugins/Archetype X/Presets/Ambient';
    s.handle(inbound(pa.FileMessageSchema, { action: A.UPDATE, folder: { key: plugin, name: 'Ambient', files: [{ index: 0, name: 'Pad', key: `${plugin}/Pad.pb` }] } }));
    s.handle(inbound(pa.FileMessageSchema, { action: A.UPDATE, folder: { key: 'cloud-0-1', name: 'Downloads', isDownloads: true, files: [{ index: 3, name: 'Tone', key: 'Tone.pb', cloudId: 'uuid-1' }] } }));
    const folders = s.getSnapshot().folders;
    await s.recallSlot(folders.get(plugin)!, folders.get(plugin)!.slots.get(0)!);
    await s.recallSlot(folders.get('cloud-0-1')!, folders.get('cloud-0-1')!.slots.get(3)!);

    const { Reassembler } = await import('@qc/protocol');
    const r = new Reassembler();
    const sent = frames.map((f) => r.push(f)).filter(Boolean).map((f) => fromBinary(schemaFor(f!.messageType)!, f!.payload) as any);
    expect(sent[0]).toMatchObject({ isPlugin: true, folderKey: plugin, keyInPluginFolder: `${plugin}/Pad.pb` });
    expect(sent[0].position).toBeUndefined();
    expect(sent[1]).toMatchObject({ isDownloads: true, keyInDownloads: 'uuid-1' });
    expect(sent[1].folderKey).toBeUndefined();

    // the unit reports a plugin preset by its key -> placed back on its folder and slot
    s.handle(inbound(pa.SetlistPositionMessageSchema, { action: A.UPDATE, isPlugin: true, keyInPluginFolder: `${plugin}/Pad.pb` }));
    expect(s.getSnapshot().position).toMatchObject({ folderKey: plugin, position: 0, pluginKey: `${plugin}/Pad.pb` });
  });

  it('selectScene validates and sends Scene UPDATE', async () => {
    const { session, frames } = recordingSession();
    const s = store();
    s.attach(session);
    await expect(s.selectScene(8)).rejects.toThrow(RangeError);
    await expect(s.selectScene(-1)).rejects.toThrow(RangeError);
    expect(frames).toHaveLength(0);
    await s.selectScene(3);
    expect(frames).toHaveLength(1);
  });

  it('actions fail cleanly when not connected', async () => {
    await expect(store().selectScene(1)).rejects.toThrow('Not connected');
    await expect(store().recall({ folderKey: 'x', position: 0, isFactory: false })).rejects.toThrow('Not connected');
  });
});

// ---- edits ----
import { fromBinary } from '@bufbuild/protobuf';
import { Reassembler } from '@qc/protocol';
import { bypassRow, model, withLaneControls } from './helpers';
import { readBypass, readParam, readParamAt } from '../src/edits';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function editRig() {
  const frames: Uint8Array[] = [];
  const t: Transport = { async send(b) { frames.push(b); }, onReport: () => () => {}, onClose: () => () => {}, async close() {} };
  const session = new Session(t);
  const s = new DeviceStore({ notifyDelayMs: 0, editThrottleMs: 5, verifyDelayMs: 20 });
  s.attach(session);
  const base = preset(
    { '0,0': model(1, { params: [[1, 2, 3, 4, 5, 6, 7, 8], [0.5]], sceneModeParams: [0] }), '0,1': model(2) },
    { bypass: [bypassRow(0, { 0: { states: [false] }, 1: { perScene: true, states: Array(8).fill(false) } }), bypassRow(1, {}), bypassRow(2, {}), bypassRow(3, {})] },
  );
  s.handle(inbound(pa.RecallPresetMessageSchema, { action: A.UPDATE, preset: base }));
  s.handle(inbound(pa.SceneMessageSchema, { action: A.UPDATE, selectedScene: 3 }));
  /** Decode everything sent so far. */
  const sent = () => {
    const r = new Reassembler();
    const out: Array<{ name: string; msg: any }> = [];
    for (const f of frames) { const fr = r.push(f); if (fr) out.push({ name: typeName(fr.messageType), msg: fromBinary(schemaFor(fr.messageType)!, fr.payload) }); }
    return out;
  };
  return { s, base, sent };
}
/** Pretend to be the unit answering the read-back with `live`. */
const answer = (s: DeviceStore, live: ReturnType<typeof preset>) => s.handle(inbound(pa.RecallPresetMessageSchema, { action: A.UPDATE, preset: live }));

describe('DeviceStore edits', () => {
  it('setParam updates the UI immediately, marks dirty, and sends one sparse Grid UPDATE', async () => {
    const { s, sent } = editRig();
    await s.setParam(0, 0, 0, 0.75);
    expect(readParam(s.getSnapshot().preset!, 0, 0, 0, 3)).toBe(0.75); // immediate
    expect(s.getSnapshot().dirty).toBe(true);
    expect(sent()).toHaveLength(0); // throttled, not yet written
    await wait(15);
    const grid = sent().filter((m) => m.name === 'Grid');
    expect(grid).toHaveLength(1);
    expect(grid[0]!.msg.preset.chains[0].models[0].params[0].paramValues[0].value).toEqual({ case: 'floatValue', value: 0.75 });
    expect(grid[0]!.msg.requestId).toBeGreaterThan(0n);
  });

  it('a slider drag is coalesced: many edits of one parameter -> one write with the LAST value', async () => {
    const { s, sent } = editRig();
    for (let i = 1; i <= 20; i++) await s.setParam(0, 0, 1, i / 20);
    await wait(15);
    const grid = sent().filter((m) => m.name === 'Grid');
    expect(grid).toHaveLength(1);
    expect(grid[0]!.msg.preset.chains[0].models[0].params[0].paramValues[0].value.value).toBe(1);
  });

  it('after the edits settle it reads the live preset back (RecallPreset READ) exactly once', async () => {
    const { s, sent } = editRig();
    await s.setParam(0, 0, 1, 0.3);
    await s.setParam(0, 0, 1, 0.4);
    await wait(60);
    const reads = sent().filter((m) => m.name === 'RecallPreset');
    expect(reads).toHaveLength(1);
    expect(reads[0]!.msg.action).toBe(A.READ);
  });

  it('a matching read-back raises no error', async () => {
    const { s, base } = editRig();
    await s.setParam(0, 0, 1, 0.3);
    await wait(60);
    const live = (await import('@bufbuild/protobuf')).clone((await import('@qc/protocol')).preset.BinaryPresetSchema, base);
    live.chains[0]!.models[0]!.params[1]!.paramValues[0] = create((await import('@qc/protocol')).preset.ParamValueSchema, { value: { case: 'floatValue', value: 0.3 } });
    answer(s, live);
    expect(s.getSnapshot().lastError).toBeUndefined();
  });

  it('a read-back that disagrees (unit refused) reports it and shows the unit\'s truth', async () => {
    const { s, base } = editRig();
    await s.setParam(0, 0, 1, 0.9, 'GAIN');
    await wait(60);
    answer(s, base); // unit still has the old 0.5
    const st = s.getSnapshot();
    expect(st.lastError).toMatch(/did not apply this change: GAIN/);
    expect(readParam(st.preset!, 0, 0, 1, 3)).toBe(0.5);
  });

  it('edits made while a read-back is in flight are not lost or falsely reported', async () => {
    const { s, base } = editRig();
    await s.setParam(0, 0, 1, 0.3);
    await wait(60); // read-back requested
    await s.setParam(0, 0, 0, 0.8); // newer edit, after the READ was sent
    const live = (await import('@bufbuild/protobuf')).clone((await import('@qc/protocol')).preset.BinaryPresetSchema, base);
    live.chains[0]!.models[0]!.params[1]!.paramValues[0] = create((await import('@qc/protocol')).preset.ParamValueSchema, { value: { case: 'floatValue', value: 0.3 } });
    answer(s, live);
    expect(s.getSnapshot().lastError).toBeUndefined();
    expect(readParam(s.getSnapshot().preset!, 0, 0, 0, 3)).toBe(0.8); // re-applied on top
  });

  it('nudgeParam accumulates from the latest value even before the UI has re-rendered', async () => {
    const { s } = editRig();
    s.handle(inbound(pa.SceneMessageSchema, { action: A.UPDATE, selectedScene: 0 }));
    // param 1 of block 0,0 holds 0.5; five taps of +0.1 without any flush in between
    for (let i = 0; i < 5; i++) await s.nudgeParam(0, 0, 1, (w) => Math.min(1, w + 0.1));
    expect(readParam(s.getSnapshot().preset!, 0, 0, 1, 0)).toBeCloseTo(1, 6);
    await expect(s.nudgeParam(0, 6, 0, (w) => w)).rejects.toThrow(/no numeric parameter/);
    await expect(s.nudgeParam(0, 0, 1, () => 2)).rejects.toThrow(RangeError); // out of range is refused, not clamped silently
  });

  it('setBypass sends a chain-less Grid UPDATE immediately and updates the UI (per-scene block: active scene only)', async () => {
    const { s, sent } = editRig();
    await s.setBypass(0, 1, true);
    expect(readBypass(s.getSnapshot().preset!, 0, 1, 3)).toBe(true);
    expect(readBypass(s.getSnapshot().preset!, 0, 1, 2)).toBe(false);
    const g = sent().find((m) => m.name === 'Grid')!;
    expect(g.msg.preset.chains).toHaveLength(0);
    expect(g.msg.preset.bypass[0].colBypass[0].sceneBypass[0].bypass).toBe(true);
  });

  it('refuses bad input before anything is sent', async () => {
    const { s, sent } = editRig();
    await expect(s.setParam(0, 0, 1, 1.5)).rejects.toThrow(RangeError);
    await expect(s.setParam(0, 0, 1, Number.NaN)).rejects.toThrow(RangeError);
    await expect(s.setParam(0, 6, 0, 0.5)).rejects.toThrow(/no parameter/);
    await expect(s.setBypass(5, 9, true)).rejects.toThrow(/no bypass/);
    await wait(30);
    expect(sent()).toHaveLength(0);
    await expect(store().setParam(0, 0, 0, 0.5)).rejects.toThrow('Not connected');
  });

  it('discardChanges re-recalls the current slot; pending edits are dropped', async () => {
    const { s, sent } = editRig();
    s.handle(inbound(pa.SetlistPositionMessageSchema, { action: A.UPDATE, folderKey: '/f', position: 9, isFactory: false }));
    await s.setParam(0, 0, 1, 0.3);
    await s.discardChanges();
    await wait(60);
    const names = sent().map((m) => m.name);
    expect(names).toEqual(['SetlistPosition']); // the throttled write and the verify read never went out
    expect(sent()[0]!.msg).toMatchObject({ folderKey: '/f', position: 9 });
  });

  it('times out an unanswered read-back instead of waiting forever, and verifies later edits again', async () => {
    vi.useFakeTimers();
    try {
      const { s, sent } = editRig();
      await s.setParam(0, 0, 1, 0.3);
      await vi.advanceTimersByTimeAsync(100); // write + read-back request go out
      expect(sent().filter((m) => m.name === 'RecallPreset')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(10_500); // the unit stays silent
      expect(s.getSnapshot().lastError).toMatch(/did not answer the read-back/);
      await s.setParam(0, 0, 1, 0.6);
      await vi.advanceTimersByTimeAsync(100);
      expect(sent().filter((m) => m.name === 'RecallPreset')).toHaveLength(2); // not stuck
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('DeviceStore reacts to changes made on the unit itself', () => {
  const gridPush = (extra: Record<string, unknown> = {}) => inbound(pa.GridMessageSchema, { action: A.UPDATE, preset: preset({}), ...extra });

  it('a foreign Grid push triggers one debounced read-back; meter updates and our own echoes do not', async () => {
    const { s, sent } = editRig();
    s.handle(gridPush({ updateType: pa.GridMessage_UpdateType.METER_UPDATE }));
    await wait(300);
    expect(sent()).toHaveLength(0); // meters are not edits

    for (let i = 0; i < 5; i++) s.handle(gridPush()); // a burst from turning a knob on the unit
    await wait(300);
    const reads = sent().filter((m) => m.name === 'RecallPreset');
    expect(reads).toHaveLength(1);
    expect(reads[0]!.msg.action).toBe(A.READ);
  });

  it('the echo of our own edit (matched by request id, or arriving right after we sent) does not cause a resync', async () => {
    const { s, sent } = editRig();
    await s.setBypass(0, 1, true);
    const ourId = sent().find((m) => m.name === 'Grid')!.msg.requestId as bigint;
    s.handle(gridPush({ requestId: ourId }));
    s.handle(gridPush()); // echo without an id, within the echo window
    await wait(40); // before the post-edit verify read-back fires (20 ms) has no bearing: count only Grid-triggered reads
    const reads = sent().filter((m) => m.name === 'RecallPreset');
    expect(reads.length).toBeLessThanOrEqual(1); // at most the normal verify read, never a resync per echo
  });
});


// ---- saving ----
import { toBinary } from '@bufbuild/protobuf';
import { preset as PSchema } from '@qc/protocol';

const USER = '/media/p4/Presets/My Presets';

/** A connected store with a user folder (slot 5 = "Old Tone", slot 7 empty), a loaded & CLEAN preset at slot 5. */
function saveRig(opts: { snapshotSink?: (s: any) => Promise<void> } = {}) {
  const frames: Uint8Array[] = [];
  const t: Transport = { async send(b) { frames.push(b); }, onReport: () => () => {}, onClose: () => () => {}, async close() {} };
  const session = new Session(t);
  const s = new DeviceStore({ notifyDelayMs: 0, editThrottleMs: 5, verifyDelayMs: 20, snapshotSink: opts.snapshotSink ?? (async () => {}) });
  s.attach(session);
  const sent = () => {
    const r = new Reassembler();
    const out: Array<{ name: string; msg: any }> = [];
    for (const f of frames) { const fr = r.push(f); if (fr) out.push({ name: typeName(fr.messageType), msg: fromBinary(schemaFor(fr.messageType)!, fr.payload) }); }
    return out;
  };
  const folderFiles = Array.from({ length: 256 }, (_, i) => (i === 5 ? { index: 5, name: 'Old Tone', key: 'k5.pb', instrument: 2 } : { index: i }));
  s.handle(inbound(pa.FileMessageSchema, { action: A.UPDATE, folder: { key: USER, name: 'My Presets', files: folderFiles } }));
  s.handle(inbound(pa.FileMessageSchema, { action: A.UPDATE, folder: { key: '/opt/neuraldsp/Factory Library/', name: 'Factory Library', isFactory: true, files: folderFiles } }));
  const stored = preset({ '0,0': model(1, { params: [[1, 2, 3, 4, 5, 6, 7, 8], [0.5]], sceneModeParams: [0] }) }, { name: 'Old Tone' });
  // the unit announces a fresh load of slot 5, then says it is not dirty
  s.handle(inbound(pa.SetlistPositionMessageSchema, { action: A.UPDATE, folderKey: USER, position: 5, isFactory: false }));
  s.handle(inbound(pa.RecallPresetMessageSchema, { action: A.UPDATE, preset: stored }));
  s.handle(inbound(pa.PresetDirtyMessageSchema, { action: A.UPDATE, isDirty: false }));
  /** Pretend to be the unit: after a File CREATE, list the new name and say we're clean. */
  const unitAcceptsSaves = (o: { rename?: (n: string) => string; answerReads?: boolean } = {}) => {
    const rename = o.rename;
    const orig = session.send.bind(session);
    (session as any).send = async (schema: any, init: any) => {
      await orig(schema, init);
      if (o.answerReads && init?.action === A.READ && schema === pa.RecallPresetMessageSchema) {
        queueMicrotask(() => s.handle(inbound(pa.RecallPresetMessageSchema, { action: A.UPDATE, preset: s.getSnapshot().preset })));
      }
      if (init?.folder?.files && init.action === A.CREATE) {
        const f = init.folder.files[0];
        queueMicrotask(() => {
          s.handle(inbound(pa.FileMessageSchema, { action: A.UPDATE, folder: { key: init.folder.key, files: [{ index: f.index, name: rename ? rename(f.name) : f.name, key: `k${f.index}.pb`, instrument: f.instrument }] } }));
          s.handle(inbound(pa.PresetDirtyMessageSchema, { action: A.UPDATE, isDirty: false }));
        });
      }
    };
  };
  return { s, sent, stored, unitAcceptsSaves };
}
const fileCreates = (sent: () => Array<{ name: string; msg: any }>) => sent().filter((m) => m.name === 'File');

describe('DeviceStore save', () => {
  it('writes ONLY to the user\'s own preset folders, and validates names, before sending anything', async () => {
    const { s, sent } = saveRig();
    await expect(s.save({ folderKey: '/opt/neuraldsp/Factory Library/', index: 3, name: 'x' })).rejects.toThrow(/read-only/);
    await expect(s.save({ folderKey: '/nope', index: 3, name: 'x' })).rejects.toThrow(/not known/);
    await expect(s.save({ folderKey: USER, index: 256, name: 'x' })).rejects.toThrow(/between 1A and 32H/);
    await expect(s.save({ folderKey: USER, index: -1, name: 'x' })).rejects.toThrow(/between 1A and 32H/);
    await expect(s.save({ folderKey: USER, index: 3, name: '   ' })).rejects.toThrow(/name/);
    await expect(s.save({ folderKey: USER, index: 3, name: 'x'.repeat(21) })).rejects.toThrow(/at most 20/);
    await expect(s.save({ folderKey: USER, index: 3, name: 'a/b' })).rejects.toThrow(/slashes/);
    await expect(s.save({ folderKey: USER, index: 3, name: 'a\nb' })).rejects.toThrow(/control/);
    expect(fileCreates(sent)).toHaveLength(0);
  });

  it('Save As to an empty slot sends one File CREATE with the slot, name and instrument; no snapshot is needed', async () => {
    const sink = vi.fn(async () => {});
    const { s, sent, unitAcceptsSaves } = saveRig({ snapshotSink: sink });
    unitAcceptsSaves();
    const r = await s.save({ folderKey: USER, index: 7, name: '  New Tone ' });
    const creates = fileCreates(sent);
    expect(creates).toHaveLength(1);
    expect(creates[0]!.msg).toMatchObject({ action: A.CREATE, type: 0, folder: { key: USER, isFactory: false } });
    expect(creates[0]!.msg.folder.files).toHaveLength(1);
    expect(creates[0]!.msg.folder.files[0]).toMatchObject({ index: 7, name: 'New Tone', instrument: 2 }); // instrument of the loaded slot
    expect(r).toMatchObject({ savedName: 'New Tone', renamed: false, snapshotted: false });
    expect(sink).not.toHaveBeenCalled();
  });

  it('overwriting the loaded slot snapshots the STORED version first (not the edited one), then saves', async () => {
    const snaps: any[] = [];
    const order: string[] = [];
    const { s, sent, stored, unitAcceptsSaves } = saveRig({ snapshotSink: async (x) => { order.push(`snapshot(sent=${fileCreates(sent).length})`); snaps.push(x); } });
    unitAcceptsSaves({ answerReads: true });
    await s.setParam(0, 0, 1, 0.9); // an unsaved edit
    const r = await s.save({ folderKey: USER, index: 5, name: 'Old Tone' });
    expect(snaps).toHaveLength(1);
    expect(order).toEqual(['snapshot(sent=0)']); // taken before the File CREATE went out
    expect(snaps[0]).toMatchObject({ folderKey: USER, folderName: 'My Presets', index: 5, name: 'Old Tone' });
    expect(snaps[0].preset).toEqual(toBinary(PSchema.BinaryPresetSchema, stored)); // the original, not the edit
    expect(r).toMatchObject({ snapshotted: true, replaced: 'Old Tone', renamed: false });
    expect(fileCreates(sent)).toHaveLength(1);
  });

  it('if the snapshot cannot be stored, NOTHING is sent', async () => {
    const { s, sent, unitAcceptsSaves } = saveRig({ snapshotSink: async () => { throw new Error('disk full'); } });
    unitAcceptsSaves();
    await expect(s.save({ folderKey: USER, index: 5, name: 'Old Tone' })).rejects.toThrow('disk full');
    expect(fileCreates(sent)).toHaveLength(0);
  });

  it('overwriting a DIFFERENT occupied slot cannot be snapshotted, and is reported as such', async () => {
    const { s, unitAcceptsSaves } = saveRig();
    unitAcceptsSaves();
    s.handle(inbound(pa.FileMessageSchema, { action: A.CREATE, folder: { key: USER, files: [{ index: 9, name: 'Other', key: 'k9.pb' }] } }));
    expect(s.canSnapshot(USER, 5)).toBe(true);
    expect(s.canSnapshot(USER, 9)).toBe(false);
    const r = await s.save({ folderKey: USER, index: 9, name: 'Mine' });
    expect(r).toMatchObject({ snapshotted: false, replaced: 'Other' });
  });

  it('no trusted baseline when the unit already had unsaved edits (dirty on load)', () => {
    const { s } = saveRig();
    s.handle(inbound(pa.SetlistPositionMessageSchema, { action: A.UPDATE, folderKey: USER, position: 6, isFactory: false }));
    s.handle(inbound(pa.RecallPresetMessageSchema, { action: A.UPDATE, preset: preset({}) }));
    s.handle(inbound(pa.PresetDirtyMessageSchema, { action: A.UPDATE, isDirty: true }));
    expect(s.canSnapshot(USER, 6)).toBe(false);
  });

  it('a local edit before the "not dirty" report means the loaded preset is not trusted as the stored one', async () => {
    const { s } = saveRig();
    s.handle(inbound(pa.SetlistPositionMessageSchema, { action: A.UPDATE, folderKey: USER, position: 6, isFactory: false }));
    s.handle(inbound(pa.RecallPresetMessageSchema, { action: A.UPDATE, preset: preset({ '0,0': model(1, { params: [[0.1]] }) }) }));
    await s.setParam(0, 0, 0, 0.5);
    s.handle(inbound(pa.PresetDirtyMessageSchema, { action: A.UPDATE, isDirty: false }));
    expect(s.canSnapshot(USER, 6)).toBe(false);
  });

  it('a READ reply (verify/resync) is the live grid, never mistaken for a stored preset', async () => {
    const { s } = saveRig();
    await s.setParam(0, 0, 1, 0.9);
    await wait(60); // the verify READ goes out
    answer(s, preset({ '0,0': model(1, { params: [[1, 2, 3, 4, 5, 6, 7, 8], [0.9]], sceneModeParams: [0] }) }));
    s.handle(inbound(pa.PresetDirtyMessageSchema, { action: A.UPDATE, isDirty: false }));
    expect(s.canSnapshot(USER, 5)).toBe(true); // still the original baseline
  });

  it('reports a de-duplicated name the unit chose', async () => {
    const { s, unitAcceptsSaves } = saveRig();
    unitAcceptsSaves({ rename: (n) => `${n}_2` });
    const r = await s.save({ folderKey: USER, index: 7, name: 'Tone' });
    expect(r).toMatchObject({ savedName: 'Tone_2', renamed: true });
  });

  it('pending edits are flushed and confirmed BEFORE the save; a refused edit aborts it', async () => {
    const { s, sent, unitAcceptsSaves } = saveRig();
    unitAcceptsSaves();
    await s.setParam(0, 0, 1, 0.9);
    // answer the read-back with the OLD value => the unit "refused"
    const pending = s.save({ folderKey: USER, index: 7, name: 'X' });
    await wait(30);
    answer(s, preset({ '0,0': model(1, { params: [[1, 2, 3, 4, 5, 6, 7, 8], [0.5]], sceneModeParams: [0] }) }));
    await expect(pending).rejects.toThrow(/not confirmed/);
    expect(sent().map((m) => m.name)).toEqual(expect.arrayContaining(['Grid', 'RecallPreset']));
    expect(fileCreates(sent)).toHaveLength(0);
  });

  it('times out when the unit never acknowledges', async () => {
    vi.useFakeTimers();
    try {
      const { s } = saveRig();
      const p = s.save({ folderKey: USER, index: 7, name: 'X' });
      const caught = p.catch((e) => e);
      await vi.advanceTimersByTimeAsync(16_000);
      expect(String(await caught)).toMatch(/did not confirm the save/);
    } finally { vi.useRealTimers(); }
  });
});

// ---- block & scene editing ----

import { readCellHash } from '../src/edits';

function blockRig() {
  const frames: Uint8Array[] = [];
  const t: Transport = { async send(b) { frames.push(b); }, onReport: () => () => {}, onClose: () => () => {}, async close() {} };
  const session = new Session(t);
  const s = new DeviceStore({ notifyDelayMs: 0, editThrottleMs: 5, verifyDelayMs: 20, structuralVerifyDelayMs: 20, structuralRetryDelayMs: 40 });
  s.attach(session);
  const bin = new Uint8Array(readFileSync(new URL('../../protocol/test/fixtures/model_repo_coros_4_0_1.bin', import.meta.url)));
  s.handle(inbound(pa.ModelRepoMessageSchema, { action: A.UPDATE, modelRepoPayload: bin }));
  const base = preset({ '0,0': model(1, { params: [[1, 2, 3, 4, 5, 6, 7, 8], [0.5]], sceneModeParams: [0] }), '0,1': model(2) }, { sceneLabels: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], sceneColors: [1, 2, 3, 4, 5, 6, 7, 8] });
  s.handle(inbound(pa.RecallPresetMessageSchema, { action: A.UPDATE, preset: base }));
  const sent = () => {
    const r = new Reassembler();
    const out: Array<{ name: string; msg: any }> = [];
    for (const f of frames) { const fr = r.push(f); if (fr) out.push({ name: typeName(fr.messageType), msg: fromBinary(schemaFor(fr.messageType)!, fr.payload) }); }
    return out;
  };
  /** The unit's live grid after some structural change, built from `base`. */
  const live = (cells: Record<string, ReturnType<typeof model> | null>) => {
    const place: Record<string, ReturnType<typeof model>> = { '0,0': model(1, { params: [[1, 2, 3, 4, 5, 6, 7, 8], [0.5]], sceneModeParams: [0] }), '0,1': model(2) };
    for (const [k, v] of Object.entries(cells)) { if (v === null) delete place[k]; else place[k] = v; }
    return preset(place);
  };
  return { s, sent, base, live };
}
const PLACE = 1; // Myth Drive (placeable)

describe('DeviceStore block editing', () => {
  it('refuses unplaceable models and bad cells before sending anything', async () => {
    const { s, sent } = blockRig();
    await expect(s.placeBlock(0, 2, 20000)).rejects.toThrow(/crashes the unit/);
    await expect(s.placeBlock(0, 2, 99999999)).rejects.toThrow(/not in this unit's catalog/);
    await expect(s.placeBlock(4, 0, PLACE)).rejects.toThrow(RangeError);
    await expect(s.removeBlock(0, 5)).rejects.toThrow(/already empty/);
    await expect(s.moveBlock(0, 5, 1, 1)).rejects.toThrow(/no block to move/);
    await expect(s.moveBlock(0, 0, 0, 1)).rejects.toThrow(/not empty/);
    await expect(s.moveBlock(0, 0, 0, 0)).rejects.toThrow(/same cell/);
    expect(sent()).toHaveLength(0);
  });

  it('place sends a sparse Grid UPDATE, flags structuralPending, and a matching read-back clears it with no error', async () => {
    const { s, sent, live } = blockRig();
    await s.placeBlock(1, 3, PLACE);
    expect(s.getSnapshot().structuralPending).toBe(true);
    expect(s.getSnapshot().dirty).toBe(true);
    const g = sent().find((m) => m.name === 'Grid')!;
    expect(g.msg.action).toBe(A.UPDATE);
    expect(g.msg.preset.chains[0]).toMatchObject({ row: 1 });
    expect(g.msg.preset.chains[0].models[0]).toMatchObject({ column: 3, hash: PLACE });
    await wait(40);
    expect(sent().filter((m) => m.name === 'RecallPreset')).toHaveLength(1);
    answer(s, live({ '1,3': model(PLACE, { params: [[0.5], [0.5], [0.5]] }) }));
    expect(s.getSnapshot().structuralPending).toBe(false);
    expect(s.getSnapshot().lastError).toBeUndefined();
    expect(readCellHash(s.getSnapshot().preset!, 1, 3)).toBe(PLACE);
    expect(s.getSnapshot().verifiedReadBacks).toBe(1);
  });

  it('a placement that shows up one read late is NOT reported as refused (retries once)', async () => {
    const { s, sent, live } = blockRig();
    await s.placeBlock(1, 3, PLACE);
    await wait(40);
    answer(s, live({})); // not there yet
    expect(s.getSnapshot().lastError).toBeUndefined();
    expect(s.getSnapshot().structuralPending).toBe(true);
    await wait(80); // retry read-back goes out
    expect(sent().filter((m) => m.name === 'RecallPreset')).toHaveLength(2);
    answer(s, live({ '1,3': model(PLACE) }));
    expect(s.getSnapshot().lastError).toBeUndefined();
    expect(s.getSnapshot().structuralPending).toBe(false);
  });

  it('a placement the unit never applies (e.g. out of DSP) is reported after the retry, naming the block', async () => {
    const { s, live } = blockRig();
    await s.placeBlock(1, 3, PLACE);
    await wait(40); answer(s, live({}));
    await wait(80); answer(s, live({}));
    const st = s.getSnapshot();
    expect(st.lastError).toMatch(/did not apply this change: Myth Drive at row 2, column 4/);
    expect(st.structuralPending).toBe(false);
    expect(readCellHash(st.preset!, 1, 3)).toBe(0); // shows the unit's truth
  });

  it('remove: optimistic, sends Grid DELETE with hash 0, confirmed by read-back', async () => {
    const { s, sent, live } = blockRig();
    await s.removeBlock(0, 1);
    expect(readCellHash(s.getSnapshot().preset!, 0, 1)).toBe(0); // immediately
    const g = sent().find((m) => m.name === 'Grid')!;
    expect(g.msg.action).toBe(A.DELETE);
    expect(g.msg.preset.chains[0].models[0]).toMatchObject({ column: 1, hash: 0 });
    await wait(40);
    answer(s, live({ '0,1': null }));
    expect(s.getSnapshot().lastError).toBeUndefined();
    expect(s.getSnapshot().structuralPending).toBe(false);
  });

  it('move: sends GridMove; verifies BOTH the vacated and the arrival cell', async () => {
    const { s, sent, live } = blockRig();
    await s.moveBlock(0, 1, 1, 5);
    const g = sent().find((m) => m.name === 'GridMove')!;
    expect(g.msg.move[0]).toMatchObject({ fromRow: 0, fromCol: 1, toRow: 1, toCol: 5, isDrop: true });
    await wait(40);
    answer(s, live({ '0,1': null, '1,5': model(2) }));
    expect(s.getSnapshot().lastError).toBeUndefined();
    // a move the unit ignored leaves the block where it was => both expectations fail
    await s.moveBlock(0, 0, 2, 2);
    await wait(40); answer(s, live({ '0,1': null, '1,5': model(2) }));
    await wait(80); answer(s, live({ '0,1': null, '1,5': model(2) }));
    expect(s.getSnapshot().lastError).toMatch(/did not apply 2 changes/);
  });

  it('parameter edits queued for a cell are flushed first, then dropped when that cell is removed (no false mismatch)', async () => {
    const { s, sent, live } = blockRig();
    await s.setParam(0, 0, 1, 0.7); // queued (throttled)
    await s.removeBlock(0, 0);
    const names = sent().map((m) => m.name);
    expect(names.slice(0, 2)).toEqual(['Grid', 'Grid']); // param write first, then the removal
    expect(sent()[0]!.msg.action).toBe(A.UPDATE);
    expect(sent()[1]!.msg.action).toBe(A.DELETE);
    await wait(60);
    answer(s, live({ '0,0': null }));
    expect(s.getSnapshot().lastError).toBeUndefined(); // the param expectation for the removed block was discarded
  });

  it('save waits for a pending placement to be confirmed, and aborts if the unit never applied it', async () => {
    const { s, sent, live } = blockRig();
    s.handle(inbound(pa.FileMessageSchema, { action: A.UPDATE, folder: { key: USER, name: 'My Presets', files: Array.from({ length: 256 }, (_, i) => ({ index: i })) } }));
    await s.placeBlock(1, 3, PLACE);
    const saving = s.save({ folderKey: USER, index: 7, name: 'X' });
    const caught = saving.catch((e) => e);
    await wait(30); answer(s, live({}));
    await wait(80); answer(s, live({}));
    expect(String(await caught)).toMatch(/not confirmed/);
    expect(sent().filter((m) => m.name === 'File')).toHaveLength(0);
  });
});

describe('DeviceStore scene editing', () => {
  it('rename: sends SceneLabel; the unit\'s push is what updates the UI; blank becomes a single space', async () => {
    const { s, sent } = blockRig();
    await s.setSceneLabel(2, '  Big Lead ');
    expect(sent().find((m) => m.name === 'SceneLabel')!.msg).toMatchObject({ action: A.UPDATE, index: 2, label: 'Big Lead' });
    expect(s.getSnapshot().preset!.sceneLabels[2]).toBe('C'); // not changed until the unit confirms
    s.handle(inbound(pa.SceneLabelMessageSchema, { action: A.UPDATE, index: 2, label: 'Big Lead' }));
    expect(s.getSnapshot().preset!.sceneLabels[2]).toBe('Big Lead');
    expect(s.getSnapshot().preset!.sceneLabels[3]).toBe('D');
    await s.setSceneLabel(4, '   ');
    expect(sent().filter((m) => m.name === 'SceneLabel')[1]!.msg.label).toBe(' ');
  });

  it('colour: sends SceneColor and applies the push', async () => {
    const { s, sent } = blockRig();
    await s.setSceneColor(1, 0xff44cc77);
    expect(sent().find((m) => m.name === 'SceneColor')!.msg).toMatchObject({ index: 1, color: 0xff44cc77 });
    s.handle(inbound(pa.SceneColorMessageSchema, { action: A.UPDATE, index: 1, color: 0xff44cc77 }));
    expect(s.getSnapshot().preset!.sceneColors[1]).toBe(0xff44cc77);
  });

  it('warns when the unit never confirms a scene change', async () => {
    vi.useFakeTimers();
    try {
      const { s } = blockRig();
      await s.setSceneLabel(0, 'x');
      await vi.advanceTimersByTimeAsync(3500);
      expect(s.getSnapshot().lastError).toMatch(/did not confirm the change to scene 1's name/);
      await s.setSceneLabel(1, 'y');
      s.handle(inbound(pa.SceneLabelMessageSchema, { action: A.UPDATE, index: 1, label: 'y' }));
      await vi.advanceTimersByTimeAsync(3500);
      expect(s.getSnapshot().lastError).toBeUndefined(); // a new edit clears the old notice, and scene 2's push arrived so no new one
    } finally { vi.useRealTimers(); }
  });

  it('copy/swap: sends SceneCopy UPDATE, then re-reads the live grid because parameters changed', async () => {
    const { s, sent } = blockRig();
    await s.copyScene(1, 3, false);
    await s.copyScene(2, 5, true);
    const copies = sent().filter((m) => m.name === 'SceneCopy');
    expect(copies[0]!.msg).toMatchObject({ action: A.UPDATE, fromIndex: 1, toIndex: 3, isSwap: false });
    expect(copies[1]!.msg).toMatchObject({ fromIndex: 2, toIndex: 5, isSwap: true });
    await wait(300);
    expect(sent().filter((m) => m.name === 'RecallPreset')).toHaveLength(1); // one debounced re-read
  });

  it('invalid scene arguments send nothing', async () => {
    const { s, sent } = blockRig();
    await expect(s.setSceneLabel(8, 'x')).rejects.toThrow(RangeError);
    await expect(s.setSceneColor(0, -1)).rejects.toThrow(RangeError);
    await expect(s.copyScene(2, 2)).rejects.toThrow(/different/);
    expect(sent()).toHaveLength(0);
  });
});

describe('DeviceStore lane routing', () => {
  const lanePreset = (ports: Array<[number | undefined, number | undefined]>) => {
    const p = preset({});
    ports.forEach(([i, o], r) => { p.chains[r]!.inPortid = i; p.chains[r]!.outPortid = o; });
    return p;
  };
  const rig = () => {
    const r = blockRig();
    r.s.handle(inbound(pa.RecallPresetMessageSchema, { action: A.UPDATE, preset: lanePreset([[1, 1], [0, 0], [2, 2], [0, 0]]) }));
    return r;
  };

  it('sets an output: immediate in the UI, one sparse Grid UPDATE, marked dirty, confirmed by read-back', async () => {
    const { s, sent } = rig();
    await s.setLanePort(2, 'out', 19);
    expect(s.getSnapshot().preset!.chains[2]!.outPortid).toBe(19);
    expect(s.getSnapshot().preset!.chains[2]!.inPortid).toBe(2); // the other side untouched
    expect(s.getSnapshot().dirty).toBe(true);
    const g = sent().find((m) => m.name === 'Grid')!;
    expect(g.msg.preset.chains[0]).toMatchObject({ row: 2, outPortid: 19 });
    expect(g.msg.preset.chains[0].inPortid).toBeUndefined();
    await wait(60);
    answer(s, lanePreset([[1, 1], [0, 0], [2, 19], [0, 0]]));
    expect(s.getSnapshot().lastError).toBeUndefined();
    expect(s.getSnapshot().verifiedReadBacks).toBe(1);
  });

  it('a port the unit did not apply is reported, and its real value is shown again', async () => {
    const { s } = rig();
    await s.setLanePort(0, 'in', 3);
    await wait(60);
    answer(s, lanePreset([[1, 1], [0, 0], [2, 2], [0, 0]])); // unit kept Input 1
    expect(s.getSnapshot().lastError).toMatch(/did not apply this change: input of lane 1/);
    expect(s.getSnapshot().preset!.chains[0]!.inPortid).toBe(1);
  });

  it('refuses unknown ports and missing lanes before anything is sent', async () => {
    const { s, sent } = rig();
    await expect(s.setLanePort(0, 'out', 99)).rejects.toThrow(RangeError);
    await expect(s.setLanePort(0, 'in', 14)).rejects.toThrow(RangeError);
    await expect(s.setLanePort(7, 'in', 1)).rejects.toThrow(RangeError);
    expect(sent()).toHaveLength(0);
    await expect(store().setLanePort(0, 'in', 1)).rejects.toThrow('Not connected');
  });

  it('a routing change made after the read-back was requested is kept on screen', async () => {
    const { s } = rig();
    await s.setLanePort(0, 'out', 2);
    await wait(60); // read-back in flight
    await s.setLanePort(1, 'in', 3);
    answer(s, lanePreset([[1, 2], [0, 0], [2, 2], [0, 0]])); // reply predates the second change
    expect(s.getSnapshot().lastError).toBeUndefined();
    expect(s.getSnapshot().preset!.chains[1]!.inPortid).toBe(3);
  });
});

describe('DeviceStore undo/redo (the unit\'s own history)', () => {
  it('tracks the unit\'s undo/redo depth from its UndoRedo pushes', () => {
    const { s } = blockRig();
    expect(s.getSnapshot()).toMatchObject({ undoCount: 0, redoCount: 0 });
    s.handle(inbound(pa.UndoRedoMessageSchema, { action: A.UPDATE, undoFrames: [1, 2, 3], redoFrames: [9] }));
    expect(s.getSnapshot()).toMatchObject({ undoCount: 3, redoCount: 1 });
    s.handle(inbound(pa.UndoRedoMessageSchema, { action: A.UPDATE }));
    expect(s.getSnapshot()).toMatchObject({ undoCount: 0, redoCount: 0 });
  });

  it('undo sends UndoRedo{UPDATE, undo:true} (and redo likewise), after flushing queued edits, then re-reads the live grid', async () => {
    const { s, sent } = blockRig();
    await s.setParam(0, 0, 1, 0.9); // queued
    await s.undo();
    const names = sent().map((m) => m.name);
    expect(names.slice(0, 2)).toEqual(['Grid', 'UndoRedo']); // the edit went out BEFORE the undo
    const u = sent()[1]!.msg;
    expect(u).toMatchObject({ action: A.UPDATE, undo: true });
    expect(u.redo).toBeUndefined();
    await wait(300);
    expect(sent().filter((m) => m.name === 'RecallPreset')).toHaveLength(1);
    await s.redo();
    const r = sent().filter((m) => m.name === 'UndoRedo')[1]!.msg;
    expect(r).toMatchObject({ action: A.UPDATE, redo: true });
    expect(r.undo).toBeUndefined();
  });

  it('undo forgets pending checks of our own edits (they would be reported as refused otherwise)', async () => {
    const { s, base } = blockRig();
    await s.setParam(0, 0, 1, 0.9);
    await wait(10);
    await s.undo();
    await wait(80); // the old verify timer must not fire a read-back that compares against the undone value
    answer(s, base);
    expect(s.getSnapshot().lastError).toBeUndefined();
  });

  it('fails cleanly when not connected', async () => {
    await expect(store().undo()).rejects.toThrow('Not connected');
  });
});

describe('DeviceStore lane controls', () => {
  const lanePreset = () => withLaneControls(preset({}));
  const rig = () => {
    const r = blockRig();
    r.s.handle(inbound(pa.RecallPresetMessageSchema, { action: A.UPDATE, preset: lanePreset() }));
    return r;
  };
  const OUT = { kind: 'laneOut' as const, row: 0 };

  it('sets a lane output parameter: immediate, one sparse write keyed by hash, verified by read-back', async () => {
    const { s, sent } = rig();
    await s.setControlParam(OUT, 1, 0.2, 'lane 1 PAN');
    expect(readParamAt(s.getSnapshot().preset!, OUT, 1, 0)).toBe(0.2);
    await wait(15);
    const g = sent().filter((m) => m.name === 'Grid');
    expect(g).toHaveLength(1);
    expect(g[0]!.msg.preset.chains[0].outputControl[0]).toMatchObject({ hash: 23000 });
    expect(g[0]!.msg.preset.chains[0].outputControl[0].params[0].paramValues[0].value).toEqual({ case: 'floatValue', value: expect.closeTo(0.2, 5) });
    await wait(50);
    answer(s, withLaneControls(preset({}), { out: [0.76923077, 0.2, 0, 0] }));
    expect(s.getSnapshot().lastError).toBeUndefined();
    expect(s.getSnapshot().verifiedReadBacks).toBe(1);
  });

  it('a lane control the unit did not apply is reported with its label, and the real value returns', async () => {
    const { s } = rig();
    await s.setControlParam(OUT, 2, 1, 'lane 1 MUTE'); // mute on
    await wait(60);
    answer(s, lanePreset()); // unit left MUTE off
    expect(s.getSnapshot().lastError).toMatch(/did not apply this change: lane 1 MUTE/);
    expect(readParamAt(s.getSnapshot().preset!, OUT, 2, 0)).toBe(0);
  });

  it('nudges from the latest value; refuses a splitter on lane 2 and bad values before sending', async () => {
    const { s, sent } = rig();
    for (let i = 0; i < 3; i++) await s.nudgeControlParam({ kind: 'laneIn', row: 2 }, 3, (w) => w + 0.1);
    expect(readParamAt(s.getSnapshot().preset!, { kind: 'laneIn', row: 2 }, 3, 0)).toBeCloseTo(0.8, 6);
    await expect(s.setControlParam({ kind: 'splitter', row: 1 }, 0, 0.5)).rejects.toThrow(/only lanes 1 and 3/);
    await expect(s.setControlParam(OUT, 0, 2)).rejects.toThrow(RangeError);
    await expect(s.setControlParam(OUT, 9, 0.5)).rejects.toThrow(/no parameter 9/);
    await wait(15);
    expect(sent().filter((m) => m.name === 'Grid')).toHaveLength(1); // only the coalesced gain write
  });

  it('block edits still work through the same path (regression)', async () => {
    const { s } = rig();
    s.handle(inbound(pa.RecallPresetMessageSchema, { action: A.UPDATE, preset: withLaneControls(preset({ '0,0': model(1, { params: [[0.5]] }) })) }));
    await s.setParam(0, 0, 0, 0.9);
    expect(readParamAt(s.getSnapshot().preset!, { kind: 'block', row: 0, column: 0 }, 0, 0)).toBe(0.9);
  });
});

describe('DeviceStore branching', () => {
  it('setSplit sends the columns, shows them at once, and verifies by read-back', async () => {
    const { s, sent, live } = blockRig();
    await s.setSplit(0, 2, 6);
    expect(s.getSnapshot().preset!.chains[0]!.splitControlPoints[0]).toMatchObject({ split: 2, mix: 6 });
    const g = sent().find((m) => m.name === 'Grid')!;
    expect(g.msg.preset.chains[0].splitControlPoints[0]).toMatchObject({ split: 2, mix: 6 });
    await wait(60);
    const lv = live({}); lv.chains[0]!.splitControlPoints = [create((await import('@qc/protocol')).preset.SplitControlPointsSchema, { split: 2, mix: 6 })];
    answer(s, lv);
    expect(s.getSnapshot().lastError).toBeUndefined();
    expect(s.getSnapshot().verifiedReadBacks).toBe(1);
  });

  it('a branch the unit did not create is reported', async () => {
    const { s, live } = blockRig();
    await s.setSplit(2, 1, 5);
    await wait(60);
    answer(s, live({}));
    expect(s.getSnapshot().lastError).toMatch(/did not apply this change: branch of lane 3/);
  });

  it('refuses bad branches before sending', async () => {
    const { s, sent } = blockRig();
    await expect(s.setSplit(1, 0, 7)).rejects.toThrow(/only lanes 1 and 3/);
    await expect(s.setSplit(0, 4, 2)).rejects.toThrow(/rejoin after/);
    expect(sent()).toHaveLength(0);
  });
});

describe('plugin folders in the library', () => {
  it('groups plugin preset folders by plugin, by path or by parent folder', () => {
    const s = store();
    const P = '/opt/neuraldsp/Plugins';
    const named = (name: string) => [{ index: 0, name, key: `${name}.pb` }];
    s.handle(inbound(pa.FileMessageSchema, { action: A.UPDATE, folder: { key: `${P}/ArchPlini`, name: 'Archetype: Plini X', files: [] } }));
    s.handle(inbound(pa.FileMessageSchema, { action: A.UPDATE, folder: { key: `${P}/ArchPlini/Presets/Creative`, name: 'Creative', files: named('a') } }));
    s.handle(inbound(pa.FileMessageSchema, { action: A.UPDATE, folder: { key: `${P}/ArchPlini/Presets/Ambient`, name: 'Ambient', files: named('b') } }));
    s.handle(inbound(pa.FileMessageSchema, { action: A.UPDATE, folder: { key: `${P}/Nolly/Presets/Ambient`, name: 'Ambient', files: named('c') } }));
    s.handle(inbound(pa.FileMessageSchema, { action: A.UPDATE, folder: { key: `${P}/Nolly/Presets/Empty`, name: 'Empty', files: [{ index: 0 }] } }));
    s.handle(inbound(pa.FileMessageSchema, { action: A.UPDATE, folder: { key: 'p1', name: 'Some Plugin', isPlugin: true, files: [] } }));
    s.handle(inbound(pa.FileMessageSchema, { action: A.UPDATE, folder: { key: 'p1/rock', parentKey: 'p1', name: 'Rock', isPlugin: true, files: named('d') } }));
    s.handle(inbound(pa.FileMessageSchema, { action: A.UPDATE, folder: { key: '/media/p4/Presets/My Presets', name: 'My Presets', files: named('e') } }));

    const groups = pluginGroups(s.getSnapshot().folders).map((g) => [g.name, g.folders.map((f) => f.name)]);
    expect(groups).toEqual([
      ['Archetype: Plini X', ['Ambient', 'Creative']], // named after the plugin's own folder
      ['Nolly', ['Ambient']], // no folder for the plugin itself -> the path; the empty folder is left out
      ['Some Plugin', ['Rock']], // flagged by the unit, outside the Plugins path -> the parent folder
    ]);
  });
});
