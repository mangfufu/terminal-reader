import { parseEbook } from './ebook-parser';

self.onmessage = async ({ data }: MessageEvent<{ name: string; bytes: Uint8Array }>) => {
  try { self.postMessage({ book: await parseEbook(data.name, data.bytes) }); }
  catch (error) { self.postMessage({ error: error instanceof Error ? error.message : '电子书解析失败' }); }
};
