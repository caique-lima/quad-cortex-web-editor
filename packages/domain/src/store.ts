import {
  parseModelRepoPayload, pa, preset as PS, type Catalog, type InboundMessage, type Session, type preset as P,
} from '@qc/protocol';
import { toBinary } from '@bufbuild/protobuf';
import { emptyIo, ioMessage, masterVolumeMessage, mergeIoSettings, type IoField, type IoState } from './io';
import {
  bypassEditMessage, blockTarget, describeTarget, moveBlockMessage, paramEditMessageFor, paramPromoteMessage, placeBlockMessage, placeRefusal, readBypass, readCellHash, readParamAt, targetKey, type ParamTarget,
  removeBlockMessage, lanePortMessage, readLanePort, readSplit, splitMessage, withLanePort, withSplit, type LaneSide, sceneColorMessage, sceneCopyMessage, sceneLabelMessage, withBypass, withoutBlock, withParamAt, withSceneColor, withSceneLabel,
} from './edits';
import { slotLabel } from './slots';

export type FolderKind = 'presets' | 'captures' | 'irs' | 'other';

export interface Slot {
  index: number;
  /** Absent for an empty slot. */
  name?: string;
  key?: string;
  instrument?: number;
  readOnly?: boolean;
  /** Set on Downloads (cloud) presets; the unit loads those by this id. */
  cloudId?: string;
}

export interface Folder {
  key: string;
  parentKey?: string;
  name: string;
  isFactory: boolean;
  isDownloads: boolean;
  isCloud: boolean;
  isFavorites: boolean;
  isPlugin: boolean;
  kind: FolderKind;
  /** Slots by index, as listed by the unit. */
  slots: ReadonlyMap<number, Slot>;
}

export interface SetlistPosition {
  folderKey: string;
  position: number;
  isFactory: boolean;
  /** Plugin and Downloads presets are not setlist slots: the unit loads them by key and ignores folder + position. */
  pluginKey?: string;
  downloadsKey?: string;
}

export interface DeviceInfo {
  coros?: string;
  firmware?: string;
  name?: string;
}

export interface DeviceState {
  info?: DeviceInfo;
  catalog?: Catalog;
  folders: ReadonlyMap<string, Folder>;
  preset?: P.BinaryPreset;
  /** Increments every time the unit pushes a preset (recall, undo, save). */
  presetRevision: number;
  position?: SetlistPosition;
  selectedScene: number;
  dirty: boolean;
  /** A recall was requested and the unit hasn't pushed the preset yet (can take 10–25 s). */
  loadingPreset: boolean;
  lastError?: string;
  /** Number of read-backs that confirmed the unit applied our edits (diagnostics). */
  verifiedReadBacks: number;
  /** A block was placed/moved/removed and the unit's result has not been confirmed by read-back yet. */
  structuralPending: boolean;
  /** Steps the unit says it can undo / redo (from its UndoRedo pushes). */
  undoCount: number;
  redoCount: number;
  /** Global input/output settings and master volume, as the unit reports them. */
  io: IoState;
}

export interface SaveTarget { folderKey: string; index: number; name: string }
export interface SaveResult {
  /** Name the unit stored (it de-duplicates collisions by appending _N). */
  savedName: string;
  renamed: boolean;
  /** A snapshot of the replaced preset was handed to the snapshot sink first. */
  snapshotted: boolean;
  replaced?: string;
}
/** What an overwrite replaces, as kept in the browser. `preset` is the BinaryPreset protobuf bytes. */
export interface PresetSnapshot { savedAt: number; folderKey: string; folderName: string; index: number; name: string; preset: Uint8Array }

export const MAX_NAME_LENGTH = 20;
const SAVE_ACK_TIMEOUT_MS = 15_000;
/** The unit needs ~0.3 s to accept a placement; read back after this, and once more if it isn't there yet. */
const PUSH_EXPECT_TIMEOUT_MS = 3000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RECALL_TIMEOUT_MS = 45_000;
const VERIFY_TIMEOUT_MS = 10_000;
/** A Grid push this soon after we sent an edit is taken to be the unit's echo of it. */
const ECHO_WINDOW_MS = 1500;

/** Best-effort classification from the folder key; refine once we have seen real listings. */
export function folderKind(key: string): FolderKind {
  if (/capture/i.test(key)) return 'captures';
  if (/impulse|(^|\/)irs?(\/|$)/i.test(key)) return 'irs';
  if (/preset|factory library/i.test(key)) return 'presets';
  return 'other';
}

/** Plugin banks (e.g. an Archetype's Ambient, Creative… folders) live under /opt/neuraldsp/Plugins; the path counts in case the flag is missing. */
export function isPluginFolder(f: Folder): boolean {
  return f.isPlugin || /^\/opt\/neuraldsp\/Plugins\//i.test(f.key);
}
export function isDownloadsFolder(f: Folder): boolean {
  return f.isDownloads || /^cloud-/i.test(f.key);
}

/** What to send to load `slot` of `folder`: setlists by folder + position, plugin and Downloads presets by their key. */
export function recallTarget(folder: Folder, slot: Slot): SetlistPosition {
  const target: SetlistPosition = { folderKey: folder.key, position: slot.index, isFactory: folder.isFactory };
  if (isDownloadsFolder(folder)) {
    const key = slot.cloudId ?? slot.key;
    if (!key) throw new Error(`The unit did not list a key for “${slot.name ?? slotLabel(slot.index)}”, so it can't be loaded from here.`);
    return { ...target, downloadsKey: key };
  }
  if (isPluginFolder(folder)) {
    if (!slot.key) throw new Error(`The unit did not list a key for “${slot.name ?? slotLabel(slot.index)}”, so it can't be loaded from here.`);
    return { ...target, pluginKey: slot.key };
  }
  return target;
}

export interface StoreOptions {
  /** Batch change notifications. 0 = synchronous (tests). */
  notifyDelayMs?: number;
  /** Coalesce rapid edits of the same parameter (slider drags) into at most one write per this many ms. */
  editThrottleMs?: number;
  /** After the last edit, wait this long, then read the live preset back to verify the unit applied it. */
  verifyDelayMs?: number;
  /** Called with the stored version of a preset BEFORE it is overwritten. If it throws, the save is aborted. */
  snapshotSink?: (snapshot: PresetSnapshot) => Promise<void>;
  /** Wait this long after a block edit before reading back (the unit takes ~0.3 s to accept a placement). */
  structuralVerifyDelayMs?: number;
  /** If the block isn't there yet at the first read-back, look once more after this long before reporting a refusal. */
  structuralRetryDelayMs?: number;
}

