import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 560, height: 400 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(process.env.DEMO_URL || 'http://127.0.0.1:1420');
  await page.locator('#command-input').waitFor();
  const command = async text => { await page.keyboard.press('Control+k'); await page.locator('#command-input').fill(text); await page.keyboard.press('Enter'); };
  const key = text => page.keyboard.press(text);
  for (const name of ['sample.mobi', 'sample.azw3', 'hybrid.mobi', 'sample.html']) {
    const encoded = (await readFile(`tests/fixtures/ebooks/${name}`)).toString('base64');
    const result = await page.evaluate(async ({ name, encoded }) => {
      const { decodeImported } = await import('/src/ebook-import.ts');
      let frames = 0; const heartbeat = setInterval(() => frames++, 5);
      try {
        const book = await decodeImported({ id: name, name, content: '', encoded });
        await (await import('/src/storage.ts')).saveBooks([book]);
        return { content: book.content, chapters: book.chapters, encoded: 'encoded' in book, frames };
      } finally { clearInterval(heartbeat); }
    }, { name, encoded });
    assert.match(result.content, /甲乙丙丁，春夏秋冬。/);
    assert.match(result.content, /全书结束。/);
    assert.ok(result.chapters.length >= 2); assert.equal(result.encoded, false);
    assert.ok(result.frames > 0, 'UI remains responsive during worker import');
  }
  await page.evaluate(async () => {
    await (await import('/src/storage.ts')).saveBooks([{ id: 'font-test', name: '字号与小狗.txt', content: Array.from({ length: 300 }, (_, i) => `第 ${i} 段。这是测试用的文字，包含逗号、句号与问号？小狗吃掉标点后，书籍原文保持完整。`).join('\n\n') }]);
  });
  await page.reload(); await command('cat "字号与小狗.txt"');
  await key('PageDown'); await key('PageDown');
  await page.waitForTimeout(350);
  const state = () => page.evaluate(() => ({ font: JSON.parse(localStorage.getItem('reader-settings')).fontSize, position: JSON.parse(localStorage.getItem('reader-positions'))['font-test'] }));
  const before = await state();
  await key('Control+ArrowUp'); await page.waitForTimeout(350);
  const after = await state();
  assert.equal(after.font, before.font + 1); assert.equal(after.position.block, before.position.block);
  assert.ok(Math.abs((after.position.offset || 0) - (before.position.offset || 0)) < 30);
  await command('style'); await key('Control+ArrowDown');
  assert.equal(Number(await page.getByLabel('正文字号', { exact: true }).inputValue()), before.font);
  await key('Escape');
  for (let i = 0; i < 20; i++) await key('Control+ArrowUp');
  assert.equal((await state()).font, 24);
  for (let i = 0; i < 24; i++) await key('Control+ArrowDown');
  assert.equal((await state()).font, 12);
  for (let i = 12; i < before.font; i++) await key('Control+ArrowUp');
  await key('Home'); await page.waitForTimeout(1500);
  const text = await page.locator('#content').textContent();
  await command('dog');
  await page.waitForFunction(() => Number(document.querySelector('.terminal-dog').dataset.droppings) > 0, null, { timeout: 15000 });
  assert.equal(await page.locator('#content').textContent(), text);
  assert.equal(await page.locator('.terminal-dog').evaluate(element => getComputedStyle(element).pointerEvents), 'none');
  await mkdir('artifacts/ebook-dog', { recursive: true });
  await page.screenshot({ path: 'artifacts/ebook-dog/dog.png' });
  await command('boss'); assert.equal(await page.locator('.terminal-dog').isVisible(), false);
  await key('Alt+q'); await command('dog');
  assert.equal(await page.locator('.terminal-dog').isVisible(), false);
  assert.equal(await page.locator('#content').textContent(), text);
  await key('F10'); await page.getByRole('menuitem', { name: '小狗', exact: true }).click();
  await page.locator('.terminal-dog').waitFor();
  await key('F10'); await page.getByRole('menuitem', { name: '收回小狗', exact: true }).click();
  assert.equal(await page.locator('.terminal-dog').isVisible(), false);
  await page.reload(); assert.equal(await page.locator('.terminal-dog').isVisible(), false);
  assert.equal((await state()).font, before.font);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await command('dog'); await page.locator('.terminal-dog').waitFor();
  await page.waitForTimeout(150);
  const still = await page.locator('.terminal-dog').evaluate(canvas => canvas.toDataURL());
  await page.waitForTimeout(400);
  assert.ok(await page.locator('.terminal-dog').evaluate((canvas, previous) => canvas.toDataURL() === previous, still), 'reduced motion keeps the dog still');
  assert.equal(await page.locator('.terminal-dog').getAttribute('data-eaten'), '0');
  await command('dog');
  assert.deepEqual(errors, []);
  console.log('PASS worker MOBI/AZW3/hybrid/HTML, responsive import, font anchors/bounds/persistence, dog eats/poops/toggles, menu, boss concealment, original text intact');
} finally { await browser.close(); }
