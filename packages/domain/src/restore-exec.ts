import { diffPresets, planStructure, planValues, unsupportedInSnapshot, type ValueOp } from './restore';
import type { DeviceStore } from './store';
import type { preset as PT } from '@qc/protocol';

export interface RestoreProgress { phase: string; done: number; total: number }

export interface RestoreReport {
  /** Differences left between the snapshot and the unit's live preset, in the dimensions this app restores. Empty = matches. */
  mismatches: string[];
  /** Blocks etc. that were not placed, with the reason. */
  skipped: string[];
  /** Judgement calls and limits that affected the result. */
  notes: string[];
  /** Parts of the snapshot this app never restores. */
  unsupported: string[];
  /** Edits that failed outright. */
  errors: string[];
  stepsRun: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BATCH = 40;

/**
 * Make the unit's LIVE preset match a snapshot, as far as this app can. Nothing is saved: the result is live and unsaved,
 * so the caller (the person) decides whether to Save. Order: structure -> read back -> values -> read back -> report.
 */
export async function restoreSnapshot(store: DeviceStore, snap: PT.BinaryPreset, onProgress: (p: RestoreProgress) => void = () => {}): Promise<RestoreReport> {
  const report: RestoreReport = { mismatches: [], skipped: [], notes: [], unsupported: unsupportedInSnapshot(snap), errors: [], stepsRun: 0 };
  const catalog = () => store.getSnapshot().catalog;
  const attempt = async (what: string, fn: () => Promise<void>) => {
    try { await fn(); report.stepsRun++; } catch (e) { report.errors.push(`${what}: ${e instanceof Error ? e.message : String(e)}`); }
  };

  // ---- phase 1: structure ----
  onProgress({ phase: 'Reading the unit', done: 0, total: 1 });
  let live = await store.readLive();
  const sp = planStructure(live, snap, catalog());
  report.skipped.push(...sp.skipped);
  for (const [i, step] of sp.steps.entries()) {
    onProgress({ phase: 'Routing and blocks', done: i, total: sp.steps.length });
    switch (step.kind) {
      case 'lanePort': await attempt(`lane ${step.row + 1} ${step.side}put`, () => store.setLanePort(step.row, step.side, step.id)); break;
      case 'split': await attempt(`branch of lane ${step.row + 1}`, () => store.setSplit(step.row, step.split, step.mix)); break;
      case 'remove': await attempt(`remove at row ${step.row + 1}, column ${step.column + 1}`, () => store.removeBlock(step.row, step.column)); break;
      case 'place': await attempt(`${step.name} at row ${step.row + 1}, column ${step.column + 1}`, () => store.placeBlock(step.row, step.column, step.hash)); break;
    }
  }
  if (sp.steps.length > 0) await store.settle(); // read-backs (with one retry for placements); failures show up in the final comparison
  live = await store.readLive();

  // ---- phase 2: values ----
  store.beginBulk();
  try {
    let plan = planValues(live, snap);
    if (plan.promotes.length > 0) {
      for (const [i, p] of plan.promotes.entries()) {
        onProgress({ phase: 'Enabling per-scene values', done: i, total: plan.promotes.length });
        await attempt(`per-scene mode for ${p.target.kind} #${p.index}`, () => store.promoteParam(p.target, p.index));
      }
      live = await store.readLive(); // learn which promotions took, then plan from what the unit really holds
      plan = planValues(live, snap);
      if (plan.promotes.length > 0) report.notes.push(`${plan.promotes.length} parameter${plan.promotes.length === 1 ? '' : 's'} would not switch to per-scene mode, so their per-scene values were not restored`);
    }
    report.notes.push(...plan.notes);

    const run = async (op: ValueOp) => {
      if (op.kind === 'param') await attempt(op.label, () => store.setControlParam(op.target, op.index, op.wire, op.label));
      else await attempt(`bypass at row ${op.row + 1}, column ${op.column + 1}`, () => store.setBypass(op.row, op.column, op.bypassed));
    };
    const total = plan.global.length + plan.perScene.reduce((n, l) => n + l.length, 0) + plan.labels.length + plan.colors.length;
    let done = 0;
    const tick = async () => { done++; if (done % BATCH === 0) { await store.drainWrites(); await sleep(5); } onProgress({ phase: 'Values', done, total }); };

    for (const op of plan.global) { await run(op); await tick(); }
    await store.drainWrites();

    for (let scene = 0; scene < plan.perScene.length; scene++) {
      const ops = plan.perScene[scene]!;
      if (ops.length === 0) continue;
      await attempt(`switch to scene ${scene + 1}`, async () => { await store.selectScene(scene); await store.waitForScene(scene); });
      for (const op of ops) { await run(op); await tick(); }
      await store.drainWrites();
    }
    for (const l of plan.labels) { await attempt(`scene ${l.index + 1} name`, () => store.setSceneLabel(l.index, l.label)); await tick(); }
    for (const c of plan.colors) { await attempt(`scene ${c.index + 1} colour`, () => store.setSceneColor(c.index, c.argb)); await tick(); }

    // leave the unit on the scene the snapshot was saved on
    const target = snap.defaultScene ?? 0;
    await attempt(`switch to scene ${target + 1}`, async () => { await store.selectScene(target); await store.waitForScene(target); });
    await store.drainWrites();
  } finally {
    store.endBulk();
  }

  // ---- final comparison ----
  onProgress({ phase: 'Checking the result', done: 0, total: 1 });
  await sleep(300); // let the scene/label pushes land
  const finalLive = await store.readLive();
  report.mismatches = diffPresets(snap, finalLive, catalog());
  onProgress({ phase: 'Done', done: 1, total: 1 });
  return report;
}