interface ExpectedParam { target: ParamTarget; index: number; wire: number; scene: number; label: string }
interface ExpectedCell { row: number; column: number; hash: number; label: string; retried?: boolean }
/** A read-back check that doesn't fit the other kinds. `apply` re-applies the change on top of a newer snapshot. */
interface ExpectedCheck { label: string; ok: (live: P.BinaryPreset) => boolean; apply: (p: P.BinaryPreset) => P.BinaryPreset | undefined }
interface ExpectedPort { row: number; side: LaneSide; id: number; label: string }
interface ExpectedBypass { row: number; column: number; bypassed: boolean; scene: number }

/** Turns the unit's pushed messages into an immutable, subscribe-able snapshot (React `useSyncExternalStore` friendly). */
export class DeviceStore {
  private state: DeviceState = {
    folders: new Map(), presetRevision: 0, selectedScene: 0, dirty: false, loadingPreset: false, verifiedReadBacks: 0, structuralPending: false, undoCount: 0, redoCount: 0, io: emptyIo(),
  };
  private pending: Partial<DeviceState> = {};
  private folderMap = new Map<string, Folder>();
  private foldersDirty = false;
  private listeners = new Set<() => void>();
  private timer?: ReturnType<typeof setTimeout>;
  private recallTimer?: ReturnType<typeof setTimeout>;
  private session?: Session;
  private readonly delay: number;
  private readonly editThrottle: number;
  private readonly verifyDelay: number;
  private readonly structuralVerifyDelay: number;
  private readonly structuralRetryDelay: number;
  private pendingWrites = new Map<string, ExpectedParam>();
  private writeTimer?: ReturnType<typeof setTimeout>;
  private verifyTimer?: ReturnType<typeof setTimeout>;
  private expectedParams = new Map<string, ExpectedParam>();
  private expectedBypass = new Map<string, ExpectedBypass>();
  /** Edits sent before the in-flight read-back; checked against its reply. */
  private verifyingParams?: Map<string, ExpectedParam>;
  private verifyingBypass?: Map<string, ExpectedBypass>;
  private expectedCells = new Map<string, ExpectedCell>();
  private verifyingCells?: Map<string, ExpectedCell>;
  private expectedPorts = new Map<string, ExpectedPort>();
  private verifyingPorts?: Map<string, ExpectedPort>;
  private expectedChecks = new Map<string, ExpectedCheck>();
  private verifyingChecks?: Map<string, ExpectedCheck>;
  private expectedPushes = new Map<string, ReturnType<typeof setTimeout>>();
  private verifyWatchdog?: ReturnType<typeof setTimeout>;
  private resyncTimer?: ReturnType<typeof setTimeout>;
  private ownRequestIds = new Set<bigint>();
  private lastEditSentAt = 0;
  private snapshotSink?: (snapshot: PresetSnapshot) => Promise<void>;
  /** The preset exactly as stored in its slot: set only when a fresh recall was followed by 'not dirty' and no local edits. */
  /** The last recall we sent, to place the unit's echo if the slot isn't in the listing yet. */
  private requested?: SetlistPosition;
  private baseline?: { preset: P.BinaryPreset; folderKey: string; position: number };
  private candidate?: P.BinaryPreset;
  private editedSinceCandidate = false;
  private readsInFlight = 0;
  private lastVerifyFailed = false;
  private saveWaiter?: (m: InboundMessage) => void;
  private bulk = false;
  private liveWaiters: Array<{ resolve: (p: P.BinaryPreset) => void; timer: ReturnType<typeof setTimeout> }> = [];

  constructor(opts: StoreOptions = {}) {
    this.delay = opts.notifyDelayMs ?? 50;
    this.editThrottle = opts.editThrottleMs ?? 40;
    this.verifyDelay = opts.verifyDelayMs ?? 700;
    this.snapshotSink = opts.snapshotSink;
    this.structuralVerifyDelay = opts.structuralVerifyDelayMs ?? 500;
    this.structuralRetryDelay = opts.structuralRetryDelayMs ?? 900;
  }

  // ---- React-friendly API --------------------------------------------------

  getSnapshot = (): DeviceState => this.state;

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  // ---- wiring --------------------------------------------------------------

  attach(session: Session): () => void {
    this.session = session;
    const off = session.on((m) => this.handle(m));
    return () => {
      off();
      this.session = undefined;
      clearTimeout(this.recallTimer);
      clearTimeout(this.writeTimer);
      clearTimeout(this.verifyTimer);
      clearTimeout(this.resyncTimer);
      clearTimeout(this.ioTimer);
    };
  }

  // ---- actions (do what the unit's own screen does; none touch saved presets) --

  /**
   * Recall a preset into the unit's live buffer. This discards any UNSAVED edits on the unit and interrupts
   * audio briefly; callers should confirm when `state.dirty`.
   */
  async recall(pos: SetlistPosition): Promise<void> {
    const s = this.requireSession();
    this.dropPendingEdits();
    this.baseline = undefined;
    this.requested = pos;
    this.set({ loadingPreset: true, lastError: undefined });
    clearTimeout(this.recallTimer);
    this.recallTimer = setTimeout(
      () => this.set({ loadingPreset: false, lastError: 'The unit did not send the preset in time.' }),
      RECALL_TIMEOUT_MS,
    );
    await s.send(pa.SetlistPositionMessageSchema, {
      action: pa.MessageAction_Enum.UPDATE,
      requestId: s.newRequestId(),
      ...(pos.downloadsKey !== undefined ? { isDownloads: true, keyInDownloads: pos.downloadsKey }
        : pos.pluginKey !== undefined ? { isPlugin: true, folderKey: pos.folderKey, keyInPluginFolder: pos.pluginKey }
        : { folderKey: pos.folderKey, position: pos.position, isFactory: pos.isFactory }),
    });
  }

  /** Load a preset as listed in the library. */
  async recallSlot(folder: Folder, slot: Slot): Promise<void> {
    await this.recall(recallTarget(folder, slot));
  }

  async selectScene(scene: number): Promise<void> {
    if (!Number.isInteger(scene) || scene < 0 || scene > 7) throw new RangeError(`scene must be 0..7, got ${scene}`);
    const s = this.requireSession();
    await s.send(pa.SceneMessageSchema, {
      action: pa.MessageAction_Enum.UPDATE,
      requestId: s.newRequestId(),
      selectedScene: scene,
    });
  }

  // ---- edits: LIVE changes on the unit; nothing is saved until an explicit save (not implemented yet) ----

  /** Throw away unsaved edits by re-loading the current slot from the unit's storage. */
  async discardChanges(): Promise<void> {
    const pos = this.state.position;
    if (!pos) throw new Error('The unit has not reported which preset is loaded.');
    await this.recall(pos);
  }

