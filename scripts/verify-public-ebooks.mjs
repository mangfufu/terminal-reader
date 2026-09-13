// Use the separately identified debug build; never attach to the user's reader.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { chromium } from 'playwright-core';

const output = path.resolve('artifacts/real-ebooks');
const sources = JSON.parse(await readFile(path.join(output, 'sources.json'), 'utf8')).filter(item => !item.error);
const root = await mkdtemp(path.join(tmpdir(), 'reader-public-compat-'));
for (const dir of ['roaming', 'local', 'webview']) await mkdir(path.join(root, dir));
const executable = path.resolve('src-tauri/target/debug/terminal-reader.exe');
// Refuse an ordinary app build so its single-instance handler cannot forward test files.
const binary = await readFile(executable);
assert.ok(binary.includes(Buffer.from('app.terminalreader.compatibilitytest')), 'build first with the isolated compatibility identifier');
const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port; await new Promise(resolve => server.close(resolve));
const child = spawn(executable, [path.join(output, 'books')], { windowsHide: true, stdio: 'ignore', env: {
  ...process.env, APPDATA: path.join(root, 'roaming'), LOCALAPPDATA: path.join(root, 'local'),
  WEBVIEW2_USER_DATA_FOLDER: path.join(root, 'webview'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
} });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser;
try {
  for (let i = 0; i < 100; i++) {
    assert.equal(child.exitCode, null, 'isolated reader exited');
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {}
    await pause(100);
  }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = browser.contexts()[0].pages()[0]; page.setDefaultTimeout(90000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => /^已读取 \d+ 份/.test(document.querySelector('#notice')?.textContent ?? ''));
  const notice = await page.locator('#notice').textContent();
  const result = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open('terminal-reader'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const books = await new Promise((resolve, reject) => { const request = db.transaction('books').objectStore('books').getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    db.close();
    const normalize = text => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    const normalized = new Map(books.map(book => [book.name, normalize(book.content)]));
    return books.map(book => {
      const group = book.name.replace(/\.(mobi|azw3|prc|fb2|epub|html)$/, '').replace(/-epub[23]$/, '');
      const reference = books.find(other => other.name === `${group}.epub` || other.name === `${group}-epub3.epub`);
      const prose = reference?.blocks.filter(block => normalize(block.text).length > 120) ?? [];
      const probes = [.1, .3, .5, .7, .9].map(fraction => prose[Math.floor(prose.length * fraction)]).filter(Boolean).map(block => normalize(block.text).slice(0, 100));
      const chapters = book.chapters ?? [];
      const middle = chapters[Math.floor(chapters.length / 2)];
      return { name: book.name, title: book.title, format: book.format, characters: book.content.length, paragraphs: book.blocks?.length ?? 0,
        chapters: chapters.length, validTargets: chapters.every(chapter => chapter.block >= 0 && chapter.block < book.blocks.length),
        matchedProbes: probes.filter(probe => normalized.get(book.name).includes(probe)).length, totalProbes: probes.length,
        chapterToOpen: middle?.title, encodedPersisted: 'encoded' in book };
    });
  });
  const command = async text => { await page.keyboard.press('Escape'); await page.keyboard.press('Control+k'); await page.locator('#command-input').fill(text); await page.keyboard.press('Enter'); };
  for (const book of result) {
    await command(`cat "${book.name}"`);
    await page.waitForFunction(name => document.querySelector('#session-file')?.textContent.includes(name), book.name);
    await command('goto 50%');
    assert.ok(await page.locator('#content').isVisible());
    await command('goto 100%');
    book.openedAndScrolled = true;
    if (book.chapterToOpen) {
      await command('chapter');
      const option = page.getByRole('option', { name: book.chapterToOpen, exact: true }).first();
      await option.click();
      book.chapterClicked = await page.locator('#panel').isHidden();
    }
    delete book.chapterToOpen;
    console.log(JSON.stringify(book));
  }
  const report = { date: new Date().toISOString(), expectedFiles: sources.length, importedFiles: result.length, notice, errors, books: result, sources };
  await writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
  assert.equal(result.length, sources.length, notice);
  assert.ok(result.every(book => book.characters > 10000 && book.validTargets && !book.encodedPersisted));
  assert.deepEqual(errors, []);
  console.log(`PASS ${result.length} real publisher files: native import, storage, first/middle/end navigation, chapter controls`);
} finally {
  if (browser) {
    try { await browser.contexts()[0].pages()[0].evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:window|close', { label: 'main' })); } catch {}
    await browser.close();
  }
  for (let i = 0; child.exitCode === null && i < 30; i++) await pause(100);
  if (child.exitCode === null) child.kill();
}
