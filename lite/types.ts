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

export interface LiteIdentity {
  characterName: string;
  userName: string;
  systemPrompt: string;
}

export interface LiteCloudConfig extends HandoffCloudConfig {}

export interface LiteEmbeddingConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  dimensions: number;
}

export interface LiteMemoryRecall {
  memoryId: string;
  content: string;
  room: string;
  importance: number;
  similarity: number;
}
