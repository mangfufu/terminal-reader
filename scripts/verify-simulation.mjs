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
  await page.clock.install();
  await page.goto('http://127.0.0.1:1420');
  await openReadingFixture(page);
  const command = async value => {
    await page.keyboard.press('/');
    const input = page.getByRole('combobox', { name: '命令' });
    await input.fill(value);
    await input.press('Enter');
  };
  const colors = () => page.locator('#content > *').evaluateAll(elements => elements.map(element => getComputedStyle(element).color));
  const bodyText = await page.locator('#content').textContent();
  const frame = () => page.locator('#terminal-effect');
  const metrics = () => page.locator('#reader').evaluate(element => ({ top: element.scrollTop, height: element.clientHeight, width: element.scrollWidth }));

  await command('/mode');
  assert.equal(await page.getByRole('combobox', { name: '显示模式' }).evaluate(element => element === document.activeElement), true);
  await page.getByRole('combobox', { name: '模拟任务频率' }).selectOption('off');
  await page.getByRole('combobox', { name: '随机颜色' }).selectOption('rich');
  await page.keyboard.press('Escape');
  const originalColors = await colors();
  assert.ok(new Set(originalColors).size >= 3, 'Simulation should color multiple paragraph roles');
  await page.keyboard.press('PageDown');
  await page.clock.runFor(50);
  const anchor = await metrics();
  await command('/mode plain');
  assert.equal(new Set(await colors()).size, 1, 'Plain mode restores uniform text');
  assert.deepEqual(await metrics(), anchor, 'Changing mode must not move the text');
  await command('/mode simulate');
  assert.deepEqual(await colors(), originalColors, 'Toggling modes preserves the random palette');
  assert.deepEqual(await metrics(), anchor);
  assert.equal(await frame().isVisible(), false, 'Disabling tasks keeps the mode color-only');

  await command('/mode preview');
  await page.clock.runFor(1200);
  assert.equal(await frame().isVisible(), true);
  const firstFrame = await frame().textContent();
  await page.clock.runFor(1000);
  assert.notEqual(await frame().textContent(), firstFrame, 'A task has multiple sequential steps');
  assert.deepEqual(await metrics(), anchor, 'Task output occupies the existing command line');
  assert.equal(await page.locator('#content').textContent(), bodyText);

  await page.keyboard.press('/');
  assert.equal(await frame().isVisible(), false, 'Command entry immediately hides simulation output');
  await page.clock.runFor(3000);
  assert.equal(await frame().isVisible(), false, 'No new output may interrupt typing');
  await page.keyboard.press('Escape');
  await page.clock.runFor(1000);
  assert.equal(await frame().isVisible(), true);
  await page.locator('#content p').first().evaluate(element => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = document.getSelection();
    selection.removeAllRanges(); selection.addRange(range);
  });
  await page.clock.runFor(1000);
  assert.equal(await frame().isVisible(), false, 'Text selection pauses simulation');
  await page.evaluate(() => document.getSelection().removeAllRanges());
  await page.clock.runFor(12000);
  assert.equal(await frame().isVisible(), false, 'A one-shot task finishes and returns the prompt');
  assert.deepEqual(await metrics(), anchor);
  assert.deepEqual(await colors(), originalColors, 'Tasks must not randomly recolor the current page');

  for (const theme of ['powershell', 'powershell-classic', 'cmd', 'linux']) {
    await command('/style ' + theme);
    await page.keyboard.press('Home');
    await page.screenshot({ path: fileURLToPath(new URL(`simulation-${theme}.png`, output)), animations: 'disabled' });
    assert.ok(new Set(await colors()).size >= 3);
    await page.setViewportSize({ width: 280, height: 160 });
    await page.clock.runFor(50);
    const small = await metrics();
    await command('/mode preview');
    await page.clock.runFor(1200);
    assert.equal(await frame().isVisible(), true);
    assert.deepEqual(await metrics(), small);
    assert.ok(small.width <= 280);
    await page.screenshot({ path: fileURLToPath(new URL(`simulation-${theme}-small.png`, output)), animations: 'disabled' });
    await command('/mode plain');
    assert.equal(await frame().isVisible(), false);
    await command('/mode simulate');
    await page.setViewportSize({ width: 560, height: 400 });
  }
  const beforeReroll = await colors();
  await command('/mode');
  await page.getByRole('button', { name: '重新配色' }).click();
  await page.keyboard.press('Escape');
  assert.notDeepEqual(await colors(), beforeReroll);
  const savedColors = await colors();
  await page.reload();
  await page.locator('#content').waitFor();
  assert.equal(await page.locator('#app').getAttribute('data-mode'), 'simulate');
  assert.deepEqual(await colors(), savedColors, 'Colors survive a restart');
  await page.clock.runFor(100000);
  assert.equal(await frame().isVisible(), false, 'Disabled periodic tasks remain off after restart');
  assert.equal(await page.locator('#content').textContent(), bodyText);
  assert.deepEqual(errors, []);
  console.log('PASS: mode switching, stable colors, four profiles, scene progress, input/selection priority, small-window position, persistence.');
} finally { await browser.close(); }
