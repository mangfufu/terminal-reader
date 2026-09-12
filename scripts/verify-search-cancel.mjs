import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 560, height: 400 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('reader-settings', JSON.stringify({ mode: 'plain', effectFrequency: 'off', fontSize: 16, colorSeed: 123 }));
    localStorage.setItem('reader-last-book', 'search:cancel');
    localStorage.setItem('reader-positions', JSON.stringify({ 'search:cancel': { block: 900, fraction: 0 } }));
  });
  await page.goto('http://127.0.0.1:1420');
  await page.evaluate(async () => {
    const { replaceBooks } = await import('/src/storage.ts');
    await replaceBooks([{
      id: 'search:cancel', name: '搜索取消.md',
      content: '# 第一章\n\n' + Array.from({ length: 1800 }, (_, i) => `第 ${i + 1} 段。书店的灯光映在河面。${i === 50 || i === 1400 ? '匹配标记' : ''}`).join('\n\n'),
    }]);
  });
  await page.reload(); await page.locator('#content').waitFor();
  const settle = () => page.evaluate(() => new Promise(resolve => setTimeout(resolve, 80)));
  await settle();
  const top = () => page.locator('#reader').evaluate(reader => reader.scrollTop);
  const originalTop = await top();
  assert.ok(originalTop > 1000);
  const find = async () => {
    const input = page.getByRole('combobox', { name: '命令' });
    await input.fill('/find 匹配标记'); await input.press('Enter');
    await page.locator('#panel-body [role="status"]').filter({ hasText: '找到 2 处' }).waitFor();
  };

  // Clearing a previously used query must retain the original return position.
  await find();
  await page.getByRole('searchbox', { name: '搜索正文' }).press('Enter');
  await page.locator('#panel').waitFor({ state: 'hidden' });
  await settle();
  assert.ok(Math.abs(await top() - originalTop) > 1000);
  await page.keyboard.press('Control+f');
  await page.getByRole('searchbox', { name: '搜索正文' }).fill('');
  await page.locator('#panel-body [role="status"]').filter({ hasText: '输入关键词' }).waitFor();
  await page.keyboard.press('Escape'); await settle();
  assert.ok(Math.abs(await top() - originalTop) <= 2, 'An empty query must still return to the pre-search position');

  for (const destination of ['escape', 'bookmarks']) {
    await find();
    const before = await top();
    // The document has multiple search batches. Dispatch cancellation in the same
    // task, while Enter's search is suspended at its first asynchronous yield.
    await page.evaluate(destination => {
      const field = document.querySelector('input[aria-label="搜索正文"]');
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      document.dispatchEvent(new KeyboardEvent('keydown', destination === 'escape'
        ? { key: 'Escape', bubbles: true, cancelable: true }
        : { key: 'd', ctrlKey: true, bubbles: true, cancelable: true }));
    }, destination);
    await settle();
    assert.ok(Math.abs(await top() - before) <= 2, `Cancelled Enter search must not jump after ${destination}`);
    if (destination === 'escape') assert.equal(await page.locator('#panel').isHidden(), true);
    else {
      assert.equal(await page.locator('#panel').isVisible(), true);
      assert.equal(await page.locator('#panel-title').textContent(), '书签', 'A cancelled search must not close the newly opened bookmark panel');
      assert.equal(await page.getByRole('textbox', { name: '书签名称', exact: true }).evaluate(field => field === document.activeElement), true);
    }
  }
  assert.deepEqual(errors, []);
  console.log('PASS: empty-query return position, Enter/Escape cancellation, Enter/bookmark-panel cancellation without delayed jumps or focus loss.');
} finally { await browser.close(); }
