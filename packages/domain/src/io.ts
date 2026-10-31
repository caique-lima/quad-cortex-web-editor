// Global input/output settings (IOSettings) and master volume. Wire details from pyquadcortex (MIT; verified on CorOS 4.0.1):
//   * sparse and PORT-KEYED; ONE field per message — output `mute` and input `input_zmode` are silently dropped when they
//     share a message with another field
//   * input level: dB = -12 + 72 * level   (-12..+60 dB, measured against the unit's screen)
//   * output / USB level spans are NOT measured upstream, so output levels are shown as a position on the knob, not in dB
//   * master volume: 0..1, shown on the unit as round(volume * 100)
import { create } from '@bufbuild/protobuf';
import { pa } from '@qc/protocol';

export const INPUT_DB_MIN = -12;
export const INPUT_DB_MAX = 60;

export const inputLevelToDb = (level: number): number => INPUT_DB_MIN + (INPUT_DB_MAX - INPUT_DB_MIN) * level;
export function dbToInputLevel(db: number): number {
  if (!(db >= INPUT_DB_MIN - 1e-9 && db <= INPUT_DB_MAX + 1e-9)) throw new RangeError(`input gain must be ${INPUT_DB_MIN}..${INPUT_DB_MAX} dB, got ${db}`);
  return Math.min(1, Math.max(0, (db - INPUT_DB_MIN) / (INPUT_DB_MAX - INPUT_DB_MIN)));
}
/** One step of the input gain control (0.1 dB), in wire units. */
export const INPUT_LEVEL_STEP = 0.1 / (INPUT_DB_MAX - INPUT_DB_MIN);

export interface InputPortState { id: number; level?: number; groundLift?: boolean; impedance?: number; type?: number; plugged?: boolean }
export interface OutputPortState { id: number; level?: number; groundLift?: boolean; mute?: boolean; plugged?: boolean }
export interface IoState {
  inputs: ReadonlyMap<number, InputPortState>;
  outputs: ReadonlyMap<number, OutputPortState>;
  /** 0..1 */
  masterVolume?: number;
}
export const emptyIo = (): IoState => ({ inputs: new Map(), outputs: new Map() });

/** Fold an IOSettings push into the state (the unit sends only what changed, keyed by port). */
export function mergeIoSettings(io: IoState, m: { settings?: { inPort?: any[]; outPort?: any[] } }): IoState {
  const inputs = new Map(io.inputs);
  const outputs = new Map(io.outputs);
  for (const p of m.settings?.inPort ?? []) {
    const prev = inputs.get(p.inputPortId) ?? { id: p.inputPortId };
    inputs.set(p.inputPortId, {
      ...prev,
      ...(p.level !== undefined && { level: p.level }),
      ...(p.groundLift !== undefined && { groundLift: p.groundLift >= 0.5 }),
      ...(p.inputZmode !== undefined && { impedance: p.inputZmode }),
      ...(p.inputType !== undefined && { type: p.inputType }),
      ...(p.plugged !== undefined && { plugged: p.plugged }),
    });
  }
  for (const p of m.settings?.outPort ?? []) {
    const prev = outputs.get(p.outputPortId) ?? { id: p.outputPortId };
    outputs.set(p.outputPortId, {
      ...prev,
      ...(p.level !== undefined && { level: p.level }),
      ...(p.groundLift !== undefined && { groundLift: p.groundLift >= 0.5 }),
      ...(p.mute !== undefined && { mute: p.mute }),
      ...(p.plugged !== undefined && { plugged: p.plugged }),
    });
  }
  return { ...io, inputs, outputs };
}

type IoInit = Parameters<typeof create<typeof pa.IOSettingsMessageSchema>>[1];
const unit = (n: number, what: string) => { if (!(n >= 0 && n <= 1)) throw new RangeError(`${what} must be within 0..1, got ${n}`); return n; };
const portId = (id: number) => { if (!Number.isInteger(id) || id < 0) throw new RangeError(`bad port id ${id}`); return id; };

export type IoField = 'in.level' | 'in.groundLift' | 'out.level' | 'out.groundLift' | 'out.mute';

/** One field of one port per message — never combine fields (some are dropped when they share a message). */
export function ioMessage(field: IoField, id: number, value: number | boolean): IoInit {
  const base = { action: pa.MessageAction_Enum.UPDATE };
  portId(id);
  switch (field) {
    case 'in.level': return { ...base, settings: { inPort: [{ inputPortId: id, level: unit(Number(value), 'level') }] } };
    case 'in.groundLift': return { ...base, settings: { inPort: [{ inputPortId: id, groundLift: value ? 1 : 0 }] } };
    case 'out.level': return { ...base, settings: { outPort: [{ outputPortId: id, level: unit(Number(value), 'level') }] } };
    case 'out.groundLift': return { ...base, settings: { outPort: [{ outputPortId: id, groundLift: value ? 1 : 0 }] } };
    case 'out.mute': return { ...base, settings: { outPort: [{ outputPortId: id, mute: !!value }] } };
  }
}

export const masterVolumeMessage = (volume: number) => ({ action: pa.MessageAction_Enum.UPDATE, volume: unit(volume, 'volume') });
/** What the unit's screen shows for master volume. */
export const masterVolumeShown = (v: number) => Math.round(v * 100);
