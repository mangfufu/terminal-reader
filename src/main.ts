import { invoke, isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { FilePicker } from './file-picker';
import { BossScreen } from './boss-screen';
import { PRIVATE_CATEGORY, isPrivateBook } from './privacy';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { demo, parseDocument, chaptersFor, sortBooks, type Book, type Position, type Block } from './document';
import { loadBooks as loadPublicBooks, saveBooks as savePublicBooks, deleteBooks as deletePublicBooks } from './storage';
import { Vault } from './vault';
import { Credentials } from './credentials';
import { deriveKey, encryptedData, seal, unseal } from './encryption';
import { parseCommand, commandAliases, quickStart } from './terminal-command';
import { ReadingProgress } from './progress';
import { createBookList } from './library';
import { LibraryPanel } from './library-panel';
import { appendKeyboardGuide, cycleFocus, cycleRegions, isEditing, keyboardRows } from './keyboard';
import { ReaderView } from './reader';
import { normalizeSettings, applyAppearance, appendAppearanceControls } from './settings';
import { searchBlocks, validPosition, keyboardList, type SearchMatch } from './navigation';
import { createBackup, parseBackup, normalizeCategory, normalizeCategories, type Bookmark, type BackupData } from './backup';
import { TerminalSimulation, paragraphRole, type ReadingMode, type ColorLevel, type EffectFrequency, type SimulationFrame } from './simulation';
import { profiles, profileFor, isTheme, renderPrompt, fileArgument, shellIcons, type Theme } from './appearance';
import './style.css';
import './terminal-panels.css';

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <header class="titlebar">
    <div class="tab" data-tauri-drag-region>
      <span id="shell-icon" class="shell-icon" data-tauri-drag-region></span>
      <span id="window-title" data-tauri-drag-region>Windows PowerShell</span>
      <button id="tab-close" class="tab-close" aria-label="关闭标签页" title="关闭标签页"><svg viewBox="0 0 12 12"><path d="m2 2 8 8m0-8-8 8"/></svg></button>
    </div>
    <button id="new-file" class="toolbar-button" title="打开文件" aria-label="打开文件"><svg viewBox="0 0 16 16"><path d="M8 2v12M2 8h12"/></svg></button>
    <button id="menu" class="toolbar-button" title="终端外观与菜单" aria-label="终端外观与菜单" aria-haspopup="menu" aria-expanded="false"><svg class="chevron" viewBox="0 0 16 16"><path d="m4 6 4 4 4-4"/></svg><svg class="hamburger" viewBox="0 0 16 16"><path d="M2 4h12M2 8h12M2 12h12"/></svg></button>
    <div class="drag-space" data-tauri-drag-region></div>
    <button id="minimize" class="window-button" aria-label="最小化"><svg viewBox="0 0 12 12"><path d="M1 6h10"/></svg></button>
    <button id="maximize" class="window-button" aria-label="最大化或还原"><svg viewBox="0 0 12 12"><rect x="1.5" y="1.5" width="9" height="9"/></svg></button>
    <button id="close" class="window-button close" aria-label="关闭窗口"><svg viewBox="0 0 12 12"><path d="m1.5 1.5 9 9m0-9-9 9"/></svg></button>
  </header>
  <div class="terminal-surface">
  <main id="reader" tabindex="0" aria-label="阅读正文">
    <div id="welcome">
      <div id="shell-banner">Windows PowerShell</div>
      <div class="reader-banner">Terminal Reader [Version 0.6.0]</div>
      <p class="muted">输入 help 快速上手 · open 导入 · ls 查看 · resume 继续</p><p class="welcome-actions"><button id="open-book" aria-label="打开文件">/open</button> 打开文件，<button id="demo-book" aria-label="读一段示例">/demo</button> 试读。</p>
    </div>
    <div id="session-command" class="session-command" hidden><span id="session-prompt"></span> <span class="shell-command">/open</span> <span id="session-file" class="shell-argument"></span></div>
    <article id="content" hidden></article>
  </main>
  <div id="notice" role="status" hidden></div>
  <footer class="command-line">
    <label for="command-input" id="prompt" title="输入 / 查看命令">PS C:\\Books&gt;</label>
    <div class="input-wrap"><input id="command-input" aria-label="命令" placeholder=" " autocomplete="off" spellcheck="false" role="combobox" aria-controls="suggestions" aria-expanded="false" /><span class="idle-cursor" aria-hidden="true"></span></div>
    <button id="reading-progress" type="button" hidden></button><span id="reading-status" class="visually-hidden" role="status"></span>
    <div id="terminal-effect" aria-hidden="true" hidden></div>
  </footer>
  </div>
  <nav id="profile-menu" role="menu" aria-label="终端外观与菜单" hidden></nav>
  <section id="panel" class="panel" role="dialog" aria-modal="true" hidden>
    <header class="panel-header"><span id="panel-title"></span><button id="panel-close" aria-label="关闭面板">×</button></header>
    <div id="panel-body"></div>
  </section>
  <section id="keyboard-help" class="panel keyboard-help" role="dialog" aria-modal="true" aria-label="键盘速查" hidden>
    <header class="panel-header"><span>键盘速查 / F1 或 Esc 返回</span><button id="keyboard-help-close" aria-label="关闭键盘速查">×</button></header>
    <div id="keyboard-help-body" tabindex="0" aria-label="快捷键说明"></div>
  </section>
  <div id="suggestions" role="listbox" aria-label="可选命令" hidden></div>
  `;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const reader = $<HTMLElement>('reader');
const content = $('content');
const input = $<HTMLInputElement>('command-input');
const suggestions = $('suggestions');
const panel = $('panel');
const panelBody = $('panel-body');
const keyboardHelp = $('keyboard-help');
const filePicker = new FilePicker(app);
const credentials = new Credentials(app);
const vault = new Vault();
appendKeyboardGuide($('keyboard-help-body'));
let helpReturnFocus: HTMLElement | null = null;
let helpInert: [HTMLElement, boolean][] = [];
function toggleKeyboardHelp() {
  if (!keyboardHelp.hidden) {
    keyboardHelp.hidden = true;
    helpInert.forEach(([element, wasInert]) => element.toggleAttribute('inert', wasInert));
    reader.toggleAttribute('inert', !panel.hidden || filePicker.active);
    if (helpReturnFocus?.isConnected && helpReturnFocus.tabIndex >= 0 && helpReturnFocus.getClientRects().length && !helpReturnFocus.closest('[inert]')) helpReturnFocus.focus();
    else if (!panel.hidden) focusPanel(); else reader.focus();
    return;
  }
  helpReturnFocus = document.activeElement as HTMLElement;
  helpInert = [filePicker.element, reader, panel, $('profile-menu'), input.closest('footer')!, app.querySelector<HTMLElement>('.titlebar')!].map(element => [element, element.hasAttribute('inert')]);
  helpInert.forEach(([element]) => element.setAttribute('inert', ''));
  keyboardHelp.hidden = false; simulation.pauseForInteraction();
  $('keyboard-help-body').focus();
}
$('keyboard-help-close').onclick = toggleKeyboardHelp;
function focusCommand() {
  closePanel(); closeProfileMenu();
  input.value = '/'; selected = 0; historyIndex = -1; input.focus(); renderSuggestions();
}
const commands = [
  ['open', '打开 TXT / Markdown / EPUB'], ['folder', '添加文件夹'], ['books', '查看书库'],
  ['ls', '列出书籍'], ['dir', '列出书籍'], ['cd', '切换分类'], ['cat', '打开书名或编号'], ['type', '打开书名或编号'], ['pwd', '当前分类'],
  ['read', '打开书名或编号'], ['recent', '最近阅读'], ['resume', '继续上次阅读'], ['progress', '章节进度与剩余页数'], ['goto', '按百分比跳转'], ['history', '命令历史'], ['clear', '清屏'], ['guide', '快速上手'], ['boss', '老板键 / 随机程序输出'], ['find', '搜索正文'], ['chapter', '章节目录'], ['mark', '添加与管理书签'], ['back', '返回跳转前的位置'],
  ['refresh', '刷新当前书籍源文件'], ['backup', '导出完整备份'], ['restore', '恢复备份'],
  ['close', '关闭当前书籍 / 返回主页'], ['next', '下一份文件'], ['prev', '上一份文件'], ['scroll', '开始 / 暂停自动滚动'],
  ['speed', '调节滚动速度'], ['style', '外观与字体'], ['mode', '纯阅读 / 模拟命令行'], ['help', '命令与快捷键'], ['demo', '阅读示例'],
] as const;

let privateActive = false;
let lockingVault = false;
let pendingVaultLock = false;
let terminalCategory = '';
let recentReads: Record<string, { at: number; percent: number }> = {};
let progressModel = new ReadingProgress([], []);
let publicSession: { books: Book[]; categories: string[]; positions: Record<string, Position>; bookmarks: Bookmark[]; commandHistory: string[]; recentReads: typeof recentReads; lastBook: string; terminalCategory: string } | undefined;
let legacyBooks: Book[] = [];
let legacyPositions: Record<string, Position> = {};
let legacyMarks: Bookmark[] = [];
function preferenceStore() { return privateActive ? vault : localStorage; }
async function saveBooks(value: Book[]) { if (privateActive) await vault.saveBooks(value); else await savePublicBooks(value); }
async function deleteBooks(ids: string[]) { if (privateActive) await vault.deleteBooks(ids); else await deletePublicBooks(ids); }

let books: Book[] = [];
let categories: string[] = [];
let current: Book | undefined;
let documentBlocks: Block[] = [];
let position: Position = { block: 0, fraction: 0 };
let settings = normalizeSettings({});
let positions: Record<string, Position> = Object.create(null);
let bookmarks: Bookmark[] = [];
let commandHistory: string[] = [];
let historyIndex = -1;
let historyDraft = '';
let lastBook = '';
function storedValue(key: string, fallback: unknown): unknown {
  try { const value = preferenceStore().getItem(key); return value === null ? fallback : JSON.parse(value); } catch { return fallback; }
}
try {
  settings = normalizeSettings(storedValue('reader-settings', {}));
  const storedPositions = storedValue('reader-positions', {});
  if (storedPositions && typeof storedPositions === 'object') for (const [id, p] of Object.entries(storedPositions)) if (validPosition(p)) positions[id] = p;
  const storedMarks = storedValue('reader-bookmarks', []);
  if (Array.isArray(storedMarks)) bookmarks = storedMarks.filter(m => m && typeof m.id === 'string' && typeof m.bookId === 'string' && typeof m.label === 'string' && Number.isFinite(m.createdAt) && validPosition(m.position));
  const history = storedValue('reader-command-history', []);
  if (Array.isArray(history)) commandHistory = history.filter(c => typeof c === 'string' && !/^\/?(?:vault|private)\b/i.test(c)).slice(-100);
  recentReads = normalizeRecent(storedValue('reader-recent', {}));
  lastBook = preferenceStore().getItem('reader-last-book') ?? '';
} catch { /* Invalid preferences do not prevent launch. */ }
try { categories = normalizeCategories(storedValue('reader-categories', [])); }
catch { /* Recover category names from healthy cached books during initialization. */ }

const boss = new BossScreen(app, () => settings.bossKey, () => { simulation.pauseForInteraction(); if (boss.active) { credentials.cancel(); if (privateActive) void lockVault(); } else void handleNativePaths([]); }, () => !lockingVault && !pendingVaultLock);
let syncedBossKey = '';
let syncingBoss = false;
let nativeBossReady = false;

let automatic = false;
let scrollPosition = 0;
let previousFrame = 0;
let frameId = 0;
let saveTimer = 0;
let noticeTimer = 0;
let importing = false;
let restoring = false;
let selected = 0;
let closing = false;
let nativePathQueue: string[] = [];
let panelCleanup: (() => void) | undefined;
let pendingBackup: BackupData | undefined;
const jumpHistory: { bookId: string; position: Position }[] = [];
let searchSession: { bookId: string; origin: Position; query: string; matches: SearchMatch[]; index: number } | undefined;
const view = new ReaderView(reader, content, (element, index) => {
  if (current) element.dataset.ansiRole = paragraphRole(current.id, index, settings.colorSeed, settings.colorLevel, documentBlocks[index]?.kind ?? 'paragraph');
});

const simulation = new TerminalSimulation(
  () => !!current && !importing && panel.hidden && keyboardHelp.hidden && !filePicker.active && !boss.active && $('profile-menu').hidden && suggestions.hidden
    && document.activeElement !== input && !document.getSelection()?.toString() && !document.hidden && document.hasFocus(),
  renderSimulation,
);

function renderSimulation(frame: SimulationFrame | null) {
  const effect = $('terminal-effect');
  effect.hidden = !frame;
  effect.parentElement!.classList.toggle('has-effect', !!frame);
  if (!frame) return;
  effect.replaceChildren();
  if (frame.kind === 'command') {
    const prompt = document.createElement('span');
    prompt.className = 'effect-full';
    renderPrompt(prompt, settings.theme);
    const compactPrompt = document.createElement('span'); compactPrompt.className = 'effect-compact';
    compactPrompt.textContent = settings.theme === 'linux' ? '$' : settings.theme === 'cmd' ? 'C:\\>' : 'PS>';
    effect.append(prompt, compactPrompt, ' ');
  }
  for (const token of frame.tokens) {
    const span = document.createElement('span');
    span.dataset.ansiRole = token.role;
    if (token.compact) {
      const full = document.createElement('span'); full.className = 'effect-full'; full.textContent = token.text;
      const compact = document.createElement('span'); compact.className = 'effect-compact'; compact.textContent = token.compact;
      span.append(full, compact);
    } else span.textContent = token.text;
    effect.append(span);
  }
  effect.title = frame.tokens.map(token => token.text).join('');
}

function applyReadingMode() {
  app.dataset.mode = settings.mode;
  app.dataset.colorLevel = settings.colorLevel;
  view.refreshColors();
  simulation.configure({ enabled: settings.mode === 'simulate' && !!current, theme: settings.theme, frequency: settings.effectFrequency });
}

function setReadingMode(mode: ReadingMode, preview = false) {
  settings.mode = mode;
  applyReadingMode();
  savePreferences();
  if (preview && current) simulation.preview();
}

function notify(message: string, duration = 4500) {
  clearTimeout(noticeTimer);
  $('notice').textContent = message;
  $('notice').hidden = false;
  noticeTimer = window.setTimeout(() => $('notice').hidden = true, duration);
}

function savePreferences() {
  try {
    localStorage.setItem('reader-settings', JSON.stringify(settings));
    preferenceStore().setItem('reader-positions', JSON.stringify(privateActive ? positions : { ...legacyPositions, ...positions }));
    preferenceStore().setItem('reader-bookmarks', JSON.stringify(privateActive ? bookmarks : [...legacyMarks, ...bookmarks]));
    preferenceStore().setItem('reader-command-history', JSON.stringify(commandHistory));
    preferenceStore().setItem('reader-last-book', current?.id ?? '');
    if (current) recentReads[current.id] = { at: Date.now(), percent: reader.scrollTop >= reader.scrollHeight - reader.clientHeight - 1 ? 100 : progressModel.at(position).percent };
    preferenceStore().setItem('reader-recent', JSON.stringify(recentReads));
    if (privateActive && vault.unlocked) void vault.flush().catch(error => notify(`保存失败：${String(error)}`));
  } catch { notify('本地存储空间不足，阅读位置暂时无法保存。'); }
}

function normalizeRecent(value: unknown): Record<string, { at: number; percent: number }> {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(Object.entries(value).filter(([id, item]) => id !== '__proto__' && id !== 'constructor' && item && Number.isFinite(item.at) && item.at >= 0 && Number.isFinite(item.percent) && item.percent >= 0 && item.percent <= 100).slice(-10000));
}
function extractLegacyBooks() {
  const legacy = books.filter(isPrivateBook);
  legacyBooks = [...new Map([...legacyBooks, ...legacy].map(book => [book.id, book])).values()];
  const ids = new Set(legacyBooks.map(book => book.id));
  legacyPositions = { ...legacyPositions, ...Object.fromEntries(Object.entries(positions).filter(([id]) => ids.has(id))) };
  legacyMarks = [...new Map([...legacyMarks, ...bookmarks.filter(mark => ids.has(mark.bookId))].map(mark => [mark.id, mark])).values()];
  books = books.filter(book => !ids.has(book.id)); categories = categories.filter(category => category !== PRIVATE_CATEGORY);
  positions = Object.fromEntries(Object.entries(positions).filter(([id]) => !ids.has(id))); bookmarks = bookmarks.filter(mark => !ids.has(mark.bookId));
  recentReads = Object.fromEntries(Object.entries(recentReads).filter(([id]) => !ids.has(id)));
  commandHistory = commandHistory.filter(command => !/^\/?(?:private|vault)\b/i.test(command) && !legacyBooks.some(book => command.includes(book.id) || command.includes(book.name)));
}
async function enterVault(argument = '') {
  if (privateActive) { await lockVault(); return; }
  if (importing || lockingVault || credentials.active) return;
  if (argument && !argument.startsWith('move')) { notify('使用 vault 进入，或 vault move 移入当前所选书籍。密码仅在验证窗口输入。'); return; }
  const move = argument.startsWith('move');
  const named = argument.slice(4).trim().replace(/^(["'])([\s\S]*)\1$/, '$2');
  const moving = move ? (named ? [namedBook(named)].filter((book): book is Book => !!book) : books.filter(book => libraryPanel.selectedIds().includes(book.id))) : [];
  if (move && !moving.length) { notify('先在书库选择书籍，或使用 vault move "书名"。'); return; }
  setAutomatic(false); rememberPosition(); clearTimeout(saveTimer); savePreferences();
  const initialBooks = legacyBooks.map(book => { const copy = { ...book }; delete copy.category; return copy; });
  const initial = { version: 1 as const, books: initialBooks, preferences: {
    'reader-positions': JSON.stringify(legacyPositions), 'reader-bookmarks': JSON.stringify(legacyMarks), 'reader-categories': '[]', 'reader-command-history': '[]', 'reader-recent': '{}',
  } };
  const creating = !await vault.exists();
  const verified = await credentials.ask(creating ? '首次进入 / 设置密码' : '验证密码', creating, async password => { await vault.unlock(password, initial); return true; });
  if (!verified) return;
  importing = true;
  try {
    // Existing vaults may also receive legacy books restored from an older archive.
    if (legacyBooks.length) {
      const priorPositions = JSON.parse(vault.getItem('reader-positions') ?? '{}');
      const priorMarks = JSON.parse(vault.getItem('reader-bookmarks') ?? '[]') as Bookmark[];
      vault.setItem('reader-positions', JSON.stringify({ ...legacyPositions, ...priorPositions }));
      vault.setItem('reader-bookmarks', JSON.stringify([...new Map([...legacyMarks, ...priorMarks].map(mark => [mark.id, mark])).values()]));
      await vault.saveBooks(initialBooks, legacyBooks.map(book => book.id));
      legacyBooks = []; legacyPositions = {}; legacyMarks = []; savePreferences();
    }
    if (moving.length) {
      const nextCategories = normalizeCategories([...JSON.parse(vault.getItem('reader-categories') ?? '[]'), ...moving.flatMap(book => book.category ? [book.category] : [])]);
      vault.setItem('reader-categories', JSON.stringify(nextCategories));
      vault.setItem('reader-positions', JSON.stringify({ ...JSON.parse(vault.getItem('reader-positions') ?? '{}'), ...Object.fromEntries(moving.flatMap(book => positions[book.id] ? [[book.id, positions[book.id]]] : [])) }));
      const marks = [...JSON.parse(vault.getItem('reader-bookmarks') ?? '[]'), ...bookmarks.filter(mark => moving.some(book => book.id === mark.bookId))] as Bookmark[];
      vault.setItem('reader-bookmarks', JSON.stringify([...new Map(marks.map(mark => [mark.id, mark])).values()]));
      await vault.saveBooks(moving, moving.map(book => book.id));
      const movedIds = new Set(moving.map(book => book.id)); books = books.filter(book => !movedIds.has(book.id));
      bookmarks = bookmarks.filter(mark => !movedIds.has(mark.bookId)); positions = Object.fromEntries(Object.entries(positions).filter(([id]) => !movedIds.has(id)));
      recentReads = Object.fromEntries(Object.entries(recentReads).filter(([id]) => !movedIds.has(id)));
      commandHistory = commandHistory.filter(command => !moving.some(book => command.includes(book.name) || command.includes(book.id)));
      if (current && movedIds.has(current.id)) { current = undefined; } savePreferences();
    }
    const focused = isTauri() ? await invoke<boolean>('reader_has_focus') : document.hasFocus();
    if (boss.active || !focused) { await vault.lock(); boss.cover(); return; }
    const read = (key: string, fallback: unknown) => { const value = vault.getItem(key); return value === null ? fallback : JSON.parse(value); };
    const restored = createBackup({ books: vault.books(), positions: read('reader-positions', {}), bookmarks: read('reader-bookmarks', []), categories: read('reader-categories', []), commandHistory: read('reader-command-history', []), settings: {}, lastBook: '', recentReads: normalizeRecent(read('reader-recent', {})) });
    publicSession = { books, categories, positions, bookmarks, commandHistory, recentReads, lastBook: current?.id ?? '', terminalCategory };
    closeCurrentBook();
    privateActive = true; books = restored.books; categories = restored.categories ?? []; positions = restored.positions; bookmarks = restored.bookmarks; commandHistory = restored.commandHistory; recentReads = restored.recentReads ?? {}; terminalCategory = '';
    updateShell(); filePicker.reset(); showLibrary(); focusPanel();
  } catch (error) { if (vault.unlocked) await vault.lock().catch(() => {}); throw error; }
  finally { importing = false; void handleNativePaths([]); }
}
async function lockVault() {
  if (!privateActive || lockingVault) return;
  pendingVaultLock = true;
  if (filePicker.active) filePicker.cancel();
  if (importing) { boss.cover(); return; }
  lockingVault = true; pendingVaultLock = false;
  const keepCover = boss.active;
  if (!boss.active) boss.cover();
  rememberPosition(); clearTimeout(saveTimer); savePreferences();
  try { await vault.lock(); } catch (error) { notify(`最近位置保存失败：${String(error)}`); }
  finally {
    current = undefined; privateActive = false;
    if (publicSession) ({ books, categories, positions, bookmarks, commandHistory, recentReads, lastBook, terminalCategory } = publicSession);
    closeCurrentBook(); panelBody.replaceChildren(); suggestions.replaceChildren(); libraryPanel.reset();
    $('notice').textContent = ''; $('notice').hidden = true; filePicker.reset();
    publicSession = undefined; historyIndex = -1; historyDraft = ''; jumpHistory.length = 0; pendingBackup = undefined;
    lockingVault = false; updateShell(); updateProgress();
    // Leave the cover in place on blur; explicit lock while focused returns to the public home.
    if (!keepCover && document.hasFocus() && boss.active) boss.toggle();
    reader.focus({ preventScroll: true }); void handleNativePaths([]);
  }
}
function onAppBlur() {
  simulation.pauseForInteraction();
  if (privateActive) { boss.cover(); void lockVault(); }
  else if (settings.autoCover) boss.cover();
  if (credentials.active) credentials.cancel();
}
async function syncBossKey() {
  if (!isTauri() || !nativeBossReady || syncingBoss || syncedBossKey === settings.bossKey) return;
  const requested = settings.bossKey; const previous = syncedBossKey; syncingBoss = true;
  try {
    await invoke('register_boss_key', { key: requested.replace('Meta+', 'Super+') });
    syncedBossKey = requested; boss.nativeKey = requested;
  } catch (error) {
    if (previous && settings.bossKey === requested) { settings.bossKey = previous; localStorage.setItem('reader-settings', JSON.stringify(settings)); const field = panelBody.querySelector<HTMLInputElement>('[data-hotkey-recorder]'); if (field) field.value = previous; }
    notify(`${String(error)}。${previous ? '已保留原快捷键。' : '当前仅支持应用内触发。'}`, 10000);
  } finally { syncingBoss = false; if (settings.bossKey !== requested && settings.bossKey !== syncedBossKey) void syncBossKey(); }
}
function scopedBooks() { return books.filter(book => !terminalCategory || (terminalCategory === '@uncategorized' ? !book.category : book.category === terminalCategory.replace(/^cat:/, ''))); }
function categoryPath(argument: string) {
  if (!argument || ['..', '~', '/', '\\'].includes(argument)) return '';
  if (argument === '未分类') return '@uncategorized';
  const name = argument.replace(/^[.][\\/]/, '').replace(/[\\/]$/, '');
  const found = categories.find(category => category === name);
  if (!found) throw new Error('分类不存在。输入 ls 查看书库；在管理分类中新建。');
  return `cat:${found}`;
}
let recentListing = false;
function namedBook(argument: string) {
  const available = recentListing ? [...scopedBooks()].filter(book => recentReads[book.id]).sort((a,b) => recentReads[b.id].at - recentReads[a.id].at) : libraryPanel.visibleBooks().length ? libraryPanel.visibleBooks().flatMap(book => books.find(current => current.id === book.id) ?? []) : scopedBooks();
  if (/^[1-9]\d*$/.test(argument)) return available[Number(argument) - 1];
  return scopedBooks().find(book => book.id === argument || book.name === argument || book.title === argument);
}
async function readNamedBook(argument: string) {
  if (!argument) { showLibrary(); return; }
  const book = namedBook(argument); if (book) { openBook(book); return; }
  if (isTauri() && /^(?:[a-z]:[\\/]|\/|~[\\/])/i.test(argument)) {
    if (importing) return; importing = true; setAutomatic(false);
    try { await acceptImported(await invoke<{files:Book[];warnings:string[]}>('import_paths', { paths:[argument] })); }
    finally { importing = false; void handleNativePaths([]); }
  } else notify('没有找到这本书。输入 ls 查看编号，或使用 open 导入。');
}
function completeArgument() {
  const match = /^(\/?\S+\s+)(.*)$/.exec(input.value); if (!match) return false;
  const command = parseCommand(input.value).name; const prefix = match[2].replace(/^["']/, '').toLocaleLowerCase();
  const choices = ['cd', 'set-location'].includes(command) ? ['..', ...categories] : ['cat', 'type', 'read', 'open', 'get-content', 'gc'].includes(command) ? scopedBooks().map(book => book.name) : [];
  const candidates = choices.filter(name => name.toLocaleLowerCase().startsWith(prefix));
  if (!candidates.length) return false;
  input.value = match[1] + (candidates[0].includes(' ') ? `"${candidates[0]}"` : candidates[0]); closeSuggestions(); return true;
}
function showRecent() {
  showPanel('最近阅读'); recentListing = true;
  const recent = [...scopedBooks()].filter(book => recentReads[book.id] || positions[book.id]).sort((a,b) => (recentReads[b.id]?.at ?? 0) - (recentReads[a.id]?.at ?? 0));
  const list = createBookList(recent, current?.id, book => openBook(book));
  [...list.children].forEach((row, index) => { const mark = recentReads[recent[index].id]; const note = document.createElement('small'); note.className = 'muted'; note.textContent = mark ? `  ${Math.round(mark.percent)}% · ${new Date(mark.at).toLocaleString()}` : `  第 ${(positions[recent[index].id]?.block ?? 0) + 1} 段`; row.append(note); });
  if (!recent.length) list.textContent = '还没有阅读记录。输入 open 或 ls 开始。'; panelBody.append(list);
}
function jumpPercent(argument: string) {
  const number = Number(argument.replace(/%$/, ''));
  if (!current) { notify('先打开一本书。'); return; }
  if (!argument || !Number.isFinite(number) || number < 0 || number > 100) { notify('用法：goto 35%（范围 0–100）'); return; }
  jumpTo(progressModel.target(number));
  if (number === 100) { reader.scrollTop = reader.scrollHeight; rememberPosition(); updateProgress(); }
}
function showProgress() {
  if (!current) { notify('先打开一本书。'); return; }
  const stats = progressModel.at(capturePosition()); if (reader.scrollTop >= reader.scrollHeight - reader.clientHeight - 1) { stats.percent = 100; stats.chapterPercent = 100; } const pages = Math.max(1, Math.ceil(reader.scrollHeight / Math.max(1, reader.clientHeight)));
  showPanel('阅读进度'); const text = document.createElement('p');
  text.textContent = `全书 ${stats.percent.toFixed(1)}% · 约剩 ${Math.ceil(pages * (1 - stats.percent / 100))} 页\n${stats.chapter} · 本章 ${stats.chapterPercent.toFixed(1)}% · 约剩 ${Math.ceil(pages * stats.chapterFraction * (1 - stats.chapterPercent / 100))} 页`;
  text.style.whiteSpace = 'pre-wrap';
  const field = document.createElement('input'); field.className = 'panel-input'; field.setAttribute('aria-label', '跳转百分比'); field.placeholder = '0–100，Enter 跳转';
  field.onkeydown = event => { if (!event.isComposing && event.key === 'Enter') { event.preventDefault(); jumpPercent(field.value); } };
  panelBody.append(text, field, button('跳转', () => jumpPercent(field.value))); field.focus();
}
function showHistory() {
  showPanel('命令历史'); const field = document.createElement('input'); field.type = 'search'; field.className = 'panel-input'; field.setAttribute('aria-label', '搜索命令历史');
  const list = document.createElement('div'); list.className = 'navigation-list';
  const render = () => { list.replaceChildren(); for (const command of [...commandHistory].reverse().filter(command => command.toLocaleLowerCase().includes(field.value.toLocaleLowerCase()))) list.append(button(command, () => { closePanel(); input.value = command; input.focus(); })); keyboardRows(list); };
  field.oninput = render; field.onkeydown = event => { if (!event.isComposing && ['ArrowDown', 'Enter'].includes(event.key)) { event.preventDefault(); list.querySelector('button')?.focus(); } };
  panelBody.append(field, list); render(); field.focus();
}
function showQuickStart() {
  showPanel('快速上手 / Terminal Reader'); panelBody.tabIndex = 0;
  const intro = document.createElement('p'); intro.textContent = '直接输入命令，Enter 执行；也兼容 /open 等原有写法。鼠标仍可点击文字。'; panelBody.append(intro);
  for (const [command, description] of quickStart) { const line = document.createElement('p'); line.className = 'keyboard-entry'; line.textContent = `${command}  ${description}`; panelBody.append(line); }
  panelBody.append(button('打开文件', () => void importBooks(false)), button('试读示例', () => void runCommand('demo')), button('开始使用', () => { closePanel(); input.focus(); }));
}

function capturePosition(): Position {
  return view.capture();
}

function restorePosition(anchor: Position) {
  view.restore(validPosition(anchor) ? anchor : { block: 0, fraction: 0 });
  scrollPosition = reader.scrollTop;
}

function rememberPosition() {
  if (!current) return;
  position = capturePosition();
  positions[current.id] = position;
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(savePreferences, 250);
}

function updateProgress() {
  const extent = reader.scrollHeight - reader.clientHeight;
  const stats = progressModel.at(position);
  const atEnd = reader.scrollTop >= extent - 1;
  const progress = atEnd ? 100 : Math.round(settings.progressScope === 'chapter' ? stats.chapterPercent : stats.percent);
  $('reading-status').textContent = current ? `${automatic ? '自动滚动' : '阅读'} · ${progress}%` : '';
  const indicator = $('reading-progress'); indicator.hidden = !current;
  const totalPages = Math.max(1, Math.ceil((extent / Math.max(1, reader.clientHeight) + 1) * (settings.progressScope === 'chapter' ? stats.chapterFraction : 1)));
  const page = Math.min(totalPages, Math.floor(progress / 100 * Math.max(0, totalPages - 1)) + 1);
  const displayedPage = progress === 100 ? totalPages : page;
  indicator.textContent = settings.progressStyle === 'bar' ? `[${'='.repeat(Math.round(progress / 10))}${'-'.repeat(10 - Math.round(progress / 10))}]` : settings.progressStyle === 'pages' ? `${displayedPage}/${totalPages}` : `${progress}%`;
  indicator.setAttribute('aria-label', `阅读进度 ${progress}%，第 ${displayedPage} / ${totalPages} 页；激活切换样式`);
  indicator.title = (settings.progressScope === 'chapter' ? `${stats.chapter} · 本章 ` : '全书 ') + (settings.progressStyle === 'pages' ? '按当前窗口估算页数；点击切换样式' : '点击切换进度条 / 页数 / 百分比');
  $('window-title').title = current ? `${current.name} · ${progress}%${automatic ? ' · 自动滚动' : ''}` : profileFor(settings.theme).title;
}

function updateShell() {
  const profile = profileFor(settings.theme);
  app.dataset.theme = profile.id;
  app.dataset.chrome = profile.chrome;
  $('window-title').textContent = profile.title;
  $('shell-banner').textContent = profile.banner;
  $('shell-icon').innerHTML = shellIcons[profile.id];
  renderPrompt($('prompt'), settings.theme);
  if (terminalCategory || privateActive) {
    const folder = `${privateActive ? 'Archive' : 'Books'}${terminalCategory ? '/' + terminalCategory.replace(/^cat:/, '') : ''}`;
    $('prompt').textContent = settings.theme === 'linux' ? `~/${folder}$` : `${settings.theme === 'cmd' ? '' : 'PS '}C:\\${folder.replaceAll('/', '\\')}>`;
  }
  renderPrompt($('session-prompt'), settings.theme);
  if (privateActive || terminalCategory) $('session-prompt').textContent = $('prompt').textContent;
  document.querySelector<HTMLElement>('#session-command .shell-command')!.textContent = settings.theme === 'linux' ? 'cat' : settings.theme === 'cmd' ? 'type' : 'Get-Content';
  $('session-command').hidden = !current;
  if (current) {
    $('session-file').textContent = fileArgument(settings.theme, current.name);
    $('session-command').title = $('session-command').textContent ?? current.name;
  }
}

function applyStyle() {
  const anchor = position;
  applyAppearance(app, settings);
  if (nativeBossReady) void syncBossKey();
  updateShell();
  applyReadingMode();
  view.refreshLayout(anchor);
  scrollPosition = reader.scrollTop;
  updateProgress();
  savePreferences();
}

function openBook(book: Book, mode: 'resume' | 'continue' = 'resume') {
  if (current) rememberPosition();
  if (mode === 'resume') setAutomatic(false);
  closePanel();
  searchSession = undefined;
  view.highlight('');
  current = book;
  app.classList.add('has-book');
  $('welcome').hidden = true;
  content.hidden = false;
  documentBlocks = parseDocument(book);
  progressModel = new ReadingProgress(documentBlocks, chaptersFor(book, documentBlocks));
  recentReads[book.id] = { at: Date.now(), percent: recentReads[book.id]?.percent ?? 0 };
  view.setBlocks(documentBlocks);
  updateShell();
  applyReadingMode();
  // Explicitly choose a destination anchor; never inherit the outgoing scrollTop.
  position = mode === 'continue' ? { block: 0, fraction: 0 } : positions[book.id] ?? { block: 0, fraction: 0 };
  restorePosition(position);
  updateProgress();
  savePreferences();
  reader.focus({ preventScroll: true });
}

function closeCurrentBook() {
  if (privateActive && !lockingVault) { void lockVault(); return; }
  if (restoring) return;
  rememberPosition(); clearTimeout(saveTimer); setAutomatic(false);
  closePanel(); closeSuggestions(); closeProfileMenu();
  current = undefined; documentBlocks = []; progressModel = new ReadingProgress([], []); view.setBlocks([]); searchSession = undefined; view.highlight('');
  jumpHistory.length = 0; app.classList.remove('has-book'); content.hidden = true; $('welcome').hidden = false;
  input.value = ''; $('session-file').textContent = ''; $('session-command').removeAttribute('title');
  updateShell(); applyReadingMode(); updateProgress(); savePreferences(); reader.focus();
}

function navigateBook(direction: number, continueReading = false) {
  if (!current) { notify('先打开一本书。'); return; }
  const scope = scopedBooks();
  const next = scope[scope.findIndex(book => book.id === current!.id) + direction];
  if (next) openBook(next, continueReading ? 'continue' : 'resume');
  else { setAutomatic(false); notify(direction > 0 ? '已到书库末尾。' : '这是第一份文件。'); }
}

function animation(time: number) {
  if (!automatic) return;
  const elapsed = previousFrame ? Math.min((time - previousFrame) / 1000, 0.1) : 0;
  previousFrame = time;
    if (panel.hidden && keyboardHelp.hidden && !filePicker.active && !boss.active && $('profile-menu').hidden && document.activeElement !== input && !document.getSelection()?.toString() && !document.hidden) {
    scrollPosition += settings.speed * elapsed;
    reader.scrollTop = scrollPosition;
    if (scrollPosition >= reader.scrollHeight - reader.clientHeight + 18) navigateBook(1, true);
  } else scrollPosition = reader.scrollTop;
  if (automatic) frameId = requestAnimationFrame(animation);
}

function setAutomatic(value: boolean) {
  cancelAnimationFrame(frameId);
  automatic = value && !!current;
  previousFrame = 0;
  scrollPosition = reader.scrollTop;
  if (automatic) frameId = requestAnimationFrame(animation);
  updateProgress();
}

function closeSuggestions() {
  suggestions.hidden = true;
  input.setAttribute('aria-expanded', 'false');
  input.removeAttribute('aria-activedescendant');
}

function closePanel() {
  panelCleanup?.(); panelCleanup = undefined;
  panel.hidden = true;
  panelBody.className = '';
  reader.removeAttribute('inert');
  scrollPosition = reader.scrollTop;
}

function showPanel(title: string) {
  closePanel();
  closeSuggestions();
  closeProfileMenu();
  $('panel-title').textContent = title;
  panel.setAttribute('aria-label', title);
  panelBody.className = ''; panelBody.removeAttribute('tabindex');
  panelBody.replaceChildren();
  panelBody.onkeydown = null;
  panel.hidden = false;
  reader.setAttribute('inert', '');
  simulation.pauseForInteraction();
  panelBody.scrollTop = 0;
}

function button(label: string, action: () => void, className = '') {
  const element = document.createElement('button');
  element.textContent = label;
  element.className = className;
  element.onclick = action;
  return element;
}

function closeProfileMenu() {
  $('profile-menu').hidden = true;
  $('menu').setAttribute('aria-expanded', 'false');
}

function showProfileMenu() {
  const menu = $('profile-menu');
  if (!menu.hidden) { closeProfileMenu(); reader.focus(); return; }
  closePanel(); closeSuggestions();
  menu.replaceChildren();
  for (const profile of profiles) {
    const item = button(profile.name, () => {
      settings.theme = profile.id;
      applyStyle(); closeProfileMenu(); reader.focus({ preventScroll: true });
    });
    item.setAttribute('role', 'menuitemradio');
    item.setAttribute('aria-checked', String(profile.id === settings.theme));
    menu.append(item);
  }
  const divider = document.createElement('hr');
  menu.append(divider);
  const modeToggle = button('模拟命令行', () => {
    closeProfileMenu(); reader.focus({ preventScroll: true });
    setReadingMode(settings.mode === 'simulate' ? 'plain' : 'simulate', settings.effectFrequency !== 'off');
  });
  modeToggle.setAttribute('role', 'menuitemcheckbox');
  modeToggle.setAttribute('aria-checked', String(settings.mode === 'simulate'));
  menu.append(modeToggle);
  for (const [label, command] of [['打开文件', 'open'], ['书库', 'books'], ['设置', 'style'], ['命令与帮助', 'help']]) {
    const item = button(label, () => void runCommand(command));
    item.setAttribute('role', 'menuitem');
    menu.append(item);
  }
  menu.hidden = false;
  $('menu').setAttribute('aria-expanded', 'true');
  simulation.pauseForInteraction();
  (menu.querySelector('[aria-checked="true"]') as HTMLElement)?.focus();
}

const libraryPanel = new LibraryPanel({
  getBooks: () => books,
  getCurrentId: () => current?.id,
  getCategories: () => categories,
  isBusy: () => importing,
  openBook: book => openBook(book),
  importBooks,
  refreshBooks,
  removeBooks: removeLibraryBooks,
  restoreBooks: restoreLibraryBooks,
  saveClassification,
  notify,
  categoryChanged: category => { terminalCategory = category; updateShell(); },
});

function showLibrary() {
  recentListing = false;
  showPanel('书库');
  libraryPanel.mount(panelBody, terminalCategory, privateActive ? 'vault' : 'public');
  if (privateActive) panelBody.querySelector('.library-controls-row')?.prepend(button('lock', () => void lockVault()));
}

function focusPanel() {
  (panelBody.querySelector<HTMLElement>('[data-focused="true"][tabindex="0"], [data-focused="true"] [tabindex="0"]') ?? panelBody.querySelector<HTMLElement>('[role="option"][aria-selected="true"]') ?? panelBody.querySelector<HTMLElement>('input, textarea, button, select') ?? $('panel-close')).focus();
}

async function removeLibraryBooks(ids: string[]): Promise<Book[]> {
  if (importing) throw new Error('书库正在处理中，请稍候。');
  const removedIds = new Set(ids);
  const removed = books.filter(book => removedIds.has(book.id));
  if (!removed.length) return [];
  importing = true; setAutomatic(false);
  try {
    await deleteBooks(removed.map(book => book.id));
    books = books.filter(book => !removedIds.has(book.id));
    if (current && removedIds.has(current.id)) {
      rememberPosition(); current = undefined; documentBlocks = []; view.setBlocks([]);
      searchSession = undefined; view.highlight('');
      app.classList.remove('has-book'); content.hidden = true; $('welcome').hidden = false;
      updateShell(); applyReadingMode(); updateProgress(); savePreferences();
    }
    return removed;
  } finally { importing = false; void handleNativePaths([]); }
}

async function restoreLibraryBooks(removed: Book[]): Promise<void> {
  if (importing) throw new Error('书库正在处理中，请稍候。');
  importing = true;
  try {
    const existing = new Set(books.map(book => book.id));
    const restored = removed.filter(book => !existing.has(book.id)).map(book => {
      if (!book.category || categories.includes(book.category)) return book;
      const { category: _category, ...uncategorized } = book;
      return uncategorized;
    });
    if (!restored.length) return;
    await saveBooks(restored);
    books = sortBooks([...books, ...restored]);
  } finally { importing = false; void handleNativePaths([]); }
}

async function saveClassification(changedBooks: Book[], nextCategories: string[]): Promise<void> {
  if (importing) throw new Error('书库正在处理中，请稍候。');
  importing = true;
  let previous: string | null | undefined;
  try {
    const catalog = normalizeCategories(nextCategories);
    const changed = changedBooks.map(book => {
      const existing = books.find(item => item.id === book.id);
      if (!existing) throw new Error('书籍已移出书库，请重新选择。');
      const { category: _category, ...copy } = existing;
      if (book.category === undefined) return copy;
      const category = normalizeCategory(book.category);
      if (!catalog.includes(category)) throw new Error('分类不存在，请重新选择。');
      return { ...copy, category };
    });
    const merged = new Map(books.map(book => [book.id, book]));
    changed.forEach(book => merged.set(book.id, book));
    if ([...merged.values()].some(book => book.category !== undefined && !catalog.includes(book.category))) throw new Error('分类仍有书籍，请先移至其他分类。');
    previous = preferenceStore().getItem('reader-categories');
    preferenceStore().setItem('reader-categories', JSON.stringify(catalog));
    if (changed.length) await saveBooks(changed);
    categories = catalog; books = sortBooks([...merged.values()]);
    if (current) current = books.find(book => book.id === current!.id) ?? current;
  } catch (error) {
    if (previous !== undefined) {
      try { if (previous === null) preferenceStore().removeItem('reader-categories'); else preferenceStore().setItem('reader-categories', previous); }
      catch { /* A future successful classification save can repair unavailable preferences. */ }
    }
    throw error;
  } finally { importing = false; void handleNativePaths([]); }
}

function jumpTo(anchor: Position, bookId = current?.id, remember = true) {
  if (!bookId) return;
  const book = books.find(book => book.id === bookId) ?? (bookId === demo.id ? demo : undefined);
  if (!book) { notify('这本书已移出书库，请重新导入后再跳转。'); return; }
  if (remember && current) { jumpHistory.push({ bookId: current.id, position: capturePosition() }); if (jumpHistory.length > 100) jumpHistory.shift(); }
  if (bookId !== current?.id) openBook(book);
  setAutomatic(false); closePanel(); restorePosition(anchor); rememberPosition(); updateProgress(); reader.focus({ preventScroll: true });
}

function goBack() {
  const entry = jumpHistory.pop();
  if (entry) { searchSession = undefined; view.highlight(''); jumpTo(entry.position, entry.bookId, false); }
  else notify('没有可返回的位置。');
}

function endSearch(restore: boolean) {
  const session = searchSession; searchSession = undefined; view.highlight('');
  if (restore && session && current?.id === session.bookId) {
    restorePosition(session.origin); rememberPosition(); updateProgress();
  }
}

function selectMatch(index: number) {
  if (!searchSession?.matches.length) { notify('先用 /find 搜索正文。'); return; }
  const session = searchSession;
  session.index = (index + session.matches.length) % session.matches.length;
  const match = session.matches[session.index];
  if (current?.id !== session.bookId) return;
  jumpTo({ block: match.block, fraction: 0, offset: match.offset, lineRatio: 0 }, session.bookId, false);
  view.highlight(session.query, match);
  notify(`搜索 ${session.index + 1}/${session.matches.length} · F3 下一个 · Shift+F3 上一个 · Esc 返回原处`, 5500);
}

function showFind(query = searchSession?.query ?? '') {
  if (!current) { notify('先打开一本书。'); return; }
  setAutomatic(false);
  const bookId = current.id;
  const origin = searchSession?.bookId === bookId ? searchSession.origin : capturePosition();
  showPanel('搜索正文');
  const field = document.createElement('input'); field.type = 'search'; field.className = 'panel-input'; field.placeholder = '输入关键词，Enter 跳到结果'; field.setAttribute('aria-label', '搜索正文'); field.value = query; field.maxLength = 256;
  const status = document.createElement('p'); status.className = 'muted'; status.setAttribute('role', 'status');
  const results = document.createElement('div'); results.className = 'navigation-list';
  field.dataset.keyboardRegion = 'search'; results.dataset.keyboardRegion = 'results';
  const actions = document.createElement('div'); actions.className = 'panel-actions';
  actions.dataset.keyboardRegion = 'actions';
  actions.append(button('结束搜索并返回', () => { closePanel(); endSearch(true); reader.focus(); }));
  panelBody.append(field, status, actions, results);
  let controller: AbortController | undefined;
  let timer = 0;
  let visible = 100;
  const render = () => {
    results.replaceChildren();
    const session = searchSession;
    if (!session || session.bookId !== bookId) return;
    for (const [index, match] of session.matches.slice(0, visible).entries()) results.append(button(`${index + 1}. ${match.excerpt}`, () => {
      jumpHistory.push({ bookId, position: origin }); selectMatch(index);
    }, 'help-item'));
    keyboardList(results);
    if (session.matches.length > visible) results.append(button('显示更多结果', () => { visible += 100; render(); }, 'help-item'));
  };
  const search = async () => {
    controller?.abort(); controller = new AbortController(); const active = controller;
    const phrase = field.value.trim(); status.textContent = phrase ? '正在搜索…' : '输入关键词，支持中文；F3 / Shift+F3 切换结果。';
    const result = await searchBlocks(documentBlocks, phrase, active.signal);
    if (active.signal.aborted || panel.hidden || current?.id !== bookId) return false;
    searchSession = { bookId, origin, query: phrase, matches: result.matches, index: -1 };
    view.highlight(phrase); visible = 100; render();
    if (phrase) status.textContent = `找到 ${result.matches.length}${result.limited ? '+（最多显示 2000 处，请缩小关键词）' : ''} 处`;
    return true;
  };
  field.oninput = () => { clearTimeout(timer); controller?.abort(); timer = window.setTimeout(() => void search(), 140); };
  field.onkeydown = event => {
    if (event.isComposing) return;
    if (event.key === 'ArrowDown') { event.preventDefault(); results.querySelector<HTMLElement>('button')?.focus(); }
    if (event.key === 'Enter') { event.preventDefault(); clearTimeout(timer); void search().then(completed => { if (completed && !panel.hidden && $('panel-title').textContent === '搜索正文' && searchSession?.matches.length) { jumpHistory.push({ bookId, position: origin }); selectMatch(0); } }); }
  };
  panelCleanup = () => { clearTimeout(timer); controller?.abort(); };
  void search(); field.focus();
}

function showChapters() {
  if (!current) { notify('先打开一本书。'); return; }
  const chapters = chaptersFor(current, documentBlocks);
  showPanel(`章节 / ${chapters.length}`);
  const field = document.createElement('input'); field.type = 'search'; field.className = 'panel-input'; field.placeholder = '筛选章节'; field.setAttribute('aria-label', '筛选章节');
  const list = document.createElement('div'); list.className = 'navigation-list';
  field.dataset.keyboardRegion = 'search'; list.dataset.keyboardRegion = 'chapters';
  const render = () => {
    list.replaceChildren();
    for (const chapter of chapters.filter(c => c.title.toLocaleLowerCase().includes(field.value.toLocaleLowerCase()))) {
      const row = button(`${'  '.repeat(Math.min(4, Math.max(0, (chapter.level ?? 1) - 1)))}${chapter.title}`, () => jumpTo({ block: chapter.block, fraction: 0, offset: 0 }), 'help-item'); list.append(row);
    }
    keyboardList(list);
    if (!list.children.length) list.textContent = chapters.length ? '没有匹配的章节。' : '未识别到章节标题，可使用搜索或书签定位。';
  };
  field.oninput = render; field.onkeydown = event => { if (!event.isComposing && (event.key === 'ArrowDown' || event.key === 'Enter')) { event.preventDefault(); list.querySelector<HTMLElement>('button')?.focus(); } };
  render(); panelBody.append(field, list);
}

function showBookmarks(argument = '') {
  if (!current) { notify('先打开一本书。'); return; }
  const bookId = current.id; const anchor = capturePosition();
  showPanel('书签');
  const name = document.createElement('input'); name.className = 'panel-input'; name.maxLength = 200; name.setAttribute('aria-label', '书签名称'); name.placeholder = '书签名称';
  name.value = argument.replace(/^add\s*/, '') || documentBlocks[anchor.block]?.text.slice(anchor.offset ?? 0, (anchor.offset ?? 0) + 35) || current.title || current.name;
  const list = document.createElement('div');
  list.dataset.keyboardRegion = 'bookmarks';
  name.dataset.keyboardRegion = 'name';
  let editingId: string | undefined;
  let bookmarkIndex = 0;
  const scope = document.createElement('select'); scope.setAttribute('aria-label', '书签范围'); scope.add(new Option('当前书籍', 'current')); scope.add(new Option('全部书籍', 'all'));
  const render = (focus = false) => {
    list.replaceChildren();
    const marks = bookmarks.filter(mark => (scope.value === 'all' || mark.bookId === bookId) && books.some(book => book.id === mark.bookId));
    marks.forEach((mark, index) => {
      const row = document.createElement('div'); row.className = 'bookmark-row';
      row.addEventListener('focusin', () => { bookmarkIndex = index; });
      if (editingId === mark.id) {
        const field = document.createElement('input'); field.className = 'panel-input'; field.value = mark.label; field.maxLength = 200; field.setAttribute('aria-label', '修改书签名称');
        const commit = () => { if (!field.value.trim()) { field.focus(); return; } mark.label = field.value.trim(); editingId = undefined; savePreferences(); render(true); };
        const cancel = () => { editingId = undefined; render(true); };
        field.onkeydown = e => {
          if (e.isComposing) return;
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        };
        row.append(field, button('保存', commit), button('取消', cancel));
      } else {
        row.append(button(mark.label, () => jumpTo(mark.position, mark.bookId), 'help-item'));
        const rename = button('改名', () => { editingId = mark.id; bookmarkIndex = index; render(true); }); rename.dataset.bookmarkAction = 'rename';
        const remove = button('删除', () => { bookmarks = bookmarks.filter(m => m.id !== mark.id); bookmarkIndex = index; savePreferences(); render(true); }); remove.dataset.bookmarkAction = 'delete';
        row.append(rename, remove);
      }
      row.title = books.find(b => b.id === mark.bookId)?.title ?? books.find(b => b.id === mark.bookId)?.name ?? mark.bookId;
      list.append(row);
    });
    if (!marks.length) list.textContent = '还没有书签。';
    const focusRow = keyboardRows(list, bookmarkIndex);
    if (focus) {
      const editor = list.querySelector<HTMLInputElement>('input');
      if (editor) { editor.focus(); editor.select(); }
      else if (marks.length) focusRow(); else name.focus();
    }
  };
  const add = () => {
    if (!name.value.trim()) { name.focus(); return; }
    bookmarks.push({ id: crypto.randomUUID(), bookId, label: name.value.trim(), position: anchor, createdAt: Date.now() });
    bookmarkIndex = bookmarks.filter(mark => scope.value === 'all' || mark.bookId === bookId).length - 1;
    savePreferences(); render(true);
  };
  name.onkeydown = event => { if (!event.isComposing && event.key === 'Enter') { event.preventDefault(); add(); } };
  scope.onchange = () => { bookmarkIndex = 0; render(); };
  const actions = document.createElement('div'); actions.className = 'panel-actions'; actions.append(button('添加当前位置', add), scope);
  actions.dataset.keyboardRegion = 'actions';
  panelBody.append(name, actions, list); render();
  panelBody.onkeydown = event => {
    if (event.isComposing || event.defaultPrevented) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') { event.preventDefault(); name.focus(); name.select(); return; }
    if (event.key === 'Escape' && editingId) { event.preventDefault(); editingId = undefined; render(true); return; }
    if (isEditing(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
    const row = (event.target as HTMLElement).closest('.bookmark-row');
    if (row && (event.key === 'F2' || event.key === 'Delete')) {
      event.preventDefault();
      if (!event.repeat) row.querySelector<HTMLButtonElement>(`[data-bookmark-action="${event.key === 'F2' ? 'rename' : 'delete'}"]`)?.click();
    }
  };
  name.select();
}

function showSpeed() {
  showPanel('自动滚动');
  const label = document.createElement('label');
  label.className = 'setting';
  const text = document.createElement('span');
  text.textContent = `${settings.speed} 像素 / 秒`;
  const range = document.createElement('input');
  range.type = 'range'; range.min = '2'; range.max = '100'; range.value = String(settings.speed);
  range.setAttribute('aria-label', '滚动速度');
  const preview = document.createElement('div');
  preview.className = 'speed-preview';
  const line = document.createElement('div');
  line.textContent = Array.from({ length: 10 }, () => '灯亮着，就算开着。\n翻过一页，夜色慢了一点。').join('\n');
  preview.append(line);
  const effect = line.animate([{ transform: 'translateY(0)' }, { transform: 'translateY(-160px)' }], { duration: 160 / settings.speed * 1000, iterations: Infinity });
  range.oninput = () => {
    settings.speed = Number(range.value); text.textContent = `${settings.speed} 像素 / 秒`;
    effect.effect?.updateTiming({ duration: 160 / settings.speed * 1000 }); savePreferences();
  };
  label.append(text, range); panelBody.append(label, preview);
  panelBody.append(button(automatic ? '暂停滚动' : '开始滚动', () => { closePanel(); setAutomatic(!automatic); reader.focus(); }, 'primary'));
}

function showStyle() {
  showPanel('外观与阅读模式');
  const themeLabel = document.createElement('label'); themeLabel.className = 'setting'; themeLabel.textContent = '终端风格';
  const select = document.createElement('select');
  select.setAttribute('aria-label', '终端风格');
  for (const profile of profiles) select.add(new Option(profile.name, profile.id));
  select.value = settings.theme;
  const description = document.createElement('p');
  description.className = 'profile-description';
  description.textContent = profileFor(settings.theme).description;
  select.onchange = () => {
    if (!isTheme(select.value)) return;
    settings.theme = select.value; applyStyle();
    refreshAppearance();
    description.textContent = profileFor(settings.theme).description;
  };
  themeLabel.append(select);
  const sizeLabel = document.createElement('label'); sizeLabel.className = 'setting'; sizeLabel.textContent = '正文字号';
  const size = document.createElement('input'); size.type = 'number'; size.min = '12'; size.max = '24'; size.value = String(settings.fontSize);
  size.setAttribute('aria-label', '正文字号');
  size.onchange = () => {
    if (!Number.isFinite(size.valueAsNumber)) return;
    settings.fontSize = Math.max(12, Math.min(24, size.valueAsNumber)); size.value = String(settings.fontSize); applyStyle();
  };
  sizeLabel.append(size);
  panelBody.append(themeLabel, description, sizeLabel);
  const refreshAppearance = appendAppearanceControls(panelBody, app, settings, applyStyle);
  const modeLabel = document.createElement('label'); modeLabel.className = 'setting'; modeLabel.textContent = '显示模式';
  const mode = document.createElement('select'); mode.id = 'display-mode'; mode.setAttribute('aria-label', '显示模式');
  mode.add(new Option('纯阅读', 'plain')); mode.add(new Option('模拟命令行', 'simulate'));
  mode.value = settings.mode;
  mode.onchange = () => { setReadingMode(mode.value as ReadingMode); simulationControls.hidden = settings.mode === 'plain'; };
  modeLabel.append(mode);
  const simulationControls = document.createElement('div'); simulationControls.hidden = settings.mode === 'plain';
  const colorLabel = document.createElement('label'); colorLabel.className = 'setting'; colorLabel.textContent = '随机颜色';
  const colors = document.createElement('select'); colors.setAttribute('aria-label', '随机颜色');
  colors.add(new Option('克制', 'soft')); colors.add(new Option('标准', 'normal')); colors.add(new Option('丰富', 'rich'));
  colors.value = settings.colorLevel;
  colors.onchange = () => { settings.colorLevel = colors.value as ColorLevel; applyReadingMode(); savePreferences(); };
  colorLabel.append(colors);
  const frequencyLabel = document.createElement('label'); frequencyLabel.className = 'setting'; frequencyLabel.textContent = '模拟任务';
  const frequency = document.createElement('select'); frequency.setAttribute('aria-label', '模拟任务频率');
  frequency.add(new Option('关闭（仅颜色）', 'off')); frequency.add(new Option('低频', 'low')); frequency.add(new Option('正常', 'normal'));
  frequency.value = settings.effectFrequency;
  frequency.onchange = () => { settings.effectFrequency = frequency.value as EffectFrequency; applyReadingMode(); savePreferences(); };
  frequencyLabel.append(frequency);
  const actions = document.createElement('div'); actions.className = 'panel-actions';
  actions.append(button('重新配色', () => {
    settings.colorSeed = crypto.getRandomValues(new Uint32Array(1))[0]; applyReadingMode(); savePreferences();
  }), button('预览一次任务', () => {
    closePanel(); reader.focus({ preventScroll: true });
    if (current) simulation.preview(); else notify('先打开一本书，再预览模拟任务。');
  }));
  const explanation = document.createElement('p'); explanation.className = 'muted';
  explanation.textContent = '颜色按段落固定。任务为模拟输出，借用提示符一行；输入或选中文字时暂停。';
  simulationControls.append(colorLabel, frequencyLabel, actions, explanation);
  panelBody.append(modeLabel, simulationControls);
  const note = document.createElement('p'); note.className = 'muted'; note.textContent = '设置即时生效。Esc 返回阅读。'; panelBody.append(note);
}

function showHelp() {
  showPanel('命令与快捷键');
  const hint = document.createElement('p'); hint.className = 'muted';
  hint.textContent = 'F1 随时打开键盘速查。Tab 切换控件，F6 切换区域，Enter 执行，Esc 逐级返回。';
  panelBody.append(hint);
  for (const [name, detail] of commands) panelBody.append(button(`/${name}  ${detail}`, () => void runCommand(name), 'help-item'));
  appendKeyboardGuide(panelBody);
}

async function acceptImported(imported: { files: Book[]; warnings: string[] }, openFirst = true) {
  imported.files = imported.files.map(book => {
    const existing = books.find(item => item.id === book.id);
    return existing ? { ...book, category: existing.category } : book;
  });
  await saveBooks(imported.files);
  const map = new Map(books.map(book => [book.id, book]));
  for (const book of imported.files) map.set(book.id, book);
  books = sortBooks([...map.values()]);
  if (openFirst && imported.files.length) openBook(sortBooks(imported.files)[0]);
  notify(imported.warnings.length ? `已读取 ${imported.files.length} 份；${imported.warnings.join('；')}` : imported.files.length ? `已读取 ${imported.files.length} 份文件` : '没有找到可读的 TXT / Markdown / EPUB 文件。', 7500);
}

async function handleNativePaths(paths: string[]) {
  nativePathQueue.push(...paths);
  if (pendingVaultLock && !importing && !lockingVault) { void lockVault(); return; }
  if (privateActive && paths.length) { void lockVault(); return; }
  if (importing || boss.active || !nativePathQueue.length) return;
  importing = true; setAutomatic(false);
  try {
    while (nativePathQueue.length) {
      const batch = [...new Set(nativePathQueue.splice(0))];
      notify('正在打开书籍…', 120000);
      await acceptImported(await invoke<{ files: Book[]; warnings: string[] }>('import_paths', { paths: batch }));
    }
  } catch (error) { notify(`打开失败：${String(error)}`, 8000); }
  finally { importing = false; if (nativePathQueue.length) void handleNativePaths([]); }
}

async function refreshBooks(ids = current ? [current.id] : []) {
  if (importing) return;
  const paths = ids.filter(id => id !== demo.id);
  if (!paths.length) { notify('没有可刷新的源文件。'); return; }
  if (!isTauri()) { notify('刷新源文件请使用桌面程序。'); return; }
  importing = true; setAutomatic(false);
  const anchor = current ? capturePosition() : undefined;
  const oldText = anchor ? documentBlocks[anchor.block]?.text : undefined;
  try {
    notify('正在刷新源文件…', 120000);
    const imported = await invoke<{ files: Book[]; warnings: string[] }>('import_paths', { paths });
    await acceptImported(imported, false);
    const updated = current && imported.files.find(book => book.id === current!.id);
    if (updated && anchor) {
      openBook(updated);
      let matching = -1;
      if (oldText) documentBlocks.forEach((block, index) => {
        if (block.text === oldText && (matching < 0 || Math.abs(index - anchor.block) < Math.abs(matching - anchor.block))) matching = index;
      });
      restorePosition({ ...anchor, block: matching >= 0 ? matching : anchor.block }); rememberPosition();
    } else if (!panel.hidden) { showLibrary(); focusPanel(); }
  } catch (error) { notify(`刷新失败：${String(error)}`, 8000); }
  finally { importing = false; void handleNativePaths([]); }
}

async function exportBackup(encrypt = false) {
  if (importing) return;
  rememberPosition(); savePreferences();
  try {
    const backup = createBackup({ books, positions, bookmarks, settings: settings as unknown as Record<string, unknown>, lastBook: current?.id ?? '', commandHistory, categories, recentReads, workspace: privateActive ? 'vault' : 'public' });
    let archive: unknown = backup;
    if (privateActive) archive = await vault.encryptedBackup(backup);
    else if (encrypt) { archive = await credentials.ask('设置备份密码', true, async password => seal(backup, await deriveKey(password))); if (!archive) return; }
    const contents = JSON.stringify(archive);
    if (isTauri()) {
      const selection = await filePicker.choose('save');
      if (!selection) return;
      const path = await invoke<string>('export_backup', { path: selection.paths[0], overwrite: selection.overwrite, contents });
      if (path) notify(`备份已保存：${path}`, 8000);
    } else {
      const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = `terminal-reader-${new Date().toISOString().slice(0, 10)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify('备份已导出。');
    }
  } catch (error) { notify(`备份失败：${String(error)}`, 8000); }
}

