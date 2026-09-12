import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 560, height: 400 }, acceptDownloads: true });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:1420', { waitUntil: 'networkidle' });
  await page.evaluate(async () => {
    await (await import('/src/storage.ts')).replaceBooks(Array.from({ length: 4 }, (_, i) => ({
      id: `keyboard:${i + 1}`, name: `0${i + 1}.md`,
      content: Array.from({ length: 90 }, (_, n) => `${n % 30 === 0 ? `# Chapter ${n / 30 + 1}\n\n` : ''}Paragraph ${n}. ${n === 40 || n === 60 ? 'needle ' : ''}Keyboard reading text.`).join('\n\n'),
    })));
  });
  await page.reload({ waitUntil: 'networkidle' });
  const key = value => page.keyboard.press(value);
  const type = value => page.keyboard.type(value);
  const button = name => page.getByRole('button', { name, exact: true });
  const focused = locator => locator.evaluate(element => element === document.activeElement);
  const books = () => page.evaluate(async () => (await import('/src/storage.ts')).loadBooks());
  const title = () => page.locator('#panel-title').textContent();
  const field = label => page.getByLabel(label, { exact: true });
  const command = async value => { await key('Control+k'); await type(value); await key('Enter'); };
  const tabTo = async locator => {
    for (let i = 0; i < 80; i++) {
      if (await locator.count() && await focused(locator)) return;
      await key('Tab');
    }
    throw new Error(`Cannot reach ${locator} with Tab; active=${await page.evaluate(() => document.activeElement.outerHTML)}`);
  };
  // After seeding fixtures, every interaction below uses key presses/text entry, never click/focus/fill.
  await key('Escape'); await key('Control+b');
  await page.waitForFunction(() => document.querySelectorAll('.book-item').length === 4);
  await key('Enter');
  await key('F6'); assert.ok(await focused(field('命令')));
  await key('Tab'); assert.equal(await focused(field('命令')), false, 'An empty command must not trap Tab');
  await key('F6'); assert.ok(await focused(page.locator('#reader')));
  await key('Space'); await page.waitForFunction(() => document.querySelector('#reader').scrollTop > 3);
  await key('F1');
  const pausedAt = await page.locator('#reader').evaluate(element => element.scrollTop);
  await page.waitForTimeout(350);
  assert.equal(await page.locator('#reader').evaluate(element => element.scrollTop), pausedAt, 'Help pauses background automatic reading');
  await key('F1'); await page.waitForFunction(top => document.querySelector('#reader').scrollTop > top + 2, pausedAt); await key('Space');
  await key('Control+k'); await type('boo'); await key('Tab');
  assert.equal(await field('命令').inputValue(), '/books ');
  await key('Enter'); assert.match(await title(), /书库/);
  await key('Control+f'); await type('02'); await key('ArrowDown'); await key('Enter');
  assert.match(await page.locator('#session-file').textContent(), /02.md/);
  await key('Control+b'); await key('Control+f'); await key('Control+a'); await key('Backspace'); await key('ArrowDown');
  await key('Control+m'); await key('Space'); await key('Shift+ArrowDown');
  assert.equal(await page.locator('.book-item[aria-selected="true"]').count(), 2);
  await key('Control+Shift+a'); assert.equal(await page.locator('.book-item[aria-selected="true"]').count(), 0);
  await key('Control+a'); assert.equal(await page.locator('.book-item[aria-selected="true"]').count(), 4);
  await key('Control+f'); await type('01'); await key('Control+a'); await key('Delete');
  assert.equal((await books()).length, 4, 'Delete inside a search box edits text only');
  assert.equal(await page.locator('.book-item[aria-selected="true"]').count(), 4, 'Input Ctrl+A must not change checked books');

  await key('Control+Shift+g'); await key('Control+n'); await type('Reading'); await key('Enter');
  await button('重命名 Reading').waitFor();
  await type('Draft'); await key('F1');
  assert.ok(await page.locator('#keyboard-help').isVisible());
  await page.screenshot({ path: 'artifacts/keyboard-help.png' });
  await key('PageDown');
  await page.waitForFunction(() => document.querySelector('#keyboard-help-body').scrollTop > 0);
  await key('F1'); assert.ok(await focused(field('分类名称')));
  assert.equal(await field('分类名称').inputValue(), 'Draft', 'Help preserves draft and focus');
  await key('F6'); await key('F2'); await key('Control+a'); await type('Canceled'); await key('Escape');
  assert.equal(await button('重命名 Reading').count(), 1);
  await key('F2'); await key('Control+a'); await type('Finished'); await key('Enter');
  await button('重命名 Finished').waitFor(); assert.ok(await focused(button('重命名 Finished')));
  await key('Escape'); assert.match(await title(), /书库/);
  await key('Alt+g'); await key('End'); await key('Control+Enter');
  await page.waitForFunction(() => document.querySelectorAll('.book-category').length === 4);
  assert.ok((await books()).every(book => book.category === 'Finished'));
  await key('Alt+g'); await key('Delete'); assert.equal((await books()).length, 4);
  await key('F6'); assert.ok(await page.locator('.book-item[data-focused="true"]').evaluate(element => element === document.activeElement));
  await key('Delete'); await button('撤销移出').waitFor(); assert.equal((await books()).length, 0);
  await key('Control+z'); await page.waitForFunction(() => document.querySelectorAll('.book-item').length === 4);
  assert.equal((await books()).length, 4, 'Immediate keyboard undo works even after deleting the entire library');
  await key('Escape'); assert.ok(await page.locator('#panel').isVisible(), 'First Escape leaves multi-select');
  await key('Control+Shift+g'); await key('F6'); await key('Delete');
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('reader-categories')).length === 0);
  assert.ok((await books()).every(book => !book.category));
  await key('Escape'); await key('Enter');

  await key('Control+j'); await key('Control+f'); await type('Chapter 2'); await key('ArrowDown'); await key('Enter');
  assert.ok(await focused(page.locator('#reader'))); await key('Alt+ArrowLeft');
  await key('Control+Shift+f'); await type('needle'); await key('Enter');
  await page.locator('mark.reader-match-current').first().waitFor(); await key('F3'); await key('Shift+F3'); await key('Escape');
  await key('Control+d'); await type('Mark one'); await key('Enter');
  assert.ok(await focused(button('Mark one')));
  await key('F2'); await type('Discard'); await key('Escape'); assert.equal(await button('Mark one').count(), 1);
  await key('F2'); await type('Changed'); await key('Enter'); assert.ok(await focused(button('Changed')));
  await key('ArrowRight'); assert.ok(await focused(button('改名'))); await key('ArrowLeft'); await key('Delete');
  assert.equal(await button('Changed').count(), 0); assert.ok(await focused(field('书签名称')));
  await key('Control+n'); await type('Keep'); await key('Enter'); await key('Enter'); assert.ok(await focused(page.locator('#reader')));

  await key('Control+,'); await tabTo(page.locator('summary')); await key('Enter');
  await tabTo(field('背景颜色值')); await key('Control+a'); await type('#123456'); await key('Enter');
  assert.equal(await page.locator('#app').evaluate(element => element.style.getPropertyValue('--bg')), '#123456');
  await key('Control+a'); await type('#bad'); await key('Escape');
  assert.equal(await field('背景颜色值').inputValue(), '#123456'); assert.ok(await page.locator('#panel').isVisible());
  await key('Control+k'); await type('speed 24'); await key('Enter');
  await key('F10'); assert.ok(await page.locator('#profile-menu').isVisible()); await key('End'); await key('Home'); await key('Escape');

  const download = page.waitForEvent('download'); await key('Control+Shift+b'); await download;
  await key('Control+Shift+r'); assert.ok(await focused(field('备份内容'))); await key('Escape');
  await key('Control+b'); await key('Control+f');
  await page.evaluate(() => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })));
  assert.ok(await focused(field('筛选书库')), 'IME confirmation must not move focus or activate an action');
  await key('Escape'); await key('Control+b'); await key('Control+a');
  await page.setViewportSize({ width: 280, height: 160 });
  await key('End'); await key('F1'); await key('PageDown'); await key('Escape');
  assert.ok(await page.locator('.book-item[data-focused="true"]').evaluate(element => element === document.activeElement));
  await key('F6'); await key('Shift+F6');
  await page.screenshot({ path: 'artifacts/keyboard-small.png' });
  assert.deepEqual(errors, []);
  console.log('PASS: keyboard-only commands, focus regions/help, library selection/classification/removal/undo, category and bookmark editing, search/chapters, settings/colors, backup entry points, IME and small window.');
} finally { await browser.close(); }
