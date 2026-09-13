import { initKf8File } from '@lingo-reader/mobi-parser';
import { huffDecoder } from './ebook-huff';
import { parseMarkup } from './ebook-markup';
import { ByteWriter } from './ebook-bytes';
import { kf8ChapterText } from './ebook-kf8';
import type { Block, Chapter } from './document';

/** Check the actual Palm database, including the second header of hybrid MOBI/KF8. */
export function inspectMobi(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fail = () => { throw new Error('MOBI / AZW 文件结构损坏或格式不受支持'); };
  const ascii = (start: number, length: number) => new TextDecoder().decode(bytes.subarray(start, start + length));
  if (bytes.length < 86 || ascii(60, 8) !== 'BOOKMOBI') return fail();
  const count = view.getUint16(76);
  if (!count || 78 + count * 8 > bytes.length) return fail();
  const offsets = Array.from({ length: count }, (_, index) => view.getUint32(78 + index * 8));
  if (offsets.some((value, index) => value < 78 + count * 8 || value >= bytes.length || index > 0 && value <= offsets[index - 1])) return fail();
  offsets.push(bytes.length);
  function header(index: number) {
    const start = offsets[index], end = offsets[index + 1];
    if (start === undefined || end - start < 132 || ascii(start + 16, 4) !== 'MOBI') return fail();
    if (view.getUint16(start + 12) !== 0) throw new Error('此电子书受 DRM 保护，请导入无 DRM 的版本');
    const length = view.getUint32(start + 20), version = view.getUint32(start + 36);
    const textLength = view.getUint32(start + 4), textRecords = view.getUint16(start + 8), compression = view.getUint16(start);
    if (length < 116 || start + 16 + length > end || !textRecords || index + textRecords >= count) return fail();
    if (![1, 2, 17480].includes(compression)) throw new Error('不支持此 MOBI 压缩方式');
    const metadata = new Map<number, Uint8Array[]>();
    if (view.getUint32(start + 128) & 64) {
      const base = start + 16 + length;
      if (base + 12 > end || ascii(base, 4) !== 'EXTH') return fail();
      const exthEnd = base + view.getUint32(base + 4), entries = view.getUint32(base + 8);
      if (exthEnd > end || entries > (exthEnd - base - 12) / 8) return fail();
      let cursor = base + 12;
      for (let i = 0; i < entries; i++) {
        if (cursor + 8 > exthEnd) return fail();
        const type = view.getUint32(cursor), size = view.getUint32(cursor + 4);
        if (size < 8 || cursor + size > exthEnd) return fail();
        metadata.set(type, [...(metadata.get(type) ?? []), bytes.subarray(cursor + 8, cursor + size)]); cursor += size;
      }
    }
    const encoding = view.getUint32(start + 28);
    if (![65001, 1252].includes(encoding)) throw new Error('不支持此 MOBI 文字编码');
    const decoder = new TextDecoder(encoding === 65001 ? 'utf-8' : 'windows-1252');
    const titleOffset = view.getUint32(start + 84), titleLength = view.getUint32(start + 88);
    const title = decoder.decode(metadata.get(503)?.[0] ?? bytes.subarray(start + titleOffset, Math.min(end, start + titleOffset + titleLength))).slice(0, 4096);
    const author = (metadata.get(100) ?? []).map(value => decoder.decode(value)).join('、').slice(0, 4096);
    const boundaryBytes = metadata.get(121)?.[0];
    const boundary = boundaryBytes?.length === 4 ? new DataView(boundaryBytes.buffer, boundaryBytes.byteOffset, 4).getUint32(0) : 0xffffffff;
    const trailing = length >= 228 ? view.getUint32(start + 240) : 0;
    return { index, version, textLength, textRecords, compression, decoder, title, author, boundary, trailing,
      huffStart: view.getUint32(start + 112), huffCount: view.getUint32(start + 116) };
  }
  let selected = header(0);
  if (selected.version < 8 && selected.boundary !== 0xffffffff) {
    let index = selected.boundary;
    if (ascii(offsets[index], 8) === 'BOUNDARY') index++;
    const second = header(index);
    if (second.version < 8) return fail();
    selected = second;
  }
  return { ...selected, offsets };
}

/** PalmDOC decompression also handles older books with no EXTH or body tags. */
export function palmDoc(bytes: Uint8Array) {
  const output = new ByteWriter();
  const put = (value: number) => output.put(value);
  for (let i = 0; i < bytes.length; i++) {
    const value = bytes[i];
    if (value >= 1 && value <= 8) {
      if (i + value >= bytes.length) throw new Error('PalmDOC 压缩数据截断');
      for (let j = 0; j < value; j++) put(bytes[++i]);
    } else if (value <= 0x7f) put(value);
    else if (value >= 0xc0) { put(32); put(value ^ 0x80); }
    else {
      if (++i >= bytes.length) throw new Error('PalmDOC 压缩数据截断');
      const pair = ((value & 0x3f) << 8) | bytes[i], distance = pair >> 3, length = (pair & 7) + 3;
      if (!distance || distance > output.length) throw new Error('PalmDOC 回溯位置损坏');
      for (let j = 0; j < length; j++) put(output.get(output.length - distance));
    }
  }
  return output.finish();
}

