export interface Chapter { title: string; block: number; level?: number }
export const ebookFormats = ['epub', 'mobi', 'azw', 'azw3', 'prc', 'fb2', 'html'] as const;
export interface Book {
  id: string; name: string; content: string; format?: typeof ebookFormats[number]; title?: string; author?: string;
  blocks?: Block[]; chapters?: Chapter[]; category?: string;
}
export interface Block { text: string; kind: 'paragraph' | 'heading' | 'code' | 'quote' }
export interface Position { block: number; fraction: number; offset?: number; lineRatio?: number; gap?: number }

export function parseDocument(book: Book): Block[] {
  if (book.blocks?.length) return book.blocks;
  const markdown = /\.(md|markdown)$/i.test(book.name);
  const lines = book.content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let fence: string | null = null;
  let code: string[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ text: paragraph.join('\n'), kind: 'paragraph' });
    paragraph = [];
  };
  for (const line of lines) {
    if (markdown && /^\s*(`{3,}|~{3,})/.test(line)) {
      const marker = line.trim()[0];
      if (!fence) { flush(); fence = marker; }
      else if (fence === marker) { blocks.push({ text: code.join('\n'), kind: 'code' }); code = []; fence = null; }
      else code.push(line);
      continue;
    }
    if (fence) { code.push(line); continue; }
    if (!line.trim()) { flush(); continue; }
    if (markdown && /^#{1,6}\s/.test(line)) {
      flush(); blocks.push({ text: line.replace(/^#{1,6}\s+/, ''), kind: 'heading' });
    } else if (markdown && /^>\s?/.test(line)) {
      flush(); blocks.push({ text: line.replace(/^>\s?/, ''), kind: 'quote' });
    } else if (!markdown) {
      blocks.push({ text: line, kind: /^(第.{1,20}[章节卷部]|chapter\s+\d+)/i.test(line.trim()) ? 'heading' : 'paragraph' });
    } else paragraph.push(line);
  }
  flush();
  if (code.length) blocks.push({ text: code.join('\n'), kind: 'code' });
  return blocks;
}

export function chaptersFor(book: Book, blocks: Block[]): Chapter[] {
  if (book.chapters?.length) return book.chapters.filter(chapter => chapter.block >= 0 && chapter.block < blocks.length);
  return blocks.flatMap((block, index) => block.kind === 'heading' ? [{ title: block.text, block: index, level: 1 }] : []);
}

const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
export function sortBooks(books: Book[]): Book[] {
  return [...books].sort((a, b) => collator.compare(a.id, b.id) || a.id.localeCompare(b.id));
}
