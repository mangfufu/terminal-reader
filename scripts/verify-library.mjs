import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 560, height: 400 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:1420');
  // Seed only this isolated browser context; never touch the desktop library.
  await page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('terminal-reader', 2);
      request.onupgradeneeded = () => request.result.createObjectStore('books', { keyPath: 'id' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction('books', 'readwrite');
      for (let index = 1; index <= 14; index++) {
        const number = String(index).padStart(2, '0');
        transaction.objectStore('books').put({
          id: `test:${number}`, name: `${number}.md`,
          content: `# 文件 ${number}\n\n` + Array.from({ length: 100 }, (_, line) => `文件 ${number} 的第 ${line + 1} 段。这里是用来验证阅读位置的正文。`).join('\n\n'),
        });
      }
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  });
  await page.reload();
  const command = async value => {
    await page.keyboard.press('/');
    const input = page.getByRole('combobox', { name: '命令' });
    await input.fill(value);
    await input.press('Enter');
  };
  const selectedBook = () => page.locator('.book-item[aria-selected="true"] .library-book-text').textContent();
  const scrollTop = () => page.locator('#reader').evaluate(element => element.scrollTop);
  const currentFile = () => page.locator('#session-file').textContent();
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const assertReaderFocused = async () => assert.equal(await page.locator('#reader').evaluate(element => element === document.activeElement), true);

  await command('/books');
  assert.equal(await page.locator('.book-item').first().evaluate(element => element === document.activeElement), true,
    'Opening the library must focus a book, not the import toolbar');
  assert.equal(await selectedBook(), '01.md');
  await page.keyboard.press('ArrowDown');
  assert.equal(await selectedBook(), '02.md');
  await page.keyboard.press('ArrowUp');
  assert.equal(await selectedBook(), '01.md');
  await page.keyboard.press('End');
  assert.equal(await selectedBook(), '14.md');
  await page.keyboard.press('Home');
  await page.keyboard.press('PageDown');
  assert.notEqual(await selectedBook(), '01.md');
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  await assertReaderFocused();
  await settle();
  assert.match(await currentFile(), /01\.md/);
  assert.equal(await scrollTop(), 0);
  await page.keyboard.press('PageDown');
  await page.keyboard.press('PageDown');
  const firstPosition = await scrollTop();
  assert.ok(firstPosition > 100);

  await page.keyboard.press('ArrowRight');
  await settle();
  assert.match(await currentFile(), /02\.md/);
  assert.equal(await scrollTop(), 0, 'An unread file must begin at its first line');
  await page.keyboard.press('PageDown');
  const secondPosition = await scrollTop();
  await page.keyboard.press('ArrowLeft');
  await settle();
  const restoredFirst = await scrollTop();
  assert.ok(Math.abs(restoredFirst - firstPosition) <= 1, `Restore file 01 history: expected ${firstPosition}, got ${restoredFirst}`);
  await page.keyboard.press('ArrowRight');
  await settle();
  assert.ok(Math.abs(await scrollTop() - secondPosition) <= 1, 'Restore file 02 history');

  await page.keyboard.press('Space');
  await page.waitForFunction(top => document.querySelector('#reader').scrollTop > top + 3, secondPosition);
  await page.keyboard.press('ArrowRight');
  await settle();
  assert.match(await currentFile(), /03\.md/);
  assert.equal(await scrollTop(), 0);
  assert.match(await page.locator('#reading-status').textContent(), /^阅读/,
    'Manual file switching should pause automatic scrolling at the destination');

  await command('/books');
  assert.equal(await selectedBook(), '03.md');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Escape');
  await assertReaderFocused();
  assert.match(await currentFile(), /03\.md/, 'Selecting without Enter must not switch files');
  await command('/prev');
  assert.ok(await scrollTop() > 0);
  await command('/next');
  assert.equal(await scrollTop(), 0);

  await page.setViewportSize({ width: 280, height: 160 });
  await command('/books');
  await page.keyboard.press('End');
  assert.equal(await selectedBook(), '14.md');
  assert.equal(await page.locator('.book-item[aria-selected="true"]').evaluate(element => {
    const rect = element.getBoundingClientRect();
    const body = document.querySelector('#panel-body').getBoundingClientRect();
    return rect.top >= body.top - 1 && rect.bottom <= body.bottom + 1;
  }), true, 'Keyboard selection must scroll into view in a small window');
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('#panel-close').evaluate(element => element === document.activeElement), true,
    'Tab should leave the book list as one focus stop');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.locator('.book-item[aria-selected="true"]').evaluate(element => element === document.activeElement), true);
  await page.keyboard.press('Enter');
  await assertReaderFocused();
  assert.match(await currentFile(), /14\.md/);
  assert.equal(await scrollTop(), 0);
  await page.keyboard.press('ArrowRight');
  assert.match(await currentFile(), /14\.md/);
  await page.reload();
  await page.locator('#content').waitFor();
  assert.match(await currentFile(), /14\.md/);
  await page.setViewportSize({ width: 560, height: 400 });
  await command('/books');
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  await settle();
  assert.ok(Math.abs(await scrollTop() - firstPosition) <= 1, 'History must survive a reload');
  await page.keyboard.press('End');
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.querySelector('#session-file').textContent.includes('02.md'));
  assert.ok(await scrollTop() < 10, 'Continuous reading starts the next file at the beginning');
  assert.match(await page.locator('#reading-status').textContent(), /^自动滚动/);
  await page.keyboard.press('Space');
  assert.deepEqual(errors, []);
  console.log('PASS: library keyboard selection, focus, small-window scrolling, unread starts, per-file history, manual/automatic transitions, reload.');
} finally { await browser.close(); }
