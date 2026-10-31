import { clone, create } from '@bufbuild/protobuf';
import { pa, preset as P, toWire, typeFor, typeName, type InboundMessage, type Session } from '@qc/protocol';
import type { DeviceStore } from '../src/store';
import { catalog } from './helpers';

const A = pa.MessageAction_Enum;

/** A small stand-in for the unit: keeps a live preset and applies the same sparse edits the real one does (per pyquadcortex's notes). */
export class FakeUnit {
  scene = 0;
  writes = 0;
  constructor(private store: DeviceStore, session: Session, public live: P.BinaryPreset) {
    const orig = session.send.bind(session);
    (session as any).send = async (schema: any, init: any) => {
      await orig(schema, init);
      this.handle(schema, init);
    };
  }

  private push(schema: any, init: Record<string, unknown>) {
    const t = typeFor(schema);
    const message = create(schema, init as never);
    const m: InboundMessage = { type: t, typeName: typeName(t), message, schema, encrypted: false, compressed: false, raw: new Uint8Array(), receivedAt: Date.now() };
    queueMicrotask(() => this.store.handle(m));
  }

  private handle(schema: any, init: any) {
    const name = typeName(typeFor(schema));
    if (name === 'RecallPreset' && init.action === A.READ) this.push(pa.RecallPresetMessageSchema, { action: A.UPDATE, preset: clone(P.BinaryPresetSchema, this.live) });
    else if (name === 'Scene') { this.scene = init.selectedScene; this.push(pa.SceneMessageSchema, { action: A.UPDATE, selectedScene: this.scene }); }
    else if (name === 'SceneLabel') { this.live.sceneLabels[init.index] = init.label; this.push(pa.SceneLabelMessageSchema, { action: A.UPDATE, index: init.index, label: init.label }); }
    else if (name === 'SceneColor') { this.live.sceneColors[init.index] = init.color; this.push(pa.SceneColorMessageSchema, { action: A.UPDATE, index: init.index, color: init.color }); }
    else if (name === 'Grid' && init.preset) this.grid(init.action, init.preset);
  }

  private writeParams(container: P.Model | undefined, written: P.Param[]) {
    if (!container) return;
    for (const wp of written) {
      const p = container.params.find((q, i) => (q.index ?? i) === wp.index);
      if (!p) continue;
      this.writes++;
      if (wp.sceneMode === true && wp.paramValues.length === 0) { // promotion: the flag alone
        if (!p.sceneMode) { p.sceneMode = true; const v = p.paramValues[0]!; p.paramValues = Array.from({ length: 8 }, () => clone(P.ParamValueSchema, v)); }
        continue;
      }
      const v = wp.paramValues[0];
      if (v?.value.case !== 'floatValue') continue;
      if (p.sceneMode) p.paramValues[this.scene] = clone(P.ParamValueSchema, v); else p.paramValues = [clone(P.ParamValueSchema, v)];
    }
  }

  private grid(action: number, w: P.BinaryPreset) {
    for (const wc of w.chains) {
      const row = wc.row ?? 0;
      const chain = this.live.chains[row];
      if (!chain) continue;
      if (wc.inPortid !== undefined) chain.inPortid = wc.inPortid;
      if (wc.outPortid !== undefined) chain.outPortid = wc.outPortid;
      if (wc.splitControlPoints.length) chain.splitControlPoints = wc.splitControlPoints.map((x) => create(P.SplitControlPointsSchema, { split: x.split, mix: x.mix }));
      for (const wm of wc.models) {
        const m = chain.models[wm.column ?? 0];
        if (!m) continue;
        if (action === A.DELETE) { m.hash = undefined; m.params = []; continue; }
        if (wm.hash) { // placement: the unit fills in default parameters
          m.hash = wm.hash;
          m.params = (catalog.models.get(wm.hash)?.params ?? []).map((cp, index) => {
            let v = 0.5;
            try { v = Math.min(1, Math.max(0, toWire(cp, cp.defaultValue))); } catch { /* leave mid */ }
            return create(P.ParamSchema, { index, sceneMode: false, paramValues: [create(P.ParamValueSchema, { value: { case: 'floatValue', value: v } })] });
          });
        } else this.writeParams(m, wm.params);
      }
      this.writeParams(chain.outputControl[0], wc.outputControl[0]?.params ?? []);
      this.writeParams(chain.inputControl[0], wc.inputControl[0]?.params ?? []);
      this.writeParams(chain.mixer[0], wc.mixer[0]?.params ?? []);
      this.writeParams(chain.combinedSplitter[0], wc.combinedSplitter[0]?.params ?? []);
    }
    for (const wb of w.bypass) for (const wcb of wb.colBypass) {
      const entry = this.live.bypass[wb.row ?? 0]?.colBypass[wcb.column ?? 0];
      if (!entry) continue;
      const on = wcb.sceneBypass[0]?.bypass === true;
      if (entry.sceneMode) entry.sceneBypass[this.scene] = create(P.SceneBypassSchema, { bypass: on });
      else entry.sceneBypass = entry.sceneBypass.map(() => create(P.SceneBypassSchema, { bypass: on }));
    }
  }
}
