export interface Chapter { title: string; block: number; level?: number }
export interface Book {
  id: string; name: string; content: string; format?: 'epub'; title?: string; author?: string;
  blocks?: Block[]; chapters?: Chapter[]; category?: string;
}
export interface Block { text: string; kind: 'paragraph' | 'heading' | 'code' | 'quote' }
export interface Position { block: number; fraction: number; offset?: number; lineRatio?: number; gap?: number }

export function parseDocument(book: Book): Block[] {
  if (book.blocks?.length) return book.blocks;
  const markdown = /\.(md|markdown)$/i.test(book.name);
  const lines = book.content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let fence: string | null = null;
  let code: string[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ text: paragraph.join('\n'), kind: 'paragraph' });
    paragraph = [];
  };
  for (const line of lines) {
    if (markdown && /^\s*(`{3,}|~{3,})/.test(line)) {
      const marker = line.trim()[0];
      if (!fence) { flush(); fence = marker; }
      else if (fence === marker) { blocks.push({ text: code.join('\n'), kind: 'code' }); code = []; fence = null; }
      else code.push(line);
      continue;
    }
    if (fence) { code.push(line); continue; }
    if (!line.trim()) { flush(); continue; }
    if (markdown && /^#{1,6}\s/.test(line)) {
      flush(); blocks.push({ text: line.replace(/^#{1,6}\s+/, ''), kind: 'heading' });
    } else if (markdown && /^>\s?/.test(line)) {
      flush(); blocks.push({ text: line.replace(/^>\s?/, ''), kind: 'quote' });
    } else if (!markdown) {
      blocks.push({ text: line, kind: /^(第.{1,20}[章节卷部]|chapter\s+\d+)/i.test(line.trim()) ? 'heading' : 'paragraph' });
    } else paragraph.push(line);
  }
  flush();
  if (code.length) blocks.push({ text: code.join('\n'), kind: 'code' });
  return blocks;
}

export function chaptersFor(book: Book, blocks: Block[]): Chapter[] {
  if (book.chapters?.length) return book.chapters.filter(chapter => chapter.block >= 0 && chapter.block < blocks.length);
  return blocks.flatMap((block, index) => block.kind === 'heading' ? [{ title: block.text, block: index, level: 1 }] : []);
}

const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
export function sortBooks(books: Book[]): Book[] {
  return [...books].sort((a, b) => collator.compare(a.id, b.id) || a.id.localeCompare(b.id));
}

export const demo: Book = {
  id: 'demo:01', name: '01 夜航.md',
  content: `# 夜航

雨停在十一点四十七分。

陈默推开书店的门时，门楣上的铜铃只响了半声。老人从柜台后抬头，把一张折过两次的纸放进抽屉，像是终于等到了什么人。

“这么晚，还开着？”

“灯亮着，就算开着。”老人说。

屋里比街上暖一些。靠窗的木桌上放着一杯冷茶，杯沿有很淡的水痕。陈默站了一会儿，听见楼上传来一下一下的脚步声。

他原本只是想找个地方避雨。末班车已经走了，手机也在十分钟前关了机。沿河的这条街，他从前来过很多次，却从没注意过这家店。

书架很高，最上层几乎碰到天花板。书脊的颜色褪得不太一样，像许多年份的秋天，被安静地收在一起。

“随便看。”老人指了指里边，“最里面有盏台灯。”

陈默走过两排书架。地板在脚下发出轻响。他看见那盏灯，也看见灯下摊开的一本笔记。

第一页没有名字，只有一行字。

> 如果你读到这里，请先看一眼窗外。

他转过头。

河对岸的楼群不见了。

## 另一边

那里只有一片黑色的水面。远处停着一艘船，船头挂着一盏很小的灯。光在水上拖出一道细线，一直延伸到窗下。

陈默没有立即说话。他又看了一眼笔记，纸张被灯光照得微微发黄，边缘很平整，仿佛刚刚有人把它打开。

“有些路，白天是看不见的。”老人不知什么时候站在了书架尽头。

“那艘船去哪儿？”

“这要看你带着什么上船。”

陈默摸了摸口袋。钥匙、没电的手机，还有一张用了许多年的车票。车票一直夹在钱包里，他几乎已经忘了。

窗外响起短短一声汽笛。

老人把台灯转向窗边。那道光在玻璃上停了一下，又落到陈默手里的票上。模糊的字迹渐渐显出来，终点站的位置却仍是一片空白。

“不着急。”老人说，“你可以再读一页。”

于是他坐了下来。

店里只剩下翻书的声音。每翻过一页，窗外的船就近了一点。那盏小灯始终亮着，像一个耐心等待的句号。

他终于想起，那张车票是在什么时候留下的。

那也是一个雨夜。

而有人曾经告诉他，故事并不总是在离开的地方结束。
`,
};
