import type { Block, Chapter, Position } from './document';
export class ReadingProgress {
  private offsets: number[] = [0];
  constructor(private blocks: Block[], private chapters: Chapter[]) {
    for (const block of blocks) this.offsets.push(this.offsets[this.offsets.length - 1] + Math.max(1, block.text.length) + 1);
  }
  at(position: Position) {
    const total = this.offsets[this.offsets.length - 1] || 1;
    const offset = (this.offsets[position.block] ?? 0) + Math.min(this.blocks[position.block]?.text.length ?? 0, position.offset ?? 0);
    let chapter = this.chapters[0]; let next = this.blocks.length;
    for (let i = 0; i < this.chapters.length; i++) if (this.chapters[i].block <= position.block) { chapter = this.chapters[i]; next = this.chapters[i + 1]?.block ?? this.blocks.length; }
    const start = this.offsets[chapter?.block ?? 0] ?? 0; const end = this.offsets[next] ?? total;
    return { percent: Math.max(0, Math.min(100, offset / total * 100)), chapterPercent: Math.max(0, Math.min(100, (offset - start) / Math.max(1, end - start) * 100)), chapter: chapter?.title ?? '正文', chapterFraction: (end - start) / total };
  }
  target(percent: number): Position {
    const total = this.offsets[this.offsets.length - 1] ?? 0;
    const offset = total * Math.max(0, Math.min(100, percent)) / 100;
    let low = 0; let high = this.blocks.length;
    while (low + 1 < high) { const middle = (low + high) >> 1; if (this.offsets[middle] <= offset) low = middle; else high = middle; }
    return { block: low, offset: Math.max(0, Math.min(this.blocks[low]?.text.length ?? 0, Math.floor(offset - this.offsets[low]))), fraction: 0 };
  }
}
