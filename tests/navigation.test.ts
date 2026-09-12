import { describe, it, expect } from 'vitest';
import { searchBlocks } from '../src/navigation';
import { chaptersFor, parseDocument } from '../src/document';
import { normalizeSettings } from '../src/settings';
describe('Reading navigation', () => {
  it('searches literals without interpreting regexp syntax or corrupting Unicode offsets', async () => {
    const controller = new AbortController();
    const blocks = [{ text: 'İ中文 a+b [c] 中文', kind: 'paragraph' as const }];
    expect((await searchBlocks(blocks, '中文', controller.signal)).matches.map(m => m.offset)).toEqual([1, 12]);
    expect((await searchBlocks(blocks, 'a+b', controller.signal)).matches.map(m => m.offset)).toEqual([4]);
    controller.abort(); expect((await searchBlocks(blocks, '中', controller.signal)).matches).toEqual([]);
  });
  it('detects TXT and Markdown chapters and respects EPUB navigation', () => {
    const txt = { id: '1', name: 'book.txt', content: '第一章 夜航\n正文\n第二章 到岸\n正文' };
    expect(chaptersFor(txt, parseDocument(txt)).map(c => c.block)).toEqual([0, 2]);
    const md = { ...txt, name: 'book.md', content: '# 一\n\n正文\n\n## 二' };
    expect(chaptersFor(md, parseDocument(md)).map(c => c.title)).toEqual(['一', '二']);
  });
  it('migrates old preferences and rejects unsafe palette/font settings', () => {
    const settings = normalizeSettings({ theme: 'cmd', fontSize: 18, colors: { bg: 'url(x)', text: '#123456' }, lineHeight: 999, fontFamily: 'Consolas;{}' });
    expect(settings.theme).toBe('cmd'); expect(settings.fontSize).toBe(18); expect(settings.lineHeight).toBe(2.2);
    expect(settings.colors).toEqual({ text: '#123456' }); expect(settings.fontFamily).toBe('Consolas');
  });
});
