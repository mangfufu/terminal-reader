import type { Block, Position } from './document';
export interface SearchMatch { block: number; offset: number; length: number; excerpt: string }
export async function searchBlocks(blocks: Block[], query: string, signal: AbortSignal): Promise<{ matches: SearchMatch[]; limited: boolean }> {
  const matches: SearchMatch[] = [];
  if (!query.trim()) return { matches, limited: false };
  const expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  for (let block = 0; block < blocks.length; block++) {
    if (signal.aborted) return { matches: [], limited: false };
    expression.lastIndex = 0;
    for (const match of blocks[block].text.matchAll(expression)) {
      const offset = match.index!;
      if (matches.length === 2000) return { matches, limited: true };
      matches.push({ block, offset, length: match[0].length, excerpt: blocks[block].text.slice(Math.max(0, offset - 24), offset + match[0].length + 64).replace(/\s+/g, ' ') });
    }
    if (block % 300 === 299) await new Promise(resolve => setTimeout(resolve, 0));
  }
  return { matches, limited: false };
}
export function validPosition(value: unknown): value is Position {
  if (!value || typeof value !== 'object') return false;
  const p = value as Position;
  return Number.isInteger(p.block) && p.block >= 0 && Number.isFinite(p.fraction) && p.fraction >= 0
    && (p.offset === undefined || (Number.isInteger(p.offset) && p.offset >= 0))
    && (p.lineRatio === undefined || Number.isFinite(p.lineRatio)) && (p.gap === undefined || Number.isFinite(p.gap));
}
export function keyboardList(list: HTMLElement) {
  list.setAttribute('role', 'listbox');
  const rows = Array.from(list.querySelectorAll<HTMLButtonElement>(':scope > button'));
  const select = (index: number, focus = true) => {
    rows.forEach((row, i) => { row.tabIndex = i === index ? 0 : -1; row.setAttribute('aria-selected', String(i === index)); });
    if (focus) { rows[index]?.focus({ preventScroll: true }); rows[index]?.scrollIntoView({ block: 'nearest' }); }
  };
  rows.forEach((row, i) => { row.setAttribute('role', 'option'); row.onfocus = () => select(i, false); });
  select(0, false);
  list.onkeydown = e => {
    if (e.isComposing || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const index = rows.indexOf(document.activeElement as HTMLButtonElement);
    const step: Record<string, number> = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: rows.length - 1, PageDown: index + 5, PageUp: index - 5 };
    if (e.key in step) { e.preventDefault(); select(Math.max(0, Math.min(rows.length - 1, step[e.key]))); }
  };
}