async function reviewBackup(text: string) {
  try {
    if (text.length > 128 * 1024 * 1024) throw new Error('备份超过容量限制');
    let decoded = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (decoded?.format === 'terminal-reader-encrypted') {
      const envelope = encryptedData(decoded);
      decoded = await credentials.ask('输入备份密码', false, async password => unseal(envelope, await deriveKey(password, envelope)));
      if (!decoded) return;
    }
    pendingBackup = parseBackup(JSON.stringify(decoded));
    if (pendingBackup.workspace === 'vault' && !privateActive) throw new Error('请先进入独立书库，再恢复这份备份。');
    if (pendingBackup.workspace === 'public' && privateActive) throw new Error('请先锁定当前书库，再恢复普通备份。');
    showPanel('恢复备份');
    const description = document.createElement('p'); description.className = 'muted';
    description.textContent = `${pendingBackup.books.length} 本书 · ${pendingBackup.categories?.length ?? 0} 个分类 · ${pendingBackup.bookmarks.length} 个书签 · ${new Date(pendingBackup.exportedAt).toLocaleString()}。恢复后合并书库和分类，相同源路径的内容、分类和进度使用备份值，并应用备份中的设置。`;
    panelBody.append(description, button('合并并恢复', () => void applyBackup(), 'primary'));
    focusPanel();
  } catch (error) { pendingBackup = undefined; notify(`备份无效：${String(error)}`, 8000); }
}

