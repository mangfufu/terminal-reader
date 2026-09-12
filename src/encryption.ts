const ITERATIONS = 310_000;
const MAX_BYTES = 128 * 1024 * 1024;
export interface EncryptedData {
  format: 'terminal-reader-encrypted'; version: 1; kdf: 'PBKDF2-SHA256'; iterations: number;
  salt: string; iv: string; ciphertext: string;
}
export interface EncryptionKey { key: CryptoKey; salt: string; iterations: number }
function encode(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 16384) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 16384)));
  return btoa(chunks.join(''));
}
function decode(text: string, max: number): Uint8Array<ArrayBuffer> {
  if (typeof text !== 'string' || text.length > Math.ceil(max / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new Error('加密文件字段无效');
  const result = Uint8Array.from(atob(text), c => c.charCodeAt(0));
  if (result.length > max) throw new Error('加密文件过大'); return result;
}
export function encryptedData(value: unknown): EncryptedData {
  const raw = value as EncryptedData;
  if (!raw || raw.format !== 'terminal-reader-encrypted' || raw.version !== 1 || raw.kdf !== 'PBKDF2-SHA256'
    || !Number.isInteger(raw.iterations) || raw.iterations < 100_000 || raw.iterations > 1_000_000
    || decode(raw.salt, 16).length !== 16 || decode(raw.iv, 12).length !== 12 || typeof raw.ciphertext !== 'string' || raw.ciphertext.length > MAX_BYTES) throw new Error('不支持或无效的加密文件');
  return raw;
}
export async function deriveKey(password: string, source?: Pick<EncryptedData, 'salt' | 'iterations'>): Promise<EncryptionKey> {
  if (password.length > 1024) throw new Error('密码过长');
  const salt = source?.salt ?? encode(crypto.getRandomValues(new Uint8Array(16)));
  const iterations = source?.iterations ?? ITERATIONS;
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: decode(salt, 16), iterations, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { key, salt, iterations };
}
export async function seal(value: unknown, source: EncryptionKey): Promise<EncryptedData> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (bytes.length > 90 * 1024 * 1024) throw new Error('内容超过加密文件容量');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, source.key, bytes);
  return { format: 'terminal-reader-encrypted', version: 1, kdf: 'PBKDF2-SHA256', iterations: source.iterations, salt: source.salt, iv: encode(iv), ciphertext: encode(new Uint8Array(ciphertext)) };
}
export async function unseal(raw: EncryptedData, source: EncryptionKey): Promise<unknown> {
  const envelope = encryptedData(raw);
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(envelope.iv, 12) }, source.key, decode(envelope.ciphertext, MAX_BYTES));
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain));
  } catch { throw new Error('密码不正确，或文件已损坏'); }
}
