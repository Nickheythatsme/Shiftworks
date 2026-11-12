// Saves live in the browser's IndexedDB. There is no backend.

const DB_NAME = 'shiftworks';
const STORE = 'saves';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open the save database.'));
  });
}

export async function writeSave(key: string, data: Uint8Array): Promise<void> {
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(data, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Could not write the save.'));
      tx.onabort = () => reject(tx.error ?? new Error('Could not write the save.'));
    });
  } finally {
    db.close();
  }
}

export async function readSave(key: string): Promise<Uint8Array | null> {
  const db = await open();
  try {
    return await new Promise<Uint8Array | null>((resolve, reject) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      request.onsuccess = () => {
        const value = request.result as unknown;
        resolve(value instanceof Uint8Array ? value : null);
      };
      request.onerror = () => reject(request.error ?? new Error('Could not read the save.'));
    });
  } finally {
    db.close();
  }
}
