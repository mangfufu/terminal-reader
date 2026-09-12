import type { Book } from './document';
import { validateBook } from './backup';

let connection: Promise<IDBDatabase> | undefined;
function database(): Promise<IDBDatabase> {
  return connection ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('terminal-reader', 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('books')) request.result.createObjectStore('books', { keyPath: 'id' });
      if (!request.result.objectStoreNames.contains('vault')) request.result.createObjectStore('vault');
    };
    request.onerror = () => { connection = undefined; reject(request.error); };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); connection = undefined; };
      db.onclose = () => { connection = undefined; };
      resolve(db);
    };
  });
}

export async function loadBooks(): Promise<Book[]> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const request = db.transaction('books').objectStore('books').getAll();
    request.onsuccess = () => {
      const books: Book[] = [];
      for (const value of request.result) {
        try { books.push(validateBook(value)); }
        catch { /* Isolate malformed old records without changing the stored source. */ }
      }
      resolve(books);
    };
    request.onerror = () => reject(request.error);
  });
}

async function writeBooks(books: Book[], replace: boolean): Promise<void> {
  // Validate every entry before opening the transaction, including replacement imports.
  const checked = books.map(validateBook);
  if (new Set(checked.map(book => book.id)).size !== checked.length) throw new Error('书库包含重复书籍编号');
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('books', 'readwrite');
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('无法保存书库'));
    transaction.onabort = () => reject(transaction.error ?? new Error('保存已取消'));
    try {
      const store = transaction.objectStore('books');
      if (replace) store.clear();
      for (const book of checked) store.put(book);
    } catch (error) {
      transaction.abort();
      reject(error);
    }
  });
}

export function saveBooks(books: Book[]): Promise<void> { return writeBooks(books, false); }

/** Replace cached books atomically: an error rolls back the clear and every put. */
export function replaceBooks(books: Book[]): Promise<void> { return writeBooks(books, true); }

/** Delete cached library entries atomically; never touches any source files. */
export async function deleteBooks(ids: string[]): Promise<void> {
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id || id.length > 4096)) throw new Error('书籍编号无效');
  const uniqueIds = [...new Set(ids)];
  if (!uniqueIds.length) return;
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('books', 'readwrite');
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('无法移出书籍'));
    transaction.onabort = () => reject(transaction.error ?? new Error('移出已取消'));
    try {
      const store = transaction.objectStore('books');
      for (const id of uniqueIds) store.delete(id);
    } catch (error) {
      transaction.abort();
      reject(error);
    }
  });
}

/** Compatibility for single-book removal callers. */
export function deleteBook(id: string): Promise<void> { return deleteBooks([id]); }

export async function readVault(): Promise<unknown> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const request = db.transaction('vault').objectStore('vault').get('main');
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}

/** Migration/moves commit encrypted content and remove public copies in one transaction. */
export async function writeVault(value: unknown, removePublic: string[] = []): Promise<void> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['vault', 'books'], 'readwrite');
    tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('无法保存独立书库'));
    try {
      tx.objectStore('vault').put(value, 'main');
      for (const id of removePublic) tx.objectStore('books').delete(id);
    } catch (error) { tx.abort(); reject(error); }
  });
}
