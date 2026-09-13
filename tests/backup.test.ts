import { describe, expect, it } from 'vitest';
import { createBackup, normalizeCategories, normalizeCategory, parseBackup, validateBackup, validateBook, type BackupData } from '../src/backup';

function sample(): BackupData {
  return {
    format: 'terminal-reader-backup', version: 1, exportedAt: '2026-09-12T08:00:00.000Z',
    books: [{ id: 'C:/Books/01.md', name: '01.md', content: '# 夜航\n\n第一段。' }],
    positions: { 'C:/Books/01.md': { block: 1, fraction: 1.15 } },
    bookmarks: [{ id: 'mark:1', bookId: 'C:/Books/01.md', label: '雨夜', position: { block: 1, fraction: 0.2, offset: 3, lineRatio: -0.1, gap: 0.25 }, createdAt: 1_789_200_000_000 }],
    settings: { theme: 'cmd', colors: { bg: '#101010' }, colorSchemes: [{ name: '深夜', colors: { text: '#aaaaaa' } }] },
    lastBook: 'C:/Books/01.md', commandHistory: ['/find 雨', '/books'],
  };
}

describe('backup validation', () => {
  it('round trips legacy books, gap positions, bookmarks and custom palettes without sharing mutable objects', () => {
    const source = sample();
    const restored = parseBackup('\uFEFF' + JSON.stringify(source));
    expect(restored).toEqual({ ...source, categories: [], recentReads: {} });
    expect(restored.books[0]).not.toBe(source.books[0]);
    expect(restored.bookmarks[0].position).not.toBe(source.bookmarks[0].position);
    (restored.settings.colors as Record<string, string>).bg = '#ffffff';
    expect((source.settings.colors as Record<string, string>).bg).toBe('#101010');
    expect(createBackup(source).exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('preserves EPUB reading order, metadata and chapter nesting', () => {
    const source = sample();
    source.books = [{
      id: 'C:/Books/story.epub', name: 'story.epub', content: '序\n\n雨夜', format: 'epub', title: '夜航', author: '匿名',
      blocks: [{ text: '序', kind: 'heading' }, { text: '雨夜', kind: 'paragraph' }],
      chapters: [{ title: '序章', block: 0 }, { title: '雨夜', block: 1, level: 2 }],
    }];
    expect(parseBackup(JSON.stringify(source)).books).toEqual(source.books);
  });

  it('accepts missing optional state from early exports while requiring the file identity and version', () => {
    const source = sample();
    const restored = validateBackup({ format: source.format, version: 1, exportedAt: source.exportedAt, books: source.books });
    expect(restored.positions).toEqual({});
    expect(restored.bookmarks).toEqual([]);
    expect(restored.commandHistory).toEqual([]);
    expect(restored.categories).toEqual([]);
    expect(() => validateBackup({ ...source, version: 2 })).toThrow(/版本/);
    expect(() => validateBackup({ ...source, format: 'unrelated-export' })).toThrow(/不是/);
    expect(() => parseBackup('{broken')).toThrow(/JSON/);
  });

  it.each([
    ['top-level', '{"__proto__":{"polluted":true}}'],
    ['settings', '{"colors":{"constructor":{"prototype":{"polluted":true}}}}'],
    ['positions', '{"__proto__":{"block":0,"fraction":0}}'],
  ])('rejects prototype-pollution keys in %s without modifying object prototypes', (where, payload) => {
    const source: Record<string, unknown> = sample() as unknown as Record<string, unknown>;
    if (where === 'top-level') Object.assign(source, JSON.parse(payload));
    else source[where] = JSON.parse(payload);
    expect(() => validateBackup(source)).toThrow();
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('rejects duplicate records, invalid anchors, timestamps and dangerous settings values', () => {
    const source = sample();
    expect(() => validateBackup({ ...source, books: [source.books[0], source.books[0]] })).toThrow(/重复/);
    expect(() => validateBackup({ ...source, bookmarks: [source.bookmarks[0], source.bookmarks[0]] })).toThrow(/重复/);
    expect(() => validateBackup({ ...source, positions: { x: { block: -1, fraction: 0 } } })).toThrow(/范围/);
    expect(() => validateBackup({ ...source, positions: { x: { block: 0, fraction: Infinity } } })).toThrow(/范围/);
    expect(() => validateBackup({ ...source, positions: { x: { block: 0, fraction: 0, gap: 1.1 } } })).toThrow(/范围/);
    expect(() => validateBackup({ ...source, positions: { x: { block: 0, fraction: 0, offset: 1.5 } } })).toThrow(/范围/);
    expect(() => validateBackup({ ...source, exportedAt: 'not a date' })).toThrow(/时间/);
    expect(() => validateBackup({ ...source, settings: { speed: NaN } })).toThrow(/数值/);
    expect(() => validateBackup({ ...source, settings: { nested: { a: { b: { c: { d: { e: 'deep' } } } } } } })).toThrow(/嵌套/);
    expect(() => validateBackup({ ...source, commandHistory: Array.from({ length: 201 }, () => '/books') })).toThrow(/过长/);
  });

  it('round trips backup text beyond the former 128 MiB cap', () => {
    const source = sample();
    const text = 'x'.repeat(65 * 1024 * 1024);
    source.books = [{ id: 'large', name: 'large.txt', content: text, blocks: [{ text, kind: 'paragraph' }] }];
    const serialized = JSON.stringify(createBackup(source));
    expect(serialized.length).toBeGreaterThan(128 * 1024 * 1024);
    const restored = parseBackup(serialized);
    expect(restored.books[0].content.length).toBe(text.length);
    expect(restored.books[0].blocks?.[0].text.length).toBe(text.length);
  });

  it('rejects damaged cached books and EPUB chapters outside the document', () => {
    expect(validateBook(sample().books[0])).toEqual(sample().books[0]);
    expect(() => validateBook({ id: 'a', name: 'a.txt', content: null })).toThrow();
    expect(() => validateBook({ id: 'a', name: 'a.epub', content: '', blocks: [{ text: 'x', kind: 'script' }] })).toThrow(/类型/);
    expect(() => validateBook({ id: 'a', name: 'a.epub', content: 'x', blocks: [{ text: 'x', kind: 'paragraph' }], chapters: [{ title: 'missing', block: 1 }] })).toThrow(/不存在/);
    expect(validateBook({ id: 'a', name: 'a.txt', content: 'x'.repeat(16 * 1024 * 1024 + 1) }).content.length).toBe(16 * 1024 * 1024 + 1);
  });

  it('round trips categorized books and unused category names with canonical names and deduplication', () => {
    const source = sample();
    source.categories = [' 小说 ', '待阅读', 'Cafe\u0301', 'Café'];
    source.books[0].category = ' 小说 ';
    source.books.push({ id: 'category:epub', name: '02.epub', format: 'epub', content: '电子书', category: '随笔' });
    const backup = createBackup(source);
    expect(backup.categories).toEqual(['小说', '待阅读', 'Café', '随笔']);
    expect(backup.books.map(book => book.category)).toEqual(['小说', '随笔']);
    expect(parseBackup(JSON.stringify(backup))).toEqual(backup);
    expect(source.books[0].category).toBe(' 小说 ');
    expect(source.categories).toEqual([' 小说 ', '待阅读', 'Cafe\u0301', 'Café']);
  });

  it('derives categories from legacy exports and leaves uncategorized books unchanged', () => {
    const source = sample();
    expect(validateBook(source.books[0])).not.toHaveProperty('category');
    source.books[0].category = ' 科幻 ';
    expect(validateBackup(source).categories).toEqual(['科幻']);
    expect(validateBook({ ...source.books[0], category: undefined })).not.toHaveProperty('category');
    expect(normalizeCategory('  Cafe\u0301  ')).toBe('Café');
    expect(normalizeCategories(['科幻', ' 科幻 ', '随笔'])).toEqual(['科幻', '随笔']);
  });

  it.each([null, 42, {}, [], '', '   ', '长'.repeat(41), '__proto__', 'constructor', '小说\u0000', '文\n学', '文\u202e学'])(
    'rejects malformed or unsafe category names %j', category => {
      const source = sample();
      expect(() => validateBook({ ...source.books[0], category })).toThrow(/分类/);
      expect(() => validateBackup({ ...source, categories: [category] })).toThrow(/分类/);
    },
  );

  it('enforces the category limit across both the catalog and books', () => {
    const source = sample();
    const categories = Array.from({ length: 200 }, (_, index) => `分类 ${index + 1}`);
    expect(validateBackup({ ...source, categories }).categories).toEqual(categories);
    expect(normalizeCategories([...categories, categories[0]])).toEqual(categories);
    expect(() => validateBackup({ ...source, categories: [...categories, '超额'] })).toThrow(/200/);
    expect(() => validateBackup({ ...source, categories, books: [{ ...source.books[0], category: '超额' }] })).toThrow(/200/);
    expect(() => validateBackup({ ...source, categories: {} })).toThrow(/分类/);
    const books = Array.from({ length: 10_000 }, (_, index) => ({ id: String(index), name: 'a.txt', content: '', category: categories[0] }));
    expect(validateBackup({ ...source, books, categories }).categories).toEqual(categories);
  });
});
