export interface ReleaseUpdate { version: string }

/** A quiet startup check. The native side also caches the result per process. */
export class ReleaseUpdates {
  private request?: Promise<ReleaseUpdate | null>;
  constructor(private readonly check: () => Promise<ReleaseUpdate | null>) {}
  once(): Promise<ReleaseUpdate | null> {
    return this.request ??= Promise.resolve().then(this.check).catch(() => null);
  }
}
