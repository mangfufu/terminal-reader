import type { Block, Position } from './document';
import './reader.css';

interface Segment { block: number; start: number; end: number; last: boolean }
interface Match { block: number; offset: number }
interface TextPart { node: Text; start: number; end: number }

// Prefix sums keep both scrollbar jumps and height corrections logarithmic even
// for books with hundreds of thousands of short paragraphs.
class Heights {
  private tree: Float64Array;
  private values: Float64Array;
  constructor(values: number[]) {
    this.values = Float64Array.from(values);
    this.tree = new Float64Array(values.length + 1);
    for (let i = 0; i < values.length; i++) {
      const index = i + 1;
      this.tree[index] += values[i];
      const parent = index + (index & -index);
      if (parent < this.tree.length) this.tree[parent] += this.tree[index];
    }
  }
  sum(end: number): number {
    let total = 0;
    for (let i = Math.min(end, this.values.length); i > 0; i -= i & -i) total += this.tree[i];
    return total;
  }
  get(index: number): number { return this.values[index] ?? 0; }
  set(index: number, value: number) {
    const difference = value - this.values[index];
    this.values[index] = value;
    for (let i = index + 1; i < this.tree.length; i += i & -i) this.tree[i] += difference;
  }
  at(y: number): number {
    if (y <= 0) return 0;
    let index = 0;
    let total = 0;
    let step = 1;
    while (step * 2 < this.tree.length) step *= 2;
    for (; step; step >>= 1) {
      const next = index + step;
      if (next < this.tree.length && total + this.tree[next] <= y) {
        index = next; total += this.tree[next];
      }
    }
    return Math.min(index, Math.max(0, this.values.length - 1));
  }
}

/** Continuous reader with bounded DOM size and portable character anchors. */
export class ReaderView {
  private blocks: Block[] = [];
  private segments: Segment[] = [];
  private firstSegments: number[] = [];
  private heights = new Heights([]);
  private mounted = new Map<number, HTMLElement>();
  private virtual = false;
  private first = -1;
  private last = -1;
  private before = document.createElement('div');
  private after = document.createElement('div');
  private query = '';
  private active?: Match;
  private lineHeight = 22;
  private spacing = 22;
  private width = 1;
  private metrics = '';
  private anchor: Position = { block: 0, fraction: 0 };
  private busy = false;
  private disposed = false;
  private observer: ResizeObserver;
  private parts = new WeakMap<HTMLElement, TextPart[]>();

  constructor(
    private reader: HTMLElement,
    private content: HTMLElement,
    private decorate: (element: HTMLElement, blockIndex: number) => void = () => {},
  ) {
    this.before.className = this.after.className = 'reader-spacer';
    this.before.setAttribute('aria-hidden', 'true');
    this.after.setAttribute('aria-hidden', 'true');
    this.reader.addEventListener('scroll', this.onScroll, { passive: true });
    this.observer = new ResizeObserver(() => {
      if (!this.disposed && this.blocks.length && this.layoutKey() !== this.metrics) this.refreshLayout(this.anchor);
    });
    this.observer.observe(reader);
    document.fonts?.addEventListener('loadingdone', this.onFonts);
  }

  setBlocks(blocks: Block[]) {
    this.blocks = blocks;
    this.query = '';
    this.active = undefined;
    this.anchor = { block: 0, fraction: 0 };
    this.segments = [];
    this.firstSegments = [];
    let characters = 0;
    let longest = 0;
    for (const block of blocks) { characters += block.text.length; longest = Math.max(longest, block.text.length); }
    this.virtual = blocks.length > 500 || characters > 150_000 || longest > 8_192;
    blocks.forEach((block, index) => {
      this.firstSegments.push(this.segments.length);
      if (!this.virtual) { this.segments.push({ block: index, start: 0, end: block.text.length, last: true }); return; }
      let start = 0;
      do {
        let end = Math.min(start + 2048, block.text.length);
        // Prefer a natural break. Never separate a UTF-16 surrogate pair.
        if (end < block.text.length) {
          const boundary = Math.max(block.text.lastIndexOf('\n', end), block.text.lastIndexOf(' ', end));
          if (boundary > start + 1536) end = boundary + 1;
          if (/[\uD800-\uDBFF]/.test(block.text[end - 1])) end--;
        }
        this.segments.push({ block: index, start, end, last: end === block.text.length });
        start = end;
      } while (start < block.text.length);
    });
    this.content.classList.toggle('reader-virtual', this.virtual);
    this.content.dataset.virtual = String(this.virtual);
    this.mounted.clear();
    this.first = this.last = -1;
    this.content.replaceChildren();
    this.readMetrics();
    if (this.virtual) {
      this.rebuildHeights();
      this.content.append(this.before, this.after);
      this.updateSpacers();
      this.renderWindow(0);
    } else {
      const fragment = document.createDocumentFragment();
      this.segments.forEach((segment, index) => {
        const element = this.createElement(segment);
        this.mounted.set(index, element);
        fragment.append(element);
      });
      this.content.append(fragment);
    }
    this.reader.scrollTop = 0;
  }

