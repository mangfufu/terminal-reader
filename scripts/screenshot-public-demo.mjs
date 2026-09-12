// Generates documentation from invented fixtures in a fresh, temporary browser
// context. Never connects to the desktop app or imports a local reader profile.
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const url = process.env.DEMO_URL || 'http://127.0.0.1:17420';
const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true,
});
const output = path.resolve('docs/images');
await mkdir(output, { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 780, height: 520 }, deviceScaleFactor: 2 });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.evaluate(async () => {
    const { saveBooks } = await import('/src/storage.ts');
    const paragraphs = [
      '傍晚六点，山间的小站亮起第一盏灯。风穿过候车厅，把桌上的时刻表翻到了下一页。',
      '林舟收起地图，推开通往月台的木门。远处的云层慢慢散开，露出一条淡金色的天际线。',
      '站长递来一杯热茶，说今晚的列车会晚到一些。于是他坐在长椅上，听铁轨深处传来的回声。',
      '这里没有催促的人，也没有必须立刻回答的问题。他把笔记本摊开，写下旅途中的第一个句子。',
      '等到群星升起时，我们再出发。',
    ];
    const content = '# 第一章 山间小站\n\n' + paragraphs.join('\n\n') + '\n\n# 第二章 星河来信\n\n' + paragraphs.join('\n\n');
    await saveBooks([
      { id: 'demo:mountain-station', name: '山间小站.md', content, category: '小说' },
      { id: 'demo:terminal-walk', name: '终端漫游.epub', title: '终端漫游', author: '示例作者', format: 'epub', content: '为展示电子书元数据而编写的虚构示例。', category: '技术' },
      { id: 'demo:reading-notes', name: '阅读札记.txt', content: '为公开文档编写的示例笔记。', category: '随笔' },
      { id: 'demo:night-train', name: '夜行列车.md', content: '# 夜行列车\n\n车窗外的灯光连成一条线。这是虚构的界面演示内容。', category: '小说' },
    ]);
    localStorage.setItem('reader-categories', JSON.stringify(['小说', '技术', '随笔']));
    localStorage.setItem('reader-settings', JSON.stringify({ theme:'powershell',mode:'simulate',effectFrequency:'off',fontSize:18,colorSeed:12031 }));
  });
  await page.reload({ waitUntil: 'networkidle' });
  const command = async text => {
    await page.keyboard.press('Control+k'); await page.keyboard.press('Control+a');
    await page.keyboard.type(text); await page.keyboard.press('Enter');
    await page.waitForTimeout(160);
  };
  await command('cat 山间小站.md');
  for (const theme of ['powershell', 'powershell-classic', 'cmd', 'linux']) {
    await command('style ' + theme);
    await page.screenshot({ path:path.join(output, theme + '.png') });
  }
  await command('style powershell'); await command('ls');
  await page.keyboard.press('Control+a');
  await page.screenshot({ path:path.join(output, 'library.png') });
  await command('help'); await page.screenshot({ path:path.join(output, 'quick-start.png') });
  await command('boss'); await page.screenshot({ path:path.join(output, 'boss-key.png') });
  await page.keyboard.press('Alt+q'); await page.keyboard.press('Escape');
  await command('vault');
  await page.getByLabel('密码', {exact:true}).waitFor();
  await page.screenshot({path:path.join(output,'password-setup.png')});
  console.log('Created public screenshots from synthetic books only.');
} finally { await browser.close(); }
