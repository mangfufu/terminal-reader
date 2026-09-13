import { Parser } from 'htmlparser2';
import type { Block, Chapter } from './document';

/** Streaming text extraction: no DOM, scripts, styles, images or external requests. */
export function parseMarkup(source: string, fb2 = false) {
  if (fb2 && /<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error('FB2 不支持 DTD 或外部实体');
  const blocks: Block[] = [], chapters: Chapter[] = [], anchors = new Map<string, number>();
  const sources: number[] = [], links: { title: string; filepos: number; source: number }[] = [];
  let pendingSource = 0, link: typeof links[number] | undefined, tocPosition: number | undefined;
  const stack: string[] = [];
  const blockTags = new Set(['p', 'div', 'section', 'article', 'li', 'tr', 'pre', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'title', 'subtitle', 'v', 'epigraph', 'poem', 'empty-line', 'mbp:pagebreak']);
  const ignored = new Set(['script', 'style', 'iframe', 'object', 'svg', 'math', 'binary', 'template', 'noscript']);
  let pending = '', kind: Block['kind'] = 'paragraph', level = 1;
  let title = '', author = '', sawFictionBook = false, bodyCount = 0;
  const inBody = () => !fb2 || stack.includes('body');
  const hidden = () => stack.some(tag => ignored.has(tag)) || (!fb2 && stack.includes('head'));
  const flush = () => {
    const text = (kind === 'code' ? pending : pending.replace(/\s+/g, ' ')).trim(); pending = '';
    if (!text) return;
    if (kind === 'heading') chapters.push({ title: text.slice(0, 4096), block: blocks.length, level });
    sources.push(pendingSource);
    blocks.push({ text, kind });
  };
  const chooseKind = () => {
    const heading = [...stack].reverse().find(tag => /^h[1-6]$/.test(tag) || fb2 && ['title', 'subtitle'].includes(tag));
    kind = heading ? 'heading' : stack.includes('pre') ? 'code' : stack.some(tag => ['blockquote', 'cite', 'epigraph'].includes(tag)) ? 'quote' : 'paragraph';
    level = heading?.match(/^h([1-6])$/) ? Number(heading[1]) : Math.max(1, Math.min(6, stack.filter(tag => tag === 'section').length));
  };
  const parser = new Parser({
    onopentag(raw, attributes) {
      const tag = raw.toLowerCase().replace(/^.*:/, '');
      if (stack.length >= 256) throw new Error('电子书嵌套结构过深');
      if (blockTags.has(tag) && inBody() && !hidden()) flush();
      stack.push(tag);
      if (tag === 'fictionbook') sawFictionBook = true;
      if (tag === 'body') bodyCount++;
      if (tag === 'meta' && attributes.name?.toLowerCase() === 'author') author = (attributes.content ?? '').slice(0, 4096);
      if (tag === 'reference' && attributes.type === 'toc' && /^\d+$/.test(attributes.filepos ?? '')) tocPosition = Number(attributes.filepos);
      if (tag === 'a' && /^\d+$/.test(attributes.filepos ?? '')) link = { title: '', filepos: Number(attributes.filepos), source: parser.startIndex };
      chooseKind();
      if (inBody() && !hidden()) {
        const id = attributes.id || attributes.name;
        if (id) anchors.set(id, blocks.length);
        if (tag === 'br' || tag === 'td' || tag === 'th') pending += kind === 'code' ? '\n' : ' ';
      }
    },
    ontext(text) {
      if (link) link.title = (link.title + text).slice(0, 4096);
      if ((!fb2 && stack.includes('head') && stack.at(-1) === 'title') || fb2 && stack.includes('title-info') && stack.at(-1) === 'book-title') title = (title + text).slice(0, 4096);
      if (fb2 && stack.includes('title-info') && stack.includes('author') && /^(first-name|middle-name|last-name|nickname)$/.test(stack.at(-1) ?? '')) author = (author + text + ' ').slice(0, 4096);
      if (inBody() && !hidden()) { if (!pending.trim() && text.trim()) pendingSource = parser.startIndex; pending += text; }
    },
    onclosetag(raw) {
      const tag = raw.toLowerCase().replace(/^.*:/, '');
      if (tag === 'a' && link) { if (link.title.trim()) links.push({ ...link, title: link.title.trim() }); link = undefined; }
      if (blockTags.has(tag) && inBody() && !hidden()) flush();
      stack.pop(); chooseKind();
    },
  }, { xmlMode: fb2, decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true });
  parser.end(source); flush();
  if (fb2 && (!sawFictionBook || !bodyCount)) throw new Error('不是有效的 FB2 电子书');
  return { blocks, chapters, anchors, sources, links, tocPosition, title: title.trim(), author: author.trim() };
}

export function decodeMarkup(bytes: Uint8Array) {
  const prefix = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  const charset = /(?:charset\s*=\s*["']?\s*|encoding\s*=\s*["'])([\w-]+)/i.exec(prefix)?.[1];
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le', { fatal: true }).decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be', { fatal: true }).decode(bytes);
  try { return new TextDecoder(charset || 'utf-8', { fatal: true }).decode(bytes); }
  catch { if (charset) throw new Error(`无法解码 ${charset} 文本`); return new TextDecoder('gb18030', { fatal: true }).decode(bytes); }
}
