/**
 * On-device storage (IndexedDB), no packages. Three stores, versioned with
 * the database:
 *
 *   cache   the offline copy from GET /api/offline, under the key "copy",
 *           with the login it belongs to
 *   active  the workout in progress, under the key "workout" (one at a time)
 *   queue   finished workouts waiting to upload, keyed by workout id
 *
 * Writes use strict durability, so a write that resolved is on disk and
 * survives the app being killed or the phone losing power.
 *
 * A new store or index means a new DB_VERSION and a step in upgrade(),
 * keeping the steps for older versions.
 */

export type StoreName = "cache" | "active" | "queue";

const DB_NAME = "liftlog";
const DB_VERSION = 1;

function upgrade(db: IDBDatabase, from: number) {
  if (from < 1) {
    db.createObjectStore("cache");
    db.createObjectStore("active");
    db.createObjectStore("queue", { keyPath: "id" });
  }
}

let opening: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => upgrade(req.result, e.oldVersion);
    req.onsuccess = () => {
      const db = req.result;
      // Another tab upgrading: let it, and reopen next time.
      db.onversionchange = () => { db.close(); opening = null; };
      resolve(db);
    };
    req.onerror = () => { opening = null; reject(req.error); };
  });
  return opening;
}

const done = <T,>(req: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

/** Runs `fn` in one transaction over `stores` and resolves once it's committed. */
export async function write(stores: StoreName[], fn: (s: Record<StoreName, IDBObjectStore>) => void): Promise<void> {
  const db = await open();
  const t = db.transaction(stores, "readwrite", { durability: "strict" });
  const s = Object.fromEntries(stores.map((n) => [n, t.objectStore(n)])) as Record<StoreName, IDBObjectStore>;
  fn(s);
  await new Promise<void>((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error("Storage write was cancelled"));
  });
}

export async function read<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  const db = await open();
  return done(db.transaction(store).objectStore(store).get(key)) as Promise<T | undefined>;
}

export async function readAll<T>(store: StoreName): Promise<T[]> {
  const db = await open();
  return done(db.transaction(store).objectStore(store).getAll()) as Promise<T[]>;
}
