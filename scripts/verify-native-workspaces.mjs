import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:net';
import { chromium } from 'playwright-core';

const output = path.resolve('artifacts/native-workspaces');
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
  await page.evaluate(async () => {
    window.__bossEvents = [];
    const handler = window.__TAURI_INTERNALS__.transformCallback(event => window.__bossEvents.push({payload:event.payload,hidden:document.querySelector('#boss-screen').hidden,focus:document.hasFocus(),time:Date.now()}));
    await window.__TAURI_INTERNALS__.invoke('plugin:event|listen',{event:'reader-boss-key',target:{kind:'Any'},handler});
  });
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
  const field = label => page.getByLabel(label, {exact:true});
  const send = async (vk = 81, foreground = false) => {
    const helper = spawn('powershell.exe', ['-NoProfile', '-File', 'scripts/send-boss-key.ps1', '-VirtualKey', String(vk), '-ReaderProcessId', foreground ? String(child.pid) : '0'], {windowsHide:true,stdio:'ignore'});
    await new Promise((resolve,reject) => { helper.once('error',reject); helper.once('exit',code => code === 0 ? resolve() : reject(new Error(`key helper ${code}`))); });
  };
  const windowCommand = async command => {
    if (command === 'unminimize' || command === 'set_focus') {
      const helper = spawn('powershell.exe', ['-NoProfile','-File','scripts/send-boss-key.ps1','-VirtualKey','0','-ReaderProcessId',String(child.pid)], {windowsHide:true,stdio:'inherit'});
      await new Promise((resolve,reject) => { helper.once('error',reject); helper.once('exit',code => code === 0 ? resolve() : reject(new Error('window restore failed'))); }); return;
    }
    return page.evaluate(command => window.__TAURI_INTERNALS__.invoke('plugin:window|'+command,{label:'main'}),command);
  };
  await command('/books'); assert.equal(await page.locator('.book-item').count(),2);
  assert.doesNotMatch(await page.locator('#panel-body').innerText(), /私密|vault|private/i);
  await page.keyboard.press('Escape');
  // Real OS input, while another window owns keyboard focus. CDP key presses alone do not test global shortcuts.
  await windowCommand('minimize'); await pause(250);
  assert.equal(await windowCommand('is_focused'),false);
  assert.ok(await page.locator('#boss-screen').isHidden());
  await send(); await page.locator('#boss-screen').waitFor();
  await send(81,true);
  assert.ok(await page.evaluate(() => window.__bossEvents.some(event => event.payload === false)));
  await page.waitForFunction(() => document.querySelector('#boss-screen').hidden);
  await command('/style'); await field('老板键').focus(); await page.keyboard.press('Alt+w'); await page.keyboard.press('Tab'); await pause(250);
  await page.keyboard.press('Escape'); await windowCommand('minimize'); await send(87); await page.locator('#boss-screen').waitFor();
  await send(87,true); await page.waitForFunction(() => document.querySelector('#boss-screen').hidden);
  await command('/style'); await field('窗口失去焦点').selectOption('on'); await page.keyboard.press('Escape');
  await windowCommand('minimize'); await page.locator('#boss-screen').waitFor();
  await send(87,true); await page.waitForFunction(() => document.querySelector('#boss-screen').hidden);
  await command('/style'); await field('窗口失去焦点').selectOption('off'); await page.keyboard.press('Escape');
  await command('/books'); await page.keyboard.press('Control+a'); await command('vault move');
  await field('密码').fill('native-vault-pass'); await field('确认密码').fill('native-vault-pass'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#credentials').hidden && document.querySelectorAll('.book-item').length === 2);
  assert.equal((await cachedBooks()).length,0);
  await page.keyboard.press('Enter');
  await windowCommand('minimize'); await page.locator('#boss-screen').waitFor();
  await page.waitForFunction(() => document.querySelector('#panel-body').children.length === 0);
  await send(87,true);
  await page.waitForFunction(() => document.querySelector('#boss-screen').hidden);
  await command('/books'); assert.equal(await page.locator('.book-item').count(),0);
  await page.keyboard.press('Control+Shift+p'); await field('密码').fill('wrong-pass'); await page.keyboard.press('Enter');
  await page.locator('#credentials [role=status]').filter({hasText:'密码不正确'}).waitFor();
  await field('密码').fill('native-vault-pass'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#credentials').hidden && document.querySelectorAll('.book-item').length === 2);
  await page.screenshot({path:path.join(output,'independent-library.png')});
  await command('/backup'); await page.locator('#file-picker').waitFor(); await page.keyboard.press('Control+l'); await page.keyboard.type(output); await page.keyboard.press('Enter');
  await page.waitForFunction(expected => document.querySelector('[aria-label="文件路径"]').value === expected,output);
  await page.keyboard.press('Control+n'); await page.keyboard.type('protected-'+Date.now()+'.json');
  const backupPath = path.join(output,await field('备份文件名').inputValue()); await page.keyboard.press('Control+Enter');
  await page.locator('#notice').filter({hasText:'备份已保存'}).waitFor();
  const archive = JSON.parse(await readFile(backupPath,'utf8')); assert.equal(archive.format,'terminal-reader-encrypted');
  assert.doesNotMatch(JSON.stringify(archive),/第一本测试正文|批量测试/);
  await command('lock'); await page.waitForFunction(() => document.querySelector('#boss-screen').hidden);
  await page.reload(); await page.locator('#notice').filter({hasText:'已读取 2 份文件'}).waitFor(); await pause(250);
  await page.keyboard.press('Control+Shift+p'); assert.ok(await field('确认密码').isHidden());
  await field('密码').fill('native-vault-pass'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#credentials').hidden && document.querySelectorAll('.book-item').length === 2);
  assert.deepEqual(errors,[]);
  await page.locator('#close').click();
  await Promise.race([
    new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit',resolve)),
    pause(8000).then(() => { throw new Error('Private workspace did not flush and exit'); }),
  ]);
  console.log('PASS: native global shortcut outside focus/remapping, automatic cover, password setup/retry, separate encrypted store, private blur lock, protected disk backup and restart authentication.');
} catch (error) {
  const failed = browser?.contexts()[0]?.pages().find(page => page.url().includes('tauri'));
  if (failed) {
    console.log('Failure state', await failed.evaluate(() => ({events:window.__bossEvents,focus:document.hasFocus(),active:document.activeElement?.id,cover:!document.querySelector('#boss-screen').hidden,notice:document.querySelector('#notice').textContent,settings:localStorage.getItem('reader-settings')})));
    await failed.screenshot({path:path.join(output,'failure.png')});
  }
  throw error;
} finally {
  if (browser) await browser.close();
  if (child.exitCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited; }
  if (originalState) await writeFile(windowState, originalState);
  else await unlink(windowState).catch(error => { if (error.code !== 'ENOENT') throw error; });
}
