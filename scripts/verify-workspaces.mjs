import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
const browser = await chromium.launch({ executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe', headless:true });
try {
  const page = await browser.newPage({ viewport:{width:560,height:400},acceptDownloads:true });
  page.setDefaultTimeout(12000); const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    const seed = sessionStorage.getItem('seed-preferences'); if (seed) { for (const [key,value] of Object.entries(JSON.parse(seed))) localStorage.setItem(key, value); sessionStorage.removeItem('seed-preferences'); }
  });
  await page.goto('http://127.0.0.1:1420', {waitUntil:'networkidle'});
  await page.evaluate(async () => {
    const body = '# One\n\n' + 'Reading text.\n\n'.repeat(50) + '# Two\n\n' + 'More reading.\n\n'.repeat(50);
    await (await import('/src/storage.ts')).replaceBooks([
      {id:'public:1',name:'01 First Book.md',content:body,category:'Tech'},
      {id:'public:2',name:'02 Second Book.txt',content:'Other public book.'},
      {id:'legacy:private',name:'Hidden private title.txt',content:'Private text must stay encrypted.',category:'私密'},
    ]);
    sessionStorage.setItem('seed-preferences', JSON.stringify({
      'reader-positions':JSON.stringify({'legacy:private':{block:0,offset:5,fraction:0}}),
      'reader-bookmarks':JSON.stringify([{id:'legacy-mark',bookId:'legacy:private',label:'Private bookmark',position:{block:0,fraction:0},createdAt:1}]),
    }));
  });
  await page.reload({waitUntil:'networkidle'});
  const key = text => page.keyboard.press(text);
  const field = label => page.getByLabel(label,{exact:true});
  const command = async text => { await key('Control+k'); await key('Control+a'); await page.keyboard.type(text); await key('Enter'); };
  const publicBooks = () => page.evaluate(async () => (await import('/src/storage.ts')).loadBooks());
  const encrypted = () => page.evaluate(async () => (await import('/src/storage.ts')).readVault());
  const password = async (value, creating=false) => { await field('密码').fill(value); if (creating) await field('确认密码').fill(value); await key('Enter'); };
  const archive = async text => { const pending = page.waitForEvent('download'); await command(text); const stream=await (await pending).createReadStream(); const chunks=[]; for await (const part of stream) chunks.push(part); return JSON.parse(Buffer.concat(chunks).toString()); };
  await command('ls'); assert.equal(await page.locator('.book-item').count(),2);
  assert.doesNotMatch(await page.locator('#panel-body').innerText(),/私密|private|vault/i);
  await command('help'); assert.doesNotMatch(await page.locator('#panel-body').innerText(),/私密|private|vault/i);
  await key('Escape'); await key('/'); assert.doesNotMatch(await page.locator('#suggestions').innerText(),/私密|private|vault/i); await key('Escape');
  await command('cd Tech'); assert.equal(await page.locator('.book-item').count(),1);
  await command('cat 1'); await page.locator('#content').waitFor();
  await command('goto 75%'); await page.waitForFunction(() => Number(document.querySelector('#reading-progress').textContent.replace('%','')) >= 70);
  await command('progress'); assert.match(await page.locator('#panel-body').innerText(),/Two.*本章/s);
  await command('cd ..'); await command('type "02 Second Book.txt"'); await command('recent');
  assert.match(await page.locator('.book-item').first().innerText(),/Second/);
  await command('resume'); assert.match(await page.locator('#session-file').textContent(),/Second/);
  await key('Control+l'); assert.ok(await page.locator('#welcome').isVisible());
  await page.keyboard.type('cat "01 First'); await key('Tab'); assert.equal(await field('命令').inputValue(),'cat "01 First Book.md"');
  await key('Control+w'); assert.ok((await field('命令').inputValue()).length < 22); await key('Control+u'); assert.equal(await field('命令').inputValue(),'');
  await key('Control+r'); assert.ok(await field('搜索命令历史').isVisible()); await key('Escape');

  // Fail the encrypted migration write once: legacy records must remain recoverable.
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) { if (this.name === 'vault') { IDBObjectStore.prototype.put = put; throw new DOMException('quota','QuotaExceededError'); } return put.apply(this,args); };
  });
  await key('Control+Shift+p'); await password('vault-pass-123',true);
  await page.locator('#credentials [role=status]').filter({hasText:'quota'}).waitFor();
  assert.equal((await publicBooks()).length,3); assert.equal(await encrypted(),undefined);
  await password('vault-pass-123',true);
  await page.waitForFunction(() => document.querySelector('#credentials').hidden && document.querySelectorAll('.book-item').length === 1);
  assert.match(await page.locator('#prompt').textContent(), /Archive/);
  assert.equal((await publicBooks()).length,2);
  const stored = await encrypted(); assert.equal(stored.format,'terminal-reader-encrypted');
  assert.doesNotMatch(JSON.stringify(stored),/Hidden private title|Private text|legacy:private/);
  assert.doesNotMatch(await page.evaluate(() => JSON.stringify(localStorage)),/Hidden private title|Private bookmark|legacy:private/);
  await command('cat 1'); assert.match(await page.locator('#content').textContent(),/Private text/);
  await command('recent'); assert.equal(await page.locator('.book-item').count(),1);
  const privateBackup = await archive('backup'); assert.equal(privateBackup.format,'terminal-reader-encrypted');
  const privatePlain = await page.evaluate(async raw => { const m=await import('/src/encryption.ts'); return m.unseal(raw,await m.deriveKey('vault-pass-123',raw)); },privateBackup);
  assert.equal(privatePlain.workspace,'vault'); assert.equal(privatePlain.books.length,1); assert.ok(privatePlain.recentReads['legacy:private']);
  await command('lock'); await page.waitForFunction(() => document.querySelector('#credentials').hidden && document.querySelector('#boss-screen').hidden && document.querySelector('#welcome').offsetHeight > 0);
  await command('cat 1'); assert.doesNotMatch(await page.locator('#content').textContent(),/Private text/,'Stale private list cannot reopen a book after lock');
  await command('ls'); assert.equal(await page.locator('.book-item').count(),2);
  await key('Control+Shift+p'); await password('wrong-password');
  await page.locator('#credentials [role=status]').filter({hasText:'密码不正确'}).waitFor();
  assert.equal(await page.locator('#credentials').isVisible(),true);
  await password('vault-pass-123'); await page.waitForFunction(() => document.querySelector('#credentials').hidden);
  await command('cat 1'); await key('Alt+q');
  await page.waitForFunction(() => document.querySelector('#panel-body').children.length === 0);
  assert.ok(await page.locator('#boss-screen').isVisible(),'Boss key stays covered while locking private data');
  await key('Alt+q'); await key('Control+Shift+p'); await field('密码').waitFor(); await key('Escape');
  await key('Control+Shift+p'); await password('vault-pass-123'); await page.waitForFunction(() => document.querySelector('#credentials').hidden);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.waitForFunction(() => document.querySelector('#panel-body').children.length === 0);
  await key('Alt+q'); await page.reload({waitUntil:'networkidle'});
  await key('Control+Shift+p'); assert.ok(await field('确认密码').isHidden()); await password('vault-pass-123');
  await page.waitForFunction(() => document.querySelector('#credentials').hidden);
  await command('restore'); await field('备份内容').fill(JSON.stringify(privateBackup)); await page.getByRole('button',{name:'预览备份',exact:true}).click();
  await password('vault-pass-123'); await page.getByRole('button',{name:'合并并恢复',exact:true}).click();
  await page.locator('#notice').filter({hasText:'已恢复'}).waitFor();
  assert.equal((await publicBooks()).length,2);
  await command('lock'); await page.waitForFunction(() => document.querySelector('#boss-screen').hidden);
  await command('restore'); await field('备份内容').fill(JSON.stringify(privateBackup)); await page.getByRole('button',{name:'预览备份',exact:true}).click();
  await password('vault-pass-123'); await page.locator('#notice').filter({hasText:'请先进入独立书库'}).waitFor();
  assert.equal((await publicBooks()).length,2);
  const publicArchive = await archive('backup'); assert.equal(publicArchive.workspace,'public'); assert.equal(publicArchive.books.length,2);
  const encryptedDownload = page.waitForEvent('download'); await command('backup --encrypt'); await password('backup-pass-123',true);
  const stream = await (await encryptedDownload).createReadStream(); const chunks=[]; for await (const chunk of stream) chunks.push(chunk);
  assert.equal(JSON.parse(Buffer.concat(chunks).toString()).format,'terminal-reader-encrypted');
  await command('ls'); await key('Home'); await command('vault move'); await password('vault-pass-123');
  await page.waitForFunction(() => document.querySelector('#credentials').hidden && document.querySelectorAll('.book-item').length === 2);
  assert.equal((await publicBooks()).length,1);
  await command('lock'); await page.waitForFunction(() => document.querySelector('#boss-screen').hidden);
  await command('ls'); assert.equal(await page.locator('.book-item').count(),1);
  await mkdir('artifacts/workspaces',{recursive:true}); await command('guide');
  await page.screenshot({path:'artifacts/workspaces/quick-start.png'});
  await page.setViewportSize({width:280,height:160}); await key('Control+Shift+p');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
  await page.screenshot({path:'artifacts/workspaces/password-small.png'});
  assert.deepEqual(errors,[]);
  console.log('PASS: mandatory password/retry, encrypted migration rollback, separate books/history/recent/backups, stale-list isolation, boss/blur lock, restart, encrypted recovery, atomic move, terminal aliases/completion/editing/history and chapter jumps.');
} finally { await browser.close(); }
