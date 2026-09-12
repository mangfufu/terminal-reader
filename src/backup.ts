import type { Book, Block, Position } from './document';

export interface Bookmark {
  id: string;
  bookId: string;
  label: string;
  position: Position;
  createdAt: number;
}

export interface BackupData {
  format: 'terminal-reader-backup';
  version: 1;
  workspace?: 'public' | 'vault';
  exportedAt: string;
  books: Book[];
  positions: Record<string, Position>;
  bookmarks: Bookmark[];
  settings: Record<string, unknown>;
  lastBook: string;
  commandHistory: string[];
  categories?: string[];
  recentReads?: Record<string, { at: number; percent: number }>;
}

export const MAX_BACKUP_BYTES = 128 * 1024 * 1024;
const MAX_BOOK_TEXT = 16 * 1024 * 1024;
const MAX_TOTAL_TEXT = 64 * 1024 * 1024;
const MAX_BOOKS = 10_000;
const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor']);
export const MAX_CATEGORIES = 200;
export const MAX_CATEGORY_LENGTH = 40;

function invalid(message: string): never { throw new Error(`备份无效：${message}`); }

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label}必须是对象`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(`${label}对象类型不受支持`);
  if (Object.keys(value).some(key => unsafeKeys.has(key))) invalid(`${label}含有不安全的字段`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string, maxLength: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > maxLength || (!allowEmpty && !value.trim())) invalid(`${label}文本为空或过长`);
  return value;
}

function number(value: unknown, label: string, min: number, max: number, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) invalid(`${label}超出允许范围`);
  return value;
}

function array(value: unknown, label: string, maxLength: number): unknown[] {
  if (!Array.isArray(value) || value.length > maxLength) invalid(`${label}列表无效或过长`);
  return value;
}

function identifier(value: unknown, label: string): string {
  const id = string(value, label, 4096);
  if (unsafeKeys.has(id)) invalid(`${label}无效`);
  return id;
}

/** One display name per category, shared by UI input, cached books and backups. */
export function normalizeCategory(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096) invalid('分类名称必须是文本');
  const category = value.trim().normalize('NFC');
  if (!category || category.length > MAX_CATEGORY_LENGTH) invalid(`分类名称须为 1–${MAX_CATEGORY_LENGTH} 个字符`);
  if (unsafeKeys.has(category) || /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(category)) invalid('分类名称含有无效字符');
  return category;
}

/** Keep first-seen order; old book-only backups can supply their derived names. */
export function normalizeCategories(value: unknown): string[] {
  const categories = [...new Set(array(value, '分类', MAX_BOOKS).map(normalizeCategory))];
  if (categories.length > MAX_CATEGORIES) invalid(`分类最多 ${MAX_CATEGORIES} 个`);
  return categories;
}

/** Copy recognized fields so restored JSON cannot carry prototypes into app state. */
export function validatePosition(value: unknown): Position {
  const raw = record(value, '阅读位置');
  const result: Position = {
    block: number(raw.block, '段落编号', 0, 2_000_000, true),
    fraction: number(raw.fraction, '段落位置', 0, 100_000),
  };
  if (raw.offset !== undefined) result.offset = number(raw.offset, '字符位置', 0, MAX_BOOK_TEXT, true);
  if (raw.lineRatio !== undefined) result.lineRatio = number(raw.lineRatio, '行内位置', -4, 4);
  if (raw.gap !== undefined) result.gap = number(raw.gap, '段落间距位置', 0, 1);
  return result;
}

/** Also used when reading the version 1 IndexedDB store from the original app. */
export function validateBook(value: unknown): Book {
  const raw = record(value, '书籍');
  const result: Book = {
    id: identifier(raw.id, '书籍编号'),
    name: string(raw.name, '文件名', 4096),
    content: string(raw.content, '正文', MAX_BOOK_TEXT, true),
  };
  if (raw.format !== undefined) {
    if (raw.format !== 'epub') invalid('电子书格式不受支持');
    result.format = raw.format;
  }
  if (raw.title !== undefined) result.title = string(raw.title, '书名', 4096, true);
  if (raw.author !== undefined) result.author = string(raw.author, '作者', 4096, true);
  if (raw.category !== undefined) result.category = normalizeCategory(raw.category);
  if (raw.blocks !== undefined) {
    let textLength = 0;
    result.blocks = array(raw.blocks, '正文段落', 200_000).map(value => {
      const block = record(value, '正文段落');
      if (!['paragraph', 'heading', 'code', 'quote'].includes(block.kind as string)) invalid('段落类型不受支持');
      const text = string(block.text, '段落正文', MAX_BOOK_TEXT, true);
      textLength += text.length;
      if (textLength > MAX_BOOK_TEXT) invalid('书籍正文过大');
      return { text, kind: block.kind as Block['kind'] };
    });
  }
  if (raw.chapters !== undefined) {
    result.chapters = array(raw.chapters, '章节目录', 20_000).map(value => {
      const chapter = record(value, '章节');
      const block = number(chapter.block, '章节段落编号', 0, 2_000_000, true);
      if (result.blocks && block >= result.blocks.length) invalid('章节指向了不存在的正文段落');
      return { title: string(chapter.title, '章节标题', 4096), block, ...(chapter.level === undefined ? {} : { level: number(chapter.level, '章节层级', 1, 20, true) }) };
    });
  }
  return result;
}

export function validateBookmark(value: unknown): Bookmark {
  const raw = record(value, '书签');
  return {
    id: identifier(raw.id, '书签编号'),
    bookId: identifier(raw.bookId, '书签书籍编号'),
    label: string(raw.label, '书签名称', 4096),
    position: validatePosition(raw.position),
    createdAt: number(raw.createdAt, '书签时间', 0, 8_640_000_000_000_000, true),
  };
}

function copySetting(value: unknown, depth: number): unknown {
  if (depth > 5) invalid('设置嵌套过深');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid('设置数值无效');
    return value;
  }
  if (typeof value === 'string') return string(value, '设置', 4096, true);
  if (Array.isArray(value)) return array(value, '设置', 100).map(item => copySetting(item, depth + 1));
  const object = record(value, '设置');
  const entries = Object.entries(object);
  if (entries.length > 100) invalid('设置字段过多');
  return Object.fromEntries(entries.map(([key, item]) => [string(key, '设置名称', 100), copySetting(item, depth + 1)]));
}

export function validateBackup(value: unknown): BackupData {
  const raw = record(value, '备份');
  if (raw.format !== 'terminal-reader-backup') invalid('不是 Terminal Reader 备份文件');
  if (raw.version !== 1) invalid('不支持此备份版本，请使用对应版本的应用');
  if (raw.workspace !== undefined && raw.workspace !== 'public' && raw.workspace !== 'vault') invalid('书库类型无效');
  const exportedAt = string(raw.exportedAt, '导出时间', 64);
  if (!Number.isFinite(Date.parse(exportedAt))) invalid('导出时间无效');

  const ids = new Set<string>();
  let totalText = 0;
  const books = array(raw.books, '书库', MAX_BOOKS).map(value => {
    const book = validateBook(value);
    if (ids.has(book.id)) invalid('书库包含重复书籍编号');
    ids.add(book.id);
    totalText += book.content.length + (book.blocks?.reduce((sum, block) => sum + block.text.length, 0) ?? 0);
    if (totalText > MAX_TOTAL_TEXT) invalid('备份正文总量过大');
    return book;
  });

  const positions: Record<string, Position> = {};
  const positionEntries = Object.entries(record(raw.positions ?? {}, '阅读进度'));
  if (positionEntries.length > MAX_BOOKS * 2) invalid('阅读进度条目过多');
  for (const [id, position] of positionEntries) positions[identifier(id, '阅读进度编号')] = validatePosition(position);

  const markIds = new Set<string>();
  const bookmarks = array(raw.bookmarks ?? [], '书签', 50_000).map(value => {
    const bookmark = validateBookmark(value);
    if (markIds.has(bookmark.id)) invalid('书签编号重复');
    markIds.add(bookmark.id);
    return bookmark;
  });
  const settings = copySetting(record(raw.settings ?? {}, '设置'), 0) as Record<string, unknown>;
  const lastBook = string(raw.lastBook ?? '', '上次阅读文件', 4096, true);
  if (unsafeKeys.has(lastBook)) invalid('上次阅读文件编号无效');
  const commandHistory = array(raw.commandHistory ?? [], '命令历史', 200).map(value => string(value, '历史命令', 4096));
  const categories = normalizeCategories([
    ...normalizeCategories(raw.categories ?? []),
    ...normalizeCategories(books.flatMap(book => book.category === undefined ? [] : [book.category])),
  ]);
  const recentReads = Object.fromEntries(Object.entries(record(raw.recentReads ?? {}, '最近阅读')).slice(0, MAX_BOOKS).map(([id, item]) => { const entry = record(item, '最近阅读'); return [identifier(id, '书籍编号'), { at: number(entry.at, '阅读时间', 0, 8640000000000000), percent: number(entry.percent, '阅读百分比', 0, 100) }]; }));
  return { format: 'terminal-reader-backup', version: 1, ...(raw.workspace ? { workspace: raw.workspace as 'public' | 'vault' } : {}), exportedAt, recentReads, books, positions, bookmarks, settings, lastBook, commandHistory, categories };
}

export function parseBackup(text: string): BackupData {
  if (text.length > MAX_BACKUP_BYTES || new TextEncoder().encode(text).byteLength > MAX_BACKUP_BYTES) invalid('备份超过 128 MiB');
  let value: unknown;
  try { value = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { invalid('文件不是有效的 JSON'); }
  return validateBackup(value);
}

export function createBackup(data: Omit<BackupData, 'format' | 'version' | 'exportedAt'>): BackupData {
  return validateBackup({ ...data, format: 'terminal-reader-backup', version: 1, exportedAt: new Date().toISOString() });
}
