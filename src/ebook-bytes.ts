/** Grow on demand instead of preallocating or imposing a decompressed-book limit. */
export class ByteWriter {
  private bytes = new Uint8Array(4096);
  length = 0;
  private reserve(extra: number) {
    if (this.length + extra <= this.bytes.length) return;
    const next = new Uint8Array(Math.max(this.bytes.length * 2, this.length + extra));
    next.set(this.bytes); this.bytes = next;
  }
  put(value: number) { this.reserve(1); this.bytes[this.length++] = value; }
  append(value: Uint8Array) { this.reserve(value.length); this.bytes.set(value, this.length); this.length += value.length; }
  get(index: number) { return this.bytes[index]; }
  finish() { return this.bytes.slice(0, this.length); }
}
