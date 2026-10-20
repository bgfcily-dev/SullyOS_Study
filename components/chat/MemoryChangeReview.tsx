import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchMemoryChanges, decideMemoryChange, MEMORY_CHANGES_UPDATED, type ChangeCloud } from '../../utils/memoryPalace/changeClient';
import type { ChangeMemory, MemoryChangeProposal } from '../../utils/memoryPalace/changeContract';

export function usePendingMemoryChanges(cloud: ChangeCloud, charId: string, offset = 0) {
    const [state, setState] = useState<{ proposals: MemoryChangeProposal[]; total: number; error: string }>({ proposals: [], total: 0, error: '' });
    const [generation, setGeneration] = useState(0);
    const refresh = useCallback(() => setGeneration(value => value + 1), []);
    useEffect(() => {
        let alive = true;
        setState({ proposals: [], total: 0, error: '' });
        fetchMemoryChanges(cloud, charId, offset).then(value => { if (alive) setState({ ...value, error: '' }); }).catch(error => { if (alive) setState({ proposals: [], total: 0, error: error.message }); });
        return () => { alive = false; };
    }, [cloud.supabaseUrl, cloud.supabaseAnonKey, charId, offset, generation]);
    useEffect(() => {
        const update = (event: Event) => { if (!(event instanceof CustomEvent) || event.detail?.charId === charId) refresh(); };
        window.addEventListener(MEMORY_CHANGES_UPDATED, update); window.addEventListener('focus', refresh);
        return () => { window.removeEventListener(MEMORY_CHANGES_UPDATED, update); window.removeEventListener('focus', refresh); };
    }, [charId, refresh]);
    return { ...state, refresh };
}

export function MemoryChangeNotice(props: { cloud: ChangeCloud; charId: string; onOpen: () => void }) {
    const pending = usePendingMemoryChanges(props.cloud, props.charId);
    if (!pending.total) return null;
    return <button type="button" onClick={props.onOpen} style={{ display: 'block', width: '100%', padding: '10px 14px', textAlign: 'left', border: '1px solid #d8cbff', background: '#f4f0ff', color: '#503677', borderRadius: 12, fontSize: 13 }}>
        建议{pending.proposals[0]?.action === 'revise_reflection' ? '更新感想' : '修改记忆'}：“{pending.proposals[0]?.before.content.slice(0, 42)}{(pending.proposals[0]?.before.content.length || 0) > 42 ? '…' : ''}”<br />
        <small>{pending.total} 条待确认 · 去记忆页查看具体内容</small>
    </button>;
}

export default function MemoryChangeReview(props: { cloud: ChangeCloud; charId: string; embed: (text: string) => Promise<number[]>; model: string; onApplied?: (records: Array<ChangeMemory & Record<string, unknown>>) => Promise<void> | void; onError?: (detail: string) => void }) {
    const [offset, setOffset] = useState(0);
    const pending = usePendingMemoryChanges(props.cloud, props.charId, offset);
    const [busy, setBusy] = useState<string | null>(null);
    const [notice, setNotice] = useState('');
    const scope = JSON.stringify([props.cloud.supabaseUrl, props.cloud.supabaseAnonKey, props.charId]);
    const scopeRef = useRef(scope); scopeRef.current = scope;
    useEffect(() => { setOffset(0); setNotice(''); setBusy(null); }, [props.cloud.supabaseUrl, props.cloud.supabaseAnonKey, props.charId]);
    const decide = async (proposal: MemoryChangeProposal, approve: boolean) => {
        if (busy) return;
        setBusy(proposal.id); setNotice('');
        const decisionScope = scope;
        try {
            const result = await decideMemoryChange({ cloud: props.cloud, proposal, approve, embed: props.embed, model: props.model });
            if (approve && result.records) await props.onApplied?.(result.records);
            if (scopeRef.current !== decisionScope) return;
            setNotice(approve ? '已确认更新，之后的召回使用新版本。' : '已忽略，原记忆保持原样。');
            if (pending.proposals.length === 1 && offset > 0) setOffset(Math.max(0, offset - 50)); else pending.refresh();
        } catch (error: any) { if (scopeRef.current === decisionScope) { const detail = error.message || '更新失败，未确认修改'; setNotice(detail); props.onError?.(detail); } }
        finally { if (scopeRef.current === decisionScope) setBusy(null); }
    };
    return <section id="memory-change-review" style={{ padding: 14, margin: '12px 0', border: '1px solid #ddd4ed', borderRadius: 14, background: '#faf8ff', color: '#382c49' }}>
        <strong>待确认的记忆更新 · {pending.total}</strong>
        <p style={{ fontSize: 12 }}>建议不会自动生效。确认事实修正会保存修改前版本；确认感想更新会追加历史，并切换当前感想。忽略后不会改原记忆。</p>
        {(pending.error || notice) && <p role="status" style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>{notice || pending.error}</p>}
        {!pending.total && !pending.error && <p style={{ fontSize: 12 }}>目前没有待确认建议。</p>}
        {pending.proposals.map(proposal => <article key={proposal.id} style={{ borderTop: '1px solid #e4dcef', padding: '12px 0', overflowWrap: 'anywhere' }}>
            <b>{proposal.action === 'correct_fact' ? '事实修正' : '感想更新'} · {proposal.before.memory_id}</b>
            {proposal.action === 'revise_reflection' && <p style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>关联事实：{proposal.before.content}</p>}
            <p style={{ whiteSpace: 'pre-wrap' }}>修改前：{proposal.action === 'correct_fact' ? proposal.before.content : proposal.current_reflection?.content || '尚无感想'}</p>
            <p style={{ whiteSpace: 'pre-wrap' }}>建议内容：{proposal.content}</p>
            {proposal.confidence !== undefined && <p>置信度：{(proposal.action === 'correct_fact' ? proposal.before : proposal.current_reflection)?.metadata?.confidence ?? '未填写'} → {proposal.confidence}</p>}
            {proposal.mood && <p>情绪标签：{proposal.mood}</p>}
            <p style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>理由：{proposal.reason}</p>
            <div style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>本次对话依据：{proposal.evidence.map((quote, index) => <blockquote key={index}>{quote}</blockquote>)}</div>
            <div style={{ display: 'flex', gap: 10 }}>
                <button type="button" disabled={!!busy} onClick={() => void decide(proposal, true)}>{busy === proposal.id ? '处理中…' : '确认更新'}</button>
                <button type="button" disabled={!!busy} onClick={() => void decide(proposal, false)}>忽略建议</button>
            </div>
        </article>)}
        {pending.total > 50 && <div style={{ display: 'flex', gap: 10 }}><button type="button" disabled={offset === 0 || !!busy} onClick={() => setOffset(value => Math.max(0, value - 50))}>上一页</button><span>{Math.floor(offset / 50) + 1} / {Math.ceil(pending.total / 50)}</span><button type="button" disabled={offset + 50 >= pending.total || !!busy} onClick={() => setOffset(value => value + 50)}>下一页</button></div>}
    </section>;
}
