/** Account-managed provider keys are reissued by authenticated account reads, never restored from config. */
const keys = new Map<string, string>();
export const HUANGGUA_PROVIDER_PREFIX = 'huanggua-account-';

export function isHuangguaManagedProvider(id: string, provider: unknown): boolean {
  return id.startsWith(HUANGGUA_PROVIDER_PREFIX) && typeof provider === 'object' && provider !== null
    && Reflect.get(provider, 'managedBy') === 'huanggua-account';
}

export function replaceHuangguaCredentials(entries: ReadonlyArray<readonly [string, string]>): void {
  keys.clear();
  for (const [id, key] of entries) keys.set(id, key);
}

export function hydrateHuangguaProviders<T extends Record<string, unknown>>(providers: T): T {
  return Object.fromEntries(Object.entries(providers).map(([id, provider]) => {
    if (!isHuangguaManagedProvider(id, provider)) return [id, provider];
    const result = { ...(provider as Record<string, unknown>), apiKey: keys.get(id) ?? '' };
    Reflect.deleteProperty(result, 'apiKeyRef');
    Reflect.deleteProperty(result, 'apiKeyRevision');
    return [id, result];
  })) as T;
}
