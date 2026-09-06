import React, { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowClockwise,
  CheckCircle,
  Cloud,
  CloudArrowUp,
  Copy,
  GearSix,
  PaperPlaneRight,
  Plus,
  Sparkle,
  Trash,
  WarningCircle,
  X,
} from '@phosphor-icons/react';
import { clearSharedContext, fetchSharedContext, publishSharedContext, SHARED_CONTEXT_SQL, testSharedContextConnection } from './cloud';
import { mergeMessageHistory, newLiteMessage } from './context';
import { requestLiteReply } from './chatApi';
import {
  loadActiveApiId,
  loadApiProfiles,
  loadCloudConfig,
  loadEmbeddingConfig,
  loadIdentity,
  loadLocalMessages,
  saveApiProfiles,
  saveCloudConfig,
  saveEmbeddingConfig,
  saveIdentity,
  saveLocalMessages,
} from './storage';
import { recallLiteMemories } from './memoryRecall';
import type { LiteApiProfile, LiteCloudConfig, LiteEmbeddingConfig, LiteIdentity, LiteMemoryRecall, LiteMessage, SharedRecentContext } from './types';

type Notice = { kind: 'success' | 'error' | 'info'; text: string } | null;

const formatSyncTime = (timestamp: number): string => timestamp
  ? new Intl.DateTimeFormat(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(timestamp)
  : '';

export function LiteApp() {
  const [draft, setDraft] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [apiProfiles, setApiProfiles] = useState<LiteApiProfile[]>(loadApiProfiles);
  const [activeApiId, setActiveApiId] = useState(() => loadActiveApiId(loadApiProfiles()));
  const [identity, setIdentity] = useState<LiteIdentity>(loadIdentity);
  const [cloudConfig, setCloudConfig] = useState<LiteCloudConfig>(loadCloudConfig);
  const [embeddingConfig, setEmbeddingConfig] = useState<LiteEmbeddingConfig>(loadEmbeddingConfig);
  const [localMessages, setLocalMessages] = useState<LiteMessage[]>(loadLocalMessages);
  const [cloudContext, setCloudContext] = useState<SharedRecentContext | null>(null);
  const [cloudBusy, setCloudBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [showSql, setShowSql] = useState(false);
  const [lastRecallCount, setLastRecallCount] = useState(0);
  const messageEndRef = useRef<HTMLDivElement>(null);
  const activeApi = apiProfiles.find((profile) => profile.id === activeApiId) || apiProfiles[0];
  const shownMessages = useMemo(
    () => mergeMessageHistory(cloudContext?.messages || [], localMessages, 100),
    [cloudContext, localMessages],
  );
  const cloudReady = Boolean(cloudConfig.supabaseUrl && cloudConfig.supabaseAnonKey);

  useEffect(() => saveApiProfiles(apiProfiles, activeApiId), [apiProfiles, activeApiId]);
  useEffect(() => saveIdentity(identity), [identity]);
  useEffect(() => saveCloudConfig(cloudConfig), [cloudConfig]);
  useEffect(() => saveEmbeddingConfig(embeddingConfig), [embeddingConfig]);
  useEffect(() => saveLocalMessages(localMessages), [localMessages]);
  useEffect(() => messageEndRef.current?.scrollIntoView({ behavior: 'smooth' }), [shownMessages.length, sending]);

  const refreshCloud = async (quiet = false) => {
    if (!cloudReady) return null;
    setCloudBusy(true);
    try {
      const next = await fetchSharedContext(cloudConfig);
      setCloudContext(next);
      if (!quiet) setNotice({ kind: 'success', text: next ? '已读取最新共享上下文' : '连接成功，云端目前没有共享上下文' });
      return next;
    } catch (error: any) {
      if (!quiet) setNotice({ kind: 'error', text: error?.message || '读取云端上下文失败' });
      return null;
    } finally {
      setCloudBusy(false);
    }
  };

  useEffect(() => {
    if (cloudReady) void refreshCloud(true);
    const onFocus = () => { if (cloudReady) void refreshCloud(true); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  // Only run when the connection target changes; refreshCloud intentionally uses current state.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloudConfig.supabaseUrl, cloudConfig.supabaseAnonKey]);

  const updateActiveApi = (patch: Partial<LiteApiProfile>) => {
    setApiProfiles((current) => current.map((profile) => profile.id === activeApiId ? { ...profile, ...patch } : profile));
  };

  const addApi = () => {
    const next: LiteApiProfile = { id: `api-${Date.now()}`, name: `API ${apiProfiles.length + 1}`, baseUrl: '', apiKey: '', model: '' };
    setApiProfiles((current) => [...current, next]);
    setActiveApiId(next.id);
  };

  const removeApi = () => {
    if (apiProfiles.length <= 1) {
      setNotice({ kind: 'info', text: '至少保留一个 API 配置' });
      return;
    }
    const next = apiProfiles.filter((profile) => profile.id !== activeApiId);
    setApiProfiles(next);
    setActiveApiId(next[0].id);
  };

  const submitMessage = async (event?: FormEvent) => {
    event?.preventDefault();
    const content = draft.trim();
    if (!content || sending) return;
    if (!activeApi?.baseUrl || !activeApi?.apiKey || !activeApi?.model) {
      setNotice({ kind: 'error', text: '请先完成聊天 API 设置' });
      setSettingsOpen(true);
      return;
    }
    setDraft('');
    setNotice(null);
    setSending(true);
    const userMessage = newLiteMessage('user', content);
    const nextLocal = [...localMessages, userMessage];
    setLocalMessages(nextLocal);
    try {
      const latestCloud = cloudReady ? await refreshCloud(true) : cloudContext;
      const activeCloud = latestCloud || cloudContext;
      let memories: LiteMemoryRecall[] = [];
      if (activeCloud?.charId && cloudReady && embeddingConfig.enabled) {
        try {
          memories = await recallLiteMemories({
            charId: activeCloud.charId,
            messages: mergeMessageHistory(activeCloud.messages, nextLocal, 50),
            cloud: cloudConfig,
            embedding: embeddingConfig,
          });
          setLastRecallCount(memories.length);
        } catch (error: any) {
          setLastRecallCount(0);
          setNotice({ kind: 'info', text: `长期记忆暂未读取，本轮仍会继续聊天：${error?.message || '未知错误'}` });
        }
      } else {
        setLastRecallCount(0);
      }
      const reply = await requestLiteReply({ api: activeApi, identity, cloudContext: activeCloud, localMessages: nextLocal, memories });
      setLocalMessages((current) => [...current, newLiteMessage('assistant', reply)]);
    } catch (error: any) {
      setNotice({ kind: 'error', text: error?.message || '生成回复失败' });
    } finally {
      setSending(false);
    }
  };

  const syncToCloud = async () => {
    setCloudBusy(true);
    setNotice(null);
    try {
      const latestCloud = cloudReady ? await fetchSharedContext(cloudConfig) : cloudContext;
      const next = await publishSharedContext({
        config: cloudConfig,
        charId: latestCloud?.charId || cloudContext?.charId || '',
        sharedMessages: latestCloud?.messages || [],
        localMessages,
        previousRevision: latestCloud?.revision || 0,
      });
      setCloudContext(next);
      setNotice({ kind: 'success', text: `已发布第 ${next.revision} 版共享上下文，其他设备现在可以读取` });
    } catch (error: any) {
      setNotice({ kind: 'error', text: error?.message || '同步失败' });
    } finally {
      setCloudBusy(false);
    }
  };

  const testCloud = async () => {
    setCloudBusy(true);
    try {
      const text = await testSharedContextConnection(cloudConfig);
      setNotice({ kind: 'success', text });
      await refreshCloud(true);
    } catch (error: any) {
      setNotice({ kind: 'error', text: error?.message || '连接失败' });
    } finally {
      setCloudBusy(false);
    }
  };

  const clearCloud = async () => {
    if (!window.confirm('只清除云端共享近期上下文，不会删除本机聊天。确定继续吗？')) return;
    setCloudBusy(true);
    try {
      await clearSharedContext(cloudConfig);
      setCloudContext(null);
      setNotice({ kind: 'success', text: '云端共享近期上下文已清除，本机聊天未删除' });
    } catch (error: any) {
      setNotice({ kind: 'error', text: error?.message || '清除失败' });
    } finally {
      setCloudBusy(false);
    }
  };

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submitMessage();
    }
  };

  return (
    <main className="lite-shell">
      <header className="lite-header">
        <div className="lite-identity">
          <div className="lite-avatar" aria-hidden="true">{(identity.characterName || 'S').slice(0, 1)}</div>
          <div>
            <h1>{identity.characterName || 'Sully'}</h1>
            <p><span className={`status-dot ${cloudContext?.charId ? 'online' : ''}`} />{cloudContext?.charId ? '已连接原版角色' : '本机对话'}</p>
          </div>
        </div>
        <button className="icon-button" type="button" aria-label="打开设置" onClick={() => setSettingsOpen(true)}>
          <GearSix size={22} weight="bold" />
        </button>
      </header>

      <section className="context-strip" aria-label="连接状态">
        <button type="button" className="strip-button" onClick={() => void refreshCloud()} disabled={!cloudReady || cloudBusy}>
          <Cloud size={17} weight="bold" />
          {cloudContext ? `v${cloudContext.revision} · ${formatSyncTime(cloudContext.updatedAt)}${lastRecallCount ? ` · 记忆${lastRecallCount}` : ''}` : cloudReady ? '读取云端' : '云端未配置'}
        </button>
        <select className="api-chip" value={activeApiId} onChange={(event) => setActiveApiId(event.target.value)} aria-label="切换聊天 API">
          {apiProfiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.name}</option>)}
        </select>
      </section>

      <section className="message-stage" aria-live="polite">
        {shownMessages.length === 0 ? <div className="empty-card">
          <div className="empty-icon"><Sparkle size={28} weight="fill" /></div>
          <h2>从这里继续</h2>
          <p>连接主脑后，这里会自动读取你手动同步的近期上下文，再和当前设备上的对话一起发送给角色。</p>
          <button type="button" onClick={() => setSettingsOpen(true)}>完成首次设置</button>
        </div> : <div className="message-list">
          {cloudContext && cloudContext.messages.length > 0 && (
            <div className="handoff-label"><Cloud size={14} /> 来自 {cloudContext.sourceDeviceName || '其他设备'} 的共享上下文</div>
          )}
          {shownMessages.map((message) => (
            <article className={`message-bubble ${message.role}`} key={message.id}>
              <p>{message.content}</p>
              <time>{new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(message.createdAt)}</time>
            </article>
          ))}
          {sending && <div className="typing-bubble"><i /><i /><i /></div>}
          <div ref={messageEndRef} />
        </div>}
      </section>

      {notice && <div className={`notice ${notice.kind}`} role="status">
        {notice.kind === 'success' ? <CheckCircle size={18} weight="fill" /> : notice.kind === 'error' ? <WarningCircle size={18} weight="fill" /> : <Cloud size={18} />}
        <span>{notice.text}</span>
        <button type="button" aria-label="关闭提示" onClick={() => setNotice(null)}><X size={15} /></button>
      </div>}

      <form className="composer" onSubmit={submitMessage}>
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onComposerKeyDown}
          placeholder="说点什么…"
          rows={1}
          aria-label="聊天内容"
        />
        <button className="send-button" type="submit" aria-label="发送" disabled={!draft.trim() || sending}>
          <PaperPlaneRight size={22} weight="fill" />
        </button>
      </form>

      {settingsOpen && (
        <div className="sheet-backdrop" role="presentation" onMouseDown={() => setSettingsOpen(false)}>
          <section className="settings-sheet" role="dialog" aria-modal="true" aria-labelledby="lite-settings-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="sheet-handle" />
            <div className="sheet-title-row">
              <div>
                <span className="eyebrow">LIGHT CLIENT</span>
                <h2 id="lite-settings-title">连接设置</h2>
              </div>
              <button type="button" className="text-button" onClick={() => setSettingsOpen(false)}>完成</button>
            </div>
            <div className="setting-card">
              <div className="setting-card-title">
                <div><strong>聊天 API</strong><p>密钥只保存在当前设备，不会上传到共享上下文。</p></div>
                <div className="small-actions">
                  <button type="button" className="round-action" onClick={addApi} aria-label="添加 API"><Plus size={17} /></button>
                  <button type="button" className="round-action danger" onClick={removeApi} aria-label="删除当前 API"><Trash size={17} /></button>
                </div>
              </div>
              <label>当前 API
                <select value={activeApiId} onChange={(event) => setActiveApiId(event.target.value)}>
                  {apiProfiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.name}</option>)}
                </select>
              </label>
              <label>显示名称<input value={activeApi?.name || ''} onChange={(event) => updateActiveApi({ name: event.target.value })} placeholder="例如：日常聊天" /></label>
              <label>API 地址<input value={activeApi?.baseUrl || ''} onChange={(event) => updateActiveApi({ baseUrl: event.target.value })} placeholder="https://example.com/v1" autoCapitalize="none" /></label>
              <label>API Key<input type="password" value={activeApi?.apiKey || ''} onChange={(event) => updateActiveApi({ apiKey: event.target.value })} placeholder="sk-..." autoCapitalize="none" /></label>
              <label>模型<input value={activeApi?.model || ''} onChange={(event) => updateActiveApi({ model: event.target.value })} placeholder="模型名称" autoCapitalize="none" /></label>
            </div>

            <div className="setting-card">
              <div className="setting-card-title"><div><strong>本机角色预设</strong><p>角色名称和预设只保存在这台设备，不上传到共享上下文。</p></div></div>
              <div className="two-fields">
                <label>角色称呼<input value={identity.characterName} onChange={(event) => setIdentity({ ...identity, characterName: event.target.value })} /></label>
                <label>你的称呼<input value={identity.userName} onChange={(event) => setIdentity({ ...identity, userName: event.target.value })} /></label>
              </div>
              <label>角色预设<textarea value={identity.systemPrompt} onChange={(event) => setIdentity({ ...identity, systemPrompt: event.target.value })} rows={5} placeholder="在这里写角色的性格、说话方式和必要设定" /></label>
            </div>

            <div className="setting-card">
              <div className="setting-card-title"><div><strong>主脑云端</strong><p>使用你自己的 Supabase，读取或覆盖一份共享近期上下文。</p></div></div>
              <label>Supabase URL<input value={cloudConfig.supabaseUrl} onChange={(event) => setCloudConfig({ ...cloudConfig, supabaseUrl: event.target.value })} placeholder="https://xxxx.supabase.co" autoCapitalize="none" /></label>
              <label>Supabase Publishable / anon key<input type="password" value={cloudConfig.supabaseAnonKey} onChange={(event) => setCloudConfig({ ...cloudConfig, supabaseAnonKey: event.target.value })} placeholder="sb_publishable_... 或 eyJ..." autoCapitalize="none" /></label>
              <label>这台设备的名称<input value={cloudConfig.deviceName} onChange={(event) => setCloudConfig({ ...cloudConfig, deviceName: event.target.value })} placeholder="例如：我的手机" /></label>
              <p className="field-hint">设备 ID 自动生成：{cloudConfig.deviceId.slice(0, 8)}…</p>
              <p className="field-hint">{cloudContext?.charId ? `原版角色 ID：${cloudContext.charId}` : '尚未收到角色 ID，请先在原版聊天页发布一次。'}</p>
              <div className="button-row">
                <button type="button" className="secondary-button" onClick={() => void testCloud()} disabled={cloudBusy}><ArrowClockwise size={17} />测试并读取</button>
                <button type="button" className="primary-button" onClick={() => void syncToCloud()} disabled={cloudBusy}><CloudArrowUp size={17} />同步近期上下文</button>
              </div>
              <button type="button" className="sql-toggle" onClick={() => setShowSql((value) => !value)}>{showSql ? '收起初始化 SQL' : '第一次使用：显示初始化 SQL'}</button>
              {showSql && <div className="sql-box">
                <div><span>复制后在 Supabase 的 SQL Editor 运行一次</span><button type="button" onClick={() => { void navigator.clipboard.writeText(SHARED_CONTEXT_SQL); setNotice({ kind: 'success', text: '初始化 SQL 已复制' }); }}><Copy size={15} />复制</button></div>
                <pre>{SHARED_CONTEXT_SQL}</pre>
              </div>}
              <button type="button" className="danger-link" onClick={() => void clearCloud()} disabled={!cloudReady || cloudBusy}>清除云端共享上下文</button>
            </div>

            <div className="setting-card">
              <div className="setting-card-title"><div><strong>原版长期记忆</strong><p>使用原版同一套 Embedding 配置，按云端 charId 检索 memory_vectors。</p></div></div>
              <label className="toggle-line"><input type="checkbox" checked={embeddingConfig.enabled} onChange={(event) => setEmbeddingConfig({ ...embeddingConfig, enabled: event.target.checked })} /><span>聊天前检索相关长期记忆</span></label>
              <label>Embedding API 地址<input value={embeddingConfig.baseUrl} onChange={(event) => setEmbeddingConfig({ ...embeddingConfig, baseUrl: event.target.value })} placeholder="https://api.siliconflow.cn/v1" autoCapitalize="none" /></label>
              <label>Embedding API Key<input type="password" value={embeddingConfig.apiKey} onChange={(event) => setEmbeddingConfig({ ...embeddingConfig, apiKey: event.target.value })} placeholder="sk-..." autoCapitalize="none" /></label>
              <div className="two-fields">
                <label>Embedding 模型<input value={embeddingConfig.model} onChange={(event) => setEmbeddingConfig({ ...embeddingConfig, model: event.target.value })} placeholder="BAAI/bge-m3" /></label>
                <label>向量维度<input type="number" min="1" value={embeddingConfig.dimensions} onChange={(event) => setEmbeddingConfig({ ...embeddingConfig, dimensions: Number(event.target.value) || 1024 })} /></label>
              </div>
              <p className="field-hint">必须与原版创建这些记忆时使用的模型和维度一致。没有填写完整时会跳过记忆检索，但普通聊天仍可继续。</p>
            </div>

            <div className="setting-card compact-card">
              <strong>本机记录</strong>
              <p>本机聊天保存在此设备的浏览器中。安装到主屏幕后仍会保留。</p>
              <button type="button" className="danger-link" onClick={() => {
                if (!window.confirm('确定清空这台设备上的聊天吗？云端共享上下文不会被删除。')) return;
                setLocalMessages([]);
                setNotice({ kind: 'success', text: '本机聊天已清空，云端共享上下文未改变' });
              }}>清空本机聊天</button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
