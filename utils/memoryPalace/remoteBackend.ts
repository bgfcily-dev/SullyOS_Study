/** Custom domains are enabled only after the authenticated health check identifies the backend. */
export function reviewedBackendKey(url: URL): string {
    return `reviewed-memory-backend:v1:${url.origin}`;
}

export function isReviewedMemoryBackend(address: string): boolean {
    try {
        const url = new URL(address);
        return localStorage.getItem(reviewedBackendKey(url)) === '1';
    } catch { return false; }
}
