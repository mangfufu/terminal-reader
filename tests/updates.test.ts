import { describe, expect, it, vi } from 'vitest';
import { ReleaseUpdates } from '../src/updates';

describe('startup release check', () => {
  it('shares concurrent requests and checks only once during a session', async () => {
    const check = vi.fn(async () => ({ version: '0.7.0' }));
    const updates = new ReleaseUpdates(check);
    expect(await Promise.all([updates.once(), updates.once()])).toEqual([{ version: '0.7.0' }, { version: '0.7.0' }]);
    await updates.once();
    expect(check).toHaveBeenCalledTimes(1);
  });
  it('silently caches no-update results, offline failures and synchronous errors', async () => {
    for (const check of [vi.fn(async () => null), vi.fn(async () => { throw new Error('offline'); }), vi.fn(() => { throw new Error('unavailable'); })]) {
      const updates = new ReleaseUpdates(check);
      expect(await updates.once()).toBeNull();
      expect(await updates.once()).toBeNull();
      expect(check).toHaveBeenCalledTimes(1);
    }
  });
});