async function restoreBackup() {
  if (importing) return;
  if (isTauri()) {
    importing = true;
    try { const selection = await filePicker.choose('restore'); if (selection) await reviewBackup(await invoke<string>('import_backup', { path: selection.paths[0] })); }
    catch (error) { notify(`读取备份失败：${String(error)}`, 8000); }
    finally { importing = false; void handleNativePaths([]); }
  } else {
    showPanel('恢复备份 / 浏览器预览');
    const text = document.createElement('textarea'); text.setAttribute('aria-label', '备份内容'); text.className = 'panel-input'; text.placeholder = '粘贴 JSON 备份内容；桌面版可浏览本地文件。';
    const review = () => reviewBackup(text.value);
    text.onkeydown = event => { if (!event.isComposing && event.ctrlKey && event.key === 'Enter') { event.preventDefault(); review(); } };
    panelBody.append(text, button('预览备份', review)); text.focus();
  }
}

async function applyBackup() {
  if (!pendingBackup || importing) return;
  importing = true; setAutomatic(false); rememberPosition(); clearTimeout(saveTimer);
  restoring = true; app.setAttribute('inert', '');
  const backup = pendingBackup;
  const keys = ['reader-settings', 'reader-positions', 'reader-bookmarks', 'reader-command-history', 'reader-last-book', 'reader-categories', 'reader-recent'];
  let previous: (string | null)[] = [];
  try {
    previous = keys.map(key => preferenceStore().getItem(key));
    const restoredSettings = normalizeSettings(backup.settings);
    const restoredPositions = Object.assign(Object.create(null) as Record<string, Position>, positions, backup.positions);
    const restoredMarks = [...new Map([...bookmarks, ...backup.bookmarks].map(mark => [mark.id, mark])).values()];
    const restoredHistory = [...new Set([...commandHistory, ...backup.commandHistory])].slice(-100);
    const restoredCategories = normalizeCategories([...categories, ...(backup.categories ?? [])]);
    const restoredRecent = { ...recentReads, ...(backup.recentReads ?? {}) };
    const values = [JSON.stringify(restoredSettings), JSON.stringify(restoredPositions), JSON.stringify(restoredMarks), JSON.stringify(restoredHistory), backup.lastBook, JSON.stringify(restoredCategories), JSON.stringify(restoredRecent)];
    keys.forEach((key, i) => preferenceStore().setItem(key, values[i]));
    await saveBooks(backup.books);
    books = sortBooks([...new Map([...books, ...backup.books].map(book => [book.id, book])).values()]);
    settings = restoredSettings; positions = restoredPositions; bookmarks = restoredMarks; commandHistory = restoredHistory; categories = restoredCategories; recentReads = restoredRecent;
    if (!privateActive) extractLegacyBooks();
    const publicBooks = books.filter(book => !isPrivateBook(book));
    const next = publicBooks.find(book => book.id === backup.lastBook) ?? publicBooks.find(book => book.id === current?.id) ?? publicBooks[0];
    current = undefined; jumpHistory.length = 0; searchSession = undefined; applyStyle();
    if (next) openBook(next); else closePanel();
    savePreferences(); pendingBackup = undefined; notify(`已恢复 ${backup.books.length} 本书和 ${backup.bookmarks.length} 个书签。`);
  } catch (error) {
    if (previous.length === keys.length) keys.forEach((key, i) => { try { if (previous[i] === null) preferenceStore().removeItem(key); else preferenceStore().setItem(key, previous[i]!); } catch { /* Keep original in-memory data. */ } });
    notify(`恢复失败，原书库保留：${String(error)}`, 8000);
  } finally { restoring = false; app.removeAttribute('inert'); importing = false; if (panel.hidden) reader.focus({ preventScroll: true }); else focusPanel(); void handleNativePaths([]); }
}