  /**
   * Set one parameter (wire value 0..1) of the block at row/column, for the active scene if the parameter is per-scene.
   * The UI updates immediately; the write is throttled; the result is verified by reading the preset back.
   */
  setParam(row: number, column: number, paramIndex: number, wire: number, label?: string): Promise<void> {
    return this.setControlParam(blockTarget(row, column), paramIndex, wire, label);
  }

  /** Same, for any container: a block, a lane's output/input-gate control, or a lane's mixer/splitter. */
  async setControlParam(target: ParamTarget, paramIndex: number, wire: number, label = `${describeTarget(target)} #${paramIndex}`): Promise<void> {
    this.requireSession();
    paramEditMessageFor(target, paramIndex, wire); // validates the target and the value before anything changes
    const base = this.pending.preset ?? this.state.preset;
    if (!base) throw new Error('No preset is loaded yet.');
    const scene = this.pending.selectedScene ?? this.state.selectedScene;
    const next = withParamAt(base, target, paramIndex, wire, scene);
    if (!next) throw new Error(`There is no parameter ${paramIndex} at ${describeTarget(target)}.`);
    this.editedSinceCandidate = true;
    this.set({ preset: next, dirty: true, lastError: undefined });
    const key = `${targetKey(target)}:${paramIndex}`;
    const e: ExpectedParam = { target, index: paramIndex, wire, scene, label };
    if (!this.bulk) this.expectedParams.set(key, e);
    this.pendingWrites.set(key, e);
    this.writeTimer ??= setTimeout(() => void this.flushWrites(), this.editThrottle);
    if (!this.bulk) this.scheduleVerify();
  }

  /**
   * Change a parameter from its LATEST value (including edits not yet published to the UI): `next` receives the current
   * wire value and returns the new one (or undefined to do nothing). Rapid taps on a ± button therefore accumulate
   * instead of all starting from the same stale render.
   */
  nudgeParam(row: number, column: number, paramIndex: number, next: (wire: number) => number | undefined, label?: string): Promise<void> {
    return this.nudgeControlParam(blockTarget(row, column), paramIndex, next, label);
  }

  async nudgeControlParam(target: ParamTarget, paramIndex: number, next: (wire: number) => number | undefined, label?: string): Promise<void> {
    const base = this.pending.preset ?? this.state.preset;
    if (!base) throw new Error('No preset is loaded yet.');
    const scene = this.pending.selectedScene ?? this.state.selectedScene;
    const cur = readParamAt(base, target, paramIndex, scene);
    if (cur === undefined) throw new Error(`There is no numeric parameter ${paramIndex} at ${describeTarget(target)}.`);
    const wire = next(cur);
    if (wire === undefined || Math.abs(wire - cur) < 1e-12) return;
    await this.setControlParam(target, paramIndex, wire, label);
  }

  /** Bypass (true) or enable (false) the block at row/column. Per-scene blocks change the active scene only. */
  async setBypass(row: number, column: number, bypassed: boolean): Promise<void> {
    const s = this.requireSession();
    const base = this.pending.preset ?? this.state.preset;
    if (!base) throw new Error('No preset is loaded yet.');
    const scene = this.pending.selectedScene ?? this.state.selectedScene;
    const next = withBypass(base, row, column, bypassed, scene);
    if (!next) throw new Error(`There is no bypass entry at row ${row + 1}, column ${column + 1}.`);
    this.editedSinceCandidate = true;
    this.set({ preset: next, dirty: true, lastError: undefined });
    if (!this.bulk) this.expectedBypass.set(`${row}:${column}`, { row, column, bypassed, scene });
    await s.send(pa.GridMessageSchema, { ...bypassEditMessage(row, column, bypassed), requestId: this.editRequestId(s) });
    if (!this.bulk) this.scheduleVerify();
  }

  /** A request id for an edit we send; remembered so the unit's echo of it can be recognised. */
  private editRequestId(s: Session): bigint {
    const id = s.newRequestId();
    this.ownRequestIds.add(id);
    if (this.ownRequestIds.size > 64) this.ownRequestIds.delete(this.ownRequestIds.values().next().value!);
    this.lastEditSentAt = Date.now();
    return id;
  }

  // ---- structural edits: blocks ---------------------------------------------------------------

  /** Send queued parameter writes now and forget param/bypass edits aimed at cells about to change shape. */
  private async beforeStructural(...cells: Array<[number, number]>): Promise<void> {
    if (this.writeTimer) { clearTimeout(this.writeTimer); await this.flushWrites(); }
    for (const [r, c] of cells) {
      for (const k of [...this.expectedParams.keys()]) if (k.startsWith(`${r}:${c}:`)) this.expectedParams.delete(k);
      this.expectedBypass.delete(`${r}:${c}`);
    }
  }

  private livePreset(): P.BinaryPreset {
    const p = this.pending.preset ?? this.state.preset;
    if (!p) throw new Error('No preset is loaded yet.');
    return p;
  }

  private blockName(hash: number): string {
    return this.state.catalog?.models.get(hash)?.name ?? `block #${hash}`;
  }

  /** Put a model in a cell (creates, or replaces whatever is there). The result is confirmed by read-back. */
  async placeBlock(row: number, column: number, hash: number): Promise<void> {
    const s = this.requireSession();
    const why = placeRefusal(this.state.catalog, hash);
    if (why) throw new Error(why);
    this.livePreset(); // a preset must be loaded
    const msg = placeBlockMessage(row, column, hash); // validates the cell and id
    await this.beforeStructural([row, column]);
    this.editedSinceCandidate = true;
    this.expectedCells.set(`${row}:${column}:cell`, { row, column, hash, label: `${this.blockName(hash)} at row ${row + 1}, column ${column + 1}` });
    this.set({ dirty: true, lastError: undefined, structuralPending: true });
    await s.send(pa.GridMessageSchema, { ...msg, requestId: this.editRequestId(s) });
    this.scheduleVerify(this.structuralVerifyDelay);
  }

  /** Empty a cell. Shown immediately; confirmed by read-back. */
  async removeBlock(row: number, column: number): Promise<void> {
    const s = this.requireSession();
    const msg = removeBlockMessage(row, column);
    const base = this.livePreset();
    if (readCellHash(base, row, column) === 0) throw new Error(`Row ${row + 1}, column ${column + 1} is already empty.`);
    await this.beforeStructural([row, column]);
    this.editedSinceCandidate = true;
    this.expectedCells.set(`${row}:${column}:cell`, { row, column, hash: 0, label: `removal at row ${row + 1}, column ${column + 1}` });
    this.set({ preset: withoutBlock(base, row, column) ?? base, dirty: true, lastError: undefined, structuralPending: true });
    await s.send(pa.GridMessageSchema, { ...msg, requestId: this.editRequestId(s) });
    this.scheduleVerify(this.structuralVerifyDelay);
  }

