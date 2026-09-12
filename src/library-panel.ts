import type { Book } from './document';
import { PRIVATE_CATEGORY } from './privacy';
import { normalizeCategory, normalizeCategories, MAX_CATEGORY_LENGTH } from './backup';
import { createBookList } from './library';
import { isEditing, keyboardRows } from './keyboard';
import './library-panel.css';

interface LibraryActions {
  getBooks(): Book[];
  getCurrentId(): string | undefined;
  getCategories(): string[];
  isBusy(): boolean;
  openBook(book: Book): void;
  importBooks(folder: boolean): Promise<void>;
  refreshBooks(ids: string[]): Promise<void>;
  removeBooks(ids: string[]): Promise<Book[]>;
  restoreBooks(books: Book[]): Promise<void>;
  saveClassification(changedBooks: Book[], categories: string[]): Promise<void>;
  notify(message: string): void;
  categoryChanged?(category: string): void;
}

function button(label: string, action: () => void) {
  const control = document.createElement('button');
  control.type = 'button'; control.textContent = label; control.onclick = action;
  return control;
}

function group() {
  const element = document.createElement('div'); element.className = 'panel-actions library-controls-row';
  return element;
}

function select(label: string, choices: [string, string][], value: string) {
  const control = document.createElement('select'); control.setAttribute('aria-label', label);
  control.title = `${label} · 点击选择，或用方向键切换`;
  for (const [id, text] of choices) control.add(new Option(text, id));
  control.value = value; return control;
}

/** Keep checked books across filtering; opening a book never changes its reading position. */
export class LibraryPanel {
  private body?: HTMLElement;
  private query = '';
  private scope = 'public';
  private visible: Book[] = [];
  visibleBooks() { return this.visible; }
  reset() { this.visible = []; this.removed = []; this.checked.clear(); this.multiple = false; this.focusedId = undefined; this.query = ''; this.category = ''; }
  private category = '';
  private focusedId?: string;
  private multiple = false;
  private checked = new Set<string>();
  private removed: Book[] = [];
  private working = false;
  private managing = false;
  private renaming?: string;
  private error = '';
  private categoryIndex = 0;

  constructor(private readonly actions: LibraryActions) {}

  mount(body: HTMLElement, category?: string, scope = 'public') {
    if (this.scope !== scope) { this.query = ''; this.category = ''; this.checked.clear(); this.multiple = false; this.removed = []; }
    this.scope = scope;
    if (category !== undefined) this.category = category;
    this.body = body; this.managing = false; this.renaming = undefined; this.error = '';
    this.focusedId = this.actions.getCurrentId() ?? this.focusedId;
    this.render();
  }

