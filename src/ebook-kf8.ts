import type { Kf8, Kf8Chapter } from '@lingo-reader/mobi-parser';

/** Narrow adapter for pinned mobi-parser 0.4.6: reconstruct text without its
 * resource renderer, which assumes every <link> is a Kindle stylesheet.
 * This also avoids allocating images, fonts and CSS that a text reader never uses.
 */
export function kf8ChapterText(book: Kf8, chapter: Kf8Chapter): string {
  const parser = book as unknown as { loadText?: (chapter: Kf8Chapter) => string };
  if (typeof parser.loadText !== 'function') throw new Error('KF8 解析器版本不兼容');
  return parser.loadText(chapter);
}
