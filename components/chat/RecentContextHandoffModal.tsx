import React, { useEffect, useMemo, useState } from 'react';
import { ArrowClockwise, CheckCircle, CloudArrowDown, CloudArrowUp, Copy, WarningCircle } from '@phosphor-icons/react';
import type { CharacterProfile } from '../../types';
import { DB } from '../../utils/db';
import { normalizeMessageContent } from '../../utils/messageFormat';
import type { RemoteVectorConfig } from '../../utils/memoryPalace/types';
import {
  fetchSharedContext,
  publishSharedContext,
  SHARED_CONTEXT_SQL,
  type HandoffCloudConfig,
  type HandoffMessage,
  type SharedRecentContext,
} from '../../utils/recentContextHandoff';
import Modal from '../os/Modal';
import { useOS } from '../../context/OSContext';
import { ContextBuilder } from '../../utils/context';
import { resolveDialogueApi } from '../../utils/characterApi';
import { loadCharacterContextMessages } from '../../utils/chatContextRange';
import { nowInTimeZone, resolveCharTimeZone } from '../../utils/timezone';
import { buildReceivedHandoff, generateHandoffSummary, handoffSummaryInstructions } from '../../utils/recentContextHandoff';

const DEVICE_ID_KEY = 'os_handoff_device_id_v1';
const DEVICE_NAME_KEY = 'os_handoff_device_name_v1';

