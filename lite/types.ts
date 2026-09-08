import type { HandoffCloudConfig, HandoffMessage, SharedRecentContext as HandoffContext } from '../utils/recentContextHandoff';

export type LiteMessage = HandoffMessage;
export type SharedRecentContext = HandoffContext;

export interface LiteApiProfile {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface LiteMemorySummaryApi {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface LiteIdentity {
  characterName: string;
  characterAvatar: string;
  userName: string;
  userPrompt: string;
  systemPrompt: string;
}

export type LiteTheme = 'light' | 'dark';

export interface LiteCloudConfig extends HandoffCloudConfig {}

export interface LiteEmbeddingConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  dimensions: number;
  extractionPrompt: string;
}

export interface LiteMemoryDraft {
  content: string;
  room: 'living_room' | 'bedroom' | 'study' | 'user_room' | 'self_room' | 'attic' | 'windowsill';
  importance: number;
  mood: string;
  tags: string[];
}

export interface PreparedLiteMemoryBatch {
  memories: LiteMemoryDraft[];
  charId: string;
  contextSignature: string;
  createdAt: number;
  usedMessages: number;
}

export interface LiteSticker {
  name: string;
  url: string;
}

export interface LiteMemoryRecall {
  memoryId: string;
  content: string;
  room: string;
  importance: number;
  similarity: number;
}

export interface LiteVectorStats {
  totalCount: number;
  currentCharacterCount: number | null;
  charId: string;
  checkedAt: number;
}

export interface LiteSyncedMemory {
  memoryId: string;
  charId: string;
  content: string;
  room: LiteMemoryDraft['room'];
  importance: number;
  mood: string;
  tags: string[];
  createdAt: number;
  lastAccessedAt: number;
  accessCount: number;
  model: string;
  dimensions: number;
  archived: boolean;
}
