import { describe, expect, it, vi } from 'vitest';
import { initKf8File } from '@lingo-reader/mobi-parser';
import { readFileSync } from 'node:fs';
import { parseEbook } from '../src/ebook-parser';
import { inspectMobi, palmDoc } from '../src/ebook-mobi';
import { parseMarkup } from '../src/ebook-markup';
import { validateBook } from '../src/backup';
import { huffDecoder } from '../src/ebook-huff';

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/ebooks/${name}`, import.meta.url)));
const encode = (text: string) => new TextEncoder().encode(text);

function classicFixture(compression: number) {
  const text = encode('<h1>第一章</h1><p>正文完整，没有 body 标签。</p>');
  const header = new Uint8Array(248), view = new DataView(header.buffer);
  view.setUint16(0, compression); view.setUint32(4, text.length); view.setUint16(8, 1); view.setUint16(10, 4096);
  header.set(encode('MOBI'), 16); view.setUint32(20, 232); view.setUint32(28, 65001); view.setUint32(36, 6);
  const records = [header, text];
  if (compression === 17480) {
    view.setUint32(112, 2); view.setUint32(116, 2);
    const huff = new Uint8Array(24 + 1024 + 256), hv = new DataView(huff.buffer);
    huff.set(encode('HUFF')); hv.setUint32(8, 24); hv.setUint32(12, 1048);
    for (let i = 0; i < 256; i++) hv.setUint32(24 + i * 4, (255 << 8) | 128 | 8);
    const cdic = new Uint8Array(16 + 512 + 768), cv = new DataView(cdic.buffer);
    cdic.set(encode('CDIC')); cv.setUint32(4, 16); cv.setUint32(8, 256); cv.setUint32(12, 8);
    for (let i = 0; i < 256; i++) { cv.setUint16(16 + i * 2, 512 + i * 3); cv.setUint16(528 + i * 3, 0x8001); cdic[530 + i * 3] = 255 - i; }
    records.push(huff, cdic);
  }
  let offset = 78 + records.length * 8 + 2;
  const bytes = new Uint8Array(offset + records.reduce((sum, record) => sum + record.length, 0)), pdb = new DataView(bytes.buffer);
  bytes.set(encode('BOOKMOBI'), 60); pdb.setUint16(76, records.length);
  records.forEach((record, i) => { pdb.setUint32(78 + i * 8, offset); bytes.set(record, offset); offset += record.length; });
  return { bytes, records };
}

describe('electronic book import', () => {
  it('reads KF8 without invoking the image/font/stylesheet renderer', async () => {
    const parser = await initKf8File(fixture('sample.azw3'));
    const render = vi.spyOn(Object.getPrototypeOf(parser), 'loadChapter').mockImplementation(() => { throw new Error('unexpected resource rendering'); });
    try {
      const book = await parseEbook('sample.azw3', fixture('sample.azw3'));
      expect(book.content).toContain('全书结束。');
      expect(book.chapters?.some(chapter => chapter.title === '第二章 星灯')).toBe(true);
      expect(render).not.toHaveBeenCalled();
    } finally { render.mockRestore(); parser.destroy(); }
  });
  for (const compression of [1, 17480]) it(`reads legacy MOBI without EXTH/body tags, compression ${compression}`, async () => {
    const { bytes } = classicFixture(compression);
    const book = await parseEbook('old.mobi', bytes);
    expect(book.content).toBe('第一章\n\n正文完整，没有 body 标签。');
    expect(book.chapters).toEqual([{ title: '第一章', block: 0, level: 1 }]);
  });
  it('grows HUFF output and rejects cyclic dictionary phrases', () => {
    const { records } = classicFixture(17480);
    expect(huffDecoder(records.slice(2))(new Uint8Array(70000).fill(65)).length).toBe(70000);
    const cdic = records[3].slice(), index = 255 - 65;
    new DataView(cdic.buffer).setUint16(528 + index * 3, 1); cdic[530 + index * 3] = 65;
    expect(() => huffDecoder([records[2], cdic])(Uint8Array.from([65]))).toThrow('损坏');
  });
  for (const [source, name] of [['sample.mobi', 'sample.mobi'], ['sample.mobi', 'sample.AZW'], ['sample.mobi', 'sample.prc'], ['sample.azw3', 'sample.azw3'], ['hybrid.mobi', 'hybrid.mobi'], ['sample.azw3', 'renamed.azw']]) {
    it(`reads complete text and navigable chapters: ${source} as ${name}`, async () => {
      const book = await parseEbook(name, fixture(source));
      expect(book.content).toContain('甲乙丙丁，春夏秋冬。');
      expect(book.content).toContain('全书结束。');
      expect(book.title).toBe('电子书兼容性示例');
      expect(book.author).toBe('Terminal Reader');
      for (const name of ['第一章 纸船', '第二章 星灯']) {
        const chapter = book.chapters?.find(item => item.title === name);
        expect(chapter, name).toBeDefined();
        expect(book.blocks?.[chapter!.block].text).toBe(name);
      }
      expect(validateBook({ id: 'synthetic', name, ...book })).toEqual({ id: 'synthetic', name, ...book });
    });
  }
  it('extracts FB2 body, metadata, nested sections and entities without binary payload', async () => {
    const xml = '<?xml version="1.0"?><FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0"><description><title-info><book-title>纸船</book-title><author><first-name>示例</first-name><last-name>作者</last-name></author></title-info></description><body><section><title><p>一</p></title><p>中文 &amp; English</p><section><title><p>二</p></title><p>结束。</p></section></section></body><binary>PRIVATE_BINARY_SAMPLE</binary></FictionBook>';
    const book = await parseEbook('book.fb2', encode(xml));
    expect(book.title).toBe('纸船'); expect(book.author).toBe('示例 作者');
    expect(book.content).toBe('一\n\n中文 & English\n\n二\n\n结束。');
    expect(book.chapters).toEqual([{ title: '一', block: 0, level: 1 }, { title: '二', block: 2, level: 2 }]);
  });
  it('extracts inert HTML with headings, inline text and code', async () => {
    const book = await parseEbook('page.HTM', encode('<html><head><title>标题</title><style>hidden</style></head><body><h1>第一章</h1><p>hello <b>world</b> &amp; 中文</p><script>alert("BAD")</script><img src="https://example.invalid/never"><pre>a\n  b</pre></body></html>'));
    expect(book.format).toBe('html'); expect(book.title).toBe('标题');
    expect(book.content).toBe('第一章\n\nhello world & 中文\n\na\n  b');
    expect(book.blocks?.at(-1)?.kind).toBe('code');
  });
  it('rejects DRM in both classic and hybrid headers before decoding', async () => {
    for (const name of ['sample.mobi', 'sample.azw3', 'hybrid.mobi']) {
      const bytes = fixture(name), header = inspectMobi(bytes);
      new DataView(bytes.buffer).setUint16(header.offsets[header.index] + 12, 2);
      await expect(parseEbook(name, bytes)).rejects.toThrow('DRM');
    }
  });
  it('rejects truncation, forged offsets and unsupported containers', async () => {
    const bytes = fixture('sample.mobi');
    await expect(parseEbook('book.mobi', bytes.subarray(0, 100))).rejects.toThrow();
    const broken = bytes.slice(); new DataView(broken.buffer).setUint32(78, 0xffffffff);
    await expect(parseEbook('book.azw', broken)).rejects.toThrow('结构');
    await expect(parseEbook('book.fb2', encode('<html><body>not FB2</body></html>'))).rejects.toThrow('FB2');
    expect(() => parseMarkup('<!DOCTYPE FictionBook><FictionBook/>', true)).toThrow('DTD');
    await expect(parseEbook('book.azw', encode('CONTnot-a-supported-kfx-container'))).rejects.toThrow('不受支持');
  });
  it('grows PalmDOC output and rejects invalid streams', () => {
    expect(new TextDecoder().decode(palmDoc(Uint8Array.from([97, 98, 99, 0x80, 0x18])))).toBe('abcabc');
    expect(() => palmDoc(Uint8Array.from([0x80, 0x18]))).toThrow('回溯');
    expect(() => palmDoc(Uint8Array.from([4, 65]))).toThrow('截断');
    expect(palmDoc(new Uint8Array(70000).fill(97)).length).toBe(70000);
  });
  it('accepts HTML text beyond the former 16 MiB cap', async () => {
    const text = 'x'.repeat(17 * 1024 * 1024);
    const book = await parseEbook('large.html', encode(`<p>${text}</p>`));
    expect(book.content.length).toBe(text.length);
    expect(validateBook({ id: 'large', name: 'large.html', ...book }).content.length).toBe(text.length);
  });
});
