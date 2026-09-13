import assert from 'node:assert/strict';
import { openReadingFixture } from './reading-fixture.mjs';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const output = new URL('../artifacts/', import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 560, height: 400 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:1420');
  await page.screenshot({ path: fileURLToPath(new URL('terminal-welcome.png', output)) });
  await openReadingFixture(page);
  await page.locator('h2').filter({ hasText: /^阅读验证$/ }).waitFor();
  await page.screenshot({ path: fileURLToPath(new URL('reader-default.png', output)) });
  await page.keyboard.press('/');
  const command = page.getByRole('combobox', { name: '命令' });
  await command.fill('/spe');
  assert.equal(await page.getByRole('option').count(), 1);
  await command.press('Tab');
  assert.equal(await command.inputValue(), '/speed ');
  await command.fill('/speed 30');
  await command.press('Enter');
  assert.equal(await page.locator('#reader').evaluate(element => element === document.activeElement), true);
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.querySelector('#reader').scrollTop > 10);
  await page.keyboard.press('Space');
  const paused = await page.locator('#reader').evaluate(element => element.scrollTop);
  await page.waitForTimeout(200);
  assert.equal(await page.locator('#reader').evaluate(element => element.scrollTop), paused);
  await page.keyboard.press('/');
  await command.fill('/style');
  await command.press('Enter');
  await page.getByRole('combobox', { name: '终端风格' }).selectOption('linux');
  assert.equal(await page.locator('#app').getAttribute('data-theme'), 'linux');
  await page.keyboard.press('Escape');
  const themes = [
    ['powershell', 'Windows Terminal · PowerShell', 'PS C:\\Books>', 'terminal'],
    ['powershell-classic', 'Windows PowerShell · 经典', 'PS C:\\Books>', 'classic'],
    ['cmd', 'CMD · 命令提示符', 'C:\\Books>', 'classic'],
    ['linux', 'Linux · Ubuntu Terminal', 'reader@desktop:~/Books$', 'linux'],
  ];
  for (const [theme, label, prompt, chrome] of themes) {
    await page.setViewportSize({ width: 560, height: 400 });
    await page.locator('#reader').evaluate(reader => {
      reader.scrollTop = document.querySelector('#content').children[6].offsetTop + 5;
    });
    const anchor = await page.locator('#content').evaluate(content => {
      const top = document.querySelector('#reader').getBoundingClientRect().top;
      return [...content.children].find(element => element.getBoundingClientRect().bottom > top)?.textContent;
    });
    await page.getByRole('button', { name: '终端外观与菜单', exact: true }).click();
    await page.getByRole('menuitemradio', { name: label, exact: true }).click();
    assert.equal(await page.locator('#app').getAttribute('data-theme'), theme);
    assert.equal(await page.locator('#app').getAttribute('data-chrome'), chrome);
    assert.equal(await page.locator('#prompt').textContent(), prompt);
    assert.equal(await page.locator('#session-prompt').textContent(), prompt);
    assert.ok(await page.locator('#session-file').textContent());
    assert.equal(await page.locator('#content').evaluate(content => {
      const top = document.querySelector('#reader').getBoundingClientRect().top;
      return [...content.children].find(element => element.getBoundingClientRect().bottom > top)?.textContent;
    }), anchor, 'Switching profiles should preserve the visible paragraph');
    await page.keyboard.press('Home');
    await page.screenshot({ path: fileURLToPath(new URL('theme-' + theme + '.png', output)) });
    await page.setViewportSize({ width: 280, height: 160 });
    await page.screenshot({ path: fileURLToPath(new URL('theme-' + theme + '-small.png', output)) });
    const dimensions = await page.locator('#app').evaluate(element => {
      const reader = document.querySelector('#reader');
      const input = document.querySelector('#command-input').getBoundingClientRect();
      const close = document.querySelector('#close').getBoundingClientRect();
      return { outerWidth: element.scrollWidth, width: element.clientWidth, readerWidth: reader.scrollWidth, clientWidth: reader.clientWidth, readerHeight: reader.clientHeight, inputWidth: input.width, closeRight: close.right };
    });
    assert.ok(dimensions.outerWidth <= dimensions.width, JSON.stringify({ theme, ...dimensions }));
    assert.ok(dimensions.readerWidth <= dimensions.clientWidth, JSON.stringify({ theme, ...dimensions }));
    assert.ok(dimensions.readerHeight >= 90, JSON.stringify({ theme, ...dimensions }));
    assert.ok(dimensions.inputWidth > 40 && dimensions.closeRight <= 280, JSON.stringify({ theme, ...dimensions }));
    await page.reload();
    await page.locator('h2').filter({ hasText: /^阅读验证$/ }).waitFor();
    assert.equal(await page.locator('#app').getAttribute('data-theme'), theme);
  }
  await page.setViewportSize({ width: 280, height: 160 });
  await page.screenshot({ path: fileURLToPath(new URL('reader-small.png', output)) });
  const layout = await page.locator('#reader').evaluate(element => ({ width: element.clientWidth, content: element.scrollWidth, height: element.clientHeight }));
  assert.ok(layout.height >= 90, JSON.stringify(layout));
  assert.ok(layout.content <= layout.width, JSON.stringify(layout));
  await page.keyboard.press('/');
  await command.fill('/speed');
  await command.press('Enter');
  await page.getByRole('slider', { name: '滚动速度' }).waitFor();
  await page.keyboard.press('Escape');
  await page.reload();
  await page.locator('h2').filter({ hasText: /^阅读验证$/ }).waitFor();
  assert.equal(await page.locator('#app').getAttribute('data-theme'), 'linux');
  assert.deepEqual(errors, []);
  console.log('PASS: reading fixture, command completion, keyboard focus, scrolling, four terminal profiles, 280x160 layout in all profiles, reload.');
} finally { await browser.close(); }