export async function parseMobi(bytes: Uint8Array) {
  const info = inspectMobi(bytes);
  if (info.version < 8) {
    if (info.compression === 17480 && (info.huffCount < 2 || info.huffStart + info.huffCount >= info.offsets.length)) throw new Error('HUFF/CDIC 字典位置损坏');
    const decompressHuff = info.compression === 17480 ? huffDecoder(Array.from({ length: info.huffCount }, (_, index) => bytes.subarray(info.offsets[info.huffStart + index], info.offsets[info.huffStart + index + 1]))) : undefined;
    const chunks: Uint8Array[] = []; let size = 0;
    for (let i = 1; i <= info.textRecords; i++) {
      let record = bytes.subarray(info.offsets[i], info.offsets[i + 1]);
      for (let flags = info.trailing >>> 1; flags; flags >>>= 1) if (flags & 1) {
        let length = 0, shift = 0;
        for (let j = record.length - 1; j >= 0 && shift < 28; j--, shift += 7) { length |= (record[j] & 0x7f) << shift; if (record[j] & 0x80) break; }
        if (length <= 0 || length > record.length) throw new Error('MOBI 尾部数据损坏');
        record = record.subarray(0, record.length - length);
      }
      if (info.trailing & 1) record = record.subarray(0, record.length - ((record.at(-1)! & 3) + 1));
      const chunk = info.compression === 1 ? record : decompressHuff ? decompressHuff(record) : palmDoc(record);
      size += chunk.length; chunks.push(chunk);
    }
    const text = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { text.set(chunk, offset); offset += chunk.length; }
    const source = info.decoder.decode(text), parsed = parseMarkup(source);
    const encoder = new TextEncoder(); let previous = 0, byteOffset = 0;
    const sourceBytes = parsed.sources.map(point => {
      byteOffset += info.decoder.encoding === 'utf-8' ? encoder.encode(source.slice(previous, point)).length : point - previous;
      previous = point; return byteOffset;
    });
    const tocStart = parsed.tocPosition === undefined ? 0 : info.decoder.decode(text.subarray(0, parsed.tocPosition)).length;
    const toc = parsed.links.filter(link => link.source >= tocStart);
    const entries: Chapter[] = [], seen = new Set<number>();
    for (const link of toc) {
      let low = 0, high = sourceBytes.length;
      while (low < high) { const mid = (low + high) >>> 1; if (sourceBytes[mid] < link.filepos) low = mid + 1; else high = mid; }
      if (low >= parsed.blocks.length || seen.has(low)) continue;
      seen.add(low); entries.push({ title: link.title, block: low, level: 1 });
      if (parsed.blocks[low].text === link.title) parsed.blocks[low].kind = 'heading';
    }
    if (entries.length) parsed.chapters = entries;
    return { ...parsed, title: info.title || parsed.title, author: info.author || parsed.author };
  }
  // Pass a standalone KF8 database to the parser when a hybrid file uses BOUNDARY.
  if (info.index) {
    const records = info.offsets.slice(info.index, -1), tableEnd = 78 + records.length * 8 + 2;
    const tail = bytes.subarray(records[0]), standalone = new Uint8Array(tableEnd + tail.length);
    standalone.set(bytes.subarray(0, 78)); new DataView(standalone.buffer).setUint16(76, records.length);
    const view = new DataView(standalone.buffer);
    records.forEach((start, index) => view.setUint32(78 + index * 8, tableEnd + start - records[0]));
    standalone.set(tail, tableEnd); bytes = standalone;
  }
  const book = await initKf8File(bytes);
  try {
    const blocks: Block[] = [], headings: Chapter[] = [], chapters: Chapter[] = [];
    const locations = new Map<string, { start: number; anchors: Map<string, number> }>();
    for (const item of book.getSpine()) {
      const html = kf8ChapterText(book, item);
      if (!html) continue;
      const parsed = parseMarkup(html), start = blocks.length;
      locations.set(item.id, { start, anchors: parsed.anchors });
      for (const chapter of parsed.chapters) headings.push({ ...chapter, block: chapter.block + start });
      for (const block of parsed.blocks) blocks.push(block);
    }
    interface TocItem { label: string; href: string; children?: TocItem[] }
    const visit = (items: TocItem[], level = 1) => {
      if (level > 32) return;
      for (const item of items) {
        const resolved = book.resolveHref(item.href), location = resolved && locations.get(resolved.id);
        if (location) {
          const selector = resolved!.selector;
          const id = /^#(.+)$/.exec(selector)?.[1] ?? /^\[id=["'](.+)["']\]$/.exec(selector)?.[1];
          const block = location.start + (id ? location.anchors.get(id) ?? 0 : 0);
          if (block < blocks.length) chapters.push({ title: item.label.slice(0, 4096), block, level: Math.min(level, 6) });
        }
        if (item.children) visit(item.children, level + 1);
      }
    };
    visit(book.getToc() ?? []);
    return { blocks, chapters: chapters.length ? chapters : headings, title: info.title, author: info.author };
  } finally { book.destroy(); }
}
