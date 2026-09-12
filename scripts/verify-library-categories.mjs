import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

// The browser owns a fresh profile. These fixtures never touch the desktop library.
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 560, height: 400 }, acceptDownloads: true });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const next = sessionStorage.getItem('category-test-preferences');
    if (!next) return;
    for (const [key, value] of Object.entries(JSON.parse(next))) localStorage.setItem(key, value);
    sessionStorage.removeItem('category-test-preferences');
  });
  await page.goto('http://127.0.0.1:1420');
  await page.evaluate(async () => {
    const { replaceBooks } = await import('/src/storage.ts');
    const content = '# 第一章\n\n' + Array.from({ length: 80 }, (_, index) => `第 ${index + 1} 段。夜雨落在窗前，书页在灯下翻过。`).join('\n\n');
    await replaceBooks([
      { id: 'category:01', name: '01 夜航.md', content, category: '小说' },
      { id: 'category:02', name: '02 星海.epub', format: 'epub', title: '星海', author: '测试作者', content: '序章\n\n星光映在海面。', blocks: [{ text: '序章', kind: 'heading' }, { text: '星光映在海面。', kind: 'paragraph' }], chapters: [{ title: '序章', block: 0 }] },
      { id: 'category:03', name: '03 学习.txt', content: '第三本', category: '技术' },
      { id: 'category:04', name: '04 山雨.txt', content: '第四本' },
      { id: 'category:05', name: '05 测试.txt', content: '第五本', category: '技术' },
      { id: 'category:06', name: '06 散文.md', content: '第六本' },
    ]);
    localStorage.setItem('reader-settings', JSON.stringify({ mode: 'plain', effectFrequency: 'off' }));
    localStorage.setItem('reader-last-book', 'category:01');
    localStorage.setItem('reader-positions', JSON.stringify({ 'category:01': { block: 20, fraction: 0.3 } }));
    localStorage.setItem('reader-bookmarks', JSON.stringify([{ id: 'category-mark', bookId: 'category:01', label: '保存的段落', position: { block: 12, fraction: 0 }, createdAt: 1789200000000 }]));
    localStorage.setItem('reader-categories', JSON.stringify(['小说', '技术', '空分类']));
    sessionStorage.setItem('category-test-preferences', JSON.stringify(Object.fromEntries(Object.keys(localStorage).filter(key => key.startsWith('reader-')).map(key => [key, localStorage.getItem(key)]))));
  });
  await page.reload();
  await page.locator('#content').waitFor();

  const button = name => page.getByRole('button', { name, exact: true });
  const row = id => page.locator(`.book-item[data-book-id="${id}"]`);
  const categoryFilter = () => page.getByRole('combobox', { name: '分类筛选', exact: true });
  const assignment = () => page.getByRole('combobox', { name: '归入分类', exact: true });
  const search = () => page.getByRole('searchbox', { name: '筛选书库', exact: true });
  const command = async value => {
    if (await page.locator('#panel').isVisible()) await page.locator('#panel-close').click();
    const input = page.getByRole('combobox', { name: '命令', exact: true });
    await input.fill(value);
    await input.press('Enter');
  };
  const openLibrary = async () => {
    await command('/books');
    await categoryFilter().selectOption('');
    await search().fill('');
    if (await button('完成多选').count()) await button('完成多选').click();
  };
  const snapshot = () => page.evaluate(async () => ({
    books: await (await import('/src/storage.ts')).loadBooks(),
    categories: JSON.parse(localStorage.getItem('reader-categories') ?? '[]'),
    positions: JSON.parse(localStorage.getItem('reader-positions') ?? '{}'),
    bookmarks: JSON.parse(localStorage.getItem('reader-bookmarks') ?? '[]'),
    settings: JSON.parse(localStorage.getItem('reader-settings') ?? '{}'),
    lastBook: localStorage.getItem('reader-last-book'),
    history: JSON.parse(localStorage.getItem('reader-command-history') ?? '[]'),
  }));
  const waitCategories = expected => page.waitForFunction(async expected => {
    const books = await (await import('/src/storage.ts')).loadBooks();
    return Object.entries(expected).every(([id, category]) => books.some(book => book.id === id && (book.category ?? '') === category));
  }, expected);
  const waitBookCount = count => page.waitForFunction(async count => (await (await import('/src/storage.ts')).loadBooks()).length === count, count);
  const enableMulti = async () => { if (await button('多选').count()) await button('多选').click(); };
  const addCategory = async name => {
    await button('管理分类').click();
    await page.getByRole('textbox', { name: '分类名称', exact: true }).fill(name);
    await button('新建分类').click();
    await button(`删除分类 ${name}`).waitFor();
    await button('返回书库').click();
  };
  const downloadArchive = async () => {
    const pending = page.waitForEvent('download');
    await command('/backup');
    const stream = await (await pending).createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  };

  await openLibrary();
  assert.equal(await page.locator('.book-item').count(), 6);
  assert.equal(await categoryFilter().locator('option[value="cat:空分类"]').count(), 1, 'Empty categories must be available');
  await addCategory('待读');
  assert.ok((await snapshot()).categories.includes('待读'));
  await enableMulti();
  assert.equal(await page.locator('.book-list').getAttribute('aria-multiselectable'), 'true');
  await row('category:01').click();
  await categoryFilter().selectOption('cat:技术');
  assert.equal(await page.locator('.book-item').count(), 2);
  await button('全选当前列表').click();
  assert.equal(await page.locator('.book-item[aria-selected="true"]').count(), 2);
  await search().fill('05');
  assert.equal(await page.locator('.book-item').count(), 1);
  assert.equal(await row('category:05').getAttribute('aria-selected'), 'true');
  assert.match(await page.locator('.library-selection-count').textContent(), /已选 3 本.*列表外 2 本/, 'Selection count must disclose checked books hidden by filters');
  await assignment().selectOption('待读');
  const beforeAssignment = await snapshot();
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    let calls = 0;
    IDBObjectStore.prototype.put = function (...args) {
      if (++calls === 2) throw new DOMException('Synthetic category assignment failure', 'QuotaExceededError');
      return original.apply(this, args);
    };
    window.__restoreCategoryTestWrite = () => { IDBObjectStore.prototype.put = original; };
  });
  await button('应用分类').click();
  await page.getByRole('alert').filter({ hasText: /Synthetic category assignment failure/ }).waitFor();
  await page.evaluate(() => { window.__restoreCategoryTestWrite(); delete window.__restoreCategoryTestWrite; });
  const afterFailedAssignment = await snapshot();
  assert.deepEqual(afterFailedAssignment.books, beforeAssignment.books, 'Failed assignment must roll back every selected book');
  assert.deepEqual(afterFailedAssignment.categories, beforeAssignment.categories, 'Failed assignment must preserve the category registry');
  assert.equal(await assignment().inputValue(), '待读', 'Failed assignment must retain the target category for retry');
  assert.equal(await row('category:05').getAttribute('aria-selected'), 'true');
  assert.match(await page.locator('.library-selection-count').textContent(), /已选 3 本.*列表外 2 本/, 'Failed assignment must retain checked books outside the filter');
  await button('应用分类').click();
  await waitCategories({ 'category:01': '待读', 'category:03': '待读', 'category:05': '待读' });
  assert.equal((await snapshot()).books.find(book => book.id === 'category:02').category, undefined, 'Bulk assignment must only change checked books');

  await openLibrary();
  await categoryFilter().selectOption('cat:待读');
  assert.equal(await page.locator('.book-item').count(), 3);
  await categoryFilter().selectOption('@uncategorized');
  assert.equal(await page.locator('.book-item').count(), 3);
  await button('管理分类').click();
  await button('重命名 待读').click();
  await page.getByRole('textbox', { name: '新的分类名称', exact: true }).fill('已整理');
  await button('保存名称').click();
  await button('删除分类 已整理').waitFor();
  await waitCategories({ 'category:01': '已整理', 'category:03': '已整理', 'category:05': '已整理' });
  assert.ok(!(await snapshot()).categories.includes('待读'));
  await button('删除分类 已整理').click();
  await button('删除分类 已整理').waitFor({ state: 'detached' });
  await waitCategories({ 'category:01': '', 'category:03': '', 'category:05': '' });
  assert.equal((await snapshot()).books.length, 6, 'Deleting a category must keep every book');
  await button('返回书库').click();
  await addCategory('归档');
  await addCategory('备用空分类');
  await categoryFilter().selectOption('');
  await enableMulti();
  if (await button('清空选择').isEnabled()) await button('清空选择').click();
  await row('category:01').click();
  await row('category:02').click();
  await assignment().selectOption('归档');
  await button('应用分类').click();
  await waitCategories({ 'category:01': '归档', 'category:02': '归档' });

  // A failed second delete must roll back the first delete as well.
  await openLibrary();
  await enableMulti();
  await row('category:01').focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Space');
  const beforeDelete = await snapshot();
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.delete;
    let calls = 0;
    IDBObjectStore.prototype.delete = function (...args) {
      if (++calls === 2) throw new DOMException('Synthetic batch delete failure', 'QuotaExceededError');
      return original.apply(this, args);
    };
    window.__restoreCategoryTestWrite = () => { IDBObjectStore.prototype.delete = original; };
  });
  await button('删除所选').click();
  await page.locator('#notice').filter({ hasText: /失败|无法|Synthetic batch delete failure/ }).waitFor();
  await page.evaluate(() => { window.__restoreCategoryTestWrite(); delete window.__restoreCategoryTestWrite; });
  assert.deepEqual((await snapshot()).books, beforeDelete.books, 'Batch delete failure must preserve every selected book');
  assert.equal(await page.locator('.book-item[aria-selected="true"]').count(), 2, 'Failed operations must keep the selection for retry');
  await button('删除所选').click();
  await waitBookCount(4);
  await button('撤销移出').waitFor();
  const afterDelete = await snapshot();
  assert.equal(afterDelete.books.some(book => ['category:01', 'category:02'].includes(book.id)), false);
  assert.deepEqual(afterDelete.bookmarks, beforeDelete.bookmarks, 'Removing cached books must retain their bookmarks');
  assert.ok(afterDelete.positions['category:01'].block >= 19, 'Removing the current book must retain its reading progress');
  assert.notEqual(afterDelete.lastBook, 'category:01', 'Removing the current book must clear its active reading reference');
  await button('撤销移出').click();
  await waitBookCount(6);
  assert.deepEqual((await snapshot()).books, beforeDelete.books, 'Undo must restore both books with their EPUB data and categories');
  await row('category:01').focus();
  await page.keyboard.press('Enter');
  await page.locator('#content').waitFor();
  await page.reload();
  await page.locator('#content').waitFor();
  const restarted = await snapshot();
  assert.equal(restarted.books.length, 6);
  assert.ok(restarted.categories.includes('归档') && restarted.categories.includes('备用空分类'));
  assert.equal(restarted.books.find(book => book.id === 'category:02').category, '归档');

  const archive = await downloadArchive();
  assert.ok(archive.categories.includes('归档') && archive.categories.includes('备用空分类'), 'Backups must include used and empty categories');
  assert.equal(archive.books.find(book => book.id === 'category:02').category, '归档');
  const changedArchive = { ...archive, categories: ['恢复分类', '备份空分类'], books: archive.books.map(book => ({ ...book, category: '恢复分类' })) };
  await command('/restore');
  await page.getByLabel('备份内容', { exact: true }).fill(JSON.stringify(changedArchive));
  await page.getByRole('button', { name: '预览备份', exact: true }).click();
  await button('合并并恢复').waitFor();
  const beforeRestore = await snapshot();
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    let failed = false;
    Storage.prototype.setItem = function (key, value) {
      if (this === localStorage && key === 'reader-categories' && !failed) {
        failed = true;
        throw new DOMException('Synthetic category settings failure', 'QuotaExceededError');
      }
      return original.call(this, key, value);
    };
    window.__restoreCategoryTestWrite = () => { Storage.prototype.setItem = original; };
  });
  await button('合并并恢复').click();
  await page.locator('#notice').filter({ hasText: '恢复失败' }).waitFor();
  await page.evaluate(() => { window.__restoreCategoryTestWrite(); delete window.__restoreCategoryTestWrite; });
  assert.deepEqual(await snapshot(), beforeRestore, 'Category restore failure must roll back books, categories and preferences together');
  await button('合并并恢复').click();
  await page.locator('#notice').filter({ hasText: '已恢复 6 本书' }).waitFor();
  await waitCategories(Object.fromEntries(archive.books.map(book => [book.id, '恢复分类'])));
  assert.ok((await snapshot()).categories.includes('备份空分类'));
  await openLibrary();
  await categoryFilter().selectOption('cat:恢复分类');
  assert.equal(await page.locator('.book-item').count(), 6);
  await enableMulti();
  await row('category:01').click();
  await row('category:02').click();
  await button('删除所选').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'artifacts/library-categories-normal.png' });
  await page.setViewportSize({ width: 280, height: 160 });
  await enableMulti();
  await row('category:01').focus();
  await page.keyboard.press('Control+a');
  assert.equal(await page.locator('.book-item[aria-selected="true"]').count(), 6);
  await page.keyboard.press('End');
  assert.equal(await row('category:06').evaluate(element => {
    const rect = element.getBoundingClientRect();
    const panel = document.querySelector('#panel-body').getBoundingClientRect();
    return rect.top >= panel.top - 1 && rect.bottom <= panel.bottom + 1;
  }), true, 'Multi-selection must remain keyboard operable in a small window');
  await page.screenshot({ path: 'artifacts/library-categories-small.png' });
  assert.deepEqual(errors, []);
  console.log('PASS: category creation/filter/rename/delete, cross-filter multi-selection, bulk assignment/failure rollback/retry, atomic batch deletion/undo, progress/bookmark preservation, restart, category backup/restore/rollback, small-window keyboard selection.');
} finally {
  await browser.close();
}