  handleKey(event: KeyboardEvent): boolean {
    if (!this.active() || !this.body?.getClientRects().length || event.isComposing) return false;
    const key = event.key.toLowerCase();
    const modified = event.ctrlKey || event.metaKey;
    const editing = isEditing(event.target);
    const activate = (label: string) => {
      const control = [...this.body!.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === label);
      if (!event.repeat && !this.working && control && !control.disabled) control.click();
    };
    const focus = (label: string) => {
      const field = [...this.body!.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select')].find(field => field.getAttribute('aria-label') === label);
      field?.focus(); if (field instanceof HTMLInputElement) field.select();
    };
    let handled = true;
    if (event.key === 'Escape') {
      if (this.working) { handled = false; }
      else if (this.renaming) {
        this.renaming = undefined; this.render(); this.body.querySelector<HTMLElement>('.library-category-row[data-focused="true"] button')?.focus();
      } else if (this.managing) {
        this.managing = false; this.render(); this.focusList();
      } else if (event.target instanceof HTMLInputElement && event.target.type === 'search' && this.query) {
        this.query = ''; this.render(); this.focusList();
      } else if (this.multiple) { activate('完成多选'); }
      else handled = false;
    } else if (modified && key === 'f' && !event.shiftKey && !this.managing) focus('筛选书库');
    else if (modified && key === 'm' && !this.managing) activate(this.multiple ? '完成多选' : '多选');
    else if (modified && key === 'g' && !this.managing) { if (event.shiftKey) activate('管理分类'); else focus('分类筛选'); }
    else if (event.altKey && !modified && key === 'g' && !this.managing) focus('归入分类');
    else if (modified && event.key === 'Enter' && !this.managing && !(event.target instanceof HTMLInputElement)) activate('应用分类');
    else if (modified && key === 'n' && this.managing) focus('分类名称');
    else if (modified && key === 'z' && !editing && !this.managing) activate('撤销移出');
    else if (modified && key === 'a' && !editing && !this.managing) {
      if (!this.multiple && !event.shiftKey) activate('多选');
      if (this.multiple) activate(event.shiftKey ? '清空选择' : '全选当前列表');
    }
    else if (!modified && !event.altKey && !editing && (event.key === 'F2' || event.key === 'Delete')) {
      const row = (event.target as HTMLElement).closest('.library-category-row');
      if (this.managing && row) {
        if (!event.repeat && !this.working) row.querySelector<HTMLButtonElement>(event.key === 'F2' ? 'button[aria-label^="重命名 "]' : 'button[aria-label^="删除分类 "]')?.click();
      } else if (!this.managing && event.key === 'Delete' && (event.target as HTMLElement).closest('.book-item')) activate(this.multiple ? '删除所选' : '移出书库');
      else handled = false;
    } else handled = false;
    if (handled) event.preventDefault();
    return handled;
  }

  private active() {
    return this.body?.classList.contains('library-panel-body');
  }

  private focusList() {
    if (this.body?.getClientRects().length) {
      (this.body.querySelector<HTMLElement>('[data-focused="true"]')
        ?? [...this.body.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '撤销移出')
        ?? this.body.querySelector<HTMLElement>('button, input, select'))?.focus();
    }
  }

  private async run(action: () => Promise<void>, focus = true) {
    if (this.working || this.actions.isBusy()) return;
    const inputs = [...this.body!.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select')].map(field => ({ label: field.getAttribute('aria-label'), value: field.value }));
    const active = document.activeElement as HTMLElement | null;
    const activeLabel = active?.getAttribute('aria-label');
    const activeText = active?.tagName === 'BUTTON' ? active.textContent : undefined;
    let failed = false;
    this.error = '';
    this.working = true;
    this.body?.setAttribute('aria-busy', 'true');
    this.body?.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button, input, select')
      .forEach(control => { control.disabled = true; });
    try { await action(); }
    catch (error) {
      failed = true; this.error = String(error).replace(/^Error: /, '').replace('备份无效：', '');
      this.actions.notify(this.error);
    }
    finally {
      this.working = false;
      this.body?.removeAttribute('aria-busy');
      if (this.active()) {
        this.render();
        if (failed) for (const entry of inputs) {
          const field = [...this.body!.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select')].find(field => field.getAttribute('aria-label') === entry.label);
          if (field) field.value = entry.value;
        }
        if (this.body?.getClientRects().length) {
          if (focus && !failed) this.focusList();
          else {
            const controls = [...this.body.querySelectorAll<HTMLElement>('button, input, select')];
            const previous = controls.find(control => activeLabel ? control.getAttribute('aria-label') === activeLabel : activeText && control.tagName === 'BUTTON' && control.textContent === activeText);
            (previous ?? this.body.querySelector<HTMLElement>('.library-category-row[data-focused="true"] button[tabindex="0"]') ?? this.body.querySelector<HTMLElement>('input') ?? controls[0])?.focus();
          }
        }
      }
    }
  }

  private render() {
    const body = this.body!;
    body.className = 'library-panel-body'; body.replaceChildren();
    const books = this.actions.getBooks();
    const ids = new Set(books.map(book => book.id));
    this.checked = new Set([...this.checked].filter(id => ids.has(id)));
    const categories = this.actions.getCategories().filter(name => name !== PRIVATE_CATEGORY);
    if (this.category.startsWith('cat:') && !categories.includes(this.category.slice(4))) this.category = '';
    const title = body.closest('.panel')?.querySelector('#panel-title');
    if (title) title.textContent = this.managing ? '管理分类' : `书库 / ${books.length}`;
    if (this.error) {
      const error = document.createElement('p'); error.className = 'library-error'; error.setAttribute('role', 'alert'); error.textContent = this.error; body.append(error);
    }
    if (this.managing) { this.renderCategories(body, categories); return; }

    const controls = document.createElement('div'); controls.className = 'library-controls';
    const files = group();
    files.dataset.keyboardRegion = 'files';
    const refresh = button('刷新选中', () => void this.run(() => this.actions.refreshBooks(this.targets())));
    const remove = button(this.multiple ? '删除所选' : '移出书库', () => {
      const ids = this.targets();
      if (!ids.length) return;
      void this.run(async () => {
        const index = this.actions.getBooks().findIndex(book => book.id === this.focusedId);
        const removed = await this.actions.removeBooks(ids);
        if (!removed.length) return;
        this.removed = removed;
        removed.forEach(book => this.checked.delete(book.id));
        if (removed.some(book => book.id === this.focusedId)) {
          const remaining = this.actions.getBooks(); this.focusedId = remaining[Math.max(0, Math.min(index, remaining.length - 1))]?.id;
        }
        this.actions.notify(`已移出 ${removed.length} 本书，可撤销。源文件保留。`);
      });
    });
    files.append(button('+ 文件', () => void this.actions.importBooks(false)), button('+ 文件夹', () => void this.actions.importBooks(true)), refresh);
    if (!this.multiple) files.append(remove);
    files.append(button('刷新全部', () => void this.run(() => this.actions.refreshBooks(books.map(book => book.id)))));
    const undo = this.removed.length ? button('撤销移出', () => void this.run(async () => {
      await this.actions.restoreBooks(this.removed); this.removed = [];
      this.actions.notify('已撤销移出。');
    })) : undefined;
    if (undo && !this.multiple) files.append(undo);
    const filters = group();
    filters.dataset.keyboardRegion = 'filter';
    const categoryCounts = new Map<string, number>();
    books.forEach(book => categoryCounts.set(book.category ?? '', (categoryCounts.get(book.category ?? '') ?? 0) + 1));
    const category = select('分类筛选', [
      ['', `全部分类 (${books.length})`], ['@uncategorized', `未分类 (${categoryCounts.get('') ?? 0})`],
      ...categories.map(name => [`cat:${name}`, `${name} (${categoryCounts.get(name) ?? 0})`] as [string, string]),
    ], this.category);
    category.className = 'library-category-filter';
    const manage = button('管理分类', () => { this.managing = true; this.render(); body.querySelector('input')?.focus(); });
    const multi = button(this.multiple ? '完成多选' : '多选', () => {
      this.multiple = !this.multiple;
      if (!this.multiple) this.checked.clear();
      this.render(); this.focusList();
    });
    multi.setAttribute('aria-pressed', String(this.multiple));
    const categoryLabel = document.createElement('span'); categoryLabel.className = 'muted'; categoryLabel.textContent = '分类:';
    filters.append(categoryLabel, category, manage, multi);
    const search = document.createElement('input'); search.type = 'search'; search.className = 'panel-input';
    search.setAttribute('aria-label', '筛选书库'); search.placeholder = '筛选书名、作者或路径'; search.value = this.query;
    const searchLine = document.createElement('label'); searchLine.className = 'library-search-line';
    searchLine.dataset.keyboardRegion = 'search';
    const searchLabel = document.createElement('span'); searchLabel.className = 'muted'; searchLabel.textContent = '查找:';
    searchLine.append(searchLabel, search);
    const assignment = group();
    assignment.dataset.keyboardRegion = 'assignment';
    const destination = select('归入分类', [['', '未分类'], ...categories.map(name => [name, name] as [string, string])], '');
    const apply = button('应用分类', () => {
      const ids = new Set(this.targets());
      const name = destination.value;
      const changed = this.actions.getBooks().filter(book => ids.has(book.id)).map(book => {
        const next = { ...book }; if (name) next.category = name; else delete next.category; return next;
      });
      if (!changed.length) return;
      void this.run(async () => {
        await this.actions.saveClassification(changed, this.actions.getCategories());
        this.actions.notify(`已将 ${changed.length} 本书归入「${name || '未分类'}」。`);
      });
    });
    const assignmentLabel = document.createElement('span'); assignmentLabel.textContent = this.multiple ? '将所选归入' : '将当前行归入';
    assignment.append(assignmentLabel, destination, apply);
    const selection = group();
    selection.dataset.keyboardRegion = 'selection';
    const count = document.createElement('span'); count.className = 'library-selection-count'; count.setAttribute('role', 'status');
    const results = document.createElement('div'); results.className = 'library-results';
    results.dataset.keyboardRegion = 'books';
    let matches: Book[] = [];
    const updateControls = () => {
      const targets = this.targets();
      remove.disabled = refresh.disabled = apply.disabled = destination.disabled = !targets.length;
      if (!this.multiple) destination.value = this.actions.getBooks().find(book => book.id === this.focusedId)?.category ?? '';
      const visible = new Set(matches.map(book => book.id));
      const hidden = [...this.checked].filter(id => !visible.has(id)).length;
      count.textContent = `已选 ${this.checked.size} 本${hidden ? `（含列表外 ${hidden} 本）` : ''}`;
    };
    const renderList = () => {
      const restoreFocus = results.contains(document.activeElement);
      const query = this.query.trim().toLocaleLowerCase();
      matches = this.actions.getBooks().filter(book =>
        (!this.category || (this.category === '@uncategorized' ? !book.category : book.category === this.category.slice(4)))
        && `${book.name} ${book.title ?? ''} ${book.author ?? ''} ${book.id}`.toLocaleLowerCase().includes(query));
      this.visible = matches;
      if (!matches.some(book => book.id === this.focusedId)) this.focusedId = matches[0]?.id;
      results.replaceChildren(createBookList(matches, this.focusedId, book => this.actions.openBook(book), {
        multiSelect: this.multiple, selectedIds: this.checked,
        onSelect: book => { this.focusedId = book.id; updateControls(); },
        onSelectionChange: ids => { this.checked = ids; updateControls(); },
      }));
      if (!matches.length) {
        const empty = document.createElement('p'); empty.className = 'muted';
        empty.textContent = books.length ? '没有匹配的书籍。' : '还没有文件。打开 TXT、Markdown 或 EPUB 开始阅读。';
        results.append(empty);
      }
      updateControls();
      if (restoreFocus) this.focusList();
    };
    category.onchange = () => { this.category = category.value; this.actions.categoryChanged?.(this.category); renderList(); };
    search.oninput = () => { this.query = search.value; renderList(); };
    search.onkeydown = event => {
      if (event.isComposing) return;
      if (event.key === 'ArrowDown' || event.key === 'Enter') { event.preventDefault(); this.focusList(); }
    };
    if (this.multiple) {
      selection.append(count, button('全选当前列表', () => { matches.forEach(book => this.checked.add(book.id)); renderList(); }),
        button('清空选择', () => { this.checked.clear(); renderList(); }), remove);
      if (undo) selection.append(undo);
    }
    const hint = document.createElement('p'); hint.className = 'library-hint';
    hint.textContent = this.multiple
      ? '空格勾选 · Shift 连选 · Delete 移出 · Ctrl+Z 撤销 · F1 快捷键'
      : '↑ ↓ 选择 · Enter 打开 · Ctrl+M 多选 · Ctrl+F 筛选 · F1 快捷键';
    if (!this.multiple) controls.append(files);
    controls.append(filters, searchLine);
    if (this.multiple) controls.append(selection);
    controls.append(assignment, hint); body.append(controls, results); renderList();
  }

  selectedIds() { return this.targets(); }

  private targets() {
    return this.multiple ? [...this.checked] : this.focusedId ? [this.focusedId] : [];
  }

  private renderCategories(body: HTMLElement, categories: string[]) {
    const management = document.createElement('div'); management.className = 'library-category-management';
    const actions = group();
    actions.dataset.keyboardRegion = 'back';
    actions.append(button('返回书库', () => { this.managing = false; this.renaming = undefined; this.render(); this.focusList(); }));
    const form = document.createElement('form'); form.className = 'panel-actions library-controls-row';
    form.dataset.keyboardRegion = 'create';
    const field = document.createElement('input'); field.type = 'text'; field.maxLength = MAX_CATEGORY_LENGTH;
    field.placeholder = '例如：小说、技术、待阅读'; field.setAttribute('aria-label', '分类名称');
    const create = button('新建分类', () => {}); create.type = 'submit';
    form.append(field, create);
    form.onsubmit = event => {
      event.preventDefault();
      void this.run(async () => {
        const name = normalizeCategory(field.value);
        if (name === PRIVATE_CATEGORY || categories.includes(name)) throw new Error('该分类已存在。');
        await this.actions.saveClassification([], normalizeCategories([...categories, name]));
        this.actions.notify(`已新建分类「${name}」。`);
      }, false).then(() => this.active() && this.body?.querySelector<HTMLInputElement>('[aria-label="分类名称"]')?.focus());
    };
    const note = document.createElement('p'); note.className = 'muted library-hint';
    note.textContent = '每本书归入一个分类。删除分类后，书籍会变为未分类。';
    const list = document.createElement('div'); list.className = 'library-category-list';
    list.dataset.keyboardRegion = 'categories';
    for (const name of categories) {
      const row = group(); row.classList.add('library-category-row');
      const index = categories.indexOf(name);
      row.addEventListener('focusin', () => { this.categoryIndex = index; });
      const count = this.actions.getBooks().filter(book => book.category === name).length;
      const label = document.createElement('span'); label.className = 'library-category-name'; label.textContent = `${name} (${count})`;
      if (this.renaming === name) {
        const rename = document.createElement('input'); rename.type = 'text'; rename.value = name; rename.maxLength = MAX_CATEGORY_LENGTH;
        rename.setAttribute('aria-label', '新的分类名称');
        const save = () => void this.run(async () => {
          const nextName = normalizeCategory(rename.value);
          if (nextName === PRIVATE_CATEGORY || (nextName !== name && categories.includes(nextName))) throw new Error('该分类已存在。');
          const changed = this.actions.getBooks().filter(book => book.category === name).map(book => ({ ...book, category: nextName }));
          await this.actions.saveClassification(changed, normalizeCategories(categories.map(category => category === name ? nextName : category)));
          if (this.category === `cat:${name}`) this.category = `cat:${nextName}`;
          this.renaming = undefined; this.actions.notify('分类名称已保存。');
        }, false);
        rename.onkeydown = event => { if (!event.isComposing && event.key === 'Enter') { event.preventDefault(); save(); } };
        row.append(rename, button('保存名称', save), button('取消', () => { this.renaming = undefined; this.render(); this.body?.querySelector<HTMLElement>('.library-category-row[data-focused="true"] button')?.focus(); }));
      } else {
        const rename = button('重命名', () => { this.renaming = name; this.render(); this.body?.querySelector<HTMLInputElement>('[aria-label="新的分类名称"]')?.select(); });
        rename.setAttribute('aria-label', `重命名 ${name}`);
        const remove = button('删除分类', () => void this.run(async () => {
          const changed = this.actions.getBooks().filter(book => book.category === name).map(book => { const next = { ...book }; delete next.category; return next; });
          await this.actions.saveClassification(changed, categories.filter(category => category !== name));
          if (this.category === `cat:${name}`) this.category = '@uncategorized';
          this.actions.notify(`已删除分类「${name}」，${changed.length} 本书移至未分类。`);
        }, false));
        remove.setAttribute('aria-label', `删除分类 ${name}`); row.append(label, rename, remove);
      }
      list.append(row);
    }
    if (!categories.length) { const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = '还没有自定义分类。'; list.append(empty); }
    keyboardRows(list, this.categoryIndex);
    management.append(actions, form, note, list); body.append(management);
  }
}
