/** Display-only pet. Canvas masks leave the source, selection and reading anchors intact. */
export class TerminalDog {
  private canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d')!;
  private frame = 0;
  private last = 0;
  private x = 24;
  private y = 42;
  private facing = 1;
  private target?: { x: number; y: number; range?: Range };
  private eaten: { range: Range; until: number }[] = [];
  private droppings: { x: number; y: number; until: number }[] = [];
  private state: 'run' | 'eat' | 'squat' = 'run';
  private until = 0;
  private enabled = false;
  private reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  private observer: MutationObserver;
  private resize: ResizeObserver;

  constructor(private host: HTMLElement, private reader: HTMLElement, private content: HTMLElement, private blocked: () => boolean) {
    this.canvas.className = 'terminal-dog'; this.canvas.setAttribute('aria-hidden', 'true'); this.canvas.hidden = true;
    host.append(this.canvas);
    this.observer = new MutationObserver(this.reset);
    this.observer.observe(content, { childList: true, subtree: true, characterData: true });
    this.resize = new ResizeObserver(this.reset); this.resize.observe(reader);
    reader.addEventListener('scroll', this.reset, { passive: true });
    document.addEventListener('visibilitychange', this.visibility);
  }
  get active() { return this.enabled; }
  toggle() { this.enabled = !this.enabled; this.reset(); this.visibility(); return this.enabled; }
  reset = () => {
    this.target = undefined; this.eaten = []; this.droppings = []; this.state = 'run';
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  };
  private visibility = () => {
    cancelAnimationFrame(this.frame); this.last = 0;
    this.canvas.hidden = !this.enabled || document.hidden;
    if (!this.canvas.hidden) this.frame = requestAnimationFrame(this.tick);
  };
  private chooseTarget(bounds: DOMRect, height: number) {
    const candidates: { x: number; y: number; range: Range }[] = [];
    let examined = 0;
    if (!this.content.hidden) for (const element of this.content.children) {
      const box = element.getBoundingClientRect();
      if (box.bottom < bounds.top || box.top > bounds.top + height) continue;
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode()) && examined < 5000 && candidates.length < 40) {
        const text = node.textContent ?? '';
        for (let i = 0; i < text.length && examined++ < 5000 && candidates.length < 40; i++) {
          if (!/[，。！？；：、,.!?;:]/.test(text[i])) continue;
          if (this.eaten.some(item => item.range.startContainer === node && item.range.startOffset === i)) continue;
          const range = document.createRange(); range.setStart(node, i); range.setEnd(node, i + 1);
          const rect = range.getBoundingClientRect();
          const x = rect.left - bounds.left + rect.width / 2, y = rect.top - bounds.top + rect.height / 2;
          if (rect.width && x >= 24 && x <= bounds.width - 24 && y >= 20 && y <= height - 20) candidates.push({ x, y, range });
        }
      }
      if (examined >= 5000 || candidates.length >= 40) break;
    }
    return candidates.length ? candidates[Math.floor(Math.random() * candidates.length)] : {
      x: 24 + Math.random() * Math.max(0, bounds.width - 48), y: 20 + Math.random() * Math.max(0, height - 40),
    };
  }
  private tick = (time: number) => {
    if (!this.enabled || document.hidden) return;
    this.frame = requestAnimationFrame(this.tick);
    if (time - this.last < 32) return;
    const elapsed = Math.min((time - (this.last || time)) / 1000, 0.06); this.last = time;
    this.canvas.hidden = this.blocked() || !!document.getSelection()?.toString();
    if (this.canvas.hidden) { this.reset(); return; }
    const bounds = this.host.getBoundingClientRect();
    const height = Math.max(0, this.host.querySelector('footer')!.getBoundingClientRect().top - bounds.top);
    if (bounds.width < 50 || height < 42) { this.canvas.hidden = true; return; }
    const ratio = Math.min(devicePixelRatio || 1, 2), ctx = this.ctx;
    if (this.canvas.width !== Math.round(bounds.width * ratio) || this.canvas.height !== Math.round(height * ratio)) {
      this.canvas.width = Math.round(bounds.width * ratio); this.canvas.height = Math.round(height * ratio);
      this.canvas.style.width = `${bounds.width}px`; this.canvas.style.height = `${height}px`;
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0, 0, bounds.width, height);
    this.x = Math.max(24, Math.min(bounds.width - 24, this.x)); this.y = Math.max(20, Math.min(height - 20, this.y));
    if (!this.reducedMotion.matches) {
      if (this.state === 'run') {
        this.target ??= this.chooseTarget(bounds, height);
        const dx = this.target.x - this.x, dy = this.target.y - this.y, distance = Math.hypot(dx, dy);
        this.facing = dx >= 0 ? 1 : -1;
        const step = Math.min(distance, elapsed * 115);
        if (distance > 2) { this.x += dx / distance * step; this.y += dy / distance * step; }
        else if (this.target.range?.startContainer.isConnected) {
          this.eaten.push({ range: this.target.range, until: time + 16000 }); this.eaten = this.eaten.slice(-24);
          this.state = 'eat'; this.until = time + 550; this.target = undefined;
        } else this.target = undefined;
      } else if (time >= this.until) {
        if (this.state === 'eat') { this.state = 'squat'; this.until = time + 700; }
        else {
          this.droppings.push({ x: this.x - this.facing * 19, y: this.y + 12, until: time + 12000 });
          this.droppings = this.droppings.slice(-8); this.state = 'run';
        }
      }
    }
    this.eaten = this.eaten.filter(item => item.until > time && item.range.startContainer.isConnected);
    ctx.fillStyle = getComputedStyle(this.host).backgroundColor;
    for (const { range } of this.eaten) {
      const rect = range.getBoundingClientRect(); ctx.fillRect(rect.left - bounds.left, rect.top - bounds.top, rect.width, rect.height);
    }
    this.droppings = this.droppings.filter(item => item.until > time);
    for (const item of this.droppings) this.pixels(['..b..', '.bbb.', 'bbbbb', 'ddddd'], item.x, item.y, { b: '#a87944', d: '#69452b' });
    ctx.save(); ctx.translate(Math.round(this.x), Math.round(this.y)); ctx.scale(this.facing, 1);
    const bounce = this.state === 'run' && !this.reducedMotion.matches ? Math.floor(time / 120) % 2 : 0;
    ctx.translate(-20, -12 + bounce + (this.state === 'squat' ? 4 : 0));
    this.pixels(['............dd..dd..', '............ddbbbd..', '.b.........bbbbwbb..', 'bb.........bbbbwkb..', '.bb.bbbbbbbbbwwwwkk.', '..bbbbbbbbbbbbwww...', '...bbbbbbbbbbbbbr...', '...bbbbbbbbbbbb.....', '....bbwwwwwwbb......', bounce ? '.....bb.....bb......' : '....bb.......bb.....', bounce ? '.....dd.....dd......' : '....dd.......dd.....'], 0, 0,
      { b: '#d5a365', d: '#795237', w: '#fff0d0', k: '#28201c', r: '#dc7667' });
    ctx.restore();
    this.canvas.dataset.state = this.state; this.canvas.dataset.eaten = String(this.eaten.length); this.canvas.dataset.droppings = String(this.droppings.length);
  };
  private pixels(rows: string[], x: number, y: number, palette: Record<string, string>) {
    rows.forEach((row, j) => [...row].forEach((pixel, i) => {
      if (palette[pixel]) { this.ctx.fillStyle = palette[pixel]; this.ctx.fillRect(Math.round(x) + i * 2, Math.round(y) + j * 2, 2, 2); }
    }));
  }
  dispose() {
    this.enabled = false; cancelAnimationFrame(this.frame); this.observer.disconnect(); this.resize.disconnect();
    this.reader.removeEventListener('scroll', this.reset); document.removeEventListener('visibilitychange', this.visibility); this.canvas.remove();
  }
}
