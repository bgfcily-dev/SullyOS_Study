import { useState } from 'react';
import { cached, exchange, fields, labels, type Profile, type Cloud } from './cognition';

const placeholders = {
    self: '我是谁，以及我怎样理解自己的性格、身份和价值取向。',
    relationship: '我与用户当前的关系，以及我对此的理解或感受。',
    user: '用户明确的身份，以及我对用户最核心的印象。',
};

interface CognitionPanelProps {
    cloud: Cloud;
    id: string;
    generate?: (profile: Profile) => Promise<Profile>;
    appearance?: 'cookie' | 'sully';
}

export function CognitionPanel({ cloud, id, generate, appearance = 'cookie' }: CognitionPanelProps) {
    const [draft, setDraft] = useState(() => cached(cloud, id));
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState('');
    const [failed, setFailed] = useState(false);
    const sully = appearance === 'sully';

    async function run(action: 'receive' | 'generate' | 'save') {
        setBusy(true);
        setFailed(false);
        setNotice('');
        try {
            const next = action === 'generate' && generate
                ? await generate(draft)
                : await exchange(cloud, id, action === 'save' ? draft : undefined);
            setDraft(next);
            setNotice(action === 'generate' ? '草稿已生成，检查后可保存到云端。'
                : action === 'save' ? '已保存并用于后续对话。'
                : next.revision ? '已接收云端认知。' : '云端还没有这位角色的认知档案。');
        } catch (error) {
            setFailed(true);
            setNotice(error instanceof Error ? error.message : String(error));
        } finally {
            setBusy(false);
        }
    }

    const secondaryButton = sully
        ? 'min-h-[44px] rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-50 transition-colors'
        : 'secondary-button';
    const primaryButton = sully
        ? 'min-h-[44px] w-full rounded-xl bg-indigo-600 px-4 py-3 text-sm font-bold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-50 transition-colors'
        : 'primary-button';

    return (
        <fieldset disabled={busy} aria-label="当前认知" aria-busy={busy}
            className={sully ? 'm-0 min-w-0 space-y-4 border-0 p-0' : 'setting-card cognition-panel'}>
            <div className={sully ? 'rounded-2xl bg-indigo-50 px-4 py-3' : 'setting-card-title'}>
                <div>
                    <strong className={sully ? 'text-sm font-bold text-indigo-900' : undefined}>当前认知</strong>
                    <p className={sully ? 'mt-1 text-xs leading-relaxed text-indigo-700' : 'field-hint'}>
                        每栏一到两句话，可留空。保存后会随角色对话发送。
                    </p>
                </div>
            </div>

            {fields.map(field => (
                <label key={field} className={sully ? 'block' : undefined}>
                    <span className={sully ? 'mb-2 flex items-center justify-between text-sm font-bold text-slate-700' : 'cognition-field-heading'}>
                        <span>{labels[field]}</span>
                        <span className={sully ? 'text-xs font-normal tabular-nums text-slate-400' : 'cognition-field-count'}>{draft[field].length}/240</span>
                    </span>
                    <textarea rows={3} maxLength={240} value={draft[field]} placeholder={placeholders[field]}
                        className={sully ? 'block w-full resize-y rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-sm leading-relaxed text-slate-800 placeholder:text-slate-400 focus:border-indigo-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-100' : undefined}
                        onChange={event => setDraft({ ...draft, [field]: event.target.value })} />
                </label>
            ))}

            <div className={sully ? 'space-y-2 border-t border-slate-100 pt-4' : 'cognition-actions'}>
                <div className={sully ? (generate ? 'grid grid-cols-2 gap-2' : 'grid grid-cols-1') : 'cognition-secondary-actions'}>
                    {generate && <button type="button" className={secondaryButton} onClick={() => void run('generate')}>生成草稿</button>}
                    <button type="button" className={secondaryButton} onClick={() => void run('receive')}>接收云端版本</button>
                </div>
                <button type="button" className={primaryButton} onClick={() => void run('save')}>保存到云端</button>
            </div>
            {(busy || notice) && <p role="status" className={sully
                ? 'rounded-xl px-3 py-2 text-xs leading-relaxed ' + (failed ? 'bg-rose-50 text-rose-700' : 'bg-slate-50 text-slate-600')
                : 'cognition-status' + (failed ? ' cognition-status-error' : '')}>
                {busy ? '处理中…' : notice}
            </p>}
        </fieldset>
    );
}
