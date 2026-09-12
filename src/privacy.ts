import type { Book } from './document';
export const PRIVATE_CATEGORY = '私密';
export function isPrivateBook(book: Book | undefined) { return book?.category === PRIVATE_CATEGORY; }
