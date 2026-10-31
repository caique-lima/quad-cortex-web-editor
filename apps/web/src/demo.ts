// Demo mode (?demo): drives the real DeviceStore/UI from a fake unit so the interface can be developed and tested
// without hardware. Uses the real block catalog captured from a CorOS 4.0.1 unit; presets and listings are synthetic.
import { clone, create } from '@bufbuild/protobuf';
import { pa, preset as P, toWire, wireModel, typeFor, typeName, type Catalog, type InboundMessage, type Session, parseModelRepoPayload } from '@qc/protocol';
import { SLOT_COUNT, type DeviceStore } from '@qc/domain';
import catalogUrl from '../../../packages/protocol/test/fixtures/model_repo_coros_4_0_1.bin?url';

const A = pa.MessageAction_Enum;
const USER = '/media/p4/Presets/My Presets';
const FACTORY = '/opt/neuraldsp/Factory Library/';

/** Synthetic plugin banks: plugin -> category folder -> preset names. */
const PLUGINS: Record<string, Record<string, string[]>> = {
  'Archetype Demo X': { Ambient: ['Glass Pad', 'Long Tail', 'Swell'], Creative: ['Octave Fuzz', 'Glitch Lead'], Rhythm: ['Tight Chug', 'Crunch Rhythm'] },
  'Demo Bass Suite': { Clean: ['Round Clean', 'Studio DI'], Drive: ['Grind', 'Fuzz Bass'] },
};

function msg(schema: Parameters<typeof typeFor>[0], init: Record<string, unknown>): InboundMessage {
  const t = typeFor(schema);
  return { type: t, typeName: typeName(t), message: create(schema, init as never), schema, encrypted: false, compressed: false, raw: new Uint8Array(), receivedAt: Date.now() };
}

/** A lane control block (input gate, output control, mixer, splitter) with the given wire values. */
function control(hash: number | undefined, vals: number[], sceneModeIdx: number[] = []) {
  return create(P.ModelSchema, {
    hash,
    params: vals.map((v, index) => create(P.ParamSchema, { index, sceneMode: sceneModeIdx.includes(index), paramValues: [create(P.ParamValueSchema, { value: { case: 'floatValue', value: v } })] })),
  });
}

function makePreset(name: string, catalog: Catalog, seed: number) {
  const cats = catalog.categories.filter((c) => !c.hidden).map((c) => [...catalog.models.values()].filter((m) => m.category === c.name && !m.hidden));
  const pick = (n: number) => { const l = cats[(seed + n * 3) % cats.length]!; return l[(seed + n) % l.length]!; };
  const place: Record<string, ReturnType<typeof pick>> = { '0,0': pick(0), '0,1': pick(1), '0,2': pick(2), '0,4': pick(3), '0,5': pick(4), '0,7': pick(5), '2,1': pick(6), '2,3': pick(7) };
  const dual = [...catalog.models.values()].find((m) => m.name === 'Dual (M)');
  if (dual) place['2,2'] = dual as (typeof place)[string]; // an IR loader, so its IR rows can be seen in the demo
  const chains = [0, 1, 2, 3].map((r) => create(P.ChainSchema, {
    inPortid: r === 0 ? 1 : r === 2 ? 2 : 0, outPortid: r === 0 ? 1 : r === 2 ? 2 : 0,
    inputControl: [control(28000, [0.3, 1, 0.5, 0.5])],
    outputControl: [control(23000, [0.76923077, 0.5, 0, 0], [0])],
    ...(r % 2 === 0 ? {
      mixer: [control(11000, [0.76923077, 0.5, 0.76923077, 0.5, 0, 0.76923077, 0])],
      combinedSplitter: [control(undefined, [0, 0, 0.5, 0.76923077, 0.76923077, 0.5, 0])],
      splitControlPoints: [create(P.SplitControlPointsSchema, { split: -1, mix: -1 })],
    } : {}),
    models: Array.from({ length: 8 }, (_, c) => {
      const m = place[`${r},${c}`];
      if (!m) return create(P.ModelSchema, {});
      return create(P.ModelSchema, {
        hash: m.id,
        params: (wireModel(catalog, m) ?? m).params.map((p, i) => create(P.ParamSchema, {
          index: i, sceneMode: i === 0 && p.type !== 'string',
          paramValues: p.type === 'string'
            ? [create(P.ParamValueSchema, { value: { case: 'stringValue', value: p.name === 'IR NAME' ? `Demo Cab ${i === 22 ? 'A' : 'B'} 57` : `${m.name}_${i < 8 ? 'Dynamic 57' : 'Ribbon 160'}` } })]
            : Array.from({ length: i === 0 ? 8 : 1 }, (_, s) => create(P.ParamValueSchema, { value: { case: 'floatValue', value: 0.2 + (((seed + i + s) % 10) / 10) * 0.6 } })),
        })),
      });
    }),
  }));
  const bypass = [0, 1, 2, 3].map((row) => create(P.BypassSchema, {
    row,
    colBypass: Array.from({ length: 8 }, (_, c) => create(P.ColBypassSchema, {
      sceneMode: row === 0 && c === 1,
      sceneBypass: Array.from({ length: row === 0 && c === 1 ? 8 : 1 }, (_, s) => create(P.SceneBypassSchema, { bypass: (row === 0 && c === 1) ? s % 2 === 1 : (row === 0 && c === 4) })),
    })),
  }));
  return create(P.BinaryPresetSchema, {
    name, chains, bypass,
    sceneLabels: ['CLEAN', 'RHYTHM', 'LEAD', ' ', 'AMBIENT', ' ', ' ', 'SOLO'],
    sceneColors: [0xff3aa0ff, 0xff44cc77, 0xffff5544, 0, 0xffaa77ff, 0, 0, 0xffffcc00],
  });
}