  /**
   * Move a block to an EMPTY cell. Moving to another row creates a parallel path (the unit computes the split/mix
   * columns). The result is read back, not guessed.
   */
  async moveBlock(fromRow: number, fromCol: number, toRow: number, toCol: number): Promise<void> {
    const s = this.requireSession();
    const msg = moveBlockMessage(fromRow, fromCol, toRow, toCol);
    const base = this.livePreset();
    const hash = readCellHash(base, fromRow, fromCol);
    if (hash === 0) throw new Error(`Row ${fromRow + 1}, column ${fromCol + 1} has no block to move.`);
    if (readCellHash(base, toRow, toCol) !== 0) throw new Error(`Row ${toRow + 1}, column ${toCol + 1} is not empty. Move it to an empty cell.`);
    await this.beforeStructural([fromRow, fromCol], [toRow, toCol]);
    this.editedSinceCandidate = true;
    const name = this.blockName(hash);
    this.expectedCells.set(`${fromRow}:${fromCol}:cell`, { row: fromRow, column: fromCol, hash: 0, label: `${name} leaving row ${fromRow + 1}, column ${fromCol + 1}` });
    this.expectedCells.set(`${toRow}:${toCol}:cell`, { row: toRow, column: toCol, hash, label: `${name} arriving at row ${toRow + 1}, column ${toCol + 1}` });
    this.set({ dirty: true, lastError: undefined, structuralPending: true });
    await s.send(pa.GridMoveMessageSchema, { ...msg, requestId: this.editRequestId(s) });
    this.scheduleVerify(this.structuralVerifyDelay);
  }

  // ---- undo / redo: the unit's own history (UndoRedo{UPDATE, undo|redo: true}) ---------------------

  async undo(): Promise<void> { await this.stepHistory('undo'); }
  async redo(): Promise<void> { await this.stepHistory('redo'); }

  /** Ask the unit to undo/redo its last grid edit, then re-read the live grid. Pending checks of OUR edits no longer apply. */
  private async stepHistory(kind: 'undo' | 'redo'): Promise<void> {
    const s = this.requireSession();
    if (this.writeTimer) { clearTimeout(this.writeTimer); await this.flushWrites(); } // our queued edits go out first, in order
    this.dropPendingEdits();
    this.set({ lastError: undefined });
    await s.send(pa.UndoRedoMessageSchema, { action: pa.MessageAction_Enum.UPDATE, requestId: s.newRequestId(), [kind]: true });
    this.scheduleResync();
  }

  // ---- bulk editing (used by restore) ----------------------------------------------------------------------

  /** While bulk, edits are written and shown but not individually verified: the caller reads the live preset back itself. */
  beginBulk(): void { this.bulk = true; }
  endBulk(): void { this.bulk = false; }

  /** Send queued parameter writes now. */
  async drainWrites(): Promise<void> {
    if (this.writeTimer) { clearTimeout(this.writeTimer); await this.flushWrites(); }
  }

  /** Read the unit's LIVE preset (unsaved edits included) and return it. Side-effect free on the unit. */
  async readLive(timeoutMs = 15_000): Promise<P.BinaryPreset> {
    const s = this.requireSession();
    await this.drainWrites();
    return new Promise<P.BinaryPreset>((resolve, reject) => {
      const waiter = {
        resolve,
        timer: setTimeout(() => {
          this.liveWaiters = this.liveWaiters.filter((w) => w !== waiter);
          this.readsInFlight = Math.max(0, this.readsInFlight - 1);
          reject(new Error('The unit did not send its live preset.'));
        }, timeoutMs),
      };
      this.liveWaiters.push(waiter);
      this.readsInFlight++;
      s.send(pa.RecallPresetMessageSchema, { action: pa.MessageAction_Enum.READ, requestId: s.newRequestId() }).catch((e) => {
        clearTimeout(waiter.timer);
        this.liveWaiters = this.liveWaiters.filter((w) => w !== waiter);
        this.readsInFlight = Math.max(0, this.readsInFlight - 1);
        reject(e);
      });
    });
  }

  /** Wait until the unit reports `scene` as the active one (a scene switch is asynchronous). */
  async waitForScene(scene: number, timeoutMs = 4000): Promise<void> {
    const t0 = Date.now();
    while ((this.pending.selectedScene ?? this.state.selectedScene) !== scene) {
      if (Date.now() - t0 > timeoutMs) throw new Error(`The unit did not switch to scene ${scene + 1}.`);
      await sleep(15);
    }
  }

  /** Switch a parameter to per-scene mode (the unit only keeps per-scene values for parameters with this flag). */
  async promoteParam(target: ParamTarget, paramIndex: number): Promise<void> {
    const s = this.requireSession();
    const msg = paramPromoteMessage(target, paramIndex);
    this.editedSinceCandidate = true;
    this.set({ dirty: true });
    await s.send(pa.GridMessageSchema, { ...msg, requestId: this.editRequestId(s) });
  }

  /** Wait for confirmation of everything edited so far. False if the unit did not apply something. */
  settle(): Promise<boolean> { return this.settleEdits(); }

  // ---- lane routing -----------------------------------------------------------------------------

  /**
   * Point a lane's input or output at a port. Only known ports can be written (the unit doesn't validate: an unknown id
   * is stored and the lane goes silent). Shown immediately, confirmed by read-back, undone by Discard.
   */
  async setLanePort(row: number, side: LaneSide, id: number): Promise<void> {
    const s = this.requireSession();
    const msg = lanePortMessage(row, side, id); // validates row and port
    const base = this.livePreset();
    const next = withLanePort(base, row, side, id);
    if (!next) throw new Error(`There is no lane ${row + 1}.`);
    this.editedSinceCandidate = true;
    this.expectedPorts.set(`${row}:${side}`, { row, side, id, label: `${side === 'in' ? 'input' : 'output'} of lane ${row + 1}` });
    this.set({ preset: next, dirty: true, lastError: undefined });
    await s.send(pa.GridMessageSchema, { ...msg, requestId: this.editRequestId(s) });
    this.scheduleVerify();
  }

  // ---- branching (split / mix columns) ----------------------------------------------------------

