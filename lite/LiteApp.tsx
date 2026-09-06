import React, { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowClockwise,
  Camera,
  CheckCircle,
  Cloud,
  CloudArrowUp,
  Copy,
  GearSix,
  MagicWand,
  PaperPlaneRight,
  Plus,
  Sparkle,
  Trash,
  WarningCircle,
  X,
} from '@phosphor-icons/react';
import { clearSharedContext, fetchSharedContext, publishSharedContext, SHARED_CONTEXT_SQL, testSharedContextConnection } from './cloud';
import { mergeMessageHistory, newLiteMessage } from './context';
import { requestLiteReply, testLiteChatConnection } from './chatApi';
import {
  loadActiveApiId,
  loadApiProfiles,
  loadCloudConfig,
  loadEmbeddingConfig,
  loadFontSize,
  loadIdentity,
  loadLocalMessages,
  loadTheme,
  saveApiProfiles,
  saveCloudConfig,
  saveEmbeddingConfig,
  saveFontSize,
  saveIdentity,
  saveLocalMessages,
  saveTheme,
} from './storage';
import { recallLiteMemories } from './memoryRecall';
import { archiveLiteContextToVectors, inspectLiteVectorStore, testLiteEmbeddingConnection } from './memoryTools';
import { fetchLiteModels } from './modelApi';
import { splitLiteReply } from './replyChunks';
import type { LiteApiProfile, LiteCloudConfig, LiteEmbeddingConfig, LiteIdentity, LiteMemoryRecall, LiteMessage, LiteTheme, LiteVectorStats, SharedRecentContext } from './types';

type Notice = { kind: 'success' | 'error' | 'info'; text: string } | null;
type SettingsSection = 'api' | 'role' | 'memory' | 'appearance' | 'local';

const formatTimestamp = (timestamp: number, withDate = false): string => {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
  try {
    return new Intl.DateTimeFormat(undefined, withDate
      ? { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }
      : { hour: '2-digit', minute: '2-digit' }).format(timestamp);
  } catch {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return '';
    const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    return withDate ? `${date.getMonth() + 1}/${date.getDate()} ${time}` : time;
  }
};

const formatSyncTime = (timestamp: number): string => formatTimestamp(timestamp, true);

const keyStatus = (value: string): string => value.trim()
  ? `已保存密钥（末尾 ${value.trim().slice(-4)}）`
  : '尚未填写密钥';

