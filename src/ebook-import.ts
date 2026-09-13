import type { Book } from './document';

export type ImportedBook = Book & { encoded?: string };

export function decodeImported(book: ImportedBook): Promise<Book> {
  if (!book.encoded) return Promise.resolve(book);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./ebook.worker.ts', import.meta.url), { type: 'module' });
    const finish = () => worker.terminate();
    worker.onmessage = ({ data }) => {
      finish();
      if (data.error) reject(new Error(data.error));
      else resolve({ id: book.id, name: book.name, ...data.book });
    };
    worker.onerror = event => { event.preventDefault(); finish(); reject(new Error('电子书解析失败，请检查文件是否完整、无 DRM')); };
    try {
      const text = atob(book.encoded!);
      const bytes = Uint8Array.from(text, character => character.charCodeAt(0));
      worker.postMessage({ name: book.name, bytes }, [bytes.buffer]);
    } catch (error) { finish(); reject(error); }
  });
}