  /**
   * Make lane 1 or 3 branch into the lane below it between two columns, or clear the branch (split -1, mix -1).
   * The unit computes nothing else here; the splitter/mixer parameters are edited separately.
   */
  async setSplit(row: number, split: number, mix: number): Promise<void> {
    const s = this.requireSession();
    const msg = splitMessage(row, split, mix);
    const base = this.livePreset();
    const next = withSplit(base, row, split, mix);
    if (!next) throw new Error(`There is no lane ${row + 1}.`);
    this.editedSinceCandidate = true;
    this.expectedChecks.set(`split:${row}`, {
      label: `branch of lane ${row + 1}`,
      ok: (live) => { const r = readSplit(live, row); return r?.split === split && r?.mix === mix; },
      apply: (p) => withSplit(p, row, split, mix),
    });
    this.set({ preset: next, dirty: true, lastError: undefined });
    await s.send(pa.GridMessageSchema, { ...msg, requestId: this.editRequestId(s) });
    this.scheduleVerify();
  }

  // ---- global input/output settings + master volume ---------------------------------------------------

  private ioQueue = new Map<string, { field: IoField; id: number; value: number | boolean }>();
  private ioTimer?: ReturnType<typeof setTimeout>;

  /**
   * Change one global setting. Shown at once; written (rapid changes of the same field coalesce to the last one);
   * the unit's own IOSettings push confirms it — if none arrives you are told.
   */
  async setIo(field: IoField, id: number, value: number | boolean): Promise<void> {
    this.requireSession();
    ioMessage(field, id, value); // validate before changing anything
    const known = field.startsWith('in.') ? this.state.io.inputs : this.state.io.outputs;
    if (!known.has(id) && !(this.pending.io && (field.startsWith('in.') ? this.pending.io.inputs : this.pending.io.outputs).has(id))) {
      throw new Error(`The unit has not reported port ${id}.`);
    }
    const io = this.pending.io ?? this.state.io;
    const side = field.startsWith('in.') ? 'inputs' : 'outputs';
    const map = new Map<number, any>(io[side] as ReadonlyMap<number, any>);
    const prop = field.split('.')[1] as string;
    map.set(id, { ...map.get(id), [prop]: value });
    this.set({ io: { ...io, [side]: map }, lastError: undefined });
    this.ioQueue.set(`${field}:${id}`, { field, id, value });
    this.ioTimer ??= setTimeout(() => void this.flushIo(), this.editThrottle);
    this.expectPush(`io:${field}:${id}`, `${field.replace('.', ' ')} of port ${id}`);
  }

  private async flushIo(): Promise<void> {
    this.ioTimer = undefined;
    const s = this.session;
    const batch = [...this.ioQueue.values()];
    this.ioQueue.clear();
    if (!s) return;
    try {
      for (const e of batch) await s.send(pa.IOSettingsMessageSchema, { ...ioMessage(e.field, e.id, e.value), requestId: s.newRequestId() });
    } catch (err) {
      this.set({ lastError: `Could not send the setting: ${String(err)}` });
    }
  }

  /** Move a level by `delta` (wire units) from its LATEST value, so rapid taps accumulate. Clamped to 0..1. */
  async nudgeIo(field: 'in.level' | 'out.level', id: number, delta: number): Promise<void> {
    const io = this.pending.io ?? this.state.io;
    const cur = (field === 'in.level' ? io.inputs.get(id) : io.outputs.get(id))?.level;
    if (cur === undefined) throw new Error(`The unit has not reported a level for port ${id}.`);
    await this.setIo(field, id, Math.min(1, Math.max(0, cur + delta)));
  }

  async nudgeMasterVolume(delta: number): Promise<void> {
    const cur = (this.pending.io ?? this.state.io).masterVolume;
    if (cur === undefined) throw new Error('The unit has not reported its master volume.');
    await this.setMasterVolume(Math.min(1, Math.max(0, cur + delta)));
  }

  /** Master volume, 0..1 (the unit shows round(volume*100)). */
  async setMasterVolume(volume: number): Promise<void> {
    const s = this.requireSession();
    const msg = masterVolumeMessage(volume);
    this.set({ io: { ...(this.pending.io ?? this.state.io), masterVolume: volume }, lastError: undefined });
    this.expectPush('io:master', 'master volume');
    await s.send(pa.MasterVolumeMessageSchema, { ...msg, requestId: s.newRequestId() });
  }

  // ---- scenes: name, colour, copy/swap ----------------------------------------------------------
  // The unit answers a scene edit by re-sending the labels/colours (SceneLabel/SceneColor pushes), which is what we show.

  private expectPush(key: string, what: string): void {
    clearTimeout(this.expectedPushes.get(key));
    this.expectedPushes.set(key, setTimeout(() => {
      this.expectedPushes.delete(key);
      this.set({ lastError: `The unit did not confirm the change to ${what}.` });
    }, PUSH_EXPECT_TIMEOUT_MS));
  }

  private gotPush(key: string): void {
    const t = this.expectedPushes.get(key);
    if (t !== undefined) { clearTimeout(t); this.expectedPushes.delete(key); }
  }

  async setSceneLabel(index: number, label: string): Promise<void> {
    const s = this.requireSession();
    const msg = sceneLabelMessage(index, label);
    this.editedSinceCandidate = true;
    this.set({ dirty: true, lastError: undefined });
    this.expectPush(`label:${index}`, `scene ${index + 1}'s name`);
    await s.send(pa.SceneLabelMessageSchema, { ...msg, requestId: this.editRequestId(s) });
  }

  /** `argb` = 0xAARRGGBB; 0 = no colour. */
  async setSceneColor(index: number, argb: number): Promise<void> {
    const s = this.requireSession();
    const msg = sceneColorMessage(index, argb);
    this.editedSinceCandidate = true;
    this.set({ dirty: true, lastError: undefined });
    this.expectPush(`color:${index}`, `scene ${index + 1}'s colour`);
    await s.send(pa.SceneColorMessageSchema, { ...msg, requestId: this.editRequestId(s) });
  }

  /** Copy one scene onto another (its name and colour come with it), or swap them. Parameters change, so re-read. */
  async copyScene(from: number, to: number, swap = false): Promise<void> {
    const s = this.requireSession();
    const msg = sceneCopyMessage(from, to, swap);
    await this.beforeStructural();
    this.editedSinceCandidate = true;
    this.set({ dirty: true, lastError: undefined });
    await s.send(pa.SceneCopyMessageSchema, { ...msg, requestId: this.editRequestId(s) });
    this.scheduleResync();
  }

  private async flushWrites(): Promise<void> {
    this.writeTimer = undefined;
    const s = this.session;
    const batch = [...this.pendingWrites.values()];
    this.pendingWrites.clear();
    if (!s) return;
    try {
      for (const e of batch) await s.send(pa.GridMessageSchema, { ...paramEditMessageFor(e.target, e.index, e.wire), requestId: this.editRequestId(s) });
    } catch (err) {
      this.set({ lastError: `Could not send the change: ${String(err)}` });
    }
  }

