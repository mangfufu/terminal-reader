import { invoke } from '@tauri-apps/api/core';
import { cycleFocus, cycleRegions, isEditing } from './keyboard';

type Mode = 'books' | 'folder' | 'save' | 'restore';
interface Entry { name: string; path: string; directory: boolean }
interface Listing { path: string; parent: string | null; entries: Entry[]; locations: Entry[]; file: string | null; truncated: boolean }
export interface Selection { paths: string[]; overwrite: boolean }
const titles: Record<Mode, string> = { books: '打开书籍', folder: '添加文件夹', save: '保存备份', restore: '恢复备份' };

/** A modal terminal browser; it never calls an operating-system file dialog. */
export class FilePicker {
  readonly element = document.createElement('section');
  private cancelCurrent?: () => void;
  cancel() { this.cancelCurrent?.(); }
  reset() { this.cancel(); this.lastDirectory = ''; this.element.replaceChildren(); }
  private finish?: (value: Selection | null) => void;
  private lastDirectory = '';
  private keyHandler?: (event: KeyboardEvent) => void;
  get active() { return !this.element.hidden; }
  constructor(private readonly app: HTMLElement) {
    this.element.id = 'file-picker'; this.element.className = 'panel file-picker'; this.element.hidden = true;
    this.element.setAttribute('role', 'dialog'); this.element.setAttribute('aria-modal', 'true');
    app.append(this.element);
  }
  handleKey(event: KeyboardEvent) { this.keyHandler?.(event); }
  choose(mode: Mode): Promise<Selection | null> {
    if (this.active) return Promise.resolve(null);
    const opener = document.activeElement as HTMLElement | null;
    const inert = [...this.app.children].filter(el => el !== this.element && el.id !== 'keyboard-help').map(el => [el as HTMLElement, el.hasAttribute('inert')] as const);
    inert.forEach(([el]) => el.inert = true);
    const root = this.element; root.hidden = false; root.setAttribute('aria-label', titles[mode]);
    root.innerHTML = `<header class="panel-header"><span>${titles[mode]}</span><button type="button" aria-label="取消文件选择">/cancel</button></header>
      <div class="file-picker-body">
        <div class="panel-actions picker-locations" data-keyboard-region="locations"></div>
        <label class="picker-line" data-keyboard-region="path">路径: <input aria-label="文件路径" spellcheck="false" autocomplete="off"></label>
        <label class="picker-line" data-keyboard-region="filter">筛选: <input aria-label="筛选文件" spellcheck="false" autocomplete="off"></label>
        <p class="muted picker-hint">Ctrl+L 路径 · ↑ ↓ 选择 · Enter 进入/打开 · 空格勾选 · Alt+↑ 上级 · Ctrl+Enter 确定 · Esc 取消</p>
        <div class="picker-list" role="listbox" aria-label="文件列表" tabindex="0" data-keyboard-region="list"></div>
        <label class="picker-line picker-name" data-keyboard-region="name">文件名: <input aria-label="备份文件名" value="terminal-reader-backup.json" autocomplete="off"></label>
        <div class="panel-actions picker-actions" data-keyboard-region="actions"></div>
        <p class="picker-status muted" role="status"></p>
        <div class="picker-overwrite" hidden><p>文件已存在，覆盖会替换原备份。</p><button type="button">确认覆盖</button> <button type="button">返回修改</button></div>
      </div>`;
    const field = root.querySelector<HTMLInputElement>('[aria-label="文件路径"]')!;
    const filter = root.querySelector<HTMLInputElement>('[aria-label="筛选文件"]')!;
    const name = root.querySelector<HTMLInputElement>('[aria-label="备份文件名"]')!;
    const list = root.querySelector<HTMLElement>('.picker-list')!;
    const status = root.querySelector<HTMLElement>('.picker-status')!;
    const overwrite = root.querySelector<HTMLElement>('.picker-overwrite')!;
    root.querySelector<HTMLElement>('.picker-name')!.hidden = mode !== 'save';
    list.setAttribute('aria-multiselectable', String(mode === 'books'));
    let listing: Listing | undefined; let matches: Entry[] = []; let index = 0;
    let generation = 0; let loading = false; let confirming = false; let closed = false; let pendingPath = '';
    let interaction = 0; let pathEdits = 0; let filterEdits = 0;
    for (const input of [field, filter, name]) input.onfocus = () => { ++interaction; };
    field.oninput = () => { ++pathEdits; ++interaction; };
    const checked = new Set<string>();
    const complete = (value: Selection | null) => {
      if (closed) return; closed = true;
      ++generation; this.keyHandler = undefined; this.cancelCurrent = undefined; root.hidden = true;
      inert.forEach(([el, previous]) => el.inert = previous);
      if (opener?.isConnected && !opener.closest('[inert]')) opener.focus({ preventScroll: true });
      this.finish?.(value); this.finish = undefined;
    };
    this.cancelCurrent = () => complete(null);
    const action = (label: string, run: () => void) => {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.onclick = run; return button;
    };
    const focusRow = () => (list.querySelector<HTMLElement>('[tabindex="0"]') ?? list).focus();
    const update = (focus = false) => {
      index = Math.max(0, Math.min(index, matches.length - 1));
      [...list.children].forEach((el, i) => {
        const row = el as HTMLButtonElement; const entry = matches[i];
        row.tabIndex = i === index ? 0 : -1; row.dataset.focused = String(i === index);
        row.setAttribute('aria-selected', String(mode === 'books' ? checked.has(entry.path) : i === index));
        row.textContent = `${entry.directory ? '<DIR>' : mode === 'books' ? checked.has(entry.path) ? '[x]  ' : '[ ]  ' : '     '} ${entry.name}`;
      });
      list.tabIndex = matches.length ? -1 : 0;
      status.textContent = loading ? '正在读取目录…' : `${matches.length} 项${checked.size ? ` · 已选 ${checked.size} 个文件` : ''}${listing?.truncated ? ' · 目录过大，仅显示前 20000 项；可输入完整路径' : ''}`;
      if (focus) { focusRow(); (document.activeElement as HTMLElement)?.scrollIntoView({ block: 'nearest' }); }
    };
    const activate = (entry?: Entry) => {
      if (loading || !entry) return;
      if (entry.directory) void navigate(entry.path);
      else if (mode === 'save') { name.value = entry.name; name.focus(); name.select(); }
      else complete({ paths: mode === 'books' && checked.size ? [...checked] : [entry.path], overwrite: false });
    };
    const render = () => {
      matches = (listing?.entries ?? []).filter(e => e.name.toLocaleLowerCase().includes(filter.value.toLocaleLowerCase()));
      list.replaceChildren();
      matches.forEach((entry, i) => {
        const row = action('', () => {
          index = i;
          if (mode === 'books' && !entry.directory) { checked.has(entry.path) ? checked.delete(entry.path) : checked.add(entry.path); update(); }
          else activate(entry);
        });
        row.className = 'picker-entry'; row.setAttribute('role', 'option'); row.title = entry.path;
        row.onfocus = () => { index = i; update(); };
        row.ondblclick = () => activate(entry); list.append(row);
      }); update();
    };
    const navigate = async (path: string) => {
      const token = ++generation; loading = true; status.textContent = '正在读取目录…';
      const startedInteraction = interaction; const startedPathEdits = pathEdits; const startedFilterEdits = filterEdits;
      list.setAttribute('aria-busy', 'true');
      try {
        const result = await invoke<Listing>('browse_directory', { path, mode });
        if (token !== generation) return;
        listing = result; this.lastDirectory = result.path;
        if (pathEdits === startedPathEdits) {
          field.value = result.path;
          if (interaction !== startedInteraction && document.activeElement === field) field.select();
        }
        if (filterEdits === startedFilterEdits) filter.value = '';
        index = 0; loading = false;
        const locations = root.querySelector('.picker-locations')!;
        locations.replaceChildren(action('.. 上级', () => { if (listing?.parent) void navigate(listing.parent); }), ...result.locations.map(e => action(e.name, () => void navigate(e.path))));
        render();
        if (result.file && (mode === 'books' || mode === 'restore')) { complete({ paths: [result.file], overwrite: false }); return; }
        if (result.file && mode === 'save') name.value = result.file.split(/[\\/]/).pop()!;
        if (interaction === startedInteraction) focusRow();
      } catch (error) { if (token === generation) { loading = false; status.textContent = String(error); if (interaction === startedInteraction) { field.focus(); field.select(); } } }
      finally { if (token === generation) list.removeAttribute('aria-busy'); }
    };
    const confirm = async () => {
      if (loading || confirming || !listing || !overwrite.hidden) return;
      if (mode === 'folder') { complete({ paths: [listing.path], overwrite: false }); return; }
      if (mode === 'save') {
        confirming = true;
        try {
          const target = await invoke<{path: string; exists: boolean}>('backup_target', { directory: listing.path, name: name.value });
          if (closed) return;
          if (target.exists) {
            pendingPath = target.path; overwrite.hidden = false;
            root.querySelectorAll<HTMLElement>('.file-picker-body > :not(.picker-overwrite)').forEach(el => el.inert = true);
            overwrite.querySelectorAll('button')[1].focus();
          } else complete({ paths: [target.path], overwrite: false });
        } catch (error) { if (!closed) { status.textContent = String(error); name.focus(); } }
        finally { confirming = false; }
      } else if (checked.size) complete({ paths: [...checked], overwrite: false });
      else activate(matches[index]);
    };
    const dismissOverwrite = () => {
      overwrite.hidden = true;
      root.querySelectorAll<HTMLElement>('.file-picker-body > *').forEach(el => el.inert = false);
      name.focus(); name.select();
    };
    overwrite.querySelectorAll('button')[0].onclick = () => complete({ paths: [pendingPath], overwrite: true });
    overwrite.querySelectorAll('button')[1].onclick = dismissOverwrite;
    root.querySelector<HTMLButtonElement>('header button')!.onclick = () => complete(null);
    root.querySelector('.picker-actions')!.append(action(mode === 'folder' ? '采用当前目录' : mode === 'save' ? '保存' : '打开所选', () => void confirm()), action('清空选择', () => { checked.clear(); update(); }), action('取消', () => complete(null)));
    field.onkeydown = event => { if (!event.isComposing && event.key === 'Enter' && !event.ctrlKey) { event.preventDefault(); void navigate(field.value); } };
    filter.oninput = () => { ++interaction; ++filterEdits; index = 0; render(); };
    this.keyHandler = event => {
      if (event.defaultPrevented || event.isComposing) return;
      const key = event.key; const modified = event.ctrlKey || event.metaKey;
      if (!overwrite.hidden) {
        if (key === 'Escape') { event.preventDefault(); dismissOverwrite(); }
        else if (key === 'Tab' || key === 'F6') { event.preventDefault(); cycleFocus(overwrite, event.shiftKey); }
        return;
      }
      if (key === 'Escape') { event.preventDefault(); complete(null); }
      else if (key === 'Tab') { event.preventDefault(); cycleFocus(root, event.shiftKey); }
      else if (key === 'F6') { event.preventDefault(); cycleRegions(root, event.shiftKey); }
      else if (modified && ['l', 'f'].includes(key.toLowerCase())) { event.preventDefault(); ++interaction; const target = key.toLowerCase() === 'l' ? field : filter; target.focus(); target.select(); }
      else if (modified && key.toLowerCase() === 'n' && mode === 'save') { event.preventDefault(); ++interaction; name.focus(); name.select(); }
      else if ((modified && key === 'Enter') || (event.target === name && key === 'Enter')) { event.preventDefault(); void confirm(); }
      else if ((event.altKey && key === 'ArrowUp') || (!isEditing(event.target) && key === 'Backspace')) { event.preventDefault(); if (listing?.parent) void navigate(listing.parent); }
      else if (event.target === filter && ['ArrowDown', 'Enter'].includes(key)) { event.preventDefault(); focusRow(); }
      else if (list.contains(event.target as Node) && !loading) {
        const targets: Record<string, number> = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: matches.length - 1, PageDown: index + 8, PageUp: index - 8 };
        if (key in targets && !modified && !event.altKey) { event.preventDefault(); index = targets[key]; update(true); }
        else if (modified && key.toLowerCase() === 'a' && mode === 'books') { event.preventDefault(); if (event.shiftKey) checked.clear(); else matches.filter(e => !e.directory).forEach(e => checked.add(e.path)); update(); }
        else if (key === ' ' && mode === 'books' && matches[index] && !matches[index].directory) { event.preventDefault(); const path = matches[index].path; checked.has(path) ? checked.delete(path) : checked.add(path); update(); }
        else if (key === 'Enter') { event.preventDefault(); activate(matches[index]); }
      }
    };
    const promise = new Promise<Selection | null>(resolve => this.finish = resolve);
    field.focus(); void navigate(this.lastDirectory); return promise;
  }
}
