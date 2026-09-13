import type { Book } from './document';
import { decodeMarkup, parseMarkup } from './ebook-markup';
import { parseMobi } from './ebook-mobi';

export async function parseEbook(name: string, bytes: Uint8Array): Promise<Omit<Book, 'id' | 'name'>> {
  const extension = name.split('.').at(-1)?.toLowerCase();
  const format = extension === 'htm' ? 'html' : extension;
  if (!['mobi', 'azw', 'azw3', 'prc', 'fb2', 'html'].includes(format ?? '')) throw new Error('电子书格式不受支持');
  const parsed = format === 'html' || format === 'fb2' ? parseMarkup(decodeMarkup(bytes), format === 'fb2') : await parseMobi(bytes);
  const content = parsed.blocks.map(block => block.text).join('\n\n');
  if (!content.trim()) throw new Error('电子书没有可读取的正文（纯图片书籍暂不支持）');
  return { format: format as Book['format'], content, blocks: parsed.blocks, chapters: parsed.chapters, ...(parsed.title ? { title: parsed.title } : {}), ...(parsed.author ? { author: parsed.author } : {}) };
}
