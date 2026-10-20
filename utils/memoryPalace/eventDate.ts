/** Event dates retain their source precision; never substitute an insertion timestamp. */
export function normalizeEventDate(value: unknown): string | undefined {
    if (typeof value !== 'string' || !/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(value)) return undefined;
    const [year, month, day] = value.split('-').map(Number);
    if (!year || (month !== undefined && (month < 1 || month > 12))) return undefined;
    if (day !== undefined) {
        const date = new Date(`${value}T00:00:00Z`);
        if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return undefined;
    }
    return value;
}

export function memoryEventDate(memory: { content: string; metadata?: Record<string, unknown> }): string | undefined {
    // Explicit structured metadata is authoritative, including an explicit unknown date.
    if (memory.metadata && 'event_date' in memory.metadata) return normalizeEventDate(memory.metadata.event_date);
    return normalizeEventDate(/^\[(\d{4}(?:-\d{2}(?:-\d{2})?)?)\](?:\r?\n|$)/.exec(memory.content)?.[1]);
}

export function queryEventDates(query: string): string[] {
    const dates = [...query.matchAll(/(?<!\d)(\d{4})(?:[-年](\d{1,2})(?:[-月](\d{1,2})日?)?月?|年)(?!\d)/g)]
        .map(match => normalizeEventDate([match[1], ...match.slice(2, 4).filter(Boolean).map(part => part.padStart(2, '0'))].join('-')))
        .filter((date): date is string => !!date);
    return [...new Set(dates)].slice(0, 4);
}

export function matchesEventDate(memory: { content: string; metadata?: Record<string, unknown> }, query: string): boolean {
    const date = memoryEventDate(memory);
    return !!date && (date === query || date.startsWith(`${query}-`));
}

/** CF endpoint supports indexed metadata or a legacy canonical leading date header. */
export async function fetchEventDateMemories(
    cloud: { supabaseUrl: string; supabaseAnonKey: string }, charId: string, dates: string[],
): Promise<any[]> {
    if (!dates.length || !new URL(cloud.supabaseUrl).hostname.endsWith('.workers.dev')) return [];
    const groups = await Promise.all(dates.map(async date => {
        const params = new URLSearchParams({ char_id: `eq.${charId}`, event_date: date, archived: 'eq.false', limit: '24', order: 'importance.desc,memory_id.asc' });
        const response = await fetch(`${cloud.supabaseUrl.replace(/\/+$/, '')}/rest/v1/memory_vectors?${params}`, {
            headers: { apikey: cloud.supabaseAnonKey, Authorization: `Bearer ${cloud.supabaseAnonKey}` },
            signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) throw new Error(`事件日期检索失败（HTTP ${response.status}），请更新记忆服务`);
        const rows = await response.json();
        if (!Array.isArray(rows)) throw new Error('事件日期检索响应无效');
        return rows.filter(row => row.char_id === charId && !row.archived && matchesEventDate(row, date));
    }));
    return [...new Map(groups.flat().map(row => [row.memory_id, row])).values()].slice(0, 24);
}
