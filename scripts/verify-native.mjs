import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:net';
import { chromium } from 'playwright-core';

const executable = path.resolve(process.env.READER_EXE || 'src-tauri/target/release/terminal-reader.exe');
execFileSync('python', ['scripts/create-epub-fixture.py']);
const fixture = path.resolve('artifacts/fixtures/夜航 native test.epub');
const second = path.resolve('artifacts/fixtures/第二份 native.txt');
const output = path.resolve('artifacts/native'); await mkdir(output, { recursive: true });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
const windowStatePath = path.join(process.env.APPDATA, 'app.terminalreader.rewrite', '.window-state.json');
let originalWindowState;
try { originalWindowState = await readFile(windowStatePath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
try {
for (const factor of [1, 1.5, 2, 3]) {
  const port = await availablePort();
  const userData = path.join(output, `profile-${factor}-${Date.now()}`);
  const env = { ...process.env, WEBVIEW2_USER_DATA_FOLDER: userData, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --force-device-scale-factor=${factor}` };
  const child = spawn(executable, [fixture], { env, windowsHide: true, stdio: 'ignore' });
  let browser;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error(`Reader exited with ${child.exitCode}; close any existing reader before testing.`);
      try { const response = await fetch(`http://127.0.0.1:${port}/json/version`); if (response.ok) { ready = true; break; } } catch {}
      await pause(200);
    }
    assert.ok(ready, 'Native WebView CDP endpoint');
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0];
    let page;
    for (let attempt = 0; attempt < 100; attempt++) { page = context.pages().find(p => /tauri/.test(p.url())); if (page) break; await pause(100); }
    assert.ok(page, 'Bundled native app page');
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(15000);
    await page.waitForFunction(() => !!window.__TAURI_INTERNALS__ && !!document.querySelector('#app .titlebar'));
    await page.evaluate(async factor => { await window.__TAURI_INTERNALS__.invoke('plugin:window|set_size', { label: 'main', value: { Physical: { width: Math.round(560 * factor), height: Math.round(400 * factor) } } }); }, factor);
    await page.locator('#content').waitFor();
    assert.ok(!page.url().includes('1420'), 'Native binary uses bundled frontend');
    assert.ok(Math.abs(await page.evaluate(() => devicePixelRatio) - factor) < 0.01, `WebView DPR ${factor}`);
    assert.match(await page.locator('#content').innerText(), /^第一章 起航/);
    assert.doesNotMatch(await page.locator('#content').innerText(), /must not execute/);
    const command = async text => {
      await page.evaluate(text => {
        document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
        const input = document.querySelector('#command-input');
        input.focus(); input.value = text; input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
      }, text);
    };
    const terminalDialog = async (commandText, selectedPath) => {
      await command(commandText);
      await page.locator('#file-picker').waitFor();
      await page.keyboard.press('Control+l');
      await page.keyboard.type(commandText === '/backup' ? path.dirname(selectedPath) : selectedPath);
      await page.keyboard.press('Enter');
      if (commandText === '/backup') {
        await page.waitForFunction(expected => document.querySelector('[aria-label="文件路径"]').value === expected, path.dirname(selectedPath)).catch(async error => { console.log('Picker diagnostics', await page.locator('#file-picker').innerText(), await page.getByLabel('文件路径', {exact:true}).inputValue(), await page.evaluate(() => document.activeElement.outerHTML)); throw error; });
        await page.getByLabel('备份文件名', {exact:true}).fill(path.basename(selectedPath));
        await page.keyboard.press('Control+Enter');
      }
    };
    await command('/chapter'); assert.equal(await page.getByRole('option').count(), 2);
    await page.getByRole('option', { name: '第二章 到岸', exact: true }).click();
    await command('/back');
    await command('/find 原生搜索标记');
    await page.getByRole('searchbox', { name: '搜索正文', exact: true }).press('Enter');
    await page.locator('mark.reader-match-current').first().waitFor();
    await page.keyboard.press('Escape');
    if (factor === 1) {
      const savePath = path.join(output, `native-backup-${Date.now()}.json`);
      await terminalDialog('/backup', savePath);
      await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('备份已保存'));
      const backup = JSON.parse(await readFile(savePath, 'utf8')); assert.equal(backup.books[0].title, '夜航测试集');
      const restoreMarker = `native-restored-${Date.now()}`;
      backup.bookmarks.push({ id: restoreMarker, bookId: backup.books[0].id, label: restoreMarker, position: { block: 0, fraction: 0 }, createdAt: Date.now() });
      await writeFile(savePath, JSON.stringify(backup), 'utf8');
      await terminalDialog('/restore', savePath);
      await page.getByRole('button', { name: '合并并恢复', exact: true }).waitFor();
      if (await page.getByRole('button', { name: '合并并恢复', exact: true }).isVisible()) await page.getByRole('button', { name: '合并并恢复', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('已恢复'));
      await page.waitForFunction(marker => JSON.parse(localStorage.getItem('reader-bookmarks') || '[]').some(item => item.id === marker), restoreMarker);
      console.log('PASS: native backup export/read/restore and unique restored bookmark.');
      await command('/boss'); assert.ok(await page.locator('#boss-screen').isVisible());
      await page.locator('.boss-title').dblclick(); await page.keyboard.press('Control+c');
      assert.ok(await page.locator('#welcome').isVisible());
      await page.keyboard.press('Control+b'); await page.keyboard.press('Enter');
      await command('/style'); await page.getByLabel('阅读进度样式', {exact:true}).selectOption('pages'); await page.keyboard.press('Escape');
      assert.match(await page.locator('#reading-progress').textContent(), /^\d+\/\d+$/);
      const secondInstance = spawn(executable, [second], { env, windowsHide: true, stdio: 'ignore' });
      await new Promise((resolve, reject) => { secondInstance.once('exit', code => code === 0 ? resolve() : reject(new Error(`second instance: ${code}`))); secondInstance.once('error', reject); });
      await page.waitForFunction(() => document.querySelector('#session-file').textContent.includes('第二份 native.txt'));
      assert.match(await page.locator('#content').innerText(), /文件关联转交测试/);
    }
    await command('/style');
    await page.getByRole('combobox', { name: '终端风格', exact: true }).selectOption('linux');
    await page.keyboard.press('Escape');
    // Resize actual window using Tauri IPC; WebView DPR is varied per process.
    await page.evaluate(async factor => { await window.__TAURI_INTERNALS__.invoke('plugin:window|set_size', { label: 'main', value: { Physical: { width: Math.round(280 * factor), height: Math.round(160 * factor) } } }); }, factor);
    await pause(250);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(output, `native-${factor}x.png`) });
    assert.deepEqual(errors, []);
    console.log(`PASS: native bundled EPUB import/navigation at WebView DPR ${factor}.`);
    await page.locator('#close').click();
    await Promise.race([
      new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); }),
      pause(8000).then(() => { throw new Error('Reader did not exit after closing its window'); }),
    ]);
  } finally {
    if (child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
    if (browser) await browser.close().catch(() => {});
  }
}
} finally {
  if (originalWindowState) await writeFile(windowStatePath, originalWindowState);
  else await unlink(windowStatePath).catch(error => { if (error.code !== 'ENOENT') throw error; });
}
console.log('PASS: native Windows executable, EPUB spine/nav, terminal file selection and backups, single-instance file handoff, isolated WebView scaling 1/1.5/2/3.');
