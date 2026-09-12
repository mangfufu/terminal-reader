import type { Book } from './document';
import './library.css';

export interface BookListOptions {
  onSelect?: (book: Book) => void;
  multiSelect?: boolean;
  selectedIds?: Set<string>;
  onSelectionChange?: (ids: Set<string>) => void;
}

export function createBookList(books: Book[], currentId: string | undefined, onOpen: (book: Book) => void, options: BookListOptions = {}): HTMLElement {
  const list = document.createElement('div');
  list.className = 'book-list';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', '书库文件');
  if (options.multiSelect) list.setAttribute('aria-multiselectable', 'true');
  const rows: HTMLButtonElement[] = [];
  let selected = Math.max(0, books.findIndex(book => book.id === currentId));
  let notified = -1;
  let checkedIds = new Set(options.selectedIds);
  let anchor = selected;
  let rangeBase: Set<string> | undefined;

  function renderSelection() {
    rows.forEach((row, rowIndex) => {
      const focused = rowIndex === selected;
      const checked = checkedIds.has(books[rowIndex].id);
      row.tabIndex = focused ? 0 : -1;
      row.dataset.focused = String(focused);
      row.setAttribute('aria-selected', String(options.multiSelect ? checked : focused));
      const checkbox = row.querySelector('.book-checkbox');
      if (checkbox) checkbox.textContent = checked ? '[x]' : '[ ]';
    });
  }

  function select(index: number) {
    selected = Math.max(0, Math.min(rows.length - 1, index));
    renderSelection();
    if (books[selected] && selected !== notified) {
      notified = selected;
      options.onSelect?.(books[selected]);
    }
  }

  function publishSelection() {
    renderSelection();
    options.onSelectionChange?.(new Set(checkedIds));
  }

  function selectRange(index: number) {
    rangeBase ??= new Set(checkedIds);
    checkedIds = new Set(rangeBase);
    for (let offset = Math.min(anchor, index); offset <= Math.max(anchor, index); offset++) {
      checkedIds.add(books[offset].id);
    }
    publishSelection();
  }

  function toggle(index: number) {
    const id = books[index].id;
    if (checkedIds.has(id)) checkedIds.delete(id);
    else checkedIds.add(id);
    anchor = index;
    rangeBase = undefined;
    publishSelection();
  }

  books.forEach(book => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'book-item';
    row.dataset.bookId = book.id;
    const text = document.createElement('span');
    text.className = 'library-book-text';
    if (book.format === 'epub' && (book.title || book.author)) {
      text.textContent = book.title || book.name;
      const details = document.createElement('small');
      details.className = 'muted';
      details.style.display = 'block';
      details.textContent = [book.author, book.title && book.title !== book.name ? book.name : ''].filter(Boolean).join(' · ');
      if (details.textContent) text.append(details);
      row.title = [book.title, book.author, book.id].filter(Boolean).join('\n');
    } else {
      text.textContent = book.name;
      row.title = book.id;
    }
    if (book.category) {
      const category = document.createElement('span');
      category.className = 'book-category';
      category.textContent = book.category;
      text.append(category);
    }
    if (options.multiSelect) {
      const checkbox = document.createElement('span');
      checkbox.className = 'book-checkbox';
      checkbox.setAttribute('aria-hidden', 'true');
      row.append(checkbox);
    }
    const number = document.createElement('span'); number.className = 'book-number muted'; number.setAttribute('aria-hidden', 'true'); number.textContent = `${rows.length + 1}. `;
    row.append(number, text);
    row.setAttribute('role', 'option');
    if (book.id === currentId) row.setAttribute('aria-current', 'true');
    const index = rows.length;
    row.onfocus = () => select(index);
    row.onclick = event => {
      select(index);
      if (!options.multiSelect) onOpen(book);
      else if (event.shiftKey) selectRange(index);
      else toggle(index);
    };
    rows.push(row);
    list.append(row);
  });
  select(selected);

  list.addEventListener('keydown', event => {
    if (event.isComposing || event.altKey || !rows.length) return;
    if (event.ctrlKey || event.metaKey) {
      if (options.multiSelect && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        if (event.shiftKey) checkedIds.clear();
        else books.forEach(book => checkedIds.add(book.id));
        rangeBase = undefined;
        publishSelection();
      }
      return;
    }
    const page = Math.max(1, Math.floor((list.parentElement?.clientHeight ?? 0) / Math.max(rows[selected].offsetHeight, 1)) - 1);
    const targets: Record<string, number> = {
      ArrowDown: selected + 1, ArrowUp: selected - 1,
      Home: 0, End: rows.length - 1,
      PageDown: selected + page, PageUp: selected - page,
    };
    if (event.key in targets) {
      event.preventDefault();
      select(targets[event.key]);
      if (options.multiSelect && event.shiftKey) selectRange(selected);
      else { anchor = selected; rangeBase = undefined; }
      rows[selected].focus({ preventScroll: true });
      rows[selected].scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter') {
      event.preventDefault();
      onOpen(books[selected]);
    } else if (options.multiSelect && event.key === ' ') {
      event.preventDefault();
      toggle(selected);
    }
  });
  return list;
}
