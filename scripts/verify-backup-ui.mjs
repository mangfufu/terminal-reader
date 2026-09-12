import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 560, height: 400 }, acceptDownloads: true });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const preferences = sessionStorage.getItem('test-next-preferences');
    if (preferences) {
      for (const [key, value] of Object.entries(JSON.parse(preferences))) localStorage.setItem(key, value);
      sessionStorage.removeItem('test-next-preferences');
    }
  });
  await page.goto('http://127.0.0.1:1420', { waitUntil: 'networkidle' });
  await page.evaluate(async () => {
    const { replaceBooks } = await import('/src/storage.ts');
    const content = '# 第一章\n\n' + Array.from({ length: 100 }, (_, i) => `第 ${i + 1} 段。雨夜中的书店，灯光映在窗前。`).join('\n\n');
    await replaceBooks([
      { id: 'backup:01', name: '01 夜航.md', content },
      { id: 'backup:02', name: '02 星海.epub', format: 'epub', title: '星海', author: '测试作者', content: '序章\n\n星光映在海面。', blocks: [{ text: '序章', kind: 'heading' }, { text: '星光映在海面。', kind: 'paragraph' }], chapters: [{ title: '序章', block: 0, level: 1 }] },
    ]);
    localStorage.setItem('reader-settings', JSON.stringify({ theme: 'cmd', fontSize: 18, speed: 24, mode: 'plain', effectFrequency: 'off', colorSeed: 123, fontFamily: 'Consolas', lineHeight: 1.5, fontWeight: 500, colors: { bg: '#121212', text: '#bbbbbb' }, colorSchemes: [{ name: '夜色', colors: { bg: '#121212' } }] }));
    localStorage.setItem('reader-positions', JSON.stringify({ 'backup:01': { block: 20, fraction: 0.3 }, 'backup:02': { block: 1, fraction: 0 } }));
    localStorage.setItem('reader-bookmarks', JSON.stringify([{ id: 'mark:original', bookId: 'backup:01', label: '雨夜', position: { block: 17, fraction: 0, offset: 2 }, createdAt: 1789200000000 }]));
    localStorage.setItem('reader-last-book', 'backup:01');
    localStorage.setItem('reader-command-history', JSON.stringify(['/find 书店', '/books']));
    // Install these fixtures before the next page loads, after the old page's unload save.
    sessionStorage.setItem('test-next-preferences', JSON.stringify(Object.fromEntries(Object.keys(localStorage).filter(key => key.startsWith('reader-')).map(key => [key, localStorage.getItem(key)]))));
  });
  await page.reload();
  await page.locator('#content').waitFor({ timeout: 10000 }).catch(async error => {
    console.log('Initial restore diagnostics:', await page.evaluate(() => ({ notice: document.querySelector('#notice')?.textContent, lastBook: localStorage.getItem('reader-last-book'), settings: localStorage.getItem('reader-settings'), positions: localStorage.getItem('reader-positions') })), errors);
    throw error;
  });
  const command = async value => {
    await page.keyboard.press('Escape');
    const input = page.getByRole('combobox', { name: '命令' });
    await input.fill(value); await input.press('Enter');
  };
  const snapshot = () => page.evaluate(async () => ({
    books: await (await import('/src/storage.ts')).loadBooks(),
    settings: JSON.parse(localStorage.getItem('reader-settings') ?? '{}'),
    positions: JSON.parse(localStorage.getItem('reader-positions') ?? '{}'),
    bookmarks: JSON.parse(localStorage.getItem('reader-bookmarks') ?? '[]'),
    lastBook: localStorage.getItem('reader-last-book'),
    history: JSON.parse(localStorage.getItem('reader-command-history') ?? '[]'),
  }));
  const downloadPromise = page.waitForEvent('download');
  await command('/backup');
  const download = await downloadPromise;
  assert.match(download.suggestedFilename(), /^terminal-reader-\d{4}-\d{2}-\d{2}\.json$/);
  const stream = await download.createReadStream();
  const chunks = []; for await (const chunk of stream) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  const backup = JSON.parse(bytes.toString('utf8'));
  assert.equal(backup.format, 'terminal-reader-backup');
  assert.equal(backup.version, 1);
  assert.equal(backup.books.length, 2);
  assert.equal(backup.books[1].author, '测试作者');
  assert.equal(backup.books[1].chapters[0].title, '序章');
  assert.equal(backup.bookmarks[0].label, '雨夜');
  assert.ok(backup.positions['backup:01'].block >= 19);
  assert.equal(backup.settings.colors.bg, '#121212');
  assert.ok(backup.commandHistory.includes('/find 书店'));

  await page.evaluate(async () => {
    const { saveBooks } = await import('/src/storage.ts');
    await saveBooks([{ id: 'backup:01', name: '01 夜航.md', content: '修改过的版本' }, { id: 'backup:03', name: '03 新书.txt', content: '备份之后新增，合并时应当保留。' }]);
    localStorage.setItem('reader-settings', JSON.stringify({ theme: 'linux', fontSize: 22, colors: { bg: '#202020' }, effectFrequency: 'off' }));
    localStorage.setItem('reader-positions', JSON.stringify({ 'backup:01': { block: 0, fraction: 0 }, 'backup:03': { block: 0, fraction: 0 } }));
    localStorage.setItem('reader-bookmarks', JSON.stringify([{ id: 'mark:original', bookId: 'backup:01', label: '已修改', position: { block: 0, fraction: 0 }, createdAt: 1789200000000 }, { id: 'mark:new', bookId: 'backup:03', label: '新书签', position: { block: 0, fraction: 0 }, createdAt: 1789200000001 }]));
    localStorage.setItem('reader-command-history', JSON.stringify(['/mode plain']));
    sessionStorage.setItem('test-next-preferences', JSON.stringify(Object.fromEntries(Object.keys(localStorage).filter(key => key.startsWith('reader-')).map(key => [key, localStorage.getItem(key)]))));
  });
  await page.reload(); await page.locator('#content').waitFor();
  await command('/restore');
  await page.getByLabel('备份内容', { exact: true }).fill((bytes).toString('utf8'));
  await page.getByRole('button', { name: '预览备份', exact: true }).click();
  await page.getByRole('button', { name: '合并并恢复', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '已恢复 2 本书' }).waitFor();
  const restored = await snapshot();
  assert.equal(restored.books.length, 3, 'Merge must retain books absent from the archive');
  assert.equal(restored.books.find(book => book.id === 'backup:01').content, backup.books[0].content);
  assert.equal(restored.books.find(book => book.id === 'backup:03').content, '备份之后新增，合并时应当保留。');
  assert.equal(restored.settings.theme, 'cmd');
  assert.equal(restored.settings.fontFamily, 'Consolas');
  assert.equal(restored.settings.lineHeight, 1.5);
  assert.deepEqual(restored.settings.colors, backup.settings.colors);
  assert.deepEqual(restored.settings.colorSchemes, backup.settings.colorSchemes);
  assert.deepEqual(restored.bookmarks.find(mark => mark.id === 'mark:original'), backup.bookmarks[0]);
  assert.ok(restored.bookmarks.some(mark => mark.id === 'mark:new'));
  assert.deepEqual(restored.positions['backup:02'], backup.positions['backup:02']);
  assert.ok(Math.abs(restored.positions['backup:01'].block - backup.positions['backup:01'].block) <= 1);
  assert.equal(restored.lastBook, backup.lastBook);
  assert.ok(restored.history.includes('/mode plain') && restored.history.includes('/find 书店'));

  for (const invalid of [{ ...backup, version: 99 }, { ...backup, books: [{ id: 'broken', name: 'x', content: null }] }]) {
    await command('/restore');
    const before = await snapshot();
    await page.getByLabel('备份内容', { exact: true }).fill((Buffer.from(JSON.stringify(invalid))).toString('utf8'));
  await page.getByRole('button', { name: '预览备份', exact: true }).click();
    await page.locator('#notice').filter({ hasText: '备份无效' }).waitFor();
    assert.deepEqual(await snapshot(), before, 'Invalid archives must leave the existing books and preferences intact');
    assert.equal(await page.getByRole('button', { name: '合并并恢复', exact: true }).count(), 0);
  }

  for (const failure of ['preferences', 'books']) {
    await command('/restore');
    const changedArchive = { ...backup, settings: { ...backup.settings, theme: 'linux', fontSize: 22 }, books: [...backup.books, { id: 'should-rollback', name: 'rollback.txt', content: '不能部分恢复' }] };
    await page.getByLabel('备份内容', { exact: true }).fill((Buffer.from(JSON.stringify(changedArchive))).toString('utf8'));
  await page.getByRole('button', { name: '预览备份', exact: true }).click();
    await page.getByRole('button', { name: '合并并恢复', exact: true }).waitFor();
    const before = await snapshot();
    await page.evaluate(failure => {
      if (failure === 'preferences') {
        const setItem = Storage.prototype.setItem;
        let failed = false;
        Storage.prototype.setItem = function (key, value) {
          if (this === localStorage && key === 'reader-positions' && !failed) { failed = true; throw new DOMException('Synthetic settings quota failure', 'QuotaExceededError'); }
          return setItem.call(this, key, value);
        };
        window.__restoreWriteMethod = () => { Storage.prototype.setItem = setItem; };
      } else {
        const put = IDBObjectStore.prototype.put;
        let calls = 0;
        IDBObjectStore.prototype.put = function (...args) {
          if (++calls === 2) throw new DOMException('Synthetic book write failure', 'QuotaExceededError');
          return put.apply(this, args);
        };
        window.__restoreWriteMethod = () => { IDBObjectStore.prototype.put = put; };
      }
    }, failure);
    await page.getByRole('button', { name: '合并并恢复', exact: true }).click();
    await page.locator('#notice').filter({ hasText: '恢复失败' }).waitFor();
    await page.evaluate(() => { window.__restoreWriteMethod(); delete window.__restoreWriteMethod; });
    assert.deepEqual(await snapshot(), before, `A ${failure} write failure must restore all existing library state`);
  }

  await command('/books');
  await page.getByRole('searchbox', { name: '筛选书库' }).fill('测试作者');
  assert.equal(await page.locator('.book-item').count(), 1);
  assert.match(await page.locator('.book-item').textContent(), /星海/);
  assert.match(await page.locator('.book-item').textContent(), /测试作者/);
  assert.match(await page.locator('.book-item').textContent(), /02 星海\.epub/);
  assert.match(await page.locator('.book-item').getAttribute('title'), /backup:02/);
  await page.getByRole('button', { name: '移出书库', exact: true }).click();
  await page.getByRole('button', { name: '撤销移出', exact: true }).waitFor();
  assert.equal((await snapshot()).books.length, 2);
  await page.getByRole('button', { name: '撤销移出', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#panel-title').textContent === '书库 / 3');
  const undone = await snapshot();
  assert.equal(undone.books.length, 3);
  assert.deepEqual(undone.books.find(book => book.id === 'backup:02'), backup.books[1]);
  await page.getByRole('searchbox', { name: '筛选书库' }).fill('does-not-exist');
  assert.equal(await page.getByRole('button', { name: '移出书库', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: '刷新选中', exact: true }).isDisabled(), true);
  await page.keyboard.press('Escape');
  await page.reload(); await page.locator('#content').waitFor();
  assert.equal((await snapshot()).books.length, 3);
  assert.equal((await snapshot()).settings.theme, 'cmd');

  // Demo books are normally in memory; backup restoration also stores them in IndexedDB.
  const downloadArchive = async () => {
    const pending = page.waitForEvent('download');
    await command('/backup');
    const stream = await (await pending).createReadStream();
    const chunks = []; for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
  };
  await command('/demo');
  const withDemo = await downloadArchive();
  const demoBackup = JSON.parse(withDemo.toString('utf8'));
  assert.equal(demoBackup.lastBook, 'demo:01');
  assert.equal(demoBackup.books.filter(book => book.id === 'demo:01').length, 1);
  await command('/restore');
  await page.getByLabel('备份内容', { exact: true }).fill((withDemo).toString('utf8'));
  await page.getByRole('button', { name: '预览备份', exact: true }).click();
  await page.getByRole('button', { name: '合并并恢复', exact: true }).click();
  await page.locator('#notice').filter({ hasText: '已恢复 4 本书' }).waitFor();
  await page.reload(); await page.locator('#content').waitFor();
  assert.equal((await snapshot()).lastBook, 'demo:01');
  await command('/books');
  assert.equal(await page.locator('.book-item').count(), 4);
  assert.equal(await page.locator('.book-item[title="demo:01"]').count(), 1, 'Reload must not append a second copy of a restored demo book');
  const reExported = JSON.parse((await downloadArchive()).toString('utf8'));
  assert.equal(reExported.books.length, 4);
  assert.equal(new Set(reExported.books.map(book => book.id)).size, 4, 'A restored demo archive must remain exportable without duplicate IDs');
  assert.deepEqual(errors, []);
  console.log('PASS: backup download, EPUB metadata, merge restore, progress/bookmark/preferences recovery, invalid-file isolation, settings/IndexedDB failure rollback, library filtering/removal/undo, demo restore/restart/re-export.');
} finally { await browser.close(); }
