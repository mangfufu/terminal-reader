import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';

const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 560, height: 400 }, acceptDownloads: true });
  page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:1420', { waitUntil: 'networkidle' });
  await page.evaluate(async () => {
    await (await import('/src/storage.ts')).replaceBooks([
      { id: 'public:1', name: '01 public.txt', content: Array.from({length:100}, (_, i) => `Public paragraph ${i}`).join('\n\n') },
      { id: 'secret:1', name: '02 secret.txt', content: 'Private reading text.', category: '私密' },
      { id: 'public:2', name: '03 public.txt', content: 'Another public book.' },
    ]);
    localStorage.setItem('reader-bookmarks', JSON.stringify([{ id: 'secret-mark', bookId: 'secret:1', label: 'Secret bookmark', position: { block: 0, fraction: 0 }, createdAt: 1 }]));
  });
  await page.reload({ waitUntil: 'networkidle' });
  const key = k => page.keyboard.press(k);
  const field = label => page.getByLabel(label, {exact:true});
  const command = async text => { await key('Control+k'); await page.keyboard.type(text); await key('Enter'); };
  await key('Control+b');
  assert.equal(await page.locator('.book-item').count(), 2);
  assert.doesNotMatch(await field('分类筛选').textContent(), /私密/);
  await key('Enter'); await key('ArrowRight');
  assert.match(await page.locator('#session-file').textContent(), /03 public/);
  await key('Control+d'); await field('书签范围').selectOption('all');
  assert.equal(await page.getByRole('button', { name:'Secret bookmark', exact:true }).count(), 0);
  await key('Control+b'); await key('Home'); await key('Enter');
  await key('PageDown');
  await page.evaluate(() => { const node = document.querySelector('#content p') ?? document.querySelector('#content'); const range = document.createRange(); range.selectNodeContents(node); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); });
  await key('Control+c'); assert.ok(await page.locator('#content').isVisible(), 'Ctrl+C copies selected text');
  await page.evaluate(() => getSelection().removeAllRanges());
  await key('Control+c'); assert.ok(await page.locator('#welcome').isVisible());
  assert.ok(await page.locator('#reading-progress').isHidden());
  assert.equal(await page.evaluate(async () => (await (await import('/src/storage.ts')).loadBooks()).length), 3);
  await page.reload({waitUntil:'networkidle'}); assert.ok(await page.locator('#welcome').isVisible());
  await key('Control+b'); await key('Home'); await key('Enter');
  await key('/');
  assert.ok(await page.locator('#suggestions').evaluate(el => el.getBoundingClientRect().height <= 132 && el.getBoundingClientRect().width < innerWidth));
  await key('Escape');
  await command('style'); await field('阅读进度样式').selectOption('pages'); await key('Escape');
  assert.match(await page.locator('#reading-progress').textContent(), /^\d+\/\d+$/);
  await page.locator('#reading-progress').click(); assert.match(await page.locator('#reading-progress').textContent(), /%$/);
  await page.locator('#reading-progress').click(); assert.match(await page.locator('#reading-progress').textContent(), /^\[[=-]{10}\]$/);
  await page.reload({waitUntil:'networkidle'}); assert.match(await page.locator('#reading-progress').textContent(), /^\[/);
  await command('style'); await field('老板键').focus(); await key('F9'); await key('Tab');
  await key('Escape');
  // Test terminal picker UI with an isolated filesystem fixture. Native tests exercise real IPC separately.
  await page.evaluate(() => {
    window.isTauri = true;
    window.testCalls = [];
    window.__TAURI_INTERNALS__ = { invoke: async (cmd, args) => {
      window.testCalls.push({cmd,args});
      if (cmd === 'browse_directory') {
        if (window.testDirectoryDelay) await new Promise(resolve => setTimeout(resolve, window.testDirectoryDelay));
        if (args.path === '/denied') throw '无权读取此目录';
        const folder = args.path === '/home/sub';
        return { path:folder?'/home/sub':'/home', parent:folder?'/home':null, truncated:false, file:null, locations:[{name:'~ 主目录',path:'/home',directory:true}], entries:folder?[]:[
          {name:'sub',path:'/home/sub',directory:true},
          ...args.mode === 'folder' ? [] : args.mode === 'books' ? [{name:'中文书籍.txt',path:'/home/中文书籍.txt',directory:false}, {name:'book.epub',path:'/home/book.epub',directory:false}] : [{name:'existing.json',path:'/home/existing.json',directory:false}],
        ] };
      }
      if (cmd === 'backup_target') return {path:'/home/'+args.name,exists:args.name==='existing.json'};
      if (cmd === 'export_backup') return args.path;
      if (cmd === 'import_paths') return {files:[],warnings:[]};
      throw new Error(`Unexpected native call: ${cmd}`);
    }};
  });
  await key('Control+o'); await page.locator('.picker-entry').first().waitFor();
  await key('Control+l'); await page.keyboard.type('/denied'); await key('Enter');
  await page.locator('.picker-status').filter({hasText:'无权读取'}).waitFor();
  await key('Control+l'); await page.keyboard.type('/home'); await key('Enter'); await page.locator('.picker-entry').first().waitFor();
  await key('F1'); assert.ok(await page.locator('#keyboard-help-body').evaluate(el => !el.closest('[inert]'))); await key('Escape');
  await key('ArrowDown'); await key('Space'); await key('ArrowDown'); await key('Space');
  assert.equal(await page.locator('.picker-entry[aria-selected="true"]').count(), 2);
  await key('F9'); await key('F9'); assert.equal(await page.locator('.picker-entry[aria-selected="true"]').count(), 2);
  await mkdir('artifacts/terminal-features', {recursive:true});
  await page.screenshot({path:'artifacts/terminal-features/picker.png'});
  await key('Control+Enter'); await page.waitForFunction(() => window.testCalls.some(c => c.cmd === 'import_paths'));
  assert.equal(await page.evaluate(() => window.testCalls.find(c => c.cmd === 'import_paths').args.paths.length), 2);
  await key('Control+Shift+o'); await page.locator('.picker-entry').first().waitFor(); await key('Enter');
  await page.waitForFunction(() => document.querySelector('[aria-label="文件路径"]').value === '/home/sub');
  await key('Control+Enter');
  await page.waitForFunction(() => window.testCalls.filter(c => c.cmd === 'import_paths').length === 2);
  assert.deepEqual(await page.evaluate(() => window.testCalls.filter(c => c.cmd === 'import_paths')[1].args.paths), ['/home/sub']);
  await key('Control+Shift+b'); await field('备份文件名').waitFor();
  await field('备份文件名').fill('existing.json'); await key('Control+Enter');
  await page.locator('.picker-overwrite').waitFor();
  assert.ok(await page.getByRole('button',{name:'返回修改',exact:true}).evaluate(el => el === document.activeElement));
  await key('Escape'); assert.ok(await page.locator('#file-picker').isVisible());
  await key('Control+Enter'); await page.locator('.picker-overwrite').waitFor();
  await key('Shift+Tab'); await key('Enter');
  await page.waitForFunction(() => window.testCalls.some(c => c.cmd === 'export_backup'));
  assert.equal(await page.evaluate(() => window.testCalls.find(c => c.cmd === 'export_backup').args.overwrite), true);
  await key('Control+Shift+r'); await page.locator('#file-picker').waitFor(); await key('Control+l'); await page.keyboard.type('/home'); await key('Enter'); await page.locator('.picker-entry').first().waitFor();
  await page.setViewportSize({width:280,height:160}); await key('F6'); await key('Shift+F6');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await key('F9'); await page.screenshot({path:'artifacts/terminal-features/boss-small.png'}); await key('F9');
  await key('Escape'); assert.equal(await page.locator('#app [inert]').count(), 0);
  await page.evaluate(() => window.testDirectoryDelay = 500);
  await key('Control+o'); await key('Control+l'); await page.keyboard.type('/unfinished/path');
  await page.waitForTimeout(600);
  assert.equal(await field('文件路径').inputValue(), '/unfinished/path', 'A late directory result must not overwrite a path draft');
  assert.ok(await field('文件路径').evaluate(el => el === document.activeElement));
  await key('Escape'); await key('Control+o'); await key('Escape'); await page.waitForTimeout(600);
  assert.ok(await page.locator('#file-picker').isHidden(), 'Canceled asynchronous navigation must not reopen a picker');
  assert.equal(await page.locator('input[type=file], input[type=color]').count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS: public filtering/reading/progress, terminal picker navigation/multiselect/help/focus/folder/save/overwrite/cancel and small window.');
} finally { await browser.close(); }