async function importBooks(folder: boolean) {
  if (importing) return;
  if (!isTauri()) { notify('请在桌面程序中打开文件。浏览器预览可使用示例。'); return; }
  importing = true;
  const wasAutomatic = automatic;
  setAutomatic(false);
  try {
    const selection = await filePicker.choose(folder ? 'folder' : 'books');
    if (!selection) return;
    notify('正在读取文件…', 120000);
    const imported = await invoke<{ files: Book[]; warnings: string[] }>('import_paths', { paths: selection.paths });
    await acceptImported(imported);
  } catch (error) { notify(`打开失败：${String(error)}`, 8000); }
  finally { importing = false; if (wasAutomatic) setAutomatic(true); void handleNativePaths([]); }
}

async function runCommand(name: string, argument = '') {
  try { await executeCommand(name, argument); } catch (error) { notify(String(error).replace(/^Error: /, ''), 8000); }
}
async function executeCommand(name: string, argument = '') {
  if (restoring) return;
  clearTimeout(noticeTimer);
  $('notice').hidden = true;
  input.value = '';
  closeSuggestions();
  closePanel();
  closeProfileMenu();
  input.blur();
  name = commandAliases[name] ?? name;
  const command = `/${name}${argument ? ` ${argument}` : ''}`;
  if (commands.some(([known]) => known === name)) { commandHistory = [...commandHistory.filter(item => item !== command), command].slice(-100); historyIndex = -1; savePreferences(); }
  switch (name) {
    case 'open': if (argument) await readNamedBook(argument); else await importBooks(false); break;
    case 'folder': await importBooks(true); break;
    case 'close': closeCurrentBook(); break;
    case 'books': if (argument) terminalCategory = categoryPath(argument); showLibrary(); break;
    case 'read': await readNamedBook(argument); break;
    case 'cd': terminalCategory = categoryPath(argument); updateShell(); showLibrary(); break;
    case 'pwd': notify(terminalCategory ? terminalCategory.replace(/^cat:/, '') : '~ / 全部'); break;
    case 'recent': showRecent(); break;
    case 'resume': { const book = [...books].sort((a,b) => (recentReads[b.id]?.at ?? 0) - (recentReads[a.id]?.at ?? 0))[0]; if (book) openBook(book); else showLibrary(); break; }
    case 'goto': jumpPercent(argument); break;
    case 'progress': showProgress(); break;
    case 'history': showHistory(); break;
    case 'clear': if (privateActive) await lockVault(); else closeCurrentBook(); input.value = ''; input.focus(); break;
    case 'guide': showQuickStart(); break;
    case 'private': case 'vault': await enterVault(argument); break;
    case 'lock': await lockVault(); break;
    case 'boss': boss.toggle(); break;
    case 'find': showFind(argument || undefined); break;
    case 'chapter': showChapters(); break;
    case 'mark': showBookmarks(argument); break;
    case 'back': goBack(); break;
    case 'refresh': await refreshBooks(); break;
    case 'backup': await exportBackup(argument === '--encrypt'); break;
    case 'restore': await restoreBackup(); break;
    case 'next': navigateBook(1); break;
    case 'prev': navigateBook(-1); break;
    case 'scroll': if (!current) notify('先打开一本书。'); else setAutomatic(!automatic); break;
    case 'speed':
      if (argument && Number.isFinite(Number(argument))) { settings.speed = Math.max(2, Math.min(100, Number(argument))); savePreferences(); notify(`滚动速度：${settings.speed} 像素 / 秒`); }
      else showSpeed();
      break;
    case 'style':
      if (isTheme(argument)) { settings.theme = argument; applyStyle(); }
      else showStyle();
      break;
    case 'mode':
      if (argument === 'plain' || argument === 'simulate') setReadingMode(argument, argument === 'simulate' && settings.effectFrequency !== 'off');
      else if (argument === 'preview') {
        setReadingMode('simulate', true);
        if (!current) notify('先打开一本书，再预览模拟任务。');
      } else showStyle();
      break;
    case 'help': showQuickStart(); break;
    case 'demo':
      if (importing) { notify('书库正在处理中，请稍候。'); break; }
      if (!books.some(book => book.id === demo.id)) books = sortBooks([...books, demo]);
      openBook(books.find(book => book.id === demo.id)!); break;
    default: notify(`没有 /${name} 命令。输入 /help 查看帮助。`);
  }
  if (panel.hidden) (name === 'clear' ? input : reader).focus({ preventScroll: true });
  else ((name === 'help' || name === 'guide' ? panelBody : name === 'mode' ? $('display-mode') : name === 'find' || name === 'mark' ? panelBody.querySelector<HTMLElement>('input') : null) ?? panelBody.querySelector<HTMLElement>('[data-focused="true"][tabindex="0"], [data-focused="true"] [tabindex="0"]') ?? panelBody.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')
    ?? panelBody.querySelector<HTMLElement>('input, textarea, button, select') ?? $('panel-close')).focus();
}