export function LiteApp() {
  const [draft, setDraft] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('api');
  const [theme, setTheme] = useState<LiteTheme>(loadTheme);
  const [fontSize, setFontSize] = useState(loadFontSize);
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
  const [settingsNotice, setSettingsNotice] = useState<Notice>(null);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [modelsBusy, setModelsBusy] = useState(false);
  const [apiTestBusy, setApiTestBusy] = useState(false);
  const [embeddingTestBusy, setEmbeddingTestBusy] = useState(false);
  const [vectorInspectBusy, setVectorInspectBusy] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [vectorStats, setVectorStats] = useState<LiteVectorStats | null>(null);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelQuery, setModelQuery] = useState('');
  const [showSql, setShowSql] = useState(false);
  const [lastRecallCount, setLastRecallCount] = useState(0);
  const messageEndRef = useRef<HTMLDivElement>(null);
  const activeApi = apiProfiles.find((profile) => profile.id === activeApiId) || apiProfiles[0];
  const shownMessages = useMemo(
    () => mergeMessageHistory(cloudContext?.messages || [], localMessages, 100),
    [cloudContext, localMessages],
  );
  const filteredModels = useMemo(() => {
    const query = modelQuery.trim().toLowerCase();
    return query ? modelOptions.filter((model) => model.toLowerCase().includes(query)) : modelOptions;
  }, [modelOptions, modelQuery]);
  const cloudReady = Boolean(cloudConfig.supabaseUrl && cloudConfig.supabaseAnonKey);

  useEffect(() => saveApiProfiles(apiProfiles, activeApiId), [apiProfiles, activeApiId]);
  useEffect(() => saveIdentity(identity), [identity]);
  useEffect(() => saveCloudConfig(cloudConfig), [cloudConfig]);
  useEffect(() => saveEmbeddingConfig(embeddingConfig), [embeddingConfig]);
  useEffect(() => saveLocalMessages(localMessages), [localMessages]);
  useEffect(() => {
    setModelOptions([]);
    setModelPickerOpen(false);
  }, [activeApiId]);
  useEffect(() => saveFontSize(fontSize), [fontSize]);
  useEffect(() => {
    saveTheme(theme);
    document.documentElement.dataset.liteTheme = theme;
    const color = theme === 'dark' ? '#202020' : '#f5f2ed';
    document.documentElement.style.backgroundColor = color;
    document.body.style.backgroundColor = color;
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute('content', color);
    return () => { delete document.documentElement.dataset.liteTheme; };
  }, [theme]);
  useEffect(() => {
    const target = messageEndRef.current;
    if (!target || typeof target.scrollIntoView !== 'function') return;
    try { target.scrollIntoView({ behavior: 'smooth' }); } catch { target.scrollIntoView(); }
  }, [shownMessages.length, sending]);

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
    setSettingsNotice({ kind: 'success', text: '已新建一套空白 API 配置' });
  };

  const removeApi = () => {
    if (apiProfiles.length <= 1) {
      setSettingsNotice({ kind: 'info', text: '至少需要保留一个 API 配置' });
      return;
    }
    const next = apiProfiles.filter((profile) => profile.id !== activeApiId);
    setApiProfiles(next);
    setActiveApiId(next[0].id);
    setSettingsNotice({ kind: 'success', text: '已删除刚才选中的 API 配置' });
  };

  const pullModels = async () => {
    if (!activeApi) return;
    setModelsBusy(true);
    setSettingsNotice({ kind: 'info', text: '正在连接 API 并读取模型列表…' });
    try {
      const models = await fetchLiteModels(activeApi);
      setModelOptions(models);
      setModelQuery('');
      setModelPickerOpen(true);
      setSettingsNotice({ kind: 'success', text: `连接成功，获取到 ${models.length} 个模型` });
    } catch (error: any) {
      setSettingsNotice({ kind: 'error', text: error?.message || '模型列表读取失败' });
    } finally {
      setModelsBusy(false);
    }
  };

  const testChatApi = async () => {
    if (!activeApi) return;
    setApiTestBusy(true);
    setSettingsNotice({ kind: 'info', text: '正在测试聊天 API…' });
    try {
      setSettingsNotice({ kind: 'success', text: await testLiteChatConnection(activeApi) });
    } catch (error: any) {
      setSettingsNotice({ kind: 'error', text: error?.message || '聊天 API 测试失败' });
    } finally {
      setApiTestBusy(false);
    }
  };

  const sendMessage = (event?: FormEvent) => {
    event?.preventDefault();
    const content = draft.trim();
    if (!content || sending) return;
    setLocalMessages((current) => [...current, newLiteMessage('user', content)]);
    setDraft('');
    setNotice({ kind: 'info', text: '消息已放入对话。点击旁边的“生成”按钮才会调用 LLM。' });
  };

  const generateReply = async () => {
    if (sending) return;
    const latestMessage = shownMessages[shownMessages.length - 1];
    if (!latestMessage || latestMessage.role !== 'user') {
      setNotice({ kind: 'info', text: '请先发送一条消息，再点击“生成”。' });
      return;
    }
    if (!activeApi?.baseUrl || !activeApi?.apiKey || !activeApi?.model) {
      setNotice({ kind: 'error', text: '请先完成聊天 API 设置' });
      setSettingsOpen(true);
      setSettingsSection('api');
      setSettingsNotice({ kind: 'error', text: '请先填写完整的 API 地址、密钥和模型' });
      return;
    }
    setNotice(null);
    setSending(true);
    try {
      const latestCloud = cloudReady ? await refreshCloud(true) : cloudContext;
      const activeCloud = latestCloud || cloudContext;
      let memories: LiteMemoryRecall[] = [];
      if (activeCloud?.charId && cloudReady && embeddingConfig.enabled) {
        try {
          memories = await recallLiteMemories({
            charId: activeCloud.charId,
            messages: mergeMessageHistory(activeCloud.messages, localMessages, 50),
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
      const reply = await requestLiteReply({ api: activeApi, identity, cloudContext: activeCloud, localMessages, memories });
      const replyParts = splitLiteReply(reply);
      const baseTime = Date.now();
      const replyMessages = replyParts.map((content, index) => ({
        ...newLiteMessage('assistant', content),
        createdAt: baseTime + index,
      }));
      setLocalMessages((current) => [...current, ...replyMessages]);
    } catch (error: any) {
      setNotice({ kind: 'error', text: error?.message || '生成回复失败' });
    } finally {
      setSending(false);
    }
  };

  const selectAvatar = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setSettingsNotice({ kind: 'error', text: '请选择图片文件' });
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setSettingsNotice({ kind: 'error', text: '头像图片不能超过 2MB' });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string') return;
      setIdentity((current) => ({ ...current, characterAvatar: reader.result as string }));
      setSettingsNotice({ kind: 'success', text: '主屏幕头像已更新' });
    };
    reader.onerror = () => setSettingsNotice({ kind: 'error', text: '头像读取失败，请换一张图片' });
    reader.readAsDataURL(file);
  };

  const syncToCloud = async () => {
    setCloudBusy(true);
    setSettingsNotice({ kind: 'info', text: '正在同步近期上下文…' });
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
      setSettingsNotice({ kind: 'success', text: `同步成功：已发布第 ${next.revision} 版共享上下文` });
    } catch (error: any) {
      setSettingsNotice({ kind: 'error', text: error?.message || '同步失败' });
    } finally {
      setCloudBusy(false);
    }
  };

  const testCloud = async () => {
    setCloudBusy(true);
    setSettingsNotice({ kind: 'info', text: '正在测试 Supabase 连接…' });
    try {
      const text = await testSharedContextConnection(cloudConfig);
      setSettingsNotice({ kind: 'success', text });
      await refreshCloud(true);
    } catch (error: any) {
      setSettingsNotice({ kind: 'error', text: error?.message || '连接失败' });
    } finally {
      setCloudBusy(false);
    }
  };

  const testEmbedding = async () => {
    setEmbeddingTestBusy(true);
    setSettingsNotice({ kind: 'info', text: '正在测试 Embedding API…' });
    try {
      setSettingsNotice({ kind: 'success', text: await testLiteEmbeddingConnection(embeddingConfig) });
    } catch (error: any) {
      setSettingsNotice({ kind: 'error', text: error?.message || 'Embedding API 测试失败' });
    } finally {
      setEmbeddingTestBusy(false);
    }
  };

  const inspectVectors = async () => {
    setVectorInspectBusy(true);
    setSettingsNotice({ kind: 'info', text: '正在读取 Supabase 中的实际向量数量…' });
    try {
      const stats = await inspectLiteVectorStore(cloudConfig, cloudContext?.charId || '');
      setVectorStats(stats);
      const currentText = stats.currentCharacterCount == null ? '当前尚无角色 ID' : `当前角色 ${stats.currentCharacterCount} 条`;
      setSettingsNotice({ kind: 'success', text: `查询成功：云端全部 ${stats.totalCount} 条，${currentText}` });
    } catch (error: any) {
      setSettingsNotice({ kind: 'error', text: error?.message || '向量数量查询失败' });
    } finally {
      setVectorInspectBusy(false);
    }
  };

  const archiveCurrentContext = async () => {
    if (!activeApi) return;
    setArchiveBusy(true);
    setSettingsNotice({ kind: 'info', text: '正在用聊天 API 整理当前上下文…' });
    try {
      const result = await archiveLiteContextToVectors({
        api: activeApi,
        cloud: cloudConfig,
        embedding: embeddingConfig,
        identity,
        charId: cloudContext?.charId || '',
        messages: shownMessages,
      });
      if (result.saved === 0) {
        setSettingsNotice({ kind: 'info', text: `已检查最近 ${result.usedMessages} 条上下文，没有提取到需要长期保留的记忆` });
      } else {
        try {
          setVectorStats(await inspectLiteVectorStore(cloudConfig, cloudContext?.charId || ''));
        } catch { /* the successful write remains successful even if recounting fails */ }
        setSettingsNotice({ kind: 'success', text: `整理成功：已将 ${result.saved} 条向量记忆写入当前角色` });
      }
    } catch (error: any) {
      setSettingsNotice({ kind: 'error', text: error?.message || '当前上下文整理失败' });
    } finally {
      setArchiveBusy(false);
    }
  };

  const clearCloud = async () => {
    if (!window.confirm('只清除云端共享近期上下文，不会删除本机聊天。确定继续吗？')) return;
    setCloudBusy(true);
    try {
      await clearSharedContext(cloudConfig);
      setCloudContext(null);
      setSettingsNotice({ kind: 'success', text: '清除成功：本机聊天没有删除' });
    } catch (error: any) {
      setSettingsNotice({ kind: 'error', text: error?.message || '清除失败' });
    } finally {
      setCloudBusy(false);
    }
  };

  const copyHandoffSql = async () => {
    try {
      await navigator.clipboard.writeText(SHARED_CONTEXT_SQL);
      setSettingsNotice({ kind: 'success', text: '初始化/升级 SQL 已复制到剪贴板' });
    } catch {
      setSettingsNotice({ kind: 'error', text: '复制失败，请长按下面的 SQL 手动复制' });
    }
  };

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  };

  return (
    <main className={`lite-shell theme-${theme}`} style={{ '--lite-message-font-size': `${fontSize}px` } as React.CSSProperties}>
      <header className="lite-header">
        <div className="lite-identity">
          <div className="lite-avatar" aria-hidden="true">
            {identity.characterAvatar ? <img src={identity.characterAvatar} alt="" /> : (identity.characterName || 'S').slice(0, 1)}
          </div>
          <div>
            <h1>{identity.characterName || 'Sully'}</h1>
            <p><span className={`status-dot ${cloudContext?.charId ? 'online' : ''}`} />{cloudContext?.charId ? '已连接' : '未连接'}</p>
          </div>
        </div>
        <div className="header-actions">
          <button className="icon-button" type="button" aria-label="打开设置" onClick={() => setSettingsOpen(true)}>
            <GearSix size={22} weight="bold" />
          </button>
        </div>
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
            <div className={`message-row ${message.role}`} key={message.id}>
              <article className={`message-bubble ${message.role}`}><p>{message.content}</p></article>
              <time className="message-time">{formatTimestamp(message.createdAt)}</time>
            </div>
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

      <form className="composer" onSubmit={sendMessage}>
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
        <button className="generate-button" type="button" aria-label="生成回复" title="生成回复（此时才调用 LLM）" disabled={sending || shownMessages[shownMessages.length - 1]?.role !== 'user'} onClick={() => void generateReply()}>
          <MagicWand size={22} weight="fill" />
        </button>
      </form>

      {settingsOpen && (
        <div className="sheet-backdrop" role="presentation" onMouseDown={() => setSettingsOpen(false)}>
          <section className="settings-sheet" role="dialog" aria-modal="true" aria-labelledby="lite-settings-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="sheet-handle" />
            <div className="sheet-title-row">
              <div>
                <span className="eyebrow">LIGHT CLIENT</span>
                <h2 id="lite-settings-title">Lite 设置</h2>
              </div>
              <button type="button" className="text-button" onClick={() => setSettingsOpen(false)}>完成</button>
            </div>
            <nav className="settings-tabs" aria-label="设置分区">
              {([
                ['api', 'API 配置'],
                ['role', '角色设置'],
                ['memory', '向量记忆'],
                ['appearance', '外观'],
                ['local', '本机数据'],
              ] as const).map(([section, label]) => (
                <button key={section} type="button" className={settingsSection === section ? 'active' : ''} onClick={() => setSettingsSection(section)}>{label}</button>
              ))}
            </nav>

            {settingsNotice && <div className={`settings-feedback ${settingsNotice.kind}`} role="status">
              {settingsNotice.kind === 'success' ? <CheckCircle size={18} weight="fill" /> : settingsNotice.kind === 'error' ? <WarningCircle size={18} weight="fill" /> : <ArrowClockwise size={18} />}
              <span>{settingsNotice.text}</span>
              <button type="button" aria-label="关闭设置提示" onClick={() => setSettingsNotice(null)}><X size={15} /></button>
            </div>}

            {settingsSection === 'api' && <>
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
              <p className={`credential-state ${activeApi?.apiKey ? 'ready' : ''}`}>{keyStatus(activeApi?.apiKey || '')}</p>
              <label>模型<input value={activeApi?.model || ''} onChange={(event) => updateActiveApi({ model: event.target.value })} placeholder="模型名称" autoCapitalize="none" /></label>
              <div className="model-actions">
                <button type="button" className="secondary-button" onClick={() => void testChatApi()} disabled={apiTestBusy}>{apiTestBusy ? <ArrowClockwise size={16} className="spin" /> : <CheckCircle size={16} />}{apiTestBusy ? '正在测试' : '测试聊天 API'}</button>
                <button type="button" className="secondary-button" onClick={() => void pullModels()} disabled={modelsBusy}>{modelsBusy ? <ArrowClockwise size={16} className="spin" /> : <ArrowClockwise size={16} />}{modelsBusy ? '正在拉取' : modelOptions.length ? '刷新模型' : '拉取模型'}</button>
                {modelOptions.length > 0 && <button type="button" className="secondary-button" onClick={() => { setModelQuery(''); setModelPickerOpen(true); }}>选择模型（{modelOptions.length}）</button>}
              </div>
              <p className="field-hint">“发送”只把消息放进本机对话；只有点击“生成”时，才会使用这里的 API 调用 LLM。</p>
            </div>
            </>}

            {settingsSection === 'role' && <>
              <div className="setting-card identity-panel">
                <h3>角色人设</h3>
                <div className="avatar-setting-row">
                  <div className="avatar-preview">{identity.characterAvatar ? <img src={identity.characterAvatar} alt="角色头像预览" /> : (identity.characterName || 'S').slice(0, 1)}</div>
                  <div className="avatar-actions">
                    <label className="avatar-upload-button"><Camera size={17} />更换头像<input type="file" accept="image/*" onChange={selectAvatar} /></label>
                    {identity.characterAvatar && <button type="button" className="danger-link" onClick={() => { setIdentity({ ...identity, characterAvatar: '' }); setSettingsNotice({ kind: 'success', text: '头像已恢复为文字头像' }); }}>移除头像</button>}
                  </div>
                </div>
                <label>名字<input value={identity.characterName} onChange={(event) => setIdentity({ ...identity, characterName: event.target.value })} placeholder="角色名字" /></label>
                <label>角色预设<textarea value={identity.systemPrompt} onChange={(event) => setIdentity({ ...identity, systemPrompt: event.target.value })} rows={7} placeholder="性格、说话方式、经历和边界" /></label>
              </div>
              <div className="setting-card identity-panel">
                <h3>用户</h3>
                <label>名字<input value={identity.userName} onChange={(event) => setIdentity({ ...identity, userName: event.target.value })} placeholder="你的名字" /></label>
                <label>用户预设<textarea value={identity.userPrompt} onChange={(event) => setIdentity({ ...identity, userPrompt: event.target.value })} rows={5} placeholder="希望角色知道的个人资料" /></label>
              </div>
            </>}

            {settingsSection === 'memory' && <>
            <div className="setting-card">
              <div className="setting-card-title"><div><strong>Supabase：接力与向量库</strong><p>这两个字段请复制原版“记忆宫殿 → 远程向量存储”的地址和 Publishable / anon key。</p></div></div>
              <label>Supabase URL<input value={cloudConfig.supabaseUrl} onChange={(event) => setCloudConfig({ ...cloudConfig, supabaseUrl: event.target.value })} placeholder="https://xxxx.supabase.co" autoCapitalize="none" /></label>
              <label>Supabase Publishable / anon key<input type="password" value={cloudConfig.supabaseAnonKey} onChange={(event) => setCloudConfig({ ...cloudConfig, supabaseAnonKey: event.target.value })} placeholder="sb_publishable_... 或 eyJ..." autoCapitalize="none" /></label>
              <p className={`credential-state ${cloudConfig.supabaseAnonKey ? 'ready' : ''}`}>{keyStatus(cloudConfig.supabaseAnonKey)}</p>
              <label>这台设备的名称<input value={cloudConfig.deviceName} onChange={(event) => setCloudConfig({ ...cloudConfig, deviceName: event.target.value })} placeholder="例如：我的手机" /></label>
              <p className="field-hint">设备 ID 自动生成：{cloudConfig.deviceId.slice(0, 8)}…</p>
              <p className="field-hint">{cloudContext?.charId ? `原版角色 ID：${cloudContext.charId}` : '尚未收到角色 ID，请先在原版聊天页发布一次。'}</p>
              <div className="button-row">
                <button type="button" className="secondary-button" onClick={() => void testCloud()} disabled={cloudBusy}><ArrowClockwise size={17} />测试并读取</button>
                <button type="button" className="primary-button" onClick={() => void syncToCloud()} disabled={cloudBusy}><CloudArrowUp size={17} />同步近期上下文</button>
              </div>
              <button type="button" className="sql-toggle" onClick={() => setShowSql((value) => !value)}>{showSql ? '收起初始化 SQL' : '第一次使用：显示初始化 SQL'}</button>
              {showSql && <div className="sql-box">
                <div><span>复制后在 Supabase 的 SQL Editor 运行一次</span><button type="button" onClick={() => void copyHandoffSql()}><Copy size={15} />复制</button></div>
                <pre>{SHARED_CONTEXT_SQL}</pre>
              </div>}
              <button type="button" className="danger-link" onClick={() => void clearCloud()} disabled={!cloudReady || cloudBusy}>清除云端共享上下文</button>
            </div>

            <div className="setting-card">
              <div className="setting-card-title"><div><strong>向量记忆：Embedding</strong><p>原版长期记忆中的“记忆宫殿”是向量记忆。Lite 用同一套 Embedding 配置，按接力上下文里的 charId 检索 memory_vectors。</p></div></div>
              <label className="toggle-line"><input type="checkbox" checked={embeddingConfig.enabled} onChange={(event) => setEmbeddingConfig({ ...embeddingConfig, enabled: event.target.checked })} /><span>点击“生成”时检索相关长期记忆</span></label>
              <label>Embedding API 地址<input value={embeddingConfig.baseUrl} onChange={(event) => setEmbeddingConfig({ ...embeddingConfig, baseUrl: event.target.value })} placeholder="https://api.siliconflow.cn/v1" autoCapitalize="none" /></label>
              <label>Embedding API Key<input type="password" value={embeddingConfig.apiKey} onChange={(event) => setEmbeddingConfig({ ...embeddingConfig, apiKey: event.target.value })} placeholder="sk-..." autoCapitalize="none" /></label>
              <p className={`credential-state ${embeddingConfig.apiKey ? 'ready' : ''}`}>{keyStatus(embeddingConfig.apiKey)}</p>
              <div className="two-fields">
                <label>Embedding 模型<input value={embeddingConfig.model} onChange={(event) => setEmbeddingConfig({ ...embeddingConfig, model: event.target.value })} placeholder="BAAI/bge-m3" /></label>
                <label>向量维度<input type="number" min="1" value={embeddingConfig.dimensions} onChange={(event) => setEmbeddingConfig({ ...embeddingConfig, dimensions: Number(event.target.value) || 1024 })} /></label>
              </div>
              <div className="memory-tool-actions">
                <button type="button" className="secondary-button" onClick={() => void testEmbedding()} disabled={embeddingTestBusy || archiveBusy}>{embeddingTestBusy ? <ArrowClockwise size={16} className="spin" /> : <CheckCircle size={16} />}{embeddingTestBusy ? '正在测试' : '测试 Embedding API'}</button>
                <button type="button" className="secondary-button" onClick={() => void inspectVectors()} disabled={vectorInspectBusy || archiveBusy}>{vectorInspectBusy ? <ArrowClockwise size={16} className="spin" /> : <Cloud size={16} />}{vectorInspectBusy ? '正在查询' : '检查云端向量数量'}</button>
              </div>
              {vectorStats && <div className="vector-stats" role="status">
                <div><span>云端全部</span><strong>{vectorStats.totalCount} 条</strong></div>
                <div><span>当前角色</span><strong>{vectorStats.currentCharacterCount == null ? '未获取 ID' : `${vectorStats.currentCharacterCount} 条`}</strong></div>
                {vectorStats.charId && <small>charId：{vectorStats.charId}</small>}
              </div>}
              <button type="button" className="primary-button archive-context-button" onClick={() => void archiveCurrentContext()} disabled={archiveBusy || embeddingTestBusy || vectorInspectBusy}>
                {archiveBusy ? <ArrowClockwise size={17} className="spin" /> : <Sparkle size={17} weight="fill" />}{archiveBusy ? '正在处理' : '一键把当前上下文整理成向量记忆'}
              </button>
              <p className="field-hint">最多整理当前最近 50 条消息。聊天 API 负责提取，Embedding API 负责向量化，最后直接写入 Supabase 的 <code>memory_vectors</code>。重复处理同一批内容会覆盖同一批记忆，不会无限复制。</p>
              <p className="field-hint">必须与原版创建这些记忆时使用的模型和维度一致。没有填写完整时会跳过记忆检索，但普通聊天仍可继续。</p>
            </div>
            </>}

            {settingsSection === 'appearance' && <div className="setting-card appearance-card">
              <div className="setting-card-title"><strong>外观</strong></div>
              <label>显示模式</label>
              <div className="theme-choice" role="group" aria-label="显示模式">
                <button type="button" className={theme === 'light' ? 'active' : ''} onClick={() => { setTheme('light'); setSettingsNotice({ kind: 'success', text: '已切换到日间模式' }); }}>日间</button>
                <button type="button" className={theme === 'dark' ? 'active' : ''} onClick={() => { setTheme('dark'); setSettingsNotice({ kind: 'success', text: '已切换到夜间模式' }); }}>夜间</button>
              </div>
              <label>聊天字体大小 <span className="range-value">{fontSize}px</span>
                <input type="range" min="12" max="20" step="1" value={fontSize} onChange={(event) => setFontSize(Number(event.target.value))} />
              </label>
              <div className="font-preview" style={{ fontSize: `${fontSize}px` }}>这是一段聊天文字预览。</div>
            </div>}

            {settingsSection === 'local' && <div className="setting-card compact-card">
              <strong>本机记录</strong>
              <p>本机聊天、API 密钥、角色预设和主题设置都保存在此设备的浏览器中，不会放进共享上下文。安装到主屏幕后仍会保留。</p>
              <button type="button" className="danger-link" onClick={() => {
                if (!window.confirm('确定清空这台设备上的聊天吗？云端共享上下文不会被删除。')) return;
                setLocalMessages([]);
                setSettingsNotice({ kind: 'success', text: '清除成功：本机聊天已清空，云端数据没有改变' });
              }}>清空本机聊天</button>
            </div>}
          </section>
        </div>
      )}

      {modelPickerOpen && (
        <div className="model-picker-backdrop" role="presentation" onMouseDown={() => setModelPickerOpen(false)}>
          <section className="model-picker" role="dialog" aria-modal="true" aria-labelledby="lite-model-picker-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="model-picker-header">
              <div><span>{modelOptions.length} 个模型</span><h2 id="lite-model-picker-title">选择模型</h2></div>
              <button type="button" className="icon-button" aria-label="关闭模型列表" onClick={() => setModelPickerOpen(false)}><X size={19} /></button>
            </div>
            <input className="model-search" value={modelQuery} onChange={(event) => setModelQuery(event.target.value)} placeholder="搜索模型名称" autoFocus />
            <div className="model-list">
              {filteredModels.length > 0 ? filteredModels.map((model) => (
                <button type="button" className={activeApi?.model === model ? 'selected' : ''} key={model} onClick={() => {
                  updateActiveApi({ model });
                  setModelPickerOpen(false);
                  setSettingsNotice({ kind: 'success', text: `已选择模型：${model}` });
                }}>
                  <span>{model}</span>{activeApi?.model === model && <CheckCircle size={18} weight="fill" />}
                </button>
              )) : <div className="model-empty">没有匹配的模型</div>}
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
