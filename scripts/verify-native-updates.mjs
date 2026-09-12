// Native IPC smoke test with an isolated app-data directory; never runs an installer.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { chromium } from 'playwright-core';
const root = await mkdtemp(path.join(tmpdir(), 'terminal-reader-update-test-'));
for (const dir of ['roaming', 'local', 'webview']) await mkdir(path.join(root, dir));
const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port; await new Promise(resolve => server.close(resolve));
const exe = path.resolve(process.env.READER_EXE || 'src-tauri/target/release/terminal-reader.exe');
const child = spawn(exe, [], { windowsHide: true, stdio: 'ignore', env: {
  ...process.env, APPDATA: path.join(root, 'roaming'), LOCALAPPDATA: path.join(root, 'local'),
  WEBVIEW2_USER_DATA_FOLDER: path.join(root, 'webview'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
} });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser;
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    assert.equal(child.exitCode, null, 'test instance must remain running');
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {}
    await pause(100);
  }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = browser.contexts()[0].pages()[0];
  await page.locator('#command-input').waitFor();
  const result = await page.evaluate(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const first = await invoke('check_release_update');
    const start = performance.now();
    const second = await invoke('check_release_update');
    let rejected = '';
    try { await invoke('install_release_update'); } catch (error) { rejected = String(error); }
    return { first, second, cachedMs: performance.now() - start, supported: await invoke('supports_auto_update'), rejected };
  });
  assert.deepEqual(result.first, result.second);
  assert.ok(result.cachedMs < 1000, 'second check uses process cache');
  assert.equal(result.supported, true);
  assert.match(result.rejected, /先下载并校验/);
  const input = page.locator('#command-input');
  await input.fill('update'); await input.press('Enter');
  await page.getByRole('dialog', { name: '软件更新', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '手动下载', exact: true }).isVisible(), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#panel').isVisible(), false);
  await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:window|close', { label: 'main' }));
  for (let attempt = 0; child.exitCode === null && attempt < 50; attempt++) await pause(100);
  assert.equal(child.exitCode, 0);
  console.log('PASS native update IPC, cached check, install guard, terminal panel, graceful exit');
} finally { await browser?.close(); if (child.exitCode === null) child.kill(); }