function matches() {
  const query = input.value.replace(/^\//, '').trim().split(/\s/)[0].toLowerCase();
  return commands.filter(([name, description]) => name.startsWith(query) || description.includes(query));
}

function renderSuggestions() {
  if (!input.value.trim() || /\s/.test(input.value.trim())) { closeSuggestions(); return; }
  const filtered = matches();
  if (!filtered.length) { closeSuggestions(); return; }
  selected = Math.max(0, Math.min(selected, filtered.length - 1));
  suggestions.replaceChildren();
  filtered.forEach(([name, description], index) => {
    const item = button('', () => void runCommand(name));
    item.id = `command-${name}`; item.setAttribute('role', 'option'); item.setAttribute('aria-selected', String(index === selected));
    const command = document.createElement('span'); command.textContent = `${input.value.startsWith('/') ? '/' : ''}${name}`;
    const detail = document.createElement('span'); detail.textContent = description;
    item.append(command, detail); suggestions.append(item);
  });
  suggestions.hidden = false;
  input.setAttribute('aria-expanded', 'true');
  input.setAttribute('aria-activedescendant', `command-${filtered[selected][0]}`);
  suggestions.children[selected].scrollIntoView({ block: 'nearest' });
}

function readingKey(event: KeyboardEvent) {
  if (!current) return;
  if (event.code === 'Space') { event.preventDefault(); if (!event.repeat) setAutomatic(!automatic); return; }
  if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); navigateBook(event.key === 'ArrowRight' ? 1 : -1); return; }
  const distances: Record<string, number> = { ArrowDown: 40, ArrowUp: -40, PageDown: reader.clientHeight * 0.8, PageUp: -reader.clientHeight * 0.8, Home: -reader.scrollHeight, End: reader.scrollHeight };
  if (event.key in distances) {
    event.preventDefault(); setAutomatic(false);
    if (distances[event.key] > 0 && reader.scrollTop >= reader.scrollHeight - reader.clientHeight - 1) navigateBook(1, true);
    else reader.scrollBy({ top: distances[event.key], behavior: 'instant' });
  }
}

