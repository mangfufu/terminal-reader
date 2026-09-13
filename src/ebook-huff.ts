import { ByteWriter } from './ebook-bytes';

/** MOBI HUFF/CDIC dictionaries with cycle detection and cached phrases. */
export function huffDecoder(records: Uint8Array[]) {
  const invalid = () => { throw new Error('HUFF/CDIC 字典或压缩数据损坏'); };
  const uint = (bytes: Uint8Array, offset: number, size = 4) => {
    if (offset < 0 || offset + size > bytes.length) return invalid();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return size === 2 ? view.getUint16(offset) : view.getUint32(offset);
  };
  const magic = (bytes: Uint8Array, name: string) => new TextDecoder().decode(bytes.subarray(0, 4)) === name;
  const huff = records[0];
  if (!huff || !magic(huff, 'HUFF')) return invalid();
  const first = uint(huff, 8), second = uint(huff, 12);
  const table = Array.from({ length: 256 }, (_, i) => uint(huff, first + i * 4));
  const ranges = Array.from({ length: 32 }, (_, i) => [uint(huff, second + i * 8), uint(huff, second + i * 8 + 4)]);
  const dictionary: { data: Uint8Array; ready: boolean; active: boolean }[] = [];
  for (const record of records.slice(1)) {
    if (!magic(record, 'CDIC')) return invalid();
    const start = uint(record, 4), total = uint(record, 8), bits = uint(record, 12);
    if (bits > 16 || start < 16) return invalid();
    const count = Math.min(2 ** bits, total - dictionary.length);
    if (count < 0) return invalid();
    for (let i = 0; i < count; i++) {
      const offset = start + uint(record, start + i * 2, 2), size = uint(record, offset, 2);
      const length = size & 0x7fff;
      if (offset + 2 + length > record.length) return invalid();
      dictionary.push({ data: record.subarray(offset + 2, offset + 2 + length), ready: !!(size & 0x8000), active: false });
    }
  }
  function decode(bytes: Uint8Array, depth = 0): Uint8Array {
    if (depth > 32) return invalid();
    const output = new ByteWriter();
    for (let bit = 0; bit < bytes.length * 8;) {
      const start = bit >>> 3, shift = bit & 7;
      // At most five bytes cover the next 32 bits; absent padding bytes are zero.
      let window = 0n;
      for (let i = 0; i < 5; i++) window = (window << 8n) | BigInt(bytes[start + i] ?? 0);
      const value = Number((window >> BigInt(8 - shift)) & 0xffffffffn);
      const entry = table[value >>> 24]; let length = entry & 31, maximum = entry >>> 8;
      if (!length) return invalid();
      if (!(entry & 128)) {
        while (length <= 32 && (value >>> (32 - length)) < ranges[length - 1][0]) length++;
        if (length > 32) return invalid();
        maximum = ranges[length - 1][1];
      }
      bit += length; if (bit > bytes.length * 8) break;
      const phrase = dictionary[maximum - (value >>> (32 - length))];
      if (!phrase || phrase.active) return invalid();
      if (!phrase.ready) {
        phrase.active = true; phrase.data = decode(phrase.data, depth + 1); phrase.active = false; phrase.ready = true;
      }
      output.append(phrase.data);
    }
    return output.finish();
  }
  return decode;
}
