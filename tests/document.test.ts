import { describe, expect, it } from 'vitest';
import { parseDocument, sortBooks, type Book } from '../src/document';

describe('document import', () => {
  it('preserves literal HTML and fenced text without creating markup', () => {
    const blocks = parseDocument({ id: 'a', name: 'a.md', content: '# 标题\r\n\r\n<script>alert(1)</script>\n\n```js\n# not a heading\n```\n> 引文' });
    expect(blocks).toEqual([
      { kind: 'heading', text: '标题' },
      { kind: 'paragraph', text: '<script>alert(1)</script>' },
      { kind: 'code', text: '# not a heading' },
      { kind: 'quote', text: '引文' },
    ]);
  });
  it('keeps numeric file order independent of opening order', () => {
    const books: Book[] = ['10.txt', '2.txt', '1.txt'].map(name => ({ id: `C:/Books/${name}`, name, content: name }));
    expect(sortBooks(books).map(book => book.name)).toEqual(['1.txt', '2.txt', '10.txt']);
    expect(books[0].name).toBe('10.txt');
  });
});
