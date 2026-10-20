import { memoryEventDate, normalizeEventDate } from './eventDate';
/** Shared contract for newly extracted memories. Existing records stay unclassified. */
export interface MemoryMetadata extends Record<string, unknown> {
    kind?: 'event' | 'reflection' | 'identity';
    event_id?: string;
    previous_id?: string;
    current_reflection_id?: string;
    status?: string;
    confidence?: number;
    event_date?: string;
}

export function readMemoryMetadata(value: unknown): MemoryMetadata | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? { ...value as MemoryMetadata } : undefined;
}

export const NEW_MEMORY_METADATA_RULES = `新增记忆必须区分事实、感想和身份记录，每条输出 metadata：
- event_date 可选：事件发生或计划发生的日期，格式 YYYY-MM-DD、YYYY-MM 或 YYYY；只保留原文有依据的精度，未知省略。不得用整理/入库时间代替，不得猜测相对日期。事实与计划状态仍保留在正文。
- kind="event"：只写发生了什么、谁说了什么；传闻写成“某人说……”，不要把动机猜测或感受混成事实。
- kind="reflection"：只记录角色在这批新对话中明确表达、值得保留的理解或感受；不能由整理模型补造心理活动。先输出对应 event，再输出可选 reflection。metadata.event_id 暂用 "N0"、"N1" 等引用本批记忆条目的零基序号（不含控制指令）；程序保存时替换为真实 ID。每个新事件最多一条首次感想，没有感想就不生成，不必写“没想法”。不理解、情绪不确定都可以如实记录。
- kind="identity"：只记录对话明确说明的设备/模型迁移、恢复或分叉；不得把普通自我认识标成身份迁移，也不得猜测旧实例已停用或没有信息损失。
- confidence 可选，0–1，只在有依据时给出；未知则省略，不能为填字段编造数值。它与 importance 重要度、情绪强度不同。
- status 由程序设为 active。不要自行输出 previous_id 或 current_reflection_id，也不要引用旧事件来自动追加感想；本次仅生成新的记忆。
- 原有 room、importance、mood、tags 字段继续提供。event/identity 的 mood 使用 neutral；主观情绪写到 reflection。`;

/** Resolve batch-only N references. No model-written IDs may mutate existing events. */
export function buildNewMemoryMetadata(drafts: Array<{ metadata?: unknown; content?: string }>, ids: string[]): MemoryMetadata[] {
    if (drafts.length !== ids.length) throw new Error('记忆条目与 ID 数量不一致');
    const result = drafts.map((draft): MemoryMetadata => {
        const input = readMemoryMetadata(draft.metadata);
        const rawKind = input?.kind;
        const kind = rawKind === undefined ? 'event' : rawKind;
        if (!['event', 'reflection', 'identity'].includes(kind)) throw new Error('记忆 metadata.kind 无效，请重新整理');
        const metadata: MemoryMetadata = { kind, status: 'active' };
        const eventDate = normalizeEventDate(input?.event_date) ?? memoryEventDate({ content: draft.content || '', metadata: input });
        if (eventDate) metadata.event_date = eventDate;
        if (typeof input?.confidence === 'number' && Number.isFinite(input.confidence)
            && input.confidence >= 0 && input.confidence <= 1) metadata.confidence = input.confidence;
        return metadata;
    });
    drafts.forEach((draft, index) => {
        if (result[index].kind !== 'reflection') return;
        const ref = readMemoryMetadata(draft.metadata)?.event_id;
        const match = typeof ref === 'string' ? /^N(\d+)$/.exec(ref) : null;
        const target = match ? Number(match[1]) : -1;
        if (target < 0 || target >= index || result[target]?.kind !== 'event') {
            throw new Error('感想必须关联本批前面的一条事实（metadata.event_id 如 N0），请重新整理');
        }
        if (result[target].current_reflection_id) throw new Error('同一新事件只能生成一条首次感想，请重新整理');
        result[index].event_id = ids[target];
        result[target].current_reflection_id = ids[index];
    });
    return result;
}
