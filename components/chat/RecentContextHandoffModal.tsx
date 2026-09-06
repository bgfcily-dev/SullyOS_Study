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

  useEffect(() => {
    localStorage.setItem(DEVICE_NAME_KEY, deviceName.trim() || '主设备');
  }, [deviceName]);

  useEffect(() => {
    if (!isOpen) return;
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
      setStatus({ kind: 'warn', text: '请先在记忆宫殿设置中配置远程向量存储（Supabase）' });
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
            id: importedCloudId || `main:${character.id}:${message.id}`,
            role: message.role as 'user' | 'assistant',
            content: normalizeMessageContent(message, character.name, userName || 'TA'),
            createdAt: message.timestamp,
            origin: importedCloudId ? 'lite' as const : 'main' as const,
          };
        })
        .filter((message) => message.content.trim());
      const next = await publishSharedContext({
        config: cloudConfig,
        charId: character.id,
        sharedMessages: latest?.charId === character.id ? latest.messages : [],
        localMessages,
        previousRevision: latest?.revision || 0,
      });
      setCloudContext(next);
      setStatus({ kind: 'ok', text: `已发布 ${next.messages.length} 条近期消息（第 ${next.revision} 版）。角色名称和设定没有上传。` });
    } catch (error: any) {
      setStatus({ kind: 'warn', text: error?.message || '发布失败' });
    } finally {
      setBusy(false);
    }
  };

  const receiveRecent = async () => {
    if (!configured) {
      setStatus({ kind: 'warn', text: '请先在记忆宫殿设置中配置远程向量存储（Supabase）' });
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

      const seenKey = `os_handoff_seen_${character.id}`;
      let storedSeen: string[] = [];
      try { storedSeen = JSON.parse(localStorage.getItem(seenKey) || '[]'); } catch { storedSeen = []; }
      const seen = new Set(storedSeen);
      const { messages: recentLocal } = await DB.getRecentMessagesWithCount(character.id, 200);
      for (const message of recentLocal) {
        const cloudId = message.metadata?.handoffCloudMessageId;
        if (typeof cloudId === 'string') seen.add(cloudId);
      }
      const additions = latest.messages.filter((message) => message.origin === 'lite' && !seen.has(message.id));
      for (const message of additions) {
        await DB.saveMessage({
          charId: character.id,
          role: message.role,
          type: 'text',
          content: message.content,
          timestamp: message.createdAt,
          metadata: {
            source: 'lite_handoff',
            handoffCloudMessageId: message.id,
            handoffDeviceId: latest.sourceDeviceId,
            handoffDeviceName: latest.sourceDeviceName,
          },
        });
        seen.add(message.id);
      }
      localStorage.setItem(seenKey, JSON.stringify([...seen].slice(-200)));
      if (additions.length > 0) await onImported();
      setStatus({ kind: 'ok', text: additions.length > 0 ? `已把轻量设备新增的 ${additions.length} 条消息接回原版` : '云端没有尚未接回的新消息' });
    } catch (error: any) {
      setStatus({ kind: 'warn', text: error?.message || '接收失败' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen={isOpen} title="跨设备接力" onClose={onClose}>
      <div className="space-y-4 text-sm text-slate-600">
        <div className="rounded-2xl border border-emerald-100 bg-emerald-50 p-3">
          <div className="font-bold text-emerald-800">当前角色：{character.name}</div>
          <div className="mt-1 break-all font-mono text-[10px] text-emerald-700">charId: {character.id}</div>
          <div className="mt-2 text-xs leading-5 text-emerald-700">只同步角色 ID 和最近 30 条消息，不上传世界观、角色设定或 API 密钥。</div>
        </div>

        <label className="block">
          <span className="mb-1 block text-xs font-bold text-slate-500">这台设备的名称</span>
          <input value={deviceName} onChange={(event) => setDeviceName(event.target.value)} className="w-full rounded-xl border border-slate-200 px-3 py-2 outline-none focus:border-emerald-400" placeholder="例如：家里的电脑" />
        </label>

        <div className="rounded-2xl bg-slate-50 p-3 text-xs leading-5">
          {configured ? (
            <>
              <div className="font-bold text-slate-700">已使用记忆宫殿中的 Supabase 配置</div>
              <div className="mt-1 break-all text-slate-400">{remoteVectorConfig.supabaseUrl}</div>
              {cloudContext && <div className="mt-1 text-slate-500">云端第 {cloudContext.revision} 版 · 来自 {cloudContext.sourceDeviceName || '未命名设备'}</div>}
            </>
          ) : <div>尚未配置 Supabase。请先到“记忆宫殿 → 设置 → 远程向量存储”完成配置。</div>}
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
            发布最近 30 条
          </button>
          <button type="button" disabled={busy} onClick={() => void receiveRecent()} className="flex items-center justify-center gap-2 rounded-2xl border border-emerald-200 bg-white px-4 py-3 font-bold text-emerald-700 disabled:opacity-50">
            <CloudArrowDown size={18} weight="bold" />
            接收轻量版新增消息
          </button>
          <button type="button" onClick={() => { void navigator.clipboard.writeText(SHARED_CONTEXT_SQL); setStatus({ kind: 'ok', text: '最新初始化/升级 SQL 已复制，请到 Supabase SQL Editor 运行一次' }); }} className="flex items-center justify-center gap-2 px-3 py-2 text-xs font-semibold text-slate-500">
            <Copy size={15} />复制接力表初始化/升级 SQL
          </button>
        </div>
      </div>
    </Modal>
  );
};

export default RecentContextHandoffModal;
