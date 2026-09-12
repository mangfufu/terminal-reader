import { describe, it, expect } from 'vitest';
import { deriveKey, seal, unseal, encryptedData } from '../src/encryption';
import { parseCommand } from '../src/terminal-command';
import { ReadingProgress } from '../src/progress';

describe('encrypted content', () => {
  it('uses fresh nonces and rejects wrong passwords, tampering and excessive KDF work', async () => {
    const key = await deriveKey('correct-password');
    const value = { books: [{ content: 'private content', name: 'private title' }] };
    const one = await seal(value, key); const two = await seal(value, key);
    expect(one.iv).not.toEqual(two.iv); expect(JSON.stringify(one)).not.toContain('private');
    expect(await unseal(one, await deriveKey('correct-password', one))).toEqual(value);
    await expect(unseal(one, await deriveKey('wrong-password', one))).rejects.toThrow('密码不正确');
    await expect(unseal({ ...one, ciphertext: (one.ciphertext[0] === 'A' ? 'B' : 'A') + one.ciphertext.slice(1) }, key)).rejects.toThrow();
    expect(() => encryptedData({ ...one, iterations: 10000001 })).toThrow();
  });
});
describe('terminal commands and chapter positions', () => {
  it('preserves quoted Unicode paths and Windows separators', () => {
    expect(parseCommand('type "C:\\My Books\\中文.txt"')).toEqual({ name: 'type', argument: 'C:\\My Books\\中文.txt' });
    expect(parseCommand('/cat "a b.txt"')).toEqual({ name: 'cat', argument: 'a b.txt' });
    expect(parseCommand('goto 35%')).toEqual({ name: 'goto', argument: '35%' });
  });
  it('anchors percentage jumps to text and isolates chapter progress', () => {
    const blocks = Array.from({length: 10}, () => ({text:'x'.repeat(99),kind:'paragraph' as const}));
    const model = new ReadingProgress(blocks, [{title:'one',block:0},{title:'two',block:5}]);
    expect(model.target(75)).toEqual({block:7,offset:50,fraction:0});
    expect(model.at(model.target(75))).toMatchObject({percent:75,chapter:'two',chapterPercent:50});
    expect(model.target(0).block).toBe(0); expect(model.target(100).block).toBe(9);
  });
});