  private isOurEcho(m: { requestId?: bigint }): boolean {
    if (m.requestId !== undefined && this.ownRequestIds.has(m.requestId)) return true;
    // Unknown id: still ours if we have just sent an edit (the echo may not carry the id).
    return Date.now() - this.lastEditSentAt < ECHO_WINDOW_MS || this.pendingWrites.size > 0 || this.writeTimer !== undefined;
  }

  /** Re-read the live preset after a change made on the unit itself. Debounced; reply flows through the normal RecallPreset path. */
  private scheduleResync(): void {
    clearTimeout(this.resyncTimer);
    this.resyncTimer = setTimeout(() => {
      const s = this.session;
      if (!s || this.verifyingParams || this.pendingWrites.size > 0) return;
      this.readsInFlight++;
      s.send(pa.RecallPresetMessageSchema, { action: pa.MessageAction_Enum.READ, requestId: s.newRequestId() }).catch(() => { this.readsInFlight = Math.max(0, this.readsInFlight - 1); });
    }, 250);
  }

  private scheduleVerify(delayMs = this.verifyDelay): void {
    clearTimeout(this.verifyTimer);
    this.verifyTimer = setTimeout(() => void this.verify(), delayMs);
  }

  private hasExpectations(): boolean {
    return this.expectedParams.size > 0 || this.expectedBypass.size > 0 || this.expectedCells.size > 0 || this.expectedPorts.size > 0 || this.expectedChecks.size > 0;
  }

  /** Read the live preset back (no side effects on the unit) and compare with what we asked for. */
  private async verify(): Promise<void> {
    const s = this.session;
    if (!s || !this.hasExpectations()) return;
    if (this.writeTimer || this.verifyingParams) return this.scheduleVerify(); // writes still pending / a read-back in flight
    this.verifyingParams = this.expectedParams;
    this.verifyingBypass = this.expectedBypass;
    this.verifyingCells = this.expectedCells;
    this.verifyingPorts = this.expectedPorts;
    this.verifyingChecks = this.expectedChecks;
    this.expectedParams = new Map();
    this.expectedBypass = new Map();
    this.expectedCells = new Map();
    this.expectedPorts = new Map();
    this.expectedChecks = new Map();
    clearTimeout(this.verifyWatchdog);
    this.verifyWatchdog = setTimeout(() => {
      this.verifyingParams = this.verifyingBypass = this.verifyingCells = this.verifyingPorts = this.verifyingChecks = undefined;
      this.lastVerifyFailed = true;
      this.readsInFlight = 0;
      this.set({ structuralPending: false, lastError: 'The unit did not answer the read-back, so the change could not be verified.' });
    }, VERIFY_TIMEOUT_MS);
    try {
      this.readsInFlight++;
      await s.send(pa.RecallPresetMessageSchema, { action: pa.MessageAction_Enum.READ, requestId: s.newRequestId() });
    } catch (err) {
      this.readsInFlight = Math.max(0, this.readsInFlight - 1);
      clearTimeout(this.verifyWatchdog);
      this.verifyingParams = this.verifyingBypass = this.verifyingCells = this.verifyingPorts = this.verifyingChecks = undefined;
      this.set({ structuralPending: false, lastError: `Could not verify the change: ${String(err)}` });
    }
  }

  /** Compare a read-back preset with the edits made before it was requested; re-apply newer edits on top. */
  private checkReadBack(live: P.BinaryPreset): P.BinaryPreset {
    clearTimeout(this.verifyWatchdog);
    const bad: string[] = [];
    for (const e of this.verifyingParams?.values() ?? []) {
      const got = readParamAt(live, e.target, e.index, e.scene);
      if (got === undefined || Math.abs(got - e.wire) > 1e-3) bad.push(e.label);
    }
    for (const e of this.verifyingBypass?.values() ?? []) {
      if (readBypass(live, e.row, e.column, e.scene) !== e.bypassed) bad.push(`bypass at row ${e.row + 1}, column ${e.column + 1}`);
    }
    for (const e of this.verifyingPorts?.values() ?? []) {
      if (readLanePort(live, e.row, e.side) !== e.id) bad.push(e.label);
    }
    for (const e of this.verifyingChecks?.values() ?? []) {
      if (!e.ok(live)) bad.push(e.label);
    }
    const retry: ExpectedCell[] = [];
    for (const e of this.verifyingCells?.values() ?? []) {
      if (readCellHash(live, e.row, e.column) === e.hash) continue;
      // A placement can take a moment to show up: look once more before calling it refused.
      if (!e.retried) retry.push({ ...e, retried: true });
      else bad.push(e.label);
    }
    for (const e of retry) this.expectedCells.set(`${e.row}:${e.column}:cell`, e);
    if (retry.length) this.scheduleVerify(this.structuralRetryDelay);
    this.verifyingParams = this.verifyingBypass = this.verifyingCells = this.verifyingPorts = this.verifyingChecks = undefined;
    this.lastVerifyFailed = bad.length > 0;
    if (this.expectedCells.size === 0) this.set({ structuralPending: false });
    if (bad.length) {
      this.set({ lastError: `The unit did not apply ${bad.length === 1 ? 'this change' : `${bad.length} changes`}: ${[...new Set(bad)].slice(0, 3).join(', ')}${bad.length > 3 ? '…' : ''}. It may refuse edits it can't fit (DSP/port limits).` });
    }
    else if (retry.length === 0) this.set({ verifiedReadBacks: this.state.verifiedReadBacks + 1 });
    // Edits made after the read-back was requested aren't in `live` yet: keep them visible.
    let out = live;
    for (const e of this.expectedParams.values()) out = withParamAt(out, e.target, e.index, e.wire, e.scene) ?? out;
    for (const e of this.expectedBypass.values()) out = withBypass(out, e.row, e.column, e.bypassed, e.scene) ?? out;
    for (const e of this.expectedPorts.values()) out = withLanePort(out, e.row, e.side, e.id) ?? out;
    for (const e of this.expectedChecks.values()) out = e.apply(out) ?? out;
    return out;
  }

  private dropPendingEdits(): void {
    clearTimeout(this.writeTimer);
    clearTimeout(this.verifyTimer);
    clearTimeout(this.verifyWatchdog);
    clearTimeout(this.resyncTimer);
    this.writeTimer = undefined;
    this.pendingWrites.clear();
    this.expectedParams.clear();
    this.expectedBypass.clear();
    this.expectedCells.clear();
    this.expectedPorts.clear();
    this.expectedChecks.clear();
    this.verifyingParams = this.verifyingBypass = this.verifyingCells = this.verifyingPorts = this.verifyingChecks = undefined;
    for (const t of this.expectedPushes.values()) clearTimeout(t);
    this.expectedPushes.clear();
    this.set({ structuralPending: false });
  }

