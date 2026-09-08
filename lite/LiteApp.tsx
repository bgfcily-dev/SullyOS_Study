import React, { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowClockwise,
  Camera,
  CheckCircle,
  Cloud,
  CloudArrowUp,
  Copy,
  GearSix,
  ImageSquare,
  List,
  Palette,
  PaperPlaneRight,
  Plus,
  Smiley,
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
  loadChatBackground,
  loadCloudConfig,
  loadDeletedMessageIds,
  loadEmbeddingConfig,
  loadFontSize,
  loadIdentity,
  loadLocalMessages,
  loadMemorySummaryApi,
  loadStickerText,
  loadTheme,
  formatLiteStickerText,
  parseLiteStickerText,
  saveApiProfiles,
  saveChatBackground,
  saveCloudConfig,
  saveDeletedMessageIds,
  saveEmbeddingConfig,
  saveFontSize,
  saveIdentity,
  saveLocalMessages,
  saveMemorySummaryApi,
  saveStickerText,
  saveTheme,
} from './storage';
import { recallLiteMemories } from './memoryRecall';
import { inspectLiteVectorStore, prepareLiteContextMemories, testLiteEmbeddingConnection, uploadPreparedLiteMemories } from './memoryTools';
import { fetchLiteModels } from './modelApi';
import { splitLiteReplyParts } from './replyChunks';
import type { LiteApiProfile, LiteCloudConfig, LiteEmbeddingConfig, LiteIdentity, LiteMemoryRecall, LiteMemorySummaryApi, LiteMessage, LiteSticker, LiteTheme, LiteVectorStats, PreparedLiteMemoryBatch, SharedRecentContext } from './types';

type Notice = { kind: 'success' | 'error' | 'info'; text: string } | null;
type SettingsSection = 'api' | 'role' | 'memory' | 'appearance';
type SettingsScope = 'quick' | 'main';
type ModelTarget = 'chat' | 'memory';
type StickerEditor = { mode: 'add' } | { mode: 'edit'; sticker: LiteSticker };

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

const isWebImageUrl = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
};

const prepareBackgroundImage = (file: File): Promise<string> => new Promise((resolve, reject) => {
  const objectUrl = URL.createObjectURL(file);
  const image = new Image();
  image.onload = () => {
    try {
      const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('canvas');
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.82));
    } catch {
      reject(new Error('图片处理失败'));
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  };
  image.onerror = () => {
    URL.revokeObjectURL(objectUrl);
    reject(new Error('图片读取失败'));
  };
  image.src = objectUrl;
});