function getOrCreateDeviceId(): string {
  const stored = localStorage.getItem(DEVICE_ID_KEY)?.trim();
  if (stored) return stored;
  const next = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `main-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  localStorage.setItem(DEVICE_ID_KEY, next);
  return next;
}

interface RecentContextHandoffModalProps {
  isOpen: boolean;
  onClose: () => void;
  character: CharacterProfile;
  userName: string;
  remoteVectorConfig: RemoteVectorConfig;
  onImported: () => Promise<void> | void;
}

const RecentContextHandoffModal: React.FC<RecentContextHandoffModalProps> = ({
  isOpen,
  onClose,
  character,
  userName,
  remoteVectorConfig,
  onImported,
}) => {
  const { apiConfig, userProfile } = useOS();
  const [preview, setPreview] = useState<{ input: Parameters<typeof publishSharedContext>[0]; summary: string } | null>(null);
  const [deviceName, setDeviceName] = useState(() => localStorage.getItem(DEVICE_NAME_KEY) || '主设备');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: 'ok' | 'warn'; text: string } | null>(null);
  const [cloudContext, setCloudContext] = useState<SharedRecentContext | null>(null);
  const deviceId = useMemo(getOrCreateDeviceId, []);
  const cloudConfig: HandoffCloudConfig = {
    supabaseUrl: remoteVectorConfig.supabaseUrl,
    supabaseAnonKey: remoteVectorConfig.supabaseAnonKey,
    deviceId,
    deviceName,
  };
  const configured = Boolean(cloudConfig.supabaseUrl && cloudConfig.supabaseAnonKey);
  const isSupabase = /\.supabase\.co(?=\/|$)/i.test(cloudConfig.supabaseUrl);

  useEffect(() => {
    localStorage.setItem(DEVICE_NAME_KEY, deviceName.trim() || '主设备');
  }, [deviceName]);

  useEffect(() => {
    if (!isOpen) return;
    setPreview(null);
    setStatus(null);
    if (!configured) {
      setCloudContext(null);
      return;
    }
    let cancelled = false;
    setBusy(true);
    fetchSharedContext(cloudConfig)
      .then((context) => { if (!cancelled) setCloudContext(context); })
      .catch((error: any) => { if (!cancelled) setStatus({ kind: 'warn', text: error?.message || '读取云端失败' }); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  // Opening the modal is the refresh boundary; credentials are managed in Memory Palace.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, remoteVectorConfig.supabaseUrl, remoteVectorConfig.supabaseAnonKey]);

  const publishRecent = async () => {
    if (!configured) {
      setStatus({ kind: 'warn', text: '请先在记忆宫殿设置中配置云端记忆同步' });
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const latest = await fetchSharedContext(cloudConfig);
      if (latest?.charId && latest.charId !== character.id) {
        const confirmed = window.confirm('云端现在属于另一个角色。继续会把接力目标切换为当前角色，并覆盖原来的近期接力内容。确定继续吗？');
        if (!confirmed) return;
      }
      const { messages } = await DB.getRecentMessagesWithCount(character.id, 30);
      const localMessages: HandoffMessage[] = messages
        .filter((message) => !message.groupId && (message.role === 'user' || message.role === 'assistant'))
        .map((message) => {
          const importedCloudId = typeof message.metadata?.handoffCloudMessageId === 'string'
            ? message.metadata.handoffCloudMessageId
            : '';
          return {
            id: importedCloudId || `main:${deviceId}:${character.id}:${message.id}`,
            role: message.role as 'user' | 'assistant',
            content: normalizeMessageContent(message, character.name, userName || 'TA'),
            createdAt: message.timestamp,
            origin: importedCloudId ? 'lite' as const : 'main' as const,
          };
        })
        .filter((message) => message.content.trim());
      const input: Parameters<typeof publishSharedContext>[0] = {
        config: cloudConfig,
        charId: character.id,
        sharedMessages: [],
        localMessages,
        previousRevision: latest?.revision || 0,
      };
      const readable = (await loadCharacterContextMessages(character)).filter(m => m.role === 'user' || m.role === 'assistant').slice(-30);
      if (!readable.length) throw new Error('当前可读上下文为空，请先发送消息后再迁移');
      const summary = await generateHandoffSummary(resolveDialogueApi(apiConfig, character), ContextBuilder.buildCharacterRequest(
        { char: character, user: userProfile },
        [...readable.map(m => ({ role: m.role, content: normalizeMessageContent(m, character.name, userName || 'TA') })), { role: 'user', content: handoffSummaryInstructions(nowInTimeZone(resolveCharTimeZone(character)), character.name) }],
      ));
      setPreview({ input, summary });
    } catch (error: any) {
      setStatus({ kind: 'warn', text: error?.message || '发布失败' });
    } finally {
      setBusy(false);
    }
  };

  const confirmPublish = async () => {
    if (!preview?.summary.trim()) return;
    setBusy(true);
    try {
      const next = await publishSharedContext({ ...preview.input, summary: preview.summary });
      setCloudContext(next);
      await DB.saveMessage({ charId: character.id, role: 'system', type: 'text', content: `上传于 ${next.sourceDeviceName}`, metadata: { source: 'handoff_upload', handoffLabel: `上传于 ${next.sourceDeviceName}` } });
      await onImported();
      setPreview(null);
      setStatus({ kind: 'ok', text: `已发布来自 ${next.sourceDeviceName}，迁移总结和近期消息已上传。` });
    } catch (error: any) {
      setStatus({ kind: 'warn', text: error?.message || '发布失败' });
    } finally { setBusy(false); }
  };

  const receiveRecent = async () => {
    if (!configured) {
      setStatus({ kind: 'warn', text: '请先在记忆宫殿设置中配置云端记忆同步' });
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const latest = await fetchSharedContext(cloudConfig);
      setCloudContext(latest);
      if (!latest) throw new Error('云端还没有近期接力内容');
      if (!latest.charId) throw new Error('这份云端数据是旧格式，请先从原版重新发布一次');
      if (latest.charId !== character.id) throw new Error('云端接力属于另一个角色，请先切换到对应角色再接收');
      if (latest.sourceDeviceId === deviceId) {
        setStatus({ kind: 'ok', text: '这份上下文来自当前设备，无需重复接收' });
        return;
      }

      const seenKey = `os_handoff_seen_${character.id}`;
      let storedSeen: string[] = [];
      try { storedSeen = JSON.parse(localStorage.getItem(seenKey) || '[]'); } catch { storedSeen = []; }
      const seen = new Set(storedSeen);
      const { messages: recentLocal } = await DB.getRecentMessagesWithCount(character.id, 200);
      for (const message of recentLocal) {
        const cloudId = message.metadata?.handoffCloudMessageId;
        if (typeof cloudId === 'string') seen.add(cloudId);
      }
      const additions = latest.messages.filter((message) => message.role !== 'system' && !seen.has(message.id) && !recentLocal.some(local =>
        `main:${deviceId}:${character.id}:${local.id}` === message.id || `main:${character.id}:${local.id}` === message.id));
      const marker = buildReceivedHandoff(latest, cloudConfig);
      const hasMarker = seen.has(marker.id);
      if (!hasMarker) {
        await DB.saveMessage({ charId: character.id, role: 'system', type: 'text', content: marker.content,
          timestamp: marker.createdAt, metadata: { source: 'handoff_receive', handoffCloudMessageId: marker.id, handoffLabel: marker.handoffLabel } });
        seen.add(marker.id);
      }
      for (const message of additions) {
        await DB.saveMessage({
          charId: character.id,
          role: message.role,
          type: 'text',
          content: message.content,
          timestamp: message.createdAt,
          metadata: {
            source: 'lite_handoff',
            handoffBatchId: marker.id,
            handoffCloudMessageId: message.id,
            handoffDeviceId: latest.sourceDeviceId,
            handoffDeviceName: latest.sourceDeviceName,
          },
        });
        seen.add(message.id);
      }
      localStorage.setItem(seenKey, JSON.stringify([...seen].slice(-200)));
      if (additions.length > 0 || !hasMarker) await onImported();
      setStatus({ kind: 'ok', text: additions.length > 0 || !hasMarker ? `已接收来自 ${latest.sourceDeviceName || '未命名设备'} 的迁移上下文和 ${additions.length} 条新增消息` : '云端没有尚未接回的新消息' });
    } catch (error: any) {
      setStatus({ kind: 'warn', text: error?.message || '接收失败' });
    } finally {
      setBusy(false);
    }
  };

  if (preview) return (
    <Modal isOpen={isOpen} title="迁移总结预览" onClose={() => { if (!busy) setPreview(null); }} footer={<>
      <button type="button" disabled={busy} onClick={() => setPreview(null)} className="flex-1 rounded-2xl bg-slate-100 px-4 py-3 font-bold text-slate-600">取消</button>
      <button type="button" disabled={busy || !preview.summary.trim()} onClick={() => void confirmPublish()} className="flex-1 rounded-2xl bg-emerald-600 px-4 py-3 font-bold text-white disabled:opacity-50">{busy ? '正在上传…' : '确认并上传'}</button>
    </>}>
      <p className="mb-3 text-sm text-slate-600">{character.name}的第一人称迁移总结 · 尚未上传。可编辑后确认，不写入长期记忆。</p>
      <textarea aria-label="角色迁移总结" value={preview.summary} disabled={busy} onChange={e => setPreview({ ...preview, summary: e.target.value })} className="w-full rounded-xl border border-slate-200 p-3 text-sm" style={{ minHeight: 180 }} />
      {status?.kind === 'warn' && <p role="alert" className="mt-3 text-sm text-amber-800">{status.text}</p>}
    </Modal>
  );

  return (
    <Modal isOpen={isOpen} title="跨设备接力" onClose={onClose}>
      <div className="space-y-4 text-sm text-slate-600">
        <div className="rounded-2xl border border-emerald-100 bg-emerald-50 p-3">
          <div className="font-bold text-emerald-800">当前角色：{character.name}</div>
          <div className="mt-1 break-all font-mono text-[10px] text-emerald-700">charId: {character.id}</div>
          <div className="mt-2 text-xs leading-5 text-emerald-700">同步角色 ID、近期消息和临时迁移总结。总结生成后先预览，再确认上传；不会写入长期记忆。</div>
        </div>

        <label className="block">
          <span className="mb-1 block text-xs font-bold text-slate-500">这台设备的名称</span>
          <input value={deviceName} onChange={(event) => setDeviceName(event.target.value)} className="w-full rounded-xl border border-slate-200 px-3 py-2 outline-none focus:border-emerald-400" placeholder="例如：家里的电脑" />
        </label>

        <div className="rounded-2xl bg-slate-50 p-3 text-xs leading-5">
          {configured ? (
            <>
              <div className="font-bold text-slate-700">已使用记忆宫殿中的云端同步配置</div>
              <div className="mt-1 break-all text-slate-400">{remoteVectorConfig.supabaseUrl}</div>
              {cloudContext && <div className="mt-1 text-slate-500">已发布来自 {cloudContext.sourceDeviceName || '未命名设备'}</div>}
            </>
          ) : <div>尚未配置云端服务。请先到“记忆宫殿 → 设置 → 云端记忆同步”完成配置。</div>}
        </div>

        {status && (
          <div className={`flex items-start gap-2 rounded-2xl p-3 text-xs leading-5 ${status.kind === 'ok' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-800'}`}>
            {status.kind === 'ok' ? <CheckCircle size={17} weight="fill" className="mt-0.5 shrink-0" /> : <WarningCircle size={17} weight="fill" className="mt-0.5 shrink-0" />}
            <span>{status.text}</span>
          </div>
        )}

        <div className="grid grid-cols-1 gap-2">
          <button type="button" disabled={busy} onClick={() => void publishRecent()} className="flex items-center justify-center gap-2 rounded-2xl bg-emerald-600 px-4 py-3 font-bold text-white disabled:opacity-50">
            {busy ? <ArrowClockwise size={18} className="animate-spin" /> : <CloudArrowUp size={18} weight="bold" />}
            同步上下文 · 生成总结并预览
          </button>
          <button type="button" disabled={busy} onClick={() => void receiveRecent()} className="flex items-center justify-center gap-2 rounded-2xl border border-emerald-200 bg-white px-4 py-3 font-bold text-emerald-700 disabled:opacity-50">
            <CloudArrowDown size={18} weight="bold" />
            接收其他设备的上下文
          </button>
          {isSupabase && (
            <button type="button" onClick={() => { void navigator.clipboard.writeText(SHARED_CONTEXT_SQL); setStatus({ kind: 'ok', text: '最新初始化/升级 SQL 已复制，请到 Supabase SQL Editor 运行一次' }); }} className="flex items-center justify-center gap-2 px-3 py-2 text-xs font-semibold text-slate-500">
              <Copy size={15} />复制 Supabase 接力表初始化/升级 SQL
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
};

export default RecentContextHandoffModal;