  // ---- saving ------------------------------------------------------------------

  /** Can the stored version of this slot be snapshotted before an overwrite? Only the slot we hold a verified baseline for. */
  canSnapshot(folderKey: string, index: number): boolean {
    const b = this.baseline;
    return !!this.snapshotSink && !!b && b.folderKey === folderKey && b.position === index;
  }

  /** Why a folder/slot can't be written, or undefined if it can. Only the user's own preset folders are writable. */
  static whyNotWritable(folder: Folder | undefined, index: number): string | undefined {
    if (!folder) return 'That folder is not known to the unit.';
    if (folder.kind !== 'presets') return 'Only preset folders can hold presets.';
    if (folder.isFactory) return 'Factory presets are read-only.';
    if (isDownloadsFolder(folder) || folder.isCloud || isPluginFolder(folder) || folder.isFavorites) return 'That folder is managed by the unit and cannot be saved into.';
    if (!Number.isInteger(index) || index < 0 || index > 255) return 'The slot must be between 1A and 32H.';
    if (folder.slots.get(index)?.readOnly) return 'That slot is read-only.';
    return undefined;
  }

  static validateName(name: string): string {
    const n = name.trim();
    if (!n) throw new Error('Give the preset a name.');
    if (n.length > MAX_NAME_LENGTH) throw new Error(`Names can be at most ${MAX_NAME_LENGTH} characters.`);
    if (/[\\/\u0000-\u001f]/.test(n)) throw new Error('Names cannot contain slashes or control characters.');
    return n;
  }

