import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 560, height: 400 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/reader-fixture', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id="app" class="has-book"><div class="terminal-surface"><main id="reader"><div class="session-command">PS C:\\Books&gt; /open test.md</div><article id="content"></article></main></div></div><script type="module">
    import '/src/style.css';
    import { ReaderView } from '/src/reader.ts';
    const reader = document.getElementById('reader'), content = document.getElementById('content');
    const view = new ReaderView(reader, content, (el, index) => el.dataset.ansiRole = index % 2 ? 'info' : 'body');
    window.harness = { reader, content, view };
  </script></body></html>` }));
  await page.goto('http://127.0.0.1:1420/reader-fixture');
  await page.waitForFunction(() => window.harness);

  const small = await page.evaluate(() => {
    const { view, content, reader } = window.harness;
    view.setBlocks(Array.from({ length: 40 }, (_, index) => ({ kind: index % 10 ? 'paragraph' : 'heading', text: `第${index}段 ` + '看书时窗口和字号会改变，这一行需要始终保持可见。'.repeat(12) })));
    reader.scrollTop = content.children[8].offsetTop + 133;
    const original = reader.scrollTop;
    const anchor = view.capture();
    reader.scrollTop = 0;
    view.restore(anchor);
    return { virtual: content.dataset.virtual, count: content.children.length, original, restored: reader.scrollTop, anchor };
  });
  assert.equal(small.virtual, 'false');
  assert.equal(small.count, 40);
  assert.ok(Math.abs(small.original - small.restored) <= 1, JSON.stringify(small));
  assert.ok(small.anchor.offset > 0, 'Capture a character inside a multiline paragraph');

  const resized = await page.evaluate(anchor => {
    const { view, content, reader } = window.harness;
    document.getElementById('app').style.setProperty('--font-size', '22px');
    content.style.maxWidth = '300px';
    view.refreshLayout(anchor);
    const element = view.elementFor(anchor.block);
    const range = document.createRange();
    range.setStart(element.firstChild, anchor.offset);
    range.setEnd(element.firstChild, anchor.offset + 1);
    const rect = range.getBoundingClientRect();
    return { delta: rect.top - reader.getBoundingClientRect().top, line: parseFloat(getComputedStyle(element).lineHeight), ratio: anchor.lineRatio };
  }, small.anchor);
  assert.ok(Math.abs(resized.delta + resized.ratio * resized.line) < 1, JSON.stringify(resized));

  const gap = await page.evaluate(() => {
    const { view, content, reader } = window.harness;
    const element = content.children[12], next = content.children[13];
    reader.scrollTop = element.offsetTop + element.offsetHeight + (next.offsetTop - element.offsetTop - element.offsetHeight) / 2;
    const before = reader.scrollTop;
    const anchor = view.capture();
    view.restore(anchor);
    return { before, after: reader.scrollTop, anchor };
  });
  assert.ok(gap.anchor.gap > 0 && gap.anchor.gap < 1, JSON.stringify(gap));
  assert.ok(Math.abs(gap.before - gap.after) <= 1, JSON.stringify(gap));

  const large = await page.evaluate(() => {
    const { view, content, reader } = window.harness;
    content.style.maxWidth = '';
    document.getElementById('app').style.setProperty('--font-size', '16px');
    const blocks = Array.from({ length: 15_000 }, (_, index) => ({ kind: index % 100 ? 'paragraph' : 'heading', text: `第${index}段 ` + '这是一部较长的书，每个段落都应能被准确找到。'.repeat(6) }));
    const started = performance.now();
    view.setBlocks(blocks);
    view.restore({ block: 12_345, fraction: 0, offset: 65, lineRatio: 0 });
    const current = view.capture();
    return { elapsed: performance.now() - started, virtual: content.dataset.virtual, nodes: content.childElementCount, current, height: reader.scrollHeight, text: view.elementFor(12_345)?.textContent };
  });
  assert.equal(large.virtual, 'true');
  assert.ok(large.nodes < 150, JSON.stringify(large));
  assert.equal(large.current.block, 12_345);
  assert.match(large.text, /^第12345段/);
  assert.ok(large.height > 1_000_000, JSON.stringify(large));
  assert.ok(large.elapsed < 5000, `Large book setup took ${large.elapsed}ms`);

  const scroll = await page.evaluate(async () => {
    const { view, content, reader } = window.harness;
    reader.scrollTop = reader.scrollHeight * .2;
    await new Promise(requestAnimationFrame);
    const start = view.capture();
    for (let i = 0; i < 60; i++) {
      reader.scrollTop += 37;
      await new Promise(requestAnimationFrame);
    }
    const end = view.capture();
    const previousHeight = reader.scrollHeight;
    reader.scrollTop = reader.scrollHeight;
    await new Promise(requestAnimationFrame);
    const last = view.capture();
    return { start, end, last, nodes: content.childElementCount, bottom: reader.scrollTop + reader.clientHeight, height: reader.scrollHeight, previousHeight };
  });
  assert.ok(scroll.end.block > scroll.start.block, JSON.stringify(scroll));
  assert.ok(scroll.last.block >= 14_990, JSON.stringify(scroll));
  assert.ok(scroll.height - scroll.bottom <= 2, JSON.stringify(scroll));
  assert.ok(scroll.nodes < 150, JSON.stringify(scroll));

  const longParagraph = await page.evaluate(() => {
    const { view, content } = window.harness;
    const text = '海边有人写下了一段很长很长的故事。'.repeat(25_000);
    view.setBlocks([{ kind: 'paragraph', text }]);
    view.restore({ block: 0, fraction: .5, offset: 215_001, lineRatio: .2 });
    const anchor = view.capture();
    view.highlight('很长很长', { block: 0, offset: text.indexOf('很长很长', 215_001) });
    return { nodes: content.childElementCount, renderedChars: content.textContent.length, length: text.length, anchor, marks: content.querySelectorAll('mark').length };
  });
  assert.ok(longParagraph.nodes < 40, JSON.stringify(longParagraph));
  assert.ok(longParagraph.renderedChars < 20_000, JSON.stringify(longParagraph));
  assert.ok(Math.abs(longParagraph.anchor.offset - 215_001) < 100, JSON.stringify(longParagraph));
  assert.ok(longParagraph.marks > 0);

  const crossChunk = await page.evaluate(() => {
    const { view, content } = window.harness;
    view.setBlocks([{ kind: 'paragraph', text: 'a'.repeat(2046) + 'needle' + 'b'.repeat(10_000) }]);
    view.restore({ block: 0, fraction: 0, offset: 2046 });
    view.highlight('needle', { block: 0, offset: 2046 });
    return { marked: [...content.querySelectorAll('mark')].map(mark => mark.textContent).join(''), count: content.querySelectorAll('.reader-match-current').length };
  });
  assert.equal(crossChunk.marked, 'needle');
  assert.equal(crossChunk.count, 2, 'A match crossing virtual chunks is highlighted in both fragments');

  await page.evaluate(() => {
    const { view } = window.harness;
    view.setBlocks(Array.from({ length: 1000 }, (_, index) => ({ kind: 'paragraph', text: `段落${index}：` + '这段文字用来验证窗口缩小后仍保留同一字符。'.repeat(20) })));
    view.restore({ block: 620, fraction: 0, offset: 179, lineRatio: .25 });
    window.resizeAnchor = view.capture();
  });
  await page.setViewportSize({ width: 280, height: 160 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const automaticResize = await page.evaluate(() => {
    const { view, reader } = window.harness;
    const anchor = window.resizeAnchor;
    const element = view.elementFor(anchor.block);
    const range = document.createRange();
    range.setStart(element.firstChild, anchor.offset - Number(element.dataset.offset));
    range.setEnd(element.firstChild, anchor.offset - Number(element.dataset.offset) + 1);
    const line = parseFloat(getComputedStyle(element).lineHeight);
    return { block: view.capture().block, delta: range.getBoundingClientRect().top - reader.getBoundingClientRect().top + anchor.lineRatio * line, width: reader.scrollWidth, clientWidth: reader.clientWidth };
  });
  assert.equal(automaticResize.block, 620);
  assert.ok(Math.abs(automaticResize.delta) < 1, JSON.stringify(automaticResize));
  assert.ok(automaticResize.width <= automaticResize.clientWidth, JSON.stringify(automaticResize));

  const safe = await page.evaluate(() => {
    const { view, content } = window.harness;
    view.setBlocks([{ kind: 'paragraph', text: '<img src=x onerror=alert(1)> hello HELLO' }]);
    view.highlight('hello', { block: 0, offset: 33 });
    return { html: content.querySelectorAll('img,script').length, marks: content.querySelectorAll('mark').length, text: content.textContent };
  });
  assert.equal(safe.html, 0);
  assert.equal(safe.marks, 2);
  assert.equal(safe.text, '<img src=x onerror=alert(1)> hello HELLO');
  assert.deepEqual(errors, []);
  console.log(`Reader verification passed: character anchors, explicit/automatic resize, gaps, 15,000 paragraphs (${Math.round(large.elapsed)} ms), scrollbar jumps, long paragraph virtualization, safe/cross-chunk highlighting.`);
} finally { await browser.close(); }
