import type { Book } from './document';
import { validateBook } from './backup';
import { deriveKey, encryptedData, seal, unseal, type EncryptionKey } from './encryption';
import { readVault, writeVault } from './storage';

interface VaultData { version: 1; books: Book[]; preferences: Record<string, string> }
export class Vault {
  private key?: EncryptionKey;
  private data?: VaultData;
  private writes: Promise<void> = Promise.resolve();
  get unlocked() { return !!this.key && !!this.data; }
  async exists() { return (await readVault()) !== undefined; }
  async unlock(password: string, initial: VaultData): Promise<void> {
    const stored = await readVault();
    if (stored === undefined) {
      if (password.length < 8) throw new Error('密码至少需要 8 个字符');
      const key = await deriveKey(password);
      await writeVault(await seal(initial, key), initial.books.map(b => b.id));
      this.key = key; this.data = structuredClone(initial); return;
    }
    const envelope = encryptedData(stored); const key = await deriveKey(password, envelope);
    const raw = await unseal(envelope, key) as VaultData;
    if (raw.version !== 1 || !Array.isArray(raw.books) || raw.books.length > 10000 || !raw.preferences || typeof raw.preferences !== 'object' || Object.entries(raw.preferences).some(([name, value]) => !name.startsWith('reader-') || typeof value !== 'string')) throw new Error('独立书库格式无效');
    this.data = { version: 1, books: raw.books.map(validateBook), preferences: Object.assign(Object.create(null), raw.preferences) }; this.key = key;
  }
  books() { return this.data?.books ?? []; }
  getItem(key: string) { return this.data?.preferences[key] ?? null; }
  setItem(key: string, value: string) { if (!this.data) throw new Error('书库已锁定'); this.data.preferences[key] = value; }
  removeItem(key: string) { if (this.data) delete this.data.preferences[key]; }
  async saveBooks(books: Book[], removePublic: string[] = []) {
    if (!this.data) throw new Error('书库已锁定');
    const previous = this.data.books;
    this.data.books = [...new Map([...previous, ...books.map(validateBook)].map(b => [b.id, b])).values()];
    try { await this.flush(removePublic); } catch (error) { this.data.books = previous; throw error; }
  }
  async deleteBooks(ids: string[]) {
    if (!this.data) throw new Error('书库已锁定');
    const previous = this.data.books; this.data.books = previous.filter(b => !ids.includes(b.id));
    try { await this.flush(); } catch (error) { this.data.books = previous; throw error; }
  }
  flush(removePublic: string[] = []): Promise<void> {
    if (!this.key || !this.data) return Promise.reject(new Error('书库已锁定'));
    const snapshot = structuredClone(this.data); const key = this.key;
    const result = this.writes.catch(() => {}).then(async () => writeVault(await seal(snapshot, key), removePublic));
    this.writes = result; return result;
  }
  async encryptedBackup(value: unknown) { if (!this.key) throw new Error('书库已锁定'); return seal(value, this.key); }
  async lock() { try { await this.flush(); } finally { this.key = undefined; this.data = undefined; } }
}
