import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
try {
  const page = await browser.newPage();
  // Keep application startup out of transaction tests; this isolated context has no user data.
  await page.route('**/?storage-transaction-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Storage transaction test</title>' }));
  await page.goto('http://127.0.0.1:1420/?storage-transaction-test');
  const result = await page.evaluate(async () => {
    const { saveBooks, loadBooks, replaceBooks, deleteBook, deleteBooks } = await import('/src/storage.ts');
    const original = [
      { id: 'test:1', name: '01.txt', content: '第一本', category: '科幻' },
      { id: 'test:2', name: '02.epub', format: 'epub', content: '第二本', category: '随笔' },
      { id: 'test:3', name: '03.md', content: '第三本' },
    ];
    await replaceBooks(original);
    let rejectedInvalid = false;
    try { await deleteBooks([original[0].id, null]); }
    catch { rejectedInvalid = true; }
    const afterInvalid = await loadBooks();

    const remove = IDBObjectStore.prototype.delete;
    let deleteCalls = 0;
    IDBObjectStore.prototype.delete = function (...args) {
      if (++deleteCalls === 2) throw new DOMException('Synthetic failure', 'InvalidStateError');
      return remove.apply(this, args);
    };
    let rejectedSync = false;
    try { await deleteBooks([original[0].id, original[1].id]); }
    catch { rejectedSync = true; }
    finally { IDBObjectStore.prototype.delete = remove; }
    const afterSync = await loadBooks();

    // Abort after the first delete succeeds: every deletion must still roll back.
    let firstDeleteSucceeded = false;
    deleteCalls = 0;
    IDBObjectStore.prototype.delete = function (...args) {
      const request = remove.apply(this, args);
      if (++deleteCalls === 1) request.addEventListener('success', () => {
        firstDeleteSucceeded = true;
        this.transaction.abort();
      });
      return request;
    };
    let rejectedAbort = false;
    try { await deleteBooks([original[0].id, original[1].id]); }
    catch { rejectedAbort = true; }
    finally { IDBObjectStore.prototype.delete = remove; }
    const afterAbort = await loadBooks();

    const transaction = IDBDatabase.prototype.transaction;
    let transactions = 0;
    deleteCalls = 0;
    IDBDatabase.prototype.transaction = function (...args) {
      if (args[1] === 'readwrite') transactions++;
      return transaction.apply(this, args);
    };
    IDBObjectStore.prototype.delete = function (...args) { deleteCalls++; return remove.apply(this, args); };
    try { await deleteBooks([original[0].id, original[1].id, original[0].id]); await deleteBooks([]); }
    finally { IDBDatabase.prototype.transaction = transaction; IDBObjectStore.prototype.delete = remove; }
    const afterDelete = await loadBooks();
    await saveBooks(original);
    const afterUndo = await loadBooks();
    await deleteBook(original[2].id);
    const afterSingleDelete = await loadBooks();

    const put = IDBObjectStore.prototype.put;
    let putCalls = 0;
    IDBObjectStore.prototype.put = function (...args) {
      if (++putCalls === 2) throw new DOMException('Synthetic category write failure', 'QuotaExceededError');
      return put.apply(this, args);
    };
    let rejectedCategory = false;
    try { await saveBooks(original.slice(0, 2).map(book => ({ ...book, category: '批量分类' }))); }
    catch { rejectedCategory = true; }
    finally { IDBObjectStore.prototype.put = put; }
    const afterCategoryFailure = await loadBooks();
    await saveBooks(original.slice(0, 2).map(book => ({ ...book, category: '  新分类  ' })));
    const afterCategorySave = await loadBooks();
    return { original, rejectedInvalid, afterInvalid, rejectedSync, afterSync, firstDeleteSucceeded, rejectedAbort, afterAbort, transactions, deleteCalls, afterDelete, afterUndo, afterSingleDelete, rejectedCategory, afterCategoryFailure, afterCategorySave };
  });
  assert.equal(result.rejectedInvalid, true);
  assert.deepEqual(result.afterInvalid, result.original, 'Validate every ID before deleting any book');
  assert.equal(result.rejectedSync, true);
  assert.deepEqual(result.afterSync, result.original, 'Synchronous failures must roll back queued deletes');
  assert.equal(result.firstDeleteSucceeded, true);
  assert.equal(result.rejectedAbort, true);
  assert.deepEqual(result.afterAbort, result.original, 'Aborts must restore even successfully deleted records');
  assert.equal(result.transactions, 1, 'Batch deletion uses one transaction; an empty batch does nothing');
  assert.equal(result.deleteCalls, 2, 'Duplicate IDs are removed once');
  assert.deepEqual(result.afterDelete, [result.original[2]]);
  assert.deepEqual(result.afterUndo, result.original, 'Undo can restore books together with their categories');
  assert.deepEqual(result.afterSingleDelete, result.original.slice(0, 2));
  assert.equal(result.rejectedCategory, true);
  assert.deepEqual(result.afterCategoryFailure, result.afterSingleDelete, 'Batch category updates must not partially commit');
  assert.deepEqual(result.afterCategorySave.map(book => book.category), ['新分类', '新分类']);
  console.log('PASS: batch delete validation, one-transaction deduplication, synchronous and asynchronous rollback, restore with categories, single-delete compatibility, atomic category writes.');
} finally { await browser.close(); }