export function LiteApp() {
  const [draft, setDraft] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('api');
  const [settingsScope, setSettingsScope] = useState<SettingsScope>('quick');
  const [theme, setTheme] = useState<LiteTheme>(loadTheme);
  const [fontSize, setFontSize] = useState(loadFontSize);
  const [apiProfiles, setApiProfiles] = useState<LiteApiProfile[]>(loadApiProfiles);
  const [activeApiId, setActiveApiId] = useState(() => loadActiveApiId(loadApiProfiles()));
  const [memorySummaryApi, setMemorySummaryApi] = useState<LiteMemorySummaryApi>(loadMemorySummaryApi);
  const [identity, setIdentity] = useState<LiteIdentity>(loadIdentity);
  const [cloudConfig, setCloudConfig] = useState<LiteCloudConfig>(loadCloudConfig);
  const [embeddingConfig, setEmbeddingConfig] = useState<LiteEmbeddingConfig>(loadEmbeddingConfig);
  const [chatBackground, setChatBackground] = useState(loadChatBackground);
  const [stickerText, setStickerText] = useState(loadStickerText);
  const [localMessages, setLocalMessages] = useState<LiteMessage[]>(loadLocalMessages);
  const [deletedMessageIds, setDeletedMessageIds] = useState<string[]>(loadDeletedMessageIds);
  const [cloudContext, setCloudContext] = useState<SharedRecentContext | null>(null);
  const [cloudBusy, setCloudBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const setSettingsNotice = setNotice;
  const setMemoryPreviewNotice = setNotice;
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [modelsBusy, setModelsBusy] = useState(false);
  const [apiTestBusy, setApiTestBusy] = useState(false);
  const [embeddingTestBusy, setEmbeddingTestBusy] = useState(false);
  const [vectorInspectBusy, setVectorInspectBusy] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [vectorStats, setVectorStats] = useState<LiteVectorStats | null>(null);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelTarget, setModelTarget] = useState<ModelTarget>('chat');
  const [modelQuery, setModelQuery] = useState('');
  const [stickerPickerOpen, setStickerPickerOpen] = useState(false);
  const [composerMenuOpen, setComposerMenuOpen] = useState(false);
  const [stickerEditor, setStickerEditor] = useState<StickerEditor | null>(null);
  const [messageEditor, setMessageEditor] = useState<LiteMessage | null>(null);
  const [memoryPreview, setMemoryPreview] = useState<PreparedLiteMemoryBatch | null>(null);
  const [showSql, setShowSql] = useState(false);
  const [lastRecallCount, setLastRecallCount] = useState(0);
  const messageStageRef = useRef<HTMLElement>(null);
  const stickerNameRef = useRef<HTMLInputElement>(null);
  const stickerUrlRef = useRef<HTMLInputElement>(null);
  const stickerBulkRef = useRef<HTMLTextAreaElement>(null);
  const stickerLongPressTimerRef = useRef<number | null>(null);
  const messageLongPressTimerRef = useRef<number | null>(null);
  const messagePointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const messageContentRef = useRef<HTMLTextAreaElement>(null);
  const suppressStickerClickRef = useRef(false);
  const activeApi = apiProfiles.find((profile) => profile.id === activeApiId) || apiProfiles[0];
  const deletedMessageIdSet = useMemo(() => new Set(deletedMessageIds), [deletedMessageIds]);
  const visibleLocalMessages = useMemo(() => localMessages.filter((message) => !deletedMessageIdSet.has(message.id)), [deletedMessageIdSet, localMessages]);
  const visibleCloudMessages = useMemo(() => (cloudContext?.messages || []).filter((message) => !deletedMessageIdSet.has(message.id)), [cloudContext, deletedMessageIdSet]);
  const shownMessages = useMemo(
    () => mergeMessageHistory(visibleCloudMessages, visibleLocalMessages, 100),
    [visibleCloudMessages, visibleLocalMessages],
  );
  const filteredModels = useMemo(() => {
    const query = modelQuery.trim().toLowerCase();
    return query ? modelOptions.filter((model) => model.toLowerCase().includes(query)) : modelOptions;
  }, [modelOptions, modelQuery]);
  const stickers = useMemo(() => parseLiteStickerText(stickerText), [stickerText]);
  const stickerMap = useMemo(() => new Map(stickers.map((sticker) => [sticker.name, sticker.url])), [stickers]);
  const cloudReady = Boolean(cloudConfig.supabaseUrl && cloudConfig.supabaseAnonKey);
  const memorySummaryApiStarted = Boolean(memorySummaryApi.baseUrl || memorySummaryApi.apiKey || memorySummaryApi.model);
  const memorySummaryApiReady = Boolean(memorySummaryApi.baseUrl && memorySummaryApi.apiKey && memorySummaryApi.model);
  const memoryApiProfile: LiteApiProfile = { id: 'memory-summary', name: '记忆总结 API', ...memorySummaryApi };
  const selectedModel = modelTarget === 'memory' ? memorySummaryApi.model : activeApi?.model || '';

  useEffect(() => saveApiProfiles(apiProfiles, activeApiId), [apiProfiles, activeApiId]);
  useEffect(() => saveMemorySummaryApi(memorySummaryApi), [memorySummaryApi]);
  useEffect(() => saveIdentity(identity), [identity]);
  useEffect(() => saveCloudConfig(cloudConfig), [cloudConfig]);
  useEffect(() => saveEmbeddingConfig(embeddingConfig), [embeddingConfig]);
  useEffect(() => saveLocalMessages(localMessages), [localMessages]);
  useEffect(() => saveDeletedMessageIds(deletedMessageIds), [deletedMessageIds]);
  useEffect(() => saveStickerText(stickerText), [stickerText]);
  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(null), notice.kind === 'error' ? 5000 : 3200);
    return () => window.clearTimeout(timeout);
  }, [notice]);
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
    const viewport = window.visualViewport;
    const updateViewportHeight = () => {
      const height = Math.round(viewport?.height || window.innerHeight);
      document.documentElement.style.setProperty('--lite-viewport-height', `${height}px`);
      document.documentElement.style.setProperty('--lite-viewport-offset-top', `${Math.round(viewport?.offsetTop || 0)}px`);
    };
    updateViewportHeight();
    window.addEventListener('resize', updateViewportHeight);
    viewport?.addEventListener('resize', updateViewportHeight);
    viewport?.addEventListener('scroll', updateViewportHeight);
    return () => {
      window.removeEventListener('resize', updateViewportHeight);
      viewport?.removeEventListener('resize', updateViewportHeight);
      viewport?.removeEventListener('scroll', updateViewportHeight);
      document.documentElement.style.removeProperty('--lite-viewport-height');
      document.documentElement.style.removeProperty('--lite-viewport-offset-top');
    };
  }, []);
  useEffect(() => {
    const stage = messageStageRef.current;
    if (!stage) return;
    const frame = window.requestAnimationFrame(() => {
      stage.scrollTop = stage.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [shownMessages.length]);

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

  const openSettings = (section: SettingsSection, scope: SettingsScope) => {
    setSettingsScope(scope);
    setSettingsSection(section);
    setSettingsOpen(true);
    setComposerMenuOpen(false);
    setStickerPickerOpen(false);
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

  const pullModels = async (target: ModelTarget = 'chat') => {
    const api = target === 'memory' ? memoryApiProfile : activeApi;
    if (!api) return;
    setModelTarget(target);
    setModelsBusy(true);
    setSettingsNotice({ kind: 'info', text: '正在连接 API 并读取模型列表…' });
    try {
      const models = await fetchLiteModels(api);
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

  const testMemorySummaryApi = async () => {
    if (!memorySummaryApiReady) {
      setSettingsNotice({
        kind: memorySummaryApiStarted ? 'error' : 'info',
        text: memorySummaryApiStarted ? '请补全记忆总结 API 的地址、密钥和模型' : '记忆总结 API 未填写，目前会使用当前聊天 API',
      });
      return;
    }
    setApiTestBusy(true);
    setSettingsNotice({ kind: 'info', text: '正在测试记忆总结 API…' });
    try {
      setSettingsNotice({ kind: 'success', text: await testLiteChatConnection(memoryApiProfile) });
    } catch (error: any) {
      setSettingsNotice({ kind: 'error', text: error?.message || '记忆总结 API 测试失败' });
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
    setNotice(null);
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
      openSettings('api', 'quick');
      setSettingsNotice({ kind: 'error', text: '请先填写完整的 API 地址、密钥和模型' });
      return;
    }
    setNotice(null);
    setSending(true);
    try {
      const latestCloud = cloudReady ? await refreshCloud(true) : cloudContext;
      const activeCloud = latestCloud || cloudContext;
      const visibleActiveCloud = activeCloud ? {
        ...activeCloud,
        messages: activeCloud.messages.filter((message) => !deletedMessageIdSet.has(message.id)),
      } : null;
      let memories: LiteMemoryRecall[] = [];
      if (visibleActiveCloud?.charId && cloudReady && embeddingConfig.enabled) {
        try {
          memories = await recallLiteMemories({
            charId: visibleActiveCloud.charId,
            messages: mergeMessageHistory(visibleActiveCloud.messages, visibleLocalMessages, 50),
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
      const reply = await requestLiteReply({ api: activeApi, identity, cloudContext: visibleActiveCloud, localMessages: visibleLocalMessages, memories, stickers });
      const replyParts = splitLiteReplyParts(reply, stickers.map((sticker) => sticker.name));
      const baseTime = Date.now();
      const replyMessages = replyParts.map((part, index) => ({
        ...newLiteMessage('assistant', part.kind === 'sticker' ? `[表情包：${part.name}]` : part.content),
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

  const saveEditedSticker = () => {
    if (!stickerEditor || stickerEditor.mode !== 'edit') return;
    const name = stickerNameRef.current?.value.trim().slice(0, 40) || '';
    const url = stickerUrlRef.current?.value.trim() || '';
    if (!name || !url) {
      setSettingsNotice({ kind: 'error', text: '请同时填写表情包名称和图片 URL' });
      return;
    }
    if (!isWebImageUrl(url)) {
      setSettingsNotice({ kind: 'error', text: '图片 URL 必须是完整的 http:// 或 https:// 地址' });
      return;
    }
    const oldName = stickerEditor.sticker.name;
    if (stickers.some((sticker) => sticker.name === name && sticker.name !== oldName)) {
      setSettingsNotice({ kind: 'error', text: `已经有名为“${name}”的表情包` });
      return;
    }
    const next = stickers.map((sticker) => sticker.name === oldName ? { name, url } : sticker);
    setStickerText(formatLiteStickerText(next));
    if (oldName !== name) {
      const oldMarker = `[表情包：${oldName}]`;
      const newMarker = `[表情包：${name}]`;
      setLocalMessages((current) => current.map((message) => message.content === oldMarker ? { ...message, content: newMarker } : message));
    }
    setStickerEditor(null);
    setSettingsNotice({ kind: 'success', text: '表情包修改成功' });
  };

  const addStickerBatch = () => {
    const incoming = parseLiteStickerText(stickerBulkRef.current?.value || '');
    if (incoming.length === 0) {
      setSettingsNotice({ kind: 'error', text: '没有识别到有效内容，请按“名称：URL”每行填写一个' });
      return;
    }
    const byName = new Map(stickers.map((sticker) => [sticker.name, sticker]));
    incoming.forEach((sticker) => byName.set(sticker.name, sticker));
    const next = [...byName.values()].slice(0, 100);
    setStickerText(formatLiteStickerText(next));
    setStickerEditor(null);
    setSettingsNotice({ kind: 'success', text: `已添加或更新 ${incoming.length} 个表情包` });
  };

  const deleteSticker = (name: string) => {
    setStickerText(formatLiteStickerText(stickers.filter((sticker) => sticker.name !== name)));
    setStickerEditor(null);
    setSettingsNotice({ kind: 'success', text: `已删除表情包“${name}”` });
  };

  const beginStickerLongPress = (sticker: LiteSticker) => {
    if (stickerLongPressTimerRef.current != null) window.clearTimeout(stickerLongPressTimerRef.current);
    suppressStickerClickRef.current = false;
    stickerLongPressTimerRef.current = window.setTimeout(() => {
      suppressStickerClickRef.current = true;
      setStickerEditor({ mode: 'edit', sticker });
      setStickerPickerOpen(false);
      window.setTimeout(() => { suppressStickerClickRef.current = false; }, 800);
    }, 520);
  };

  const cancelStickerLongPress = () => {
    if (stickerLongPressTimerRef.current != null) window.clearTimeout(stickerLongPressTimerRef.current);
    stickerLongPressTimerRef.current = null;
  };

  const cancelMessageLongPress = () => {
    if (messageLongPressTimerRef.current != null) window.clearTimeout(messageLongPressTimerRef.current);
    messageLongPressTimerRef.current = null;
    messagePointerStartRef.current = null;
  };

  const beginMessageLongPress = (message: LiteMessage, event: React.PointerEvent) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    cancelMessageLongPress();
    messagePointerStartRef.current = { x: event.clientX, y: event.clientY };
    messageLongPressTimerRef.current = window.setTimeout(() => {
      messageLongPressTimerRef.current = null;
      messagePointerStartRef.current = null;
      setMessageEditor(message);
    }, 520);
  };

  const moveMessagePointer = (event: React.PointerEvent) => {
    const start = messagePointerStartRef.current;
    if (!start) return;
    if (Math.abs(event.clientX - start.x) > 8 || Math.abs(event.clientY - start.y) > 8) cancelMessageLongPress();
  };

  const saveEditedMessage = () => {
    if (!messageEditor) return;
    const content = messageContentRef.current?.value.trim() || '';
    if (!content) {
      setNotice({ kind: 'error', text: '消息内容不能为空；如果不需要这条消息，可以点击删除' });
      return;
    }
    setLocalMessages((current) => {
      const edited = { ...messageEditor, content };
      const exists = current.some((message) => message.id === edited.id);
      return exists ? current.map((message) => message.id === edited.id ? edited : message) : [...current, edited];
    });
    setDeletedMessageIds((current) => current.filter((id) => id !== messageEditor.id));
    setMessageEditor(null);
    setNotice({ kind: 'success', text: '消息已修改；下次同步近期上下文时会带上修改' });
  };

  const deleteMessage = () => {
    if (!messageEditor) return;
    const id = messageEditor.id;
    setLocalMessages((current) => current.filter((message) => message.id !== id));
    setDeletedMessageIds((current) => current.includes(id) ? current : [...current, id]);
    setMessageEditor(null);
    setNotice({ kind: 'success', text: '消息已删除；下次同步近期上下文时会带上修改' });
  };

  const selectBackground = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setNotice({ kind: 'error', text: '请选择图片文件' });
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setNotice({ kind: 'error', text: '聊天背景原图不能超过 8MB' });
      return;
    }
    try {
      const prepared = await prepareBackgroundImage(file);
      setChatBackground(prepared);
      const saved = saveChatBackground(prepared);
      setNotice(saved
        ? { kind: 'success', text: '聊天背景已更新' }
        : { kind: 'error', text: '背景已临时显示，但安卓浏览器空间不足，重新打开后可能消失' });
    } catch (error: any) {
      setNotice({ kind: 'error', text: error?.message || '聊天背景处理失败' });
    }
  };

  const syncToCloud = async () => {
    setCloudBusy(true);
    setSettingsNotice({ kind: 'info', text: '正在同步近期上下文…' });
    try {
      const latestCloud = cloudReady ? await fetchSharedContext(cloudConfig) : cloudContext;
      const next = await publishSharedContext({
        config: cloudConfig,
        charId: latestCloud?.charId || cloudContext?.charId || '',
        sharedMessages: (latestCloud?.messages || []).filter((message) => !deletedMessageIdSet.has(message.id)),
        localMessages: visibleLocalMessages,
        previousRevision: latestCloud?.revision || 0,
      });
      setCloudContext(next);
      setDeletedMessageIds([]);
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
    if (memorySummaryApiStarted && !memorySummaryApiReady) {
      setNotice({ kind: 'error', text: '记忆总结 API 只填写了一部分，请补全地址、密钥和模型，或全部清空后使用聊天 API' });
      return;
    }
    const summaryApi = memorySummaryApiReady ? memoryApiProfile : activeApi;
    setArchiveBusy(true);
    setSettingsNotice({ kind: 'info', text: `正在用${memorySummaryApiReady ? '独立记忆总结' : '当前聊天'} API 整理上下文…` });
    try {
      const result = await prepareLiteContextMemories({
        api: summaryApi,
        identity,
        charId: cloudContext?.charId || '',
        messages: shownMessages,
        extractionPrompt: embeddingConfig.extractionPrompt,
      });
      if (result.memories.length === 0) {
        setSettingsNotice({ kind: 'info', text: `已检查最近 ${result.usedMessages} 条上下文，没有提取到需要长期保留的记忆` });
      } else {
        setMemoryPreview(result);
        setMemoryPreviewNotice(null);
        setSettingsNotice({ kind: 'success', text: `已整理出 ${result.memories.length} 条草稿，请预览确认后再上传` });
      }
    } catch (error: any) {
      setSettingsNotice({ kind: 'error', text: error?.message || '当前上下文整理失败' });
    } finally {
      setArchiveBusy(false);
    }
  };

  const confirmMemoryUpload = async () => {
    if (!memoryPreview) return;
    setArchiveBusy(true);
    setMemoryPreviewNotice({ kind: 'info', text: '正在生成向量并上传…' });
    setSettingsNotice({ kind: 'info', text: '正在生成向量并上传到 Supabase…' });
    try {
      const result = await uploadPreparedLiteMemories({ batch: memoryPreview, cloud: cloudConfig, embedding: embeddingConfig });
      setMemoryPreview(null);
      setMemoryPreviewNotice(null);
      try { setVectorStats(await inspectLiteVectorStore(cloudConfig, cloudContext?.charId || '')); } catch { /* write already succeeded */ }
      setSettingsNotice({ kind: 'success', text: `上传成功：${result.saved} 条记忆已写入当前角色的云端向量库` });
    } catch (error: any) {
      const text = error?.message || '向量记忆上传失败';
      setMemoryPreviewNotice({ kind: 'error', text });
      setSettingsNotice({ kind: 'error', text });
    } finally {
      setArchiveBusy(false);
    }
  };

  const sendSticker = (name: string) => {
    setLocalMessages((current) => [...current, newLiteMessage('user', `[表情包：${name}]`)]);
    setStickerPickerOpen(false);
    setNotice(null);
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
          <button className="icon-button" type="button" aria-label="打开角色与记忆设置" onClick={() => openSettings('role', 'main')}>
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

      <section
        className={`message-stage${chatBackground ? ' has-chat-background' : ''}${shownMessages.length === 0 ? ' is-empty' : ''}`}
        aria-live="polite"
        ref={messageStageRef}
        style={chatBackground ? { backgroundImage: `linear-gradient(rgba(20, 20, 20, .08), rgba(20, 20, 20, .08)), url(${chatBackground})` } : undefined}
      >
        {shownMessages.length === 0 ? <div className="empty-card">
          <div className="empty-icon"><Sparkle size={28} weight="fill" /></div>
          <h2>从这里继续</h2>
          <p>连接主脑后，这里会自动读取你手动同步的近期上下文，再和当前设备上的对话一起发送给角色。</p>
          <button type="button" onClick={() => openSettings('api', 'quick')}>完成首次设置</button>
        </div> : <div className="message-list">
          {cloudContext && visibleCloudMessages.length > 0 && (
            <div className="handoff-label"><Cloud size={14} /> 来自 {cloudContext.sourceDeviceName || '其他设备'} 的共享上下文</div>
          )}
          {shownMessages.map((message) => {
            const stickerName = message.content.match(/^\[表情包：(.+)\]$/)?.[1];
            const stickerUrl = stickerName ? stickerMap.get(stickerName) : undefined;
            return <div className={`message-row ${message.role}`} key={message.id}>
              <article
                className={`message-bubble ${message.role}${stickerUrl ? ' sticker-message' : ''}`}
                tabIndex={0}
                aria-label={`${message.role === 'user' ? '用户' : '角色'}消息，长按可编辑或删除`}
                onPointerDown={(event) => beginMessageLongPress(message, event)}
                onPointerMove={moveMessagePointer}
                onPointerUp={cancelMessageLongPress}
                onPointerCancel={cancelMessageLongPress}
                onPointerLeave={cancelMessageLongPress}
                onContextMenu={(event) => { event.preventDefault(); cancelMessageLongPress(); setMessageEditor(message); }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    setMessageEditor(message);
                  }
                }}
              >
                {stickerUrl ? <img src={stickerUrl} alt={`表情包：${stickerName}`} loading="lazy" /> : <p>{message.content}</p>}
              </article>
              <time className="message-time">{formatTimestamp(message.createdAt)}</time>
            </div>;
          })}
          {sending && <div className="typing-bubble"><i /><i /><i /></div>}
        </div>}
      </section>

      {notice && <div className={`notice ${notice.kind}`} role="status">
        {notice.kind === 'success' ? <CheckCircle size={18} weight="fill" /> : notice.kind === 'error' ? <WarningCircle size={18} weight="fill" /> : <Cloud size={18} />}
        <span>{notice.text}</span>
      </div>}

      {composerMenuOpen && <section className="composer-tray function-tray" aria-label="快捷功能">
        <button type="button" aria-label="打开 API 设置" title="API 设置" onClick={() => openSettings('api', 'quick')}><GearSix size={21} /></button>
        <button type="button" aria-label="打开外观设置" title="外观设置" onClick={() => openSettings('appearance', 'quick')}><Palette size={21} /></button>
      </section>}

      {stickerPickerOpen && <section className="composer-tray sticker-tray" aria-label="表情包">
        <div className="composer-tray-title"><span>点击发送，长按修改或删除</span><button type="button" aria-label="关闭表情包" onClick={() => setStickerPickerOpen(false)}><X size={16} /></button></div>
        <div className="sticker-grid">
          <button type="button" className="add-sticker-tile" onClick={() => setStickerEditor({ mode: 'add' })}><Plus size={24} /><span>添加</span></button>
          {stickers.map((sticker) => <button
            type="button"
            key={sticker.name}
            onPointerDown={() => beginStickerLongPress(sticker)}
            onPointerUp={cancelStickerLongPress}
            onPointerCancel={cancelStickerLongPress}
            onPointerLeave={cancelStickerLongPress}
            onContextMenu={(event) => { event.preventDefault(); cancelStickerLongPress(); setStickerEditor({ mode: 'edit', sticker }); setStickerPickerOpen(false); }}
            onClick={() => {
              if (suppressStickerClickRef.current) { suppressStickerClickRef.current = false; return; }
              sendSticker(sticker.name);
            }}
          ><img src={sticker.url} alt="" loading="lazy" draggable={false} /><span>{sticker.name}</span></button>)}
        </div>
      </section>}

      <form className="composer" onSubmit={sendMessage}>
        <button className="menu-button" type="button" aria-label="打开功能菜单" title="功能菜单" onClick={() => { setComposerMenuOpen((open) => !open); setStickerPickerOpen(false); }}>
          <List size={23} />
        </button>
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onComposerKeyDown}
          onFocus={() => window.setTimeout(() => {
            const stage = messageStageRef.current;
            if (stage) stage.scrollTop = stage.scrollHeight;
          }, 180)}
          placeholder="说点什么…"
          rows={1}
          aria-label="聊天内容"
          enterKeyHint="send"
        />
        <button className="sticker-button" type="button" aria-label="选择表情包" title="选择表情包" onClick={() => { setStickerPickerOpen((open) => !open); setComposerMenuOpen(false); }}>
          <Smiley size={23} />
        </button>
        <button className="generate-button" type="button" aria-label="生成回复" title="生成回复（此时才调用 LLM）" disabled={sending || shownMessages[shownMessages.length - 1]?.role !== 'user'} onClick={() => void generateReply()}>
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
                <h2 id="lite-settings-title">{settingsScope === 'main' ? '角色与记忆' : settingsSection === 'api' ? 'API 配置' : '外观'}</h2>
              </div>
              <button type="button" className="text-button" onClick={() => setSettingsOpen(false)}>完成</button>
            </div>
            {settingsScope === 'main' && <nav className="settings-tabs" aria-label="设置分区">
              {([['role', '角色设置'], ['memory', '向量记忆']] as const).map(([section, label]) => (
                <button key={section} type="button" className={settingsSection === section ? 'active' : ''} onClick={() => setSettingsSection(section)}>{label}</button>
              ))}
            </nav>}

            <div key={settingsSection} className="settings-section-panel">
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
                <button type="button" className="secondary-button" onClick={() => void pullModels('chat')} disabled={modelsBusy}>{modelsBusy && modelTarget === 'chat' ? <ArrowClockwise size={16} className="spin" /> : <ArrowClockwise size={16} />}{modelsBusy && modelTarget === 'chat' ? '正在拉取' : '拉取模型'}</button>
                {modelTarget === 'chat' && modelOptions.length > 0 && <button type="button" className="secondary-button" onClick={() => { setModelQuery(''); setModelPickerOpen(true); }}>选择模型（{modelOptions.length}）</button>}
              </div>
              <p className="field-hint">在输入框按回车会把消息放进本机对话；只有点击纸飞机“生成”键时，才会调用 LLM。</p>
            </div>
            <div className="setting-card">
              <div className="setting-card-title"><div><strong>记忆总结 API（可选）</strong><p>“整理当前上下文”先用语言模型总结，再用 Embedding 模型生成向量。这里留空时使用当前聊天 API；填写后可换成更便宜的模型。</p></div></div>
              <label>API 地址<input value={memorySummaryApi.baseUrl} onChange={(event) => setMemorySummaryApi({ ...memorySummaryApi, baseUrl: event.target.value })} placeholder="留空则跟随聊天 API" autoCapitalize="none" /></label>
              <label>API Key<input type="password" value={memorySummaryApi.apiKey} onChange={(event) => setMemorySummaryApi({ ...memorySummaryApi, apiKey: event.target.value })} placeholder="留空则跟随聊天 API" autoCapitalize="none" /></label>
              <p className={`credential-state ${memorySummaryApi.apiKey ? 'ready' : ''}`}>{memorySummaryApi.apiKey ? keyStatus(memorySummaryApi.apiKey) : '未单独配置，使用当前聊天 API'}</p>
              <label>模型<input value={memorySummaryApi.model} onChange={(event) => setMemorySummaryApi({ ...memorySummaryApi, model: event.target.value })} placeholder="例如：较便宜的指令模型" autoCapitalize="none" /></label>
              <div className="model-actions">
                <button type="button" className="secondary-button" onClick={() => void testMemorySummaryApi()} disabled={apiTestBusy}>{apiTestBusy ? <ArrowClockwise size={16} className="spin" /> : <CheckCircle size={16} />}{apiTestBusy ? '正在测试' : '测试总结 API'}</button>
                <button type="button" className="secondary-button" onClick={() => void pullModels('memory')} disabled={modelsBusy}>{modelsBusy && modelTarget === 'memory' ? <ArrowClockwise size={16} className="spin" /> : <ArrowClockwise size={16} />}{modelsBusy && modelTarget === 'memory' ? '正在拉取' : '拉取模型'}</button>
                {modelTarget === 'memory' && modelOptions.length > 0 && <button type="button" className="secondary-button" onClick={() => { setModelQuery(''); setModelPickerOpen(true); }}>选择模型（{modelOptions.length}）</button>}
              </div>
              <button type="button" className="text-button copy-chat-api" onClick={() => {
                if (!activeApi) return;
                setMemorySummaryApi({ baseUrl: activeApi.baseUrl, apiKey: activeApi.apiKey, model: activeApi.model });
                setNotice({ kind: 'success', text: '已复制当前聊天 API，可再单独更换模型' });
              }}>复制当前聊天 API</button>
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
                {archiveBusy ? <ArrowClockwise size={17} className="spin" /> : <Sparkle size={17} weight="fill" />}{archiveBusy ? '正在处理' : '整理当前上下文并预览'}
              </button>
              <label>记忆整理补充要求（可选）<textarea value={embeddingConfig.extractionPrompt} onChange={(event) => setEmbeddingConfig({ ...embeddingConfig, extractionPrompt: event.target.value })} rows={4} placeholder="例如：更重视用户的长期计划；不要记录工作细节" /></label>
              <details className="prompt-preview"><summary>查看内置记忆整理规则</summary><div>从最近 50 条对话中筛选真正值得长期保留的内容，通常提取 1–5 条、最多 8 条；使用角色第一人称，并为每条记忆分配房间、重要性、情绪和标签。固定 JSON 格式由程序维护，补充要求不会覆盖这些结构规则。</div></details>
              <p className="field-hint">先由独立记忆总结 API（未配置时为当前聊天 API）整理草稿；确认后才调用 Embedding API 并写入 Supabase 的 <code>memory_vectors</code>。重复处理同一批内容会覆盖同一批记忆。</p>
              <p className="field-hint">必须与原版创建这些记忆时使用的模型和维度一致。没有填写完整时会跳过记忆检索，但普通聊天仍可继续。</p>
            </div>
            </>}

            {settingsSection === 'appearance' && <>
            <div className="setting-card appearance-card">
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
              <div className="background-setting">
                <div className={`background-preview${chatBackground ? ' custom' : ''}`} style={chatBackground ? { backgroundImage: `url(${chatBackground})` } : undefined}><ImageSquare size={24} /></div>
                <div>
                  <label className="avatar-upload-button"><ImageSquare size={17} />上传聊天背景<input type="file" accept="image/*" onChange={selectBackground} /></label>
                  {chatBackground && <button type="button" className="danger-link" onClick={() => {
                    setChatBackground('');
                    setNotice(saveChatBackground('')
                      ? { kind: 'success', text: '聊天背景已移除' }
                      : { kind: 'error', text: '当前已隐藏背景，但浏览器未能保存这项修改' });
                  }}>移除背景</button>}
                </div>
              </div>
              <p className="field-hint">背景只保存在这台设备；上传时会自动缩小图片，减少安卓浏览器存储压力。</p>
            </div>
            </>}
            </div>
          </section>
        </div>
      )}

      {modelPickerOpen && (
        <div className="model-picker-backdrop" role="presentation" onMouseDown={() => setModelPickerOpen(false)}>
          <section className="model-picker" role="dialog" aria-modal="true" aria-labelledby="lite-model-picker-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="model-picker-header">
              <div><span>{modelOptions.length} 个模型</span><h2 id="lite-model-picker-title">{modelTarget === 'memory' ? '选择记忆总结模型' : '选择聊天模型'}</h2></div>
              <button type="button" className="icon-button" aria-label="关闭模型列表" onClick={() => setModelPickerOpen(false)}><X size={19} /></button>
            </div>
            <input className="model-search" value={modelQuery} onChange={(event) => setModelQuery(event.target.value)} placeholder="搜索模型名称" autoFocus />
            <div className="model-list">
              {filteredModels.length > 0 ? filteredModels.map((model) => (
                <button type="button" className={selectedModel === model ? 'selected' : ''} key={model} onClick={() => {
                  if (modelTarget === 'memory') setMemorySummaryApi({ ...memorySummaryApi, model });
                  else updateActiveApi({ model });
                  setModelPickerOpen(false);
                  setSettingsNotice({ kind: 'success', text: `已选择模型：${model}` });
                }}>
                  <span>{model}</span>{selectedModel === model && <CheckCircle size={18} weight="fill" />}
                </button>
              )) : <div className="model-empty">没有匹配的模型</div>}
            </div>
          </section>
        </div>
      )}

      {stickerEditor && (
        <div className="model-picker-backdrop" role="presentation" onMouseDown={() => setStickerEditor(null)}>
          <section key={stickerEditor.mode === 'edit' ? stickerEditor.sticker.name : 'add'} className="sticker-editor-dialog" role="dialog" aria-modal="true" aria-labelledby="lite-sticker-editor-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="model-picker-header"><div><span>{stickerEditor.mode === 'add' ? '每行一个' : '可修改名称和网址'}</span><h2 id="lite-sticker-editor-title">{stickerEditor.mode === 'add' ? '添加表情包' : '编辑表情包'}</h2></div><button type="button" className="round-action" aria-label="关闭" onClick={() => setStickerEditor(null)}><X size={18} /></button></div>
            {stickerEditor.mode === 'add' ? <>
              <label>名称：URL
                <textarea ref={stickerBulkRef} rows={8} defaultValue="" placeholder={'开心：https://example.com/happy.png\n抱抱：https://example.com/hug.gif'} autoCapitalize="none" autoFocus />
              </label>
              <p className="field-hint">可以一次粘贴多行。同名表情包会更新为新的 URL。</p>
              <button type="button" className="primary-button" onClick={addStickerBatch}>添加到表情栏</button>
            </> : <>
              <label>名称<input ref={stickerNameRef} defaultValue={stickerEditor.sticker.name} autoFocus /></label>
              <label>图片 URL<input ref={stickerUrlRef} defaultValue={stickerEditor.sticker.url} autoCapitalize="none" /></label>
              <div className="sticker-editor-footer">
                <button type="button" className="danger-link" onClick={() => deleteSticker(stickerEditor.sticker.name)}>删除</button>
                <button type="button" className="primary-button" onClick={saveEditedSticker}>保存修改</button>
              </div>
            </>}
          </section>
        </div>
      )}

      {messageEditor && (
        <div className="model-picker-backdrop" role="presentation" onMouseDown={() => setMessageEditor(null)}>
          <section key={messageEditor.id} className="sticker-editor-dialog message-editor-dialog" role="dialog" aria-modal="true" aria-labelledby="lite-message-editor-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="model-picker-header"><div><span>修改后保存在当前设备</span><h2 id="lite-message-editor-title">编辑消息</h2></div><button type="button" className="round-action" aria-label="关闭" onClick={() => setMessageEditor(null)}><X size={18} /></button></div>
            <label>消息内容<textarea ref={messageContentRef} rows={6} defaultValue={messageEditor.content} autoFocus /></label>
            <div className="sticker-editor-footer">
              <button type="button" className="danger-link" onClick={deleteMessage}>删除这条消息</button>
              <button type="button" className="primary-button" onClick={saveEditedMessage}>保存修改</button>
            </div>
          </section>
        </div>
      )}

      {memoryPreview && (
        <div className="model-picker-backdrop memory-preview-backdrop" role="presentation" onMouseDown={() => { if (!archiveBusy) { setMemoryPreview(null); setMemoryPreviewNotice(null); } }}>
          <section className="memory-preview" role="dialog" aria-modal="true" aria-labelledby="lite-memory-preview-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="model-picker-header"><div><span>尚未上传</span><h2 id="lite-memory-preview-title">确认记忆内容</h2></div><button type="button" className="round-action" aria-label="关闭" disabled={archiveBusy} onClick={() => { setMemoryPreview(null); setMemoryPreviewNotice(null); }}><X size={18} /></button></div>
            <p className="memory-preview-hint">请先检查下面 {memoryPreview.memories.length} 条内容。点击确认上传前，云端不会发生变化。</p>
            <div className="memory-preview-list">
              {memoryPreview.memories.map((memory, index) => <article key={`${memory.room}-${index}`}>
                <div><span>{memory.room}</span><b>重要性 {memory.importance}</b></div>
                <p>{memory.content}</p>
                {memory.tags.length > 0 && <small>{memory.tags.join(' · ')}</small>}
              </article>)}
            </div>
            <div className="preview-actions"><button type="button" className="secondary-button" disabled={archiveBusy} onClick={() => { setMemoryPreview(null); setMemoryPreviewNotice(null); }}>取消</button><button type="button" className="primary-button" disabled={archiveBusy} onClick={() => void confirmMemoryUpload()}>{archiveBusy ? <ArrowClockwise size={17} className="spin" /> : <CloudArrowUp size={17} />}{archiveBusy ? '正在上传' : '确认并上传'}</button></div>
          </section>
        </div>
      )}
    </main>
  );
}
