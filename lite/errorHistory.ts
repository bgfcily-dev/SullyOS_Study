export interface SavedError { id: string; createdAt: number; detail: string }
const STORAGE_KEY = 'cookie_error_history_v1';
export const ERROR_HISTORY_LIMIT = 20;
export function errorDetail(text: string, secrets: string[] = []): string {
    let detail = text || '未知错误';
    for (const secret of secrets.filter(value => value.length >= 4)) detail = detail.split(secret).join('[密钥已隐藏]');
    detail = detail.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [已隐藏]');
    return detail.length > 8000 ? `${detail.slice(0, 8000)}\n[内容过长，仅保留前 8000 字]` : detail;
}
export function loadErrorHistory(): SavedError[] {
    try {
        const values: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
        if (!Array.isArray(values)) return [];
        return values.filter((value): value is SavedError => !!value && typeof value.id === 'string' && typeof value.detail === 'string' && typeof value.createdAt === 'number' && Number.isFinite(value.createdAt)).slice(0, ERROR_HISTORY_LIMIT).map(value => ({ ...value, detail: errorDetail(value.detail) }));
    } catch { return []; }
}
export function saveErrorHistory(values: SavedError[]): void {
    try { if (values.length) localStorage.setItem(STORAGE_KEY, JSON.stringify(values.slice(0, ERROR_HISTORY_LIMIT))); else localStorage.removeItem(STORAGE_KEY); } catch { /* Keep the current session's errors when browser storage is full. */ }
}