  /** The mounted element at a block; unmounted virtual blocks return undefined. */
  elementFor(index: number): HTMLElement | undefined {
    const first = this.firstSegments[index];
    if (first === undefined) return undefined;
    const direct = this.mounted.get(first);
    if (direct) return direct;
    for (const [segmentIndex, element] of this.mounted) if (this.segments[segmentIndex].block === index) return element;
    return undefined;
  }

  capture(): Position {
    if (!this.segments.length || this.reader.scrollTop <= 0) return this.anchor = { block: 0, fraction: 0 };
    if (this.virtual) this.renderWindow();
    const y = this.reader.getBoundingClientRect().top + this.reader.clientTop;
    let foundIndex = this.virtual ? this.first : 0;
    if (!this.virtual) {
      let low = 0; let high = this.segments.length - 1;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (this.mounted.get(mid)!.getBoundingClientRect().top <= y) low = mid;
        else high = mid - 1;
      }
      foundIndex = low;
    } else {
      for (const [index, element] of this.mounted) {
        if (element.getBoundingClientRect().top <= y) foundIndex = index;
        else break;
      }
    }
    const element = this.mounted.get(foundIndex);
    if (!element) return this.anchor;
    const segment = this.segments[foundIndex];
    const rect = element.getBoundingClientRect();
    const text = this.blocks[segment.block].text;
    const textHeight = Math.max(1, rect.height - (this.virtual && segment.last ? this.segmentSpacing(foundIndex) : 0));
    const fraction = Math.max(0, (y - rect.top) / textHeight);
    const next = this.mounted.get(foundIndex + 1);
    const gapHeight = this.virtual ? this.segmentSpacing(foundIndex) : Math.max(0, (next?.getBoundingClientRect().top ?? rect.bottom) - rect.bottom);
    if (segment.last && y >= rect.top + textHeight && gapHeight > 0) {
      return this.anchor = { block: segment.block, fraction, offset: text.length, gap: Math.min(1, (y - rect.top - textHeight) / gapHeight) };
    }
    const length = segment.end - segment.start;
    if (!length) return this.anchor = { block: segment.block, fraction, offset: 0 };
    let low = 0; let high = length - 1;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      const bounds = this.characterRect(element, mid);
      if (bounds && bounds.bottom > y + 0.25) high = mid;
      else low = mid + 1;
    }
    const bounds = this.characterRect(element, low);
    return this.anchor = {
      block: segment.block, fraction, offset: segment.start + low,
      lineRatio: bounds ? Math.max(-4, Math.min(4, (y - bounds.top) / this.lineHeight)) : 0,
    };
  }

  restore(position: Position) {
    if (!this.segments.length) return;
    const anchor: Position = {
      ...position,
      block: Number.isFinite(position?.block) ? Math.max(0, Math.min(this.blocks.length - 1, Math.floor(position.block))) : 0,
      fraction: Number.isFinite(position?.fraction) ? Math.max(0, position.fraction) : 0,
    };
    if (anchor.block === 0 && anchor.fraction === 0 && !anchor.offset && !anchor.lineRatio && !anchor.gap) {
      this.reader.scrollTop = 0;
      if (this.virtual) this.renderWindow(0);
      this.anchor = anchor;
      return;
    }
    const first = this.firstSegments[anchor.block];
    const end = this.firstSegments[anchor.block + 1] ?? this.segments.length;
    let index = first;
    const hasOffset = Number.isFinite(anchor.offset);
    const offset = hasOffset ? Math.max(0, Math.min(this.blocks[anchor.block].text.length, Math.floor(anchor.offset!))) : 0;
    if (hasOffset) {
      while (index + 1 < end && this.segments[index].end <= offset) index++;
    } else if (this.virtual && end - first > 1) {
      const total = this.heights.sum(end) - this.heights.sum(first);
      index = Math.min(end - 1, this.heights.at(this.heights.sum(first) + total * Math.min(1, anchor.fraction)));
    }
    this.busy = true;
    if (this.virtual) {
      this.reader.scrollTop = this.content.offsetTop + this.heights.sum(index);
      this.renderWindow(index);
    }
    const element = this.mounted.get(index);
    if (element) {
      const segment = this.segments[index];
      const height = element.getBoundingClientRect().height;
      const textHeight = height - (this.virtual ? this.segmentSpacing(index) : 0);
      let target = element.offsetTop;
      if (hasOffset && anchor.gap !== undefined && segment.last) {
        const next = this.mounted.get(index + 1);
        const spacing = this.virtual ? this.segmentSpacing(index) : Math.max(0, (next?.offsetTop ?? (target + textHeight)) - target - textHeight);
        target += textHeight + Math.max(0, Math.min(1, anchor.gap)) * spacing;
      } else if (hasOffset && segment.end > segment.start) {
        const local = Math.max(0, Math.min(segment.end - segment.start - 1, offset - segment.start));
        const rect = this.characterRect(element, local);
        if (rect) target = rect.top - this.reader.getBoundingClientRect().top - this.reader.clientTop + this.reader.scrollTop + (Number.isFinite(anchor.lineRatio) ? anchor.lineRatio! : 0) * this.lineHeight;
      } else {
        const next = this.mounted.get(index + 1);
        const span = this.virtual ? height : next ? next.offsetTop - element.offsetTop : height;
        target += Math.min(span, textHeight * anchor.fraction);
      }
      this.reader.scrollTop = Math.max(0, target);
    }
    this.busy = false;
    if (this.virtual) this.renderWindow();
    this.anchor = anchor;
  }

  refreshLayout(anchor: Position = this.anchor) {
    if (this.disposed || !this.blocks.length) return;
    this.readMetrics();
    if (this.virtual) {
      this.rebuildHeights();
      this.first = this.last = -1;
      this.mounted.clear();
      this.content.replaceChildren(this.before, this.after);
      this.updateSpacers();
    }
    this.restore(anchor);
  }

  refreshColors() {
    for (const [index, element] of this.mounted) this.decorate(element, this.segments[index].block);
  }

  highlight(query: string, active?: Match) {
    this.query = query;
    this.active = active;
    for (const [index, element] of this.mounted) this.fillText(element, this.segments[index]);
  }

  destroy() {
    this.disposed = true;
    this.observer.disconnect();
    this.reader.removeEventListener('scroll', this.onScroll);
    document.fonts?.removeEventListener('loadingdone', this.onFonts);
    this.mounted.clear();
  }

  private onFonts = () => this.refreshLayout(this.anchor);
  private onScroll = () => {
    if (this.busy || this.disposed) return;
    if (this.virtual) this.renderWindow();
    this.capture();
  };

  private layoutKey() {
    const style = getComputedStyle(this.content);
    return [this.content.clientWidth, style.font, style.lineHeight, this.reader.clientHeight].join('|');
  }

  private readMetrics() {
    const style = getComputedStyle(this.content);
    this.lineHeight = parseFloat(style.lineHeight) || (parseFloat(style.fontSize) || 16) * 1.375;
    this.width = Math.max(1, this.content.clientWidth);
    // The tiny-window stylesheet intentionally reduces paragraph whitespace.
    const sample = document.createElement('p');
    sample.textContent = 'M';
    sample.style.visibility = 'hidden';
    const tail = document.createElement('span');
    this.content.append(sample, tail);
    this.spacing = Math.max(0, parseFloat(getComputedStyle(sample).marginBottom) || 0);
    sample.remove(); tail.remove();
    this.metrics = this.layoutKey();
  }

  private rebuildHeights() {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    const style = getComputedStyle(this.content);
    if (context) context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const narrow = context?.measureText('a').width || parseFloat(style.fontSize) * 0.6;
    const wide = context?.measureText('中').width || parseFloat(style.fontSize);
    const values = this.segments.map((segment, index) => {
      const text = this.blocks[segment.block].text;
      let rows = 1; let rowWidth = 0;
      if (!segment.start && ['heading', 'quote'].includes(this.blocks[segment.block].kind)) rowWidth += narrow * 2;
      for (let offset = segment.start; offset < segment.end; offset++) {
        const code = text.charCodeAt(offset);
        if (code === 10) { rows++; rowWidth = 0; continue; }
        const charWidth = code === 9 ? narrow * 4 : code < 256 ? narrow : code >= 0xdc00 && code <= 0xdfff ? 0 : wide;
        if (rowWidth > 0 && rowWidth + charWidth > this.width) { rows++; rowWidth = 0; }
        rowWidth += charWidth;
      }
      return rows * this.lineHeight + this.segmentSpacing(index);
    });
    this.heights = new Heights(values);
  }

  private segmentSpacing(index: number) { return this.segments[index].last && index < this.segments.length - 1 ? this.spacing : 0; }

  private renderWindow(forceIndex?: number) {
    if (!this.virtual || !this.segments.length) return;
    const top = Math.max(0, this.reader.scrollTop - this.content.offsetTop);
    const anchorIndex = forceIndex ?? this.heights.at(top);
    const relative = top - this.heights.sum(anchorIndex);
    const viewTop = forceIndex === undefined ? top : this.heights.sum(forceIndex);
    const overscan = Math.max(600, this.reader.clientHeight);
    const first = this.heights.at(Math.max(0, viewTop - overscan));
    const last = Math.min(this.segments.length - 1, this.heights.at(viewTop + this.reader.clientHeight + overscan) + 1);
    if (first === this.first && last === this.last) return;
    const wasBusy = this.busy;
    this.busy = true;
    const fragment = document.createDocumentFragment();
    fragment.append(this.before);
    const mounted = new Map<number, HTMLElement>();
    for (let index = first; index <= last; index++) {
      const element = this.mounted.get(index) ?? this.createElement(this.segments[index]);
      mounted.set(index, element);
      fragment.append(element);
    }
    fragment.append(this.after);
    this.first = first; this.last = last;
    this.mounted = mounted;
    this.content.replaceChildren(fragment);
    for (const [index, element] of this.mounted) this.heights.set(index, Math.max(1, element.getBoundingClientRect().height));
    this.updateSpacers();
    // Correct only estimates above the visible segment, so newly measured text
    // does not push the reader away from the line they are following.
    if (forceIndex === undefined) this.reader.scrollTop = this.content.offsetTop + this.heights.sum(anchorIndex) + relative;
    this.busy = wasBusy;
  }

  private updateSpacers() {
    this.before.style.height = `${this.heights.sum(Math.max(0, this.first))}px`;
    this.after.style.height = `${Math.max(0, this.heights.sum(this.segments.length) - this.heights.sum(this.last + 1))}px`;
  }

  private createElement(segment: Segment) {
    const block = this.blocks[segment.block];
    const element = document.createElement(block.kind === 'heading' ? 'h2' : block.kind === 'code' ? 'pre' : 'p');
    element.className = block.kind;
    element.dataset.block = String(segment.block);
    element.dataset.offset = String(segment.start);
    if (this.virtual) {
      element.classList.add('reader-segment');
      if (segment.start) element.classList.add('reader-continuation');
      element.style.margin = '0';
      element.style.paddingBottom = `${segment.last && segment.block < this.blocks.length - 1 ? this.spacing : 0}px`;
    }
    this.fillText(element, segment);
    this.decorate(element, segment.block);
    return element;
  }

  private fillText(element: HTMLElement, segment: Segment) {
    const text = this.blocks[segment.block].text.slice(segment.start, segment.end);
    this.parts.delete(element);
    if (!this.query) { element.textContent = text; return; }
    // Search the surrounding text too, so a match crossing a virtual chunk
    // boundary is still highlighted on both sides.
    const source = this.blocks[segment.block].text;
    const start = Math.max(0, segment.start - this.query.length + 1);
    const end = Math.min(source.length, segment.end + this.query.length - 1);
    const haystack = source.slice(start, end);
    // RegExp returns offsets in the original UTF-16 string. Lowercasing the
    // entire source first can change its length for characters such as İ.
    const pattern = new RegExp(this.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
    const fragment = document.createDocumentFragment();
    let copied = segment.start;
    let match = pattern.exec(haystack);
    let count = 0;
    while (match && count++ < 4096) {
      const matchStart = start + match.index;
      const matchEnd = matchStart + match[0].length;
      const from = Math.max(segment.start, matchStart);
      const to = Math.min(segment.end, matchEnd);
      if (to > from && from >= copied) {
        fragment.append(source.slice(copied, from));
        const mark = document.createElement('mark');
        mark.className = 'reader-match';
        if (this.active?.block === segment.block && this.active.offset === matchStart) mark.classList.add('reader-match-current');
        mark.textContent = source.slice(from, to);
        fragment.append(mark);
        copied = to;
      }
      match = pattern.exec(haystack);
    }
    fragment.append(source.slice(copied, segment.end));
    element.replaceChildren(fragment);
  }

  private characterRect(element: HTMLElement, offset: number): DOMRect | undefined {
    let parts = this.parts.get(element);
    if (!parts) {
      parts = [];
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let node: Node | null; let start = 0;
      while ((node = walker.nextNode())) {
        const end = start + (node.textContent?.length ?? 0);
        parts.push({ node: node as Text, start, end });
        start = end;
      }
      this.parts.set(element, parts);
    }
    const part = parts.find(item => offset >= item.start && offset < item.end);
    if (!part) return undefined;
    const range = document.createRange();
    const local = offset - part.start;
    range.setStart(part.node, local);
    range.setEnd(part.node, Math.min(part.node.length, local + 1));
    return range.getClientRects()[0] ?? range.getBoundingClientRect();
  }
}