  /**
   * Save the unit's CURRENT live preset into a slot (a snapshot of the unit's grid — the unit ignores any payload).
   * Overwrites whatever is there. Order: validate → confirm all pending edits were applied → snapshot the replaced
   * preset if we can → send → wait for the unit to acknowledge → read back the name it stored.
   */
  async save(target: SaveTarget): Promise<SaveResult> {
    const s = this.requireSession();
    const name = DeviceStore.validateName(target.name);
    const folder = this.state.folders.get(target.folderKey);
    const why = DeviceStore.whyNotWritable(folder, target.index);
    if (why) throw new Error(why);
    if (!this.state.preset) throw new Error('No preset is loaded yet.');

    if (!(await this.settleEdits())) throw new Error('Some of your changes were not confirmed by the unit, so nothing was saved. Check the message above, then try again.');

    const existing = folder!.slots.get(target.index);
    let snapshotted = false;
    if (existing?.name && this.canSnapshot(target.folderKey, target.index)) {
      await this.snapshotSink!({
        savedAt: Date.now(), folderKey: target.folderKey, folderName: folder!.name, index: target.index, name: existing.name,
        preset: toBinary(PS.BinaryPresetSchema, this.baseline!.preset),
      }); // throws -> the save is aborted before anything is sent
      snapshotted = true;
    }

    const instrument = existing?.instrument ?? this.state.folders.get(this.state.position?.folderKey ?? '')?.slots.get(this.state.position?.position ?? -1)?.instrument ?? 1;
    const acked = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.saveWaiter = undefined; reject(new Error('The unit did not confirm the save in time. Check the unit before trying again.')); }, SAVE_ACK_TIMEOUT_MS);
      this.saveWaiter = (m) => {
        const x = m.message as any;
        const done =
          (m.typeName === 'File' && x?.folder?.key === target.folderKey) ||
          (m.typeName === 'RecallPreset' && x?.reason === pa.RecallPresetReason_Enum.SAVE) ||
          (m.typeName === 'PresetDirty' && x && x.isDirty !== true);
        if (done) { clearTimeout(timer); this.saveWaiter = undefined; resolve(); }
      };
    });
    acked.catch(() => {});
    try {
      await s.send(pa.FileMessageSchema, {
        action: pa.MessageAction_Enum.CREATE,
        requestId: s.newRequestId(),
        type: 0,
        folder: { key: target.folderKey, isFactory: false, files: [{ index: target.index, name, instrument }] },
      });
      await acked;
    } catch (e) {
      this.saveWaiter = undefined;
      throw e;
    }

    // The listing is eventually consistent: give it a moment to show the stored name (the unit may add a _N suffix).
    let savedName = name;
    for (let i = 0; i < 40; i++) {
      const stored = this.latestFolders().get(target.folderKey)?.slots.get(target.index)?.name;
      if (stored && (stored === name || stored.startsWith(name.slice(0, 15)))) { savedName = stored; break; }
      await sleep(100);
    }
    this.baseline = { preset: this.state.preset!, folderKey: target.folderKey, position: target.index };
    return { savedName, renamed: savedName !== name, snapshotted, replaced: existing?.name };
  }

  private latestFolders(): ReadonlyMap<string, Folder> {
    return this.foldersDirty ? new Map(this.folderMap) : this.state.folders;
  }

  /** Push pending edits out and wait until the unit has confirmed them. False if a confirmation failed. */
  private async settleEdits(): Promise<boolean> {
    if (this.writeTimer) { clearTimeout(this.writeTimer); await this.flushWrites(); }
    clearTimeout(this.verifyTimer);
    this.lastVerifyFailed = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 2 * VERIFY_TIMEOUT_MS) {
      if (this.verifyingParams) { await sleep(20); continue; }
      if (this.hasExpectations()) { clearTimeout(this.verifyTimer); await this.verify(); await sleep(0); continue; }
      break;
    }
    return !this.lastVerifyFailed && !this.hasExpectations();
  }

  // ---- inbound -------------------------------------------------------------

  handle(msg: InboundMessage): void {
    this.saveWaiter?.(msg);
    const m = msg.message as any;
    if (!m) return;
    switch (msg.typeName) {
      case 'Version':
        if (m.appFwVersion !== undefined || m.zenosGitHash !== undefined) {
          this.set({ info: { coros: m.zenosGitHash, firmware: m.appFwVersion, name: m.customName } });
        }
        break;
      case 'ModelRepo':
        if (m.modelRepoPayload?.length) {
          try {
            this.set({ catalog: parseModelRepoPayload(m.modelRepoPayload) });
          } catch (e) {
            this.set({ lastError: `Could not read the block catalog: ${String(e)}` });
          }
        }
        break;
      case 'File':
        if (m.folder) this.mergeFolder(m.action, m.folder);
        break;
      case 'RecallPreset':
        if (m.preset) {
          clearTimeout(this.recallTimer);
          // A reply to a READ we sent is the LIVE (possibly edited) grid; anything else is a fresh load of a stored preset.
          if (this.readsInFlight > 0) this.readsInFlight--;
          else { this.candidate = m.preset; this.editedSinceCandidate = false; }
          const preset = this.verifyingParams ? this.checkReadBack(m.preset) : m.preset;
          this.set({ preset, presetRevision: this.state.presetRevision + 1, loadingPreset: false });
          const w = this.liveWaiters.shift();
          if (w) { clearTimeout(w.timer); w.resolve(m.preset); }
        }
        break;
      case 'SetlistPosition': {
        const pos = this.positionFromPush(m);
        if (pos) this.set({ position: pos });
        break;
      }
      case 'Grid':
        // The unit echoes our own edits (same request id) and pushes a Grid message when something changes on the unit itself.
        // We don't try to interpret foreign shapes: just re-read the live preset. Meter updates are not edits.
        if (m.preset && m.updateType === undefined && !this.isOurEcho(m)) this.scheduleResync();
        break;
      case 'IOSettings': {
        const merged = mergeIoSettings(this.pending.io ?? this.state.io, m);
        this.set({ io: merged });
        for (const p of m.settings?.inPort ?? []) {
          if (p.level !== undefined) this.gotPush(`io:in.level:${p.inputPortId}`);
          if (p.groundLift !== undefined) this.gotPush(`io:in.groundLift:${p.inputPortId}`);
        }
        for (const p of m.settings?.outPort ?? []) {
          if (p.level !== undefined) this.gotPush(`io:out.level:${p.outputPortId}`);
          if (p.groundLift !== undefined) this.gotPush(`io:out.groundLift:${p.outputPortId}`);
          if (p.mute !== undefined) this.gotPush(`io:out.mute:${p.outputPortId}`);
        }
        break;
      }
      case 'MasterVolume':
        if (m.volume !== undefined) { this.gotPush('io:master'); this.set({ io: { ...(this.pending.io ?? this.state.io), masterVolume: m.volume } }); }
        break;
      case 'UndoRedo':
        this.set({ undoCount: m.undoFrames?.length ?? 0, redoCount: m.redoFrames?.length ?? 0 });
        break;
      case 'SceneLabel':
        if (m.index !== undefined && m.label !== undefined) {
          this.gotPush(`label:${m.index}`);
          const base = this.pending.preset ?? this.state.preset;
          if (base && m.index >= 0 && m.index < 8) this.set({ preset: withSceneLabel(base, m.index, m.label) });
        }
        break;
      case 'SceneColor':
        if (m.index !== undefined && m.color !== undefined) {
          this.gotPush(`color:${m.index}`);
          const base = this.pending.preset ?? this.state.preset;
          if (base && m.index >= 0 && m.index < 8) this.set({ preset: withSceneColor(base, m.index, m.color) });
        }
        break;
      case 'Scene':
        if (m.selectedScene !== undefined) this.set({ selectedScene: m.selectedScene });
        break;
      case 'PresetDirty':
        this.set({ dirty: m.isDirty === true });
        if (m.isDirty === true) this.candidate = undefined;
        else if (this.candidate && !this.editedSinceCandidate) {
          // A fresh load that the unit says has no unsaved changes == the preset exactly as stored in its slot.
          const pos = this.pending.position ?? this.state.position;
          if (pos) this.baseline = { preset: this.candidate, folderKey: pos.folderKey, position: pos.position };
          this.candidate = undefined;
        }
        break;
    }
  }

  /** A plugin or Downloads preset is reported by its key: find it in the listing (or in the recall we just sent). */
  private positionFromPush(m: any): SetlistPosition | undefined {
    const key: string | undefined = m.isPlugin ? m.keyInPluginFolder : m.isDownloads ? m.keyInDownloads : undefined;
    if (key) {
      for (const f of this.latestFolders().values()) {
        for (const slot of f.slots.values()) if (slot.key === key || slot.cloudId === key) return recallTarget(f, slot);
      }
      const r = this.requested;
      return r && (r.pluginKey === key || r.downloadsKey === key) ? r : undefined;
    }
    if (m.folderKey !== undefined && m.position !== undefined) return { folderKey: m.folderKey, position: m.position, isFactory: m.isFactory === true };
    return undefined;
  }

  private mergeFolder(action: number, f: any): void {
    if (!f.key) return;
    const files: any[] = f.files ?? [];
    const prev = this.folderMap.get(f.key);
    const slots = new Map<number, Slot>();
    // A full setlist listing carries all 256 slots (empty ones without a name) -> replace; otherwise merge into what we have.
    const full = files.length >= 256;
    if (prev && !full) for (const [i, s] of prev.slots) slots.set(i, s);
    if (action === pa.MessageAction_Enum.DELETE) {
      for (const file of files) {
        for (const [i, s] of slots) if ((file.key && s.key === file.key) || (file.index !== undefined && i === file.index && !file.key)) slots.delete(i);
      }
    } else {
      files.forEach((file, n) => {
        const index = file.index ?? n;
        slots.set(index, { index, name: file.name || undefined, key: file.key, instrument: file.instrument, readOnly: file.isReadonly === true ? true : undefined, cloudId: file.cloudId || undefined });
      });
    }
    this.folderMap.set(f.key, {
      key: f.key,
      parentKey: f.parentKey ?? prev?.parentKey,
      name: f.name ?? prev?.name ?? f.key.split('/').filter(Boolean).pop() ?? f.key,
      isFactory: f.isFactory ?? prev?.isFactory ?? false,
      isDownloads: f.isDownloads ?? prev?.isDownloads ?? false,
      isCloud: f.isCloud ?? prev?.isCloud ?? false,
      isFavorites: f.isFavorites ?? prev?.isFavorites ?? false,
      isPlugin: f.isPlugin ?? prev?.isPlugin ?? false,
      kind: folderKind(f.key),
      slots,
    });
    this.foldersDirty = true;
    this.schedule();
  }

  // ---- plumbing ------------------------------------------------------------

  private requireSession(): Session {
    if (!this.session) throw new Error('Not connected');
    return this.session;
  }

  private set(patch: Partial<DeviceState>): void {
    Object.assign(this.pending, patch);
    this.schedule();
  }

  private schedule(): void {
    if (this.delay === 0) return this.flush();
    this.timer ??= setTimeout(() => this.flush(), this.delay);
  }

  /** Publish pending changes as a new snapshot. Exposed for tests. */
  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const folders = this.foldersDirty ? new Map(this.folderMap) : this.state.folders;
    this.foldersDirty = false;
    this.state = { ...this.state, ...this.pending, folders };
    this.pending = {};
    for (const l of [...this.listeners]) l();
  }
}
