import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:net';
import { chromium } from 'playwright-core';

const output = path.resolve('artifacts/native-library');
await mkdir(output, { recursive: true });
const fixture = path.join(output, '分类测试.txt');
const second = path.join(output, '批量测试.md');
await writeFile(fixture, '第一本测试正文。\n\n阅读进度与分类保留。', 'utf8');
await writeFile(second, '# 第二本\n\n批量移出后可撤销。', 'utf8');
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
const windowState = path.join(process.env.APPDATA, 'app.terminalreader.rewrite', '.window-state.json');
let originalState;
try { originalState = await readFile(windowState); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const child = spawn(path.resolve(process.env.READER_EXE || 'src-tauri/target/release/terminal-reader.exe'), [fixture, second], {
  windowsHide: true, stdio: 'ignore',
  env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: path.join(output, `profile-${Date.now()}`), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser;
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Reader exited (${child.exitCode}); another running instance may own the window.`);
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) { ready = true; break; } } catch {}
    await pause(200);
  }
  assert.ok(ready, 'Native debug endpoint');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  let page;
  for (let attempt = 0; attempt < 100; attempt++) {
    page = browser.contexts()[0].pages().find(page => page.url().includes('tauri'));
    if (page) break;
    await pause(100);
  }
  assert.ok(page, 'Bundled application');
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.locator('#content').waitFor();
  await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:window|set_size', { label: 'main', value: { Logical: { width: 560, height: 400 } } }));
  const command = async value => {
    await page.keyboard.press('Control+k');
    await page.keyboard.type(value.replace(/^\//, '')); await page.keyboard.press('Enter');
  };
  const button = name => page.getByRole('button', { name, exact: true });
  const cachedBooks = () => page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('terminal-reader', 2);
    request.onsuccess = () => {
      const database = request.result;
      const read = database.transaction('books').objectStore('books').getAll();
      read.onsuccess = () => { database.close(); resolve(read.result); };
      read.onerror = () => reject(read.error);
    };
    request.onerror = () => reject(request.error);
  }));
  await command('/books');
  await page.waitForFunction(() => document.querySelectorAll('.book-item').length === 2);
  await page.keyboard.press('Control+Shift+g');
  await page.keyboard.press('Control+n');
  await page.keyboard.type('原生分类');
  await page.keyboard.press('Enter');
  await button('删除分类 原生分类').waitFor();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Alt+g');
  await page.keyboard.press('End');
  await page.keyboard.press('Control+Enter');
  await page.waitForFunction(() => document.querySelectorAll('.book-category').length === 2);
  assert.ok((await cachedBooks()).every(book => book.category === '原生分类'));
  await page.reload();
  await page.locator('#content').waitFor();
  await command('/refresh');
  await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('已读取'));
  await command('/books');
  assert.equal(await page.locator('.book-category').count(), 2, 'Native refresh retains category');
  await page.keyboard.press('Control+a');
  await page.keyboard.press('F1');
  await page.locator('#keyboard-help').waitFor();
  await page.keyboard.press('Escape');
  await page.screenshot({ path: path.join(output, 'multiple-selection.png') });
  await page.keyboard.press('Delete');
  await button('撤销移出').waitFor();
  assert.equal((await cachedBooks()).length, 0);
  assert.ok(await page.locator('#welcome').isVisible());
  await page.keyboard.press('Control+z');
  await page.waitForFunction(() => document.querySelectorAll('.book-item').length === 2);
  assert.equal((await cachedBooks()).length, 2);
  assert.match(await readFile(fixture, 'utf8'), /第一本测试正文/);
  assert.match(await readFile(second, 'utf8'), /批量移出后可撤销/);
  assert.deepEqual(errors, []);
  console.log('PASS: keyboard-only Windows category actions, help/focus, persistence, native source refresh, bulk removal/undo and original files preserved.');
} finally {
  if (browser) await browser.close();
  if (child.exitCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited; }
  if (originalState) await writeFile(windowState, originalState);
  else await unlink(windowState).catch(error => { if (error.code !== 'ENOENT') throw error; });
}