input.addEventListener('input', () => { selected = 0; historyIndex = -1; renderSuggestions(); });
input.addEventListener('focus', () => { simulation.pauseForInteraction(); renderSuggestions(); });
input.addEventListener('keydown', event => {
  if (event.isComposing) return;
  if ((event.ctrlKey || event.metaKey) && ['p', 'n'].includes(event.key.toLowerCase())) {
    event.preventDefault(); if (!commandHistory.length) return;
    if (historyIndex < 0) { historyDraft = input.value; historyIndex = commandHistory.length; }
    historyIndex = Math.max(0, Math.min(commandHistory.length, historyIndex + (event.key.toLowerCase() === 'p' ? -1 : 1))); input.value = commandHistory[historyIndex] ?? historyDraft; closeSuggestions(); return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'e') { event.preventDefault(); input.setSelectionRange(input.value.length, input.value.length); return; }
  if ((event.ctrlKey || event.metaKey) && ['u', 'w'].includes(event.key.toLowerCase())) {
    event.preventDefault(); const end = input.selectionStart ?? input.value.length; const start = event.key.toLowerCase() === 'u' ? 0 : input.value.slice(0, end).search(/\S+\s*$/);
    input.setRangeText('', Math.max(0, start), input.selectionEnd ?? end, 'end'); renderSuggestions(); return;
  }
  if (event.ctrlKey || event.metaKey) return;
  if (event.key === 'Escape') { event.preventDefault(); input.value = ''; historyIndex = -1; closeSuggestions(); reader.focus(); return; }
  if (!input.value && event.key === 'Enter') { event.preventDefault(); closeSuggestions(); reader.focus(); return; }
  if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && (event.altKey || historyIndex >= 0 || !input.value && event.key === 'ArrowUp') && commandHistory.length) {
    event.preventDefault();
    if (historyIndex < 0) { historyDraft = input.value; historyIndex = commandHistory.length; }
    historyIndex = Math.max(0, Math.min(commandHistory.length, historyIndex + (event.key === 'ArrowUp' ? -1 : 1)));
    input.value = commandHistory[historyIndex] ?? historyDraft; closeSuggestions(); return;
  }
  if (!input.value && ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', ' ', 'ArrowLeft', 'ArrowRight'].includes(event.key)) { reader.focus(); readingKey(event); return; }
  if (event.key === 'Tab' && !event.shiftKey && completeArgument()) { event.preventDefault(); return; }
  if (event.key === 'Tab' && (event.shiftKey || suggestions.hidden)) { closeSuggestions(); return; }
  if (['ArrowDown', 'ArrowUp', 'Tab', 'Enter'].includes(event.key)) {
    event.preventDefault();
    const filtered = matches();
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && filtered.length) { selected = (selected + (event.key === 'ArrowDown' ? 1 : filtered.length - 1)) % filtered.length; renderSuggestions(); }
    if (event.key === 'Tab' && filtered[selected]) { input.value = `${input.value.startsWith('/') ? '/' : ''}${filtered[selected][0]} `; renderSuggestions(); }
    if (event.key === 'Enter') {
      const parsed = parseCommand(input.value);
      void runCommand(parsed.name, parsed.argument);
    }
  }
});

