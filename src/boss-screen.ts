import { cycleFocus, shortcutFor } from './keyboard';

/** Independent cover: no book names, source paths or real commands are used. */
export class BossScreen {
  readonly element = document.createElement('section');
  nativeKey = '';
  private timer = 0;
  private previousFocus: HTMLElement | null = null;
  private previousInert = false;
  private previousTitle = '';
  private sequence = 0;
  get active() { return !this.element.hidden; }
  constructor(private readonly app: HTMLElement, private readonly key: () => string, private readonly changed: () => void, private readonly canReveal: () => boolean = () => true) {
    this.element.id = 'boss-screen'; this.element.hidden = true; this.element.tabIndex = 0;
    this.element.setAttribute('aria-label', 'Terminal');
    this.element.innerHTML = '<header data-tauri-drag-region><button class="boss-title" type="button">Terminal</button></header><div class="boss-output" aria-live="off"></div><div class="boss-prompt">&gt; <span class="boss-cursor">_</span></div>';
    document.body.append(this.element);
    this.element.querySelector('button')!.ondblclick = () => this.toggle();
    document.addEventListener('keydown', event => {
      if (!this.active && (event.target as HTMLElement)?.closest('[data-hotkey-recorder]')) return;
      if (shortcutFor(event) === this.key()) {
        event.preventDefault(); event.stopImmediatePropagation(); if (!event.repeat && this.nativeKey !== this.key()) this.toggle(); return;
      }
      if (!this.active) return;
      event.stopImmediatePropagation();
      if (event.key === 'Tab') { event.preventDefault(); cycleFocus(this.element, event.shiftKey); }
      else if (!['Alt', 'F4'].includes(event.key)) event.preventDefault();
    }, true);
  }
  cover() { if (!this.active) this.toggle(); }
  toggle() {
    if (this.active) {
      if (!this.canReveal()) return;
      clearInterval(this.timer); this.element.hidden = true;
      this.app.style.visibility = ''; this.app.inert = this.previousInert; this.app.removeAttribute('aria-hidden');
      document.title = this.previousTitle; this.changed();
      if (this.previousFocus?.isConnected && !this.previousFocus.closest('[inert]')) this.previousFocus.focus({ preventScroll: true });
      else (this.app.querySelector<HTMLElement>('#credentials:not([hidden]) input, #file-picker:not([hidden]) input, #panel:not([hidden]) [tabindex="0"], #reader') ?? this.app).focus();
      return;
    }
    this.previousFocus = document.activeElement as HTMLElement; this.previousInert = this.app.inert; this.previousTitle = document.title;
    this.app.style.visibility = 'hidden'; this.app.inert = true; this.app.setAttribute('aria-hidden', 'true');
    document.getSelection()?.removeAllRanges();
    const theme = this.app.dataset.theme;
    const title = theme === 'cmd' ? 'Command Prompt' : theme === 'linux' ? 'dev@workstation: ~' : 'Windows PowerShell';
    this.element.querySelector('.boss-title')!.textContent = title; document.title = title;
    this.element.querySelector('.boss-prompt')!.firstChild!.textContent = theme === 'linux' ? 'dev@workstation:~/workspace$ ' : theme === 'cmd' ? 'C:\\workspace> ' : 'PS C:\\workspace> ';
    this.element.querySelector('.boss-output')!.replaceChildren(); this.sequence = 0;
    for (let i = 0; i < 35; i++) this.line();
    this.element.hidden = false; this.element.focus(); this.changed();
    this.timer = window.setInterval(() => this.line(), 250 + Math.random() * 500);
  }
  private line() {
    const modules = ['runtime', 'scheduler', 'transport', 'worker', 'cache', 'parser', 'renderer', 'service'];
    const module = modules[Math.floor(Math.random() * modules.length)];
    const ms = (1 + Math.random() * 80).toFixed(2);
    const outputs = [
      `[build] compiled src/${module}.ts (${ms} ms)`,
      `[test] ${module}.spec passed (${1 + Math.floor(Math.random() * 30)} assertions)`,
      `[cache] ${module}: hit / checksum verified`,
      `[worker] task ${++this.sequence} completed in ${ms} ms`,
      `[info] health check: ${module} ready`,
      `[build] processing dependencies: ${module}`,
    ];
    const line = document.createElement('div'); const choice = Math.floor(Math.random() * outputs.length);
    line.textContent = `${new Date().toTimeString().slice(0, 8)}  ${outputs[choice]}`;
    line.className = ['boss-info', 'boss-success', 'boss-muted', '', 'boss-info', ''][choice];
    const output = this.element.querySelector('.boss-output')!; output.append(line);
    while (output.children.length > 90) output.firstElementChild!.remove();
    output.scrollTop = output.scrollHeight;
  }
}
