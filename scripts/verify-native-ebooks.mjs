// Real native import + bundled Worker/CSP checks. All files and app data are synthetic.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, copyFile, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { chromium } from 'playwright-core';

const root = await mkdtemp(path.join(tmpdir(), 'terminal-reader-ebook-test-'));
for (const dir of ['roaming', 'local', 'webview', 'books']) await mkdir(path.join(root, dir));
const bookDir = path.join(root, 'books');
for (const [source, name] of [['sample.mobi', '01.mobi'], ['sample.azw3', '02.azw3'], ['hybrid.mobi', '03.mobi'], ['sample.mobi', '04.azw'], ['sample.mobi', '05.prc'], ['sample.html', '06.html']]) await copyFile(`tests/fixtures/ebooks/${source}`, path.join(bookDir, name));
await writeFile(path.join(bookDir, '07.fb2'), '<FictionBook><description><title-info><book-title>测试 FB2</book-title></title-info></description><body><section><title><p>第一章</p></title><p>FB2 正文。</p></section></body></FictionBook>');
const damaged = await readFile('tests/fixtures/ebooks/sample.mobi'); damaged.writeUInt16BE(2, damaged.readUInt32BE(78) + 12);
await writeFile(path.join(bookDir, '08-drm.mobi'), damaged);
await writeFile(path.join(bookDir, '09-broken.azw3'), 'Not an ebook');
const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port; await new Promise(resolve => server.close(resolve));
const exe = path.resolve(process.env.READER_EXE || 'src-tauri/target/release/terminal-reader.exe');
const child = spawn(exe, [bookDir], { windowsHide: true, stdio: 'ignore', env: {
  ...process.env, APPDATA: path.join(root, 'roaming'), LOCALAPPDATA: path.join(root, 'local'),
  WEBVIEW2_USER_DATA_FOLDER: path.join(root, 'webview'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
} });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser;
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    assert.equal(child.exitCode, null, 'test instance must remain running; another desktop instance may be open');
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {}
    await pause(100);
  }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = browser.contexts()[0].pages()[0];
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(20000);
  await page.locator('#content').waitFor();
  assert.ok(!page.url().includes('1420'));
  assert.match(await page.locator('#notice').textContent(), /已读取 7 份.*DRM/);
  assert.match(await page.locator('#content').textContent(), /全书结束。/);
  const command = async text => { await page.keyboard.press('Control+k'); await page.locator('#command-input').fill(text); await page.keyboard.press('Enter'); };
  await command('books'); assert.equal(await page.locator('.book-item').count(), 7);
  await page.keyboard.press('Escape');
  await command('cat 02.azw3');
  await command('chapter'); await page.getByRole('option', { name: '第二章 星灯', exact: true }).click();
  await command('find 春夏秋冬');
  await page.getByRole('searchbox', { name: '搜索正文', exact: true }).press('Enter');
  await page.locator('mark.reader-match-current').first().waitFor();
  await page.keyboard.press('Escape'); await command('refresh');
  await page.locator('#notice').filter({ hasText: '已读取 1 份文件' }).waitFor();
  await page.keyboard.press('Control+ArrowUp');
  await page.getByRole('status').filter({ hasText: '字号 17' }).waitFor();
  await command('dog'); await page.locator('.terminal-dog').waitFor();
  await command('dog'); assert.equal(await page.locator('.terminal-dog').isVisible(), false);
  await command('open'); await page.locator('#file-picker').waitFor();
  await page.keyboard.press('Control+l'); await page.getByLabel('文件路径', { exact: true }).fill(bookDir); await page.keyboard.press('Enter');
  await page.locator('.picker-entry').filter({ hasText: '07.fb2' }).waitFor();
  assert.equal(await page.locator('.picker-entry').filter({ hasText: /0[1-9][-.]/ }).count(), 9);
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, []);
  await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:window|close', { label: 'main' }));
  for (let attempt = 0; child.exitCode === null && attempt < 50; attempt++) await pause(100);
  assert.equal(child.exitCode, 0);
  console.log('PASS bundled native workers/CSP, 7 formats, DRM/corrupt batch continuation, startup folder, chapters/search/refresh, font/dog, terminal picker, graceful exit');
} finally { await browser?.close(); if (child.exitCode === null) child.kill(); }
