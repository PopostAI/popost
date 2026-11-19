/**
 * Shared Popost storage for the React shell and the canvas editor (port of the product's
 * browser-storage.mjs). IndexedDB is authoritative once a key is migrated; legacy localStorage
 * keys (`popost-product:*`) stay untouched as a fallback copy. Nothing is ever deleted to free quota.
 */
const PREFIX = 'popost-product:';
const DB_NAME = 'popost-workspace-v24';
const STORE = 'records';
const DEFAULT_WRITE_ERROR = '项目保存失败，请检查浏览器存储权限。';

type Entry = readonly [key: string, value: unknown];

const memory = new Map<string, unknown>();
let database: IDBDatabase | undefined;
let initialization: Promise<void> | undefined;
let pending: Promise<void> = Promise.resolve();
let failure: unknown;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('浏览器项目存储被占用，请关闭旧工作台页面后重试。'));
  });
}

function requireDatabase(): IDBDatabase {
  if (!database) throw new Error('项目存储尚未初始化');
  return database;
}

function transactionWrite(entries: readonly Entry[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = requireDatabase().transaction(STORE, 'readwrite');
    const records = tx.objectStore(STORE);
    for (const [key, value] of entries) records.put(value, key);
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('项目存储写入失败'));
  });
}

function loadAllRecords(): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = requireDatabase().transaction(STORE, 'readonly');
    const cursor = tx.objectStore(STORE).openCursor();
    cursor.onsuccess = () => {
      const row = cursor.result;
      if (!row) return;
      memory.set(String(row.key), row.value);
      row.continue();
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Legacy localStorage records that IndexedDB does not know yet. Malformed JSON is skipped. */
function collectLegacyRecords(): Entry[] {
  const additions: Entry[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const fullKey = localStorage.key(i);
    if (!fullKey?.startsWith(PREFIX)) continue;
    const key = fullKey.slice(PREFIX.length);
    if (memory.has(key)) continue;
    try {
      const value: unknown = JSON.parse(localStorage.getItem(fullKey) ?? 'null');
      memory.set(key, value);
      additions.push([key, value]);
    } catch {
      /* preserve the malformed legacy record without overwriting it */
    }
  }
  return additions;
}

export function initStorage(): Promise<void> {
  initialization ??= (async () => {
    database = await openDatabase();
    await loadAllRecords();
    const additions = collectLegacyRecords();
    if (additions.length) await transactionWrite(additions);
  })();
  return initialization;
}

export function readStored<T>(key: string, fallback: T): T {
  if (memory.has(key)) return memory.get(key) as T;
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(PREFIX + key) || 'null');
    return (parsed ?? fallback) as T;
  } catch {
    return fallback;
  }
}

function reportWriteFailure(error: unknown): never {
  failure = error;
  const detail = error instanceof Error && error.message ? error.message : DEFAULT_WRITE_ERROR;
  window.dispatchEvent(new CustomEvent('popost-storage-error', { detail }));
  throw error;
}

export function writeStored(key: string, value: unknown): void {
  // Snapshot before asynchronous persistence so later in-place mutations by the caller are harmless.
  const snapshot = structuredClone(value);
  memory.set(key, snapshot);
  pending = pending
    .catch(() => {})
    .then(async () => {
      await initStorage();
      await transactionWrite([[key, snapshot]]);
      failure = undefined;
    })
    .catch(reportWriteFailure);
  // Avoid unhandled rejections for synchronous UI changes; flushStorage is the durability gate.
  pending.catch(() => {});
}

export async function flushStorage(): Promise<void> {
  await initStorage();
  await pending;
  if (failure) throw failure;
}

function readRecord(key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const tx = requireDatabase().transaction(STORE, 'readonly');
    const request = tx.objectStore(STORE).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Re-read `key` from IndexedDB (picks up writes of another window) and replace the in-memory copy. */
export async function refreshStored<T>(key: string, fallback: T): Promise<T> {
  await initStorage();
  const value = ((await readRecord(key)) ?? fallback) as T;
  memory.set(key, value);
  return value;
}
