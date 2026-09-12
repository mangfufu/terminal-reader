// Isolated browser fixtures; no personal library, desktop profile or live installer.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
await mkdir('artifacts/updates', { recursive: true });
try {
  for (const scenario of ['none', 'offline', 'available', 'unsupported', 'failed-download', 'storage-failure']) {
    const context = await browser.newContext({ viewport: { width: 560, height: 400 } });
    await context.addInitScript(({ scenario }) => {
      window.isTauri = true;
      window.testCalls = [];
      window.testEvents = {};
      const callbacks = new Map(); let next = 0;
      window.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
        transformCallback(callback) { const id = ++next; callbacks.set(id, callback); return id; },
        unregisterCallback(id) { callbacks.delete(id); },
        async invoke(name, args) {
          window.testCalls.push(name);
          if (name === 'plugin:event|listen') { window.testEvents[args.event] = callbacks.get(args.handler); return ++next; }
          if (name === 'startup_paths') return [];
          if (name === 'reader_has_focus') return true;
          if (name === 'supports_auto_update') return scenario !== 'unsupported';
          if (name === 'check_release_update') {
            await new Promise(resolve => { window.finishUpdateCheck = resolve; });
            if (scenario === 'offline') throw new Error('offline');
            return scenario === 'none' ? null : { version: '0.9.0' };
          }
          if (name === 'download_release_update') {
            window.testEvents['reader-update-progress']?.({ payload: { downloaded: 50, total: 100 } });
            await new Promise(resolve => { window.finishUpdateDownload = resolve; });
            if (scenario === 'failed-download') throw new Error('下载失败或签名校验未通过');
            return '0.9.0';
          }
          return null;
        },
      };
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    }, { scenario });
    const page = await context.newPage(); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(process.env.DEMO_URL || 'http://127.0.0.1:17420');
    await page.waitForFunction(() => !!window.finishUpdateCheck);
    const input = page.locator('#command-input'); await input.focus(); await input.fill('hel');
    await page.evaluate(() => window.finishUpdateCheck());
    await page.waitForTimeout(100);
    assert.equal(await input.inputValue(), 'hel');
    assert.equal(await input.evaluate(el => el === document.activeElement), true, 'startup check must not steal focus');
    assert.equal(await page.evaluate(() => window.testCalls.filter(x => x === 'check_release_update').length), 1);
    if (['none', 'offline'].includes(scenario)) {
      assert.equal(await page.locator('#update-notice').isVisible(), false);
      assert.equal(await page.locator('#notice').isVisible(), false);
    } else {
      await page.locator('#update-notice').waitFor();
      await input.fill('update'); await input.press('Enter');
      await page.getByRole('dialog', { name: '软件更新', exact: true }).waitFor();
      const download = page.getByRole('button', { name: '下载更新', exact: true });
      if (scenario === 'unsupported') {
        assert.equal(await download.isDisabled(), true);
        await page.getByRole('button', { name: '手动下载', exact: true }).press('Enter');
        assert.ok(await page.evaluate(() => window.testCalls.includes('open_release_download')));
      } else {
        await download.waitFor(); await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(el => el.textContent === '下载更新')?.disabled);
        await download.press('Enter');
        await page.waitForFunction(() => !!window.finishUpdateDownload);
        assert.match(await page.locator('#panel-body').innerText(), /50%/);
        await page.keyboard.press('Escape');
        await page.evaluate(() => window.finishUpdateDownload());
        await page.waitForTimeout(80);
        assert.equal(await page.locator('#panel').isVisible(), false, 'background download must not reopen a panel');
        assert.equal(await page.evaluate(() => window.testCalls.includes('install_release_update')), false);
        await input.fill('update'); await input.press('Enter');
        if (scenario === 'failed-download') {
          assert.match(await page.locator('#panel-body').innerText(), /校验未通过/);
        } else {
          const install = page.getByRole('button', { name: '安装并重启', exact: true });
          await install.waitFor();
          await page.screenshot({ path: 'artifacts/updates/ready.png' });
          await page.evaluate(() => window.testEvents['reader-boss-key']({ payload: false }));
          assert.equal(await page.locator('#update-notice').isVisible(), false);
          await page.evaluate(() => window.testEvents['reader-boss-key']({ payload: false }));
          if (scenario === 'storage-failure') await page.evaluate(() => {
            window.originalSetItem = Storage.prototype.setItem;
            Storage.prototype.setItem = () => { throw new Error('storage full'); };
          });
          await install.press('Enter');
          if (scenario === 'storage-failure') {
            await page.waitForFunction(() => document.querySelector('#panel-body').textContent.includes('阅读位置尚未保存'));
            assert.equal(await page.evaluate(() => window.testCalls.includes('install_release_update')), false);
            await page.evaluate(() => { Storage.prototype.setItem = window.originalSetItem; });
            await page.getByRole('button', { name: '安装并重启', exact: true }).press('Enter');
          }
          await page.waitForFunction(() => window.testCalls.includes('install_release_update'));
        }
      }
    }
    assert.deepEqual(errors, []); await context.close();
    console.log(`PASS ${scenario}`);
  }
} finally { await browser.close(); }
