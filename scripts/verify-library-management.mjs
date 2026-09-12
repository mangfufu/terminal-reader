import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 560, height: 400 } });
  await page.goto('http://127.0.0.1:1420');
  const result = await page.evaluate(async () => {
    const { saveBooks, loadBooks, replaceBooks, deleteBook } = await import('/src/storage.ts');
    const { createBookList } = await import('/src/library.ts');
    const original = [{ id: 'test:1', name: '01.txt', content: '第一本' }, { id: 'test:2', name: '02.txt', content: '第二本' }];
    await replaceBooks(original);
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('terminal-reader', 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction('books', 'readwrite');
      transaction.objectStore('books').put({ id: 'broken', name: 42, content: null });
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    const isolated = await loadBooks();
    let invalidRejected = false;
    try { await replaceBooks([{ id: 'invalid', name: 'bad.txt', content: null }]); }
    catch { invalidRejected = true; }
    const afterInvalid = await loadBooks();

    // Simulate a synchronous failure after clear and the first put were already queued.
    const put = IDBObjectStore.prototype.put;
    let calls = 0;
    IDBObjectStore.prototype.put = function (...args) {
      if (++calls === 2) throw new DOMException('Synthetic write failure', 'QuotaExceededError');
      return put.apply(this, args);
    };
    let rollbackRejected = false;
    try { await replaceBooks([{ id: 'new:1', name: '1.txt', content: '1' }, { id: 'new:2', name: '2.txt', content: '2' }]); }
    catch { rollbackRejected = true; }
    finally { IDBObjectStore.prototype.put = put; }
    const afterRollback = await loadBooks();
    await saveBooks([{ ...original[0], content: '更新内容' }]);
    const afterRefresh = await loadBooks();
    await deleteBook(original[1].id);
    const afterRemove = await loadBooks();
    await replaceBooks([{ id: 'restored', name: 'restored.epub', format: 'epub', content: '章节', blocks: [{ text: '章节', kind: 'heading' }], chapters: [{ title: '一', block: 0, level: 1 }] }]);
    const afterRestore = await loadBooks();
    database.close();

    const selections = [];
    const opens = [];
    const list = createBookList(original, undefined, book => opens.push(book.id), { onSelect: book => selections.push(book.id) });
    document.body.append(list);
    list.querySelector('button').focus();
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    list.remove();
    return { isolated, invalidRejected, afterInvalid, rollbackRejected, afterRollback, afterRefresh, afterRemove, afterRestore, selections, opens };
  });
  assert.equal(result.isolated.length, 2, 'Corrupted records must not prevent healthy books from loading');
  assert.equal(result.invalidRejected, true);
  assert.deepEqual(result.afterInvalid, result.isolated, 'Validation must finish before clearing cached books');
  assert.equal(result.rollbackRejected, true);
  assert.deepEqual(result.afterRollback, result.isolated, 'Partial restore failures must roll back the clear and writes');
  assert.equal(result.afterRefresh.length, 2);
  assert.equal(result.afterRefresh.find(book => book.id === 'test:1').content, '更新内容');
  assert.equal(result.afterRemove.length, 1);
  assert.equal(result.afterRestore.length, 1);
  assert.equal(result.afterRestore[0].format, 'epub');
  assert.equal(result.afterRestore[0].chapters[0].title, '一');
  assert.deepEqual(result.selections, ['test:1', 'test:2']);
  assert.deepEqual(result.opens, ['test:2']);
  console.log('PASS: damaged-record isolation, refresh, cache removal, replacement atomicity, EPUB restore, library selection callbacks.');
} finally { await browser.close(); }