document.addEventListener('keydown', event => {
  if (restoring) { event.preventDefault(); return; }
  if (event.isComposing || event.defaultPrevented) return;
  if (credentials.active) return;
  if (!keyboardHelp.hidden) {
    if (event.key === 'Escape' || event.key === 'F1') { event.preventDefault(); toggleKeyboardHelp(); }
    else if (event.key === 'Tab' || event.key === 'F6') { event.preventDefault(); cycleFocus(keyboardHelp, event.shiftKey); }
    return;
  }
  if (event.key === 'F1') { event.preventDefault(); toggleKeyboardHelp(); return; }
  if (filePicker.active) { filePicker.handleKey(event); return; }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c' && !event.shiftKey && !event.altKey) {
    const field = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement ? event.target : null;
    if (!document.getSelection()?.toString() && !(field && field.selectionStart !== field.selectionEnd)) { event.preventDefault(); closeCurrentBook(); }
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l') { event.preventDefault(); void runCommand('clear'); return; }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r' && !event.shiftKey) { event.preventDefault(); showHistory(); return; }
  if (libraryPanel.handleKey(event)) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    if (!$('profile-menu').hidden) { closeProfileMenu(); reader.focus(); return; }
    const leavingSearch = panel.hidden || $('panel-title').textContent === '搜索正文';
    closePanel(); closeSuggestions(); closeProfileMenu();
    if (leavingSearch) endSearch(true);
    reader.focus(); return;
  }
  if (!$('profile-menu').hidden && ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Tab'].includes(event.key)) {
    const items = Array.from($('profile-menu').querySelectorAll('button'));
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === 'ArrowUp' || (event.key === 'Tab' && event.shiftKey) ? items.length - 1 : 1;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + step) % items.length;
    event.preventDefault(); items[next]?.focus(); return;
  }
  if (event.key === 'F6') {
    event.preventDefault(); closeSuggestions();
    if (!panel.hidden) {
      if (!panelBody.querySelector('[data-keyboard-region]')) panelBody.querySelectorAll<HTMLElement>('.setting, details > summary, .panel-actions, .navigation-list').forEach(element => { element.dataset.keyboardRegion = 'controls'; });
      if (panelBody.querySelector('[data-keyboard-region]')) cycleRegions(panelBody, event.shiftKey); else cycleFocus(panel, event.shiftKey);
    } else {
      closeProfileMenu();
      const regions = [reader, input, $('menu')];
      const index = regions.findIndex(region => region === document.activeElement || (region === $('menu') && !!document.activeElement?.closest('.titlebar')));
      regions[(index + (event.shiftKey ? regions.length - 1 : 1)) % regions.length].focus();
    }
    return;
  }
  if (event.key === 'F10') { event.preventDefault(); showProfileMenu(); return; }
  if (event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey) {
    event.preventDefault(); cycleFocus(panel.hidden ? app : panel, event.shiftKey); return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); focusCommand(); return; }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') { event.preventDefault(); void importBooks(event.shiftKey); return; }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    const field = !event.shiftKey && !panel.hidden && panelBody.querySelector<HTMLInputElement>('[aria-label="筛选章节"]');
    if (field) { field.focus(); field.select(); } else showFind(); return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd') { event.preventDefault(); showBookmarks(); panelBody.querySelector<HTMLInputElement>('input')?.focus(); return; }
  if (event.ctrlKey || event.metaKey) {
    const key = event.key.toLowerCase();
    const shortcut = key === 'p' && event.shiftKey ? 'private' : key === 'b' ? (event.shiftKey ? 'backup' : 'books') : key === 'j' && !event.shiftKey ? 'chapter' : key === ',' ? 'style' : key === 'r' && event.shiftKey ? 'restore' : undefined;
    if (shortcut) { event.preventDefault(); if (!event.repeat) void runCommand(shortcut); return; }
  }
  if (event.altKey && event.key === 'ArrowLeft') { event.preventDefault(); goBack(); return; }
  if (event.key === 'F3' && searchSession) { event.preventDefault(); selectMatch(searchSession.index + (event.shiftKey ? -1 : 1)); return; }
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (isEditing(event.target)) return;
  if (event.key === '/') { event.preventDefault(); focusCommand(); return; }
  if (panel.hidden && !(event.target as HTMLElement).closest('button') && !document.getSelection()?.toString()) {
    if (event.key.length === 1 && event.key !== ' ') { event.preventDefault(); input.value = event.key; input.focus(); renderSuggestions(); } else readingKey(event);
  }
});

