// Snapshots of presets that were about to be overwritten, kept in this browser's IndexedDB.
// NOTE: the unit ignores full-preset writes, so these cannot be "restored" by sending them back; they are a record
// (exportable as raw BinaryPreset protobuf bytes) until block placement + rebuild-from-snapshot exists.
import type { PresetSnapshot } from '@qc/domain';

export interface StoredSnapshot extends PresetSnapshot { id: number }

const DB = 'qc-editor';
const STORE = 'snapshots';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('This browser has no IndexedDB, so a snapshot cannot be kept.'));
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new Error(`Could not open the snapshot store: ${req.error?.message ?? 'unknown error'}`));
  });
}

const done = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(new Error(`Snapshot store error: ${tx.error?.message ?? 'unknown'}`));
  tx.onabort = () => reject(new Error(`Snapshot store aborted: ${tx.error?.message ?? 'unknown'}`));
});

/** Resolves only once the snapshot is durably committed; throws otherwise (which aborts the save). */
export async function addSnapshot(s: PresetSnapshot): Promise<void> {
  const db = await open();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).add(s);
    await done(tx);
  } finally { db.close(); }
}

export async function listSnapshots(): Promise<StoredSnapshot[]> {
  const db = await open();
  try {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    await done(tx);
    return (req.result as StoredSnapshot[]).sort((a, b) => b.savedAt - a.savedAt);
  } finally { db.close(); }
}

export async function deleteSnapshot(id: number): Promise<void> {
  const db = await open();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    await done(tx);
  } finally { db.close(); }
}

export function downloadSnapshot(s: StoredSnapshot): void {
  const safe = s.name.replace(/[^\w.-]+/g, '_');
  const url = URL.createObjectURL(new Blob([s.preset as BlobPart], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safe}-${new Date(s.savedAt).toISOString().slice(0, 19).replace(/[:T]/g, '')}.binarypreset`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