const NAMES = ['Clean Sparkle', 'Edge of Breakup', 'Plexi Crunch', 'Modern High Gain', 'Ambient Pad', 'Blues Lead', 'Funk Chop', 'Acoustic Sim', 'Bass DI', 'Metal Rhythm'];

export async function startDemo(store: DeviceStore): Promise<void> {
  const catalogBytes = new Uint8Array(await (await fetch(catalogUrl)).arrayBuffer());
  const catalog = parseModelRepoPayload(catalogBytes);
  const listeners = new Set<(m: InboundMessage) => void>();
  const emit = (m: InboundMessage) => listeners.forEach((l) => l(m));
  let nextId = 1n;
  let current = makePreset('Plexi Crunch 2', catalog, 2); // the demo unit's live (possibly edited) preset
  let scene = 0;
  let dirty = false;
  let history: Array<ReturnType<typeof makePreset>> = [];
  let redoStack: Array<ReturnType<typeof makePreset>> = [];
  const emitHistory = () => emit(msg(pa.UndoRedoMessageSchema, { action: A.UPDATE, undoFrames: history.map((_, i) => i), redoFrames: redoStack.map((_, i) => i) }));
  const userNames = new Map<number, string>(); // slot -> name, for the demo's My Presets folder

  const fake = {
    on: (cb: (m: InboundMessage) => void) => { listeners.add(cb); return () => listeners.delete(cb); },
    newRequestId: () => nextId++,
    async send(schema: Parameters<typeof typeFor>[0], init: any) {
      await new Promise((r) => setTimeout(r, 60));
      const t = typeName(typeFor(schema));
      const editing = ['Grid', 'GridMove', 'SceneLabel', 'SceneColor', 'SceneCopy'].includes(t) && !(t === 'Grid' && init.action === A.READ);
      if (editing) { history.push(clone(P.BinaryPresetSchema, current)); redoStack = []; setTimeout(emitHistory, 30); }
      if (t === 'IOSettings' && init.settings) {
        // The unit applies the change and pushes the new value back.
        setTimeout(() => emit(msg(pa.IOSettingsMessageSchema, { action: A.UPDATE, settings: init.settings })), 40);
      }
      if (t === 'MasterVolume' && init.volume !== undefined) setTimeout(() => emit(msg(pa.MasterVolumeMessageSchema, { action: A.UPDATE, volume: init.volume })), 40);
      if (t === 'UndoRedo' && (init.undo || init.redo)) {
        const from = init.undo ? history : redoStack;
        const to = init.undo ? redoStack : history;
        const prev = from.pop();
        if (prev) { to.push(clone(P.BinaryPresetSchema, current)); current = prev; dirty = history.length > 0; }
        emitHistory();
        emit(msg(pa.PresetDirtyMessageSchema, { action: A.UPDATE, isDirty: dirty }));
      }
      if (t === 'SetlistPosition') {
        // Plugin presets are recalled (and reported back) by key, like on the real unit.
        const pluginKey = init.isPlugin ? init.keyInPluginFolder as string : undefined;
        const slot = pluginKey ? pluginKey.length : init.position as number;
        setTimeout(() => {
          emit(msg(pa.SetlistPositionMessageSchema, pluginKey
            ? { action: A.UPDATE, isPlugin: true, keyInPluginFolder: pluginKey }
            : { action: A.UPDATE, folderKey: init.folderKey, position: slot, isFactory: init.isFactory }));
          emit(msg(pa.SceneMessageSchema, { action: A.UPDATE, selectedScene: 0 }));
          current = makePreset(pluginKey ? pluginKey.split('/').pop()!.replace(/\.pb$/, '') : `${NAMES[slot % NAMES.length]} ${slot}`, catalog, slot);
          history = []; redoStack = []; emitHistory();
          scene = 0;
          emit(msg(pa.PresetDirtyMessageSchema, { action: A.UPDATE, isDirty: false }));
          emit(msg(pa.RecallPresetMessageSchema, { action: A.UPDATE, preset: clone(P.BinaryPresetSchema, current) }));
        }, 1500); // the real unit takes 10–25 s
      }
      if (t === 'Scene') { scene = init.selectedScene; emit(msg(pa.SceneMessageSchema, { action: A.UPDATE, selectedScene: scene })); }
      if (t === 'RecallPreset' && init.action === A.READ) emit(msg(pa.RecallPresetMessageSchema, { action: A.UPDATE, preset: clone(P.BinaryPresetSchema, current) }));
      if (t === 'Grid' && init.preset) {
        // Lane routing: the unit stores whatever port id it is given without validating it.
        for (const chain of init.preset.chains ?? []) {
          const lane = current.chains[chain.row];
          if (!lane || init.action === A.DELETE) continue;
          if (chain.inPortid !== undefined) { lane.inPortid = chain.inPortid; dirty = true; }
          if (chain.outPortid !== undefined) { lane.outPortid = chain.outPortid; dirty = true; }
        }
        // Structural edits: place/replace (UPDATE with a hash) and remove (action DELETE). Row 4 is "out of DSP" in the demo:
        // like the real unit it accepts the write and silently does nothing.
        for (const chain of init.preset.chains ?? []) for (const m of chain.models ?? []) {
          const target = current.chains[chain.row]?.models[m.column];
          if (!target) continue;
          if (init.action === A.DELETE) { target.hash = undefined; target.params = []; dirty = true; }
          else if (m.hash) {
            if (chain.row === 3) continue;
            const cat = catalog.models.get(m.hash);
            target.hash = m.hash;
            target.params = ((cat && wireModel(catalog, cat)) ?? cat)?.params.map((cp, i) => {
              let w = 0.5;
              try { w = Math.min(1, Math.max(0, toWire(cp, cp.defaultValue))); } catch { /* unconvertible: leave mid */ }
              return create(P.ParamSchema, { index: i, paramValues: [create(P.ParamValueSchema, { value: { case: 'floatValue', value: w } })] });
            }) ?? [];
            dirty = true;
            emit(msg(pa.GridMessageSchema, { action: A.UPDATE, requestId: init.requestId, preset: init.preset })); // the echo of an accepted placement
          }
        }
        // Lane controls (keyed by hash, or bare for the splitter) and branch columns.
        for (const chain of init.preset.chains ?? []) {
          const lane = current.chains[chain.row];
          if (!lane) continue;
          const apply = (written: Array<{ params?: any[] }> | undefined, mine: Array<{ params: any[] }>) => {
            const target = mine[0];
            if (!target) return;
            for (const wp of written ?? []) for (const p of wp.params ?? []) {
              const tp = target.params[p.index];
              const v = p.paramValues?.[0]?.value;
              if (tp && p.sceneMode === true && !p.paramValues?.length) { if (!tp.sceneMode) { const first = tp.paramValues[0]!; tp.sceneMode = true; tp.paramValues = Array.from({ length: 8 }, () => clone(P.ParamValueSchema, first)); } }
              else if (tp && v?.case === 'floatValue') tp.paramValues[tp.sceneMode ? scene : 0] = create(P.ParamValueSchema, { value: v });
            }
          };
          apply(chain.outputControl, lane.outputControl);
          apply(chain.inputControl, lane.inputControl);
          apply(chain.mixer, lane.mixer);
          apply(chain.combinedSplitter, lane.combinedSplitter);
          if (chain.splitControlPoints?.length) { lane.splitControlPoints = chain.splitControlPoints.map((x: any) => create(P.SplitControlPointsSchema, { split: x.split, mix: x.mix })); dirty = true; }
        }
        // Apply a sparse row/column-keyed edit like the unit does. Entry [0] = the active scene.
        for (const chain of init.preset.chains ?? []) for (const m of chain.models ?? []) for (const p of m.params ?? []) {
          const target = current.chains[chain.row]?.models[m.column]?.params[p.index];
          const v = p.paramValues?.[0]?.value;
          if (target && p.sceneMode === true && !p.paramValues?.length) { // promote: the flag alone
            if (!target.sceneMode) { const first = target.paramValues[0]!; target.sceneMode = true; target.paramValues = Array.from({ length: 8 }, () => clone(P.ParamValueSchema, first)); }
          } else if (target && v?.case === 'floatValue') target.paramValues[target.sceneMode ? scene : 0] = create(P.ParamValueSchema, { value: v });
        }
        for (const b of init.preset.bypass ?? []) for (const cb of b.colBypass ?? []) {
          const target = current.bypass[b.row]?.colBypass[cb.column];
          if (!target) continue;
          const on = cb.sceneBypass?.[0]?.bypass === true;
          if (target.sceneMode) target.sceneBypass[scene] = create(P.SceneBypassSchema, { bypass: on });
          else target.sceneBypass = target.sceneBypass.map(() => create(P.SceneBypassSchema, { bypass: on }));
        }
        dirty = true;
        emit(msg(pa.PresetDirtyMessageSchema, { action: A.UPDATE, isDirty: true }));
      }
      if (t === 'GridMove') {
        for (const mv of init.move ?? []) {
          const src = current.chains[mv.fromRow]?.models[mv.fromCol];
          const dst = current.chains[mv.toRow]?.models[mv.toCol];
          if (src?.hash && dst && !dst.hash) { dst.hash = src.hash; dst.params = src.params; src.hash = undefined; src.params = []; dirty = true; }
        }
      }
      const pushScenes = () => {
        for (let i = 0; i < 8; i++) {
          emit(msg(pa.SceneLabelMessageSchema, { action: A.UPDATE, index: i, label: current.sceneLabels[i] ?? ' ' }));
          emit(msg(pa.SceneColorMessageSchema, { action: A.UPDATE, index: i, color: current.sceneColors[i] ?? 0 }));
        }
        dirty = true;
        emit(msg(pa.PresetDirtyMessageSchema, { action: A.UPDATE, isDirty: true }));
      };
      if (t === 'SceneLabel') { current.sceneLabels[init.index] = init.label; pushScenes(); }
      if (t === 'SceneColor') { current.sceneColors[init.index] = init.color; pushScenes(); }
      if (t === 'SceneCopy') {
        const { fromIndex: a, toIndex: b, isSwap } = init;
        const [la, lb, ca, cb] = [current.sceneLabels[a] ?? ' ', current.sceneLabels[b] ?? ' ', current.sceneColors[a] ?? 0, current.sceneColors[b] ?? 0];
        current.sceneLabels[b] = la; current.sceneColors[b] = ca;
        if (isSwap) { current.sceneLabels[a] = lb; current.sceneColors[a] = cb; }
        pushScenes();
      }
      if (t === 'File' && init.action === A.CREATE && init.folder?.files?.[0]) {
        // Save: snapshot the live grid into the slot; the unit de-duplicates names with a _N suffix (max 20 chars).
        const f = init.folder.files[0];
        let name: string = f.name;
        const taken = (n: string) => [...userNames].some(([i, v]) => i !== f.index && v === n);
        for (let n = 2; taken(name); n++) name = `${f.name.slice(0, 20 - String(n).length - 1)}_${n}`;
        userNames.set(f.index, name);
        current.name = name;
        dirty = false;
        setTimeout(() => {
          emit(msg(pa.FileMessageSchema, { action: A.UPDATE, folder: { key: init.folder.key, files: [{ index: f.index, name, key: `${f.index}.pb`, instrument: f.instrument }] } }));
          emit(msg(pa.PresetDirtyMessageSchema, { action: A.UPDATE, isDirty: false }));
        }, 400);
      }
    },
  } as unknown as Session;

  store.attach(fake);
  emit(msg(pa.VersionMessageSchema, { action: A.UPDATE, zenosGitHash: '4.1.0', appFwVersion: 'demo', customName: 'Demo Cortex' }));
  emit(msg(pa.ModelRepoMessageSchema, { action: A.UPDATE, modelRepoPayload: catalogBytes }));
  emit(msg(pa.IOSettingsMessageSchema, { action: A.UPDATE, settings: {
    inPort: [{ inputPortId: 1, level: 1 / 6, groundLift: 0, plugged: true }, { inputPortId: 2, level: 1 / 6, groundLift: 0, plugged: false }],
    outPort: [4, 5, 6, 7].map((id) => ({ outputPortId: id, level: 0.5, groundLift: 0, mute: false, plugged: id < 6 })),
  } }));
  emit(msg(pa.MasterVolumeMessageSchema, { action: A.UPDATE, volume: 0.5 }));
  for (let i = 0; i < 70; i++) userNames.set(i, `${NAMES[i % NAMES.length]} ${i}`);
  const listing = (named: number) => Array.from({ length: SLOT_COUNT }, (_, i) => (i < named ? { index: i, name: `${NAMES[i % NAMES.length]} ${i}`, key: `${i}.pb`, instrument: 1 } : { index: i }));
  emit(msg(pa.FileMessageSchema, { action: A.UPDATE, folder: { key: USER, name: 'My Presets', files: listing(70) } }));
  emit(msg(pa.FileMessageSchema, { action: A.UPDATE, folder: { key: FACTORY, name: 'Factory Library', isFactory: true, files: listing(256) } }));
  for (const [plugin, categories] of Object.entries(PLUGINS)) {
    for (const [category, names] of Object.entries(categories)) {
      const key = `/opt/neuraldsp/Plugins/${plugin}/Presets/${category}`;
      emit(msg(pa.FileMessageSchema, { action: A.UPDATE, folder: { key, name: category, isPlugin: true, files: names.map((name, index) => ({ index, name, key: `${key}/${name}.pb`, instrument: 1 })) } }));
    }
  }
  emit(msg(pa.FileMessageSchema, { action: A.UPDATE, folder: { key: '/media/p4/Neural Captures/Mine', name: 'Captures', files: listing(5) } }));
  emit(msg(pa.SetlistPositionMessageSchema, { action: A.UPDATE, folderKey: USER, position: 2, isFactory: false }));
  setTimeout(() => { emit(msg(pa.RecallPresetMessageSchema, { action: A.UPDATE, preset: clone(P.BinaryPresetSchema, current) })); emit(msg(pa.PresetDirtyMessageSchema, { action: A.UPDATE, isDirty: false })); }, 1200);
}
