import type { RemoteVectorConfig } from './types';
import { reviewedBackendKey } from './remoteBackend';

const policies = new Map<string, { disabled: boolean; expires: number }>();

/** Read-only: checking a policy never migrates or edits memories. */
export async function areEventBoxesDisabled(charId: string, config?: RemoteVectorConfig): Promise<boolean> {
    if (!config) {
        try { config = JSON.parse(localStorage.getItem('os_remote_vector_config') || 'null') || undefined; } catch { return false; }
    }
    if (!config?.enabled || !config.initialized) return false;
    let base: URL;
    try { base = new URL(config.supabaseUrl); } catch { return false; }
    if (!['http:', 'https:'].includes(base.protocol) || base.hostname.endsWith('.supabase.co')) return false;
    const key = JSON.stringify([base.href, config.supabaseAnonKey, charId]);
    const cached = policies.get(key);
    if (cached && cached.expires > Date.now()) return cached.disabled;
    const persistenceKey = reviewedBackendKey(base);
    let disabled = false;
    try { disabled = localStorage.getItem(persistenceKey) === '1'; } catch { /* optional */ }
    try {
        const response = await fetch(new URL('/health', base), { headers: { apikey: config.supabaseAnonKey, Authorization: `Bearer ${config.supabaseAnonKey}` }, signal: AbortSignal.timeout(10_000) });
        if (response.ok) {
            const health = await response.json() as { backend?: string; capabilities?: unknown };
            disabled = (base.hostname.endsWith('.workers.dev') || health.backend === 'cloudflare-memory-sync')
                && Array.isArray(health.capabilities) && health.capabilities.includes('confirmed_memory_changes_v1');
            if (disabled) { try { localStorage.setItem(persistenceKey, '1'); } catch { /* optional */ } }
        }
    } catch { /* Keep the known new mode offline. */ }
    policies.set(key, { disabled, expires: Date.now() + 60_000 });
    if (policies.size > 32) policies.delete(policies.keys().next().value!);
    return disabled;
}