reader.addEventListener('scroll', () => { rememberPosition(); updateProgress(); });
reader.addEventListener('wheel', () => setAutomatic(false), { passive: true });
reader.addEventListener('touchstart', () => setAutomatic(false), { passive: true });
reader.addEventListener('pointerdown', () => { closeSuggestions(); input.blur(); });
reader.addEventListener('pointerdown', () => simulation.pauseForInteraction());
document.addEventListener('selectionchange', () => {
  if (document.getSelection()?.toString()) simulation.pauseForInteraction();
});
document.addEventListener('visibilitychange', () => { if (document.hidden) simulation.pauseForInteraction(); });
window.addEventListener('blur', onAppBlur);
$('reading-progress').onclick = () => {
  const styles = ['bar', 'pages', 'percent'] as const; settings.progressStyle = styles[(styles.indexOf(settings.progressStyle) + 1) % styles.length]; updateProgress(); savePreferences();
};
new ResizeObserver(() => updateProgress()).observe(reader);
$('open-book').onclick = () => void importBooks(false);
$('demo-book').onclick = () => void runCommand('demo');
$('new-file').onclick = () => void runCommand('open');
$('menu').onclick = showProfileMenu;
document.addEventListener('pointerdown', event => {
  if (!(event.target as HTMLElement).closest('#profile-menu, #menu')) closeProfileMenu();
});
$('panel-close').onclick = () => { closePanel(); reader.focus(); };
for (const name of ['minimize', 'maximize', 'close', 'tab-close']) {
  $(name).onclick = async () => {
    if (!isTauri()) { notify('窗口控制在桌面程序中可用。'); return; }
    try {
      const window = getCurrentWindow();
      if (name === 'minimize') await window.minimize();
      if (name === 'maximize') await window.toggleMaximize();
      if ((name === 'close' || name === 'tab-close') && !closing) { if (privateActive) await lockVault(); closing = true; rememberPosition(); savePreferences(); await window.close(); }
    } catch (error) { closing = false; notify(String(error)); }
  };
}
let unlistenProgress: UnlistenFn | undefined;
let unlistenOpen: UnlistenFn | undefined;
window.addEventListener('beforeunload', () => { rememberPosition(); savePreferences(); simulation.destroy(); view.destroy(); unlistenProgress?.(); unlistenOpen?.(); });
if (import.meta.hot) import.meta.hot.dispose(() => { simulation.destroy(); view.destroy(); unlistenProgress?.(); unlistenOpen?.(); });

async function init() {
  applyStyle();
  if (isTauri()) {
    try {
      await listen<boolean>('reader-boss-key', event => {
        if (document.hasFocus() && document.activeElement?.hasAttribute('data-hotkey-recorder')) return;
        if (event.payload) boss.cover(); else boss.toggle();
      });
      nativeBossReady = true; await syncBossKey();
      await getCurrentWindow().onFocusChanged(async event => {
        if (!event.payload && !await invoke<boolean>('reader_has_focus')) onAppBlur();
      });
      await getCurrentWindow().onCloseRequested(async event => { if (privateActive && !closing) { event.preventDefault(); await lockVault(); closing = true; await getCurrentWindow().close(); } });
    } catch (error) { notify(`全局快捷键暂不可用：${String(error)}`); }
    try { unlistenProgress = await listen<{ processed: number; imported: number; path: string }>('reader-import-progress', event => {
      if (importing) notify(`正在读取 ${event.payload.processed} 项，已导入 ${event.payload.imported} 本 · ${event.payload.path}`, 120000);
    }); } catch { /* The final import result still reports warnings. */ }
  }
  try {
    books = sortBooks(await loadPublicBooks());
    extractLegacyBooks();
    categories = normalizeCategories([...categories, ...new Set(books.flatMap(book => book.category === undefined ? [] : [book.category]))]);
    try { preferenceStore().setItem('reader-categories', JSON.stringify(categories)); } catch { notify('分类暂时无法保存。'); }
    const previous = books.find(book => book.id === lastBook) ?? (lastBook === demo.id ? demo : undefined);
    if (previous) { if (previous.id === demo.id && !books.some(book => book.id === demo.id)) books = sortBooks([...books, demo]); openBook(previous); }
  } catch (error) { notify(`书库读取失败：${String(error)}`); }
  if (isTauri()) {
    try {
      unlistenOpen = await listen<string[]>('reader-open-paths', event => void handleNativePaths(event.payload));
      const paths = await invoke<string[]>('startup_paths');
      if (paths.length) await handleNativePaths(paths);
    } catch (error) { notify(`文件关联初始化失败：${String(error)}`); }
  }
}
void init();
