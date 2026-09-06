import { describe, expect, it } from 'vitest';
import { buildLiteBuiltinChatPrompt, buildLiteRoleContext, LITE_ROLE_PRESET_TEMPLATE, resolveLiteRolePreset } from './prompts';
import type { LiteIdentity } from './types';

const identity: LiteIdentity = {
  characterName: '小树',
  userName: '小雨',
  systemPrompt: LITE_ROLE_PRESET_TEMPLATE,
  useBuiltinRules: true,
};

describe('Sully Lite prompts', () => {
  it('resolves names in the editable role template', () => {
    const result = resolveLiteRolePreset(LITE_ROLE_PRESET_TEMPLATE, identity);
    expect(result).toContain('你是 小树');
    expect(result).toContain('小雨');
    expect(result).not.toContain('{{characterName}}');
  });

  it('builds an original-style role context', () => {
    const result = buildLiteRoleContext(identity);
    expect(result).toContain('[System: Roleplay Configuration]');
    expect(result).toContain('### 你的身份 (Character)');
    expect(result).toContain('### 互动对象 (User)');
  });

  it('keeps general chat rules without unsupported original action directives', () => {
    const result = buildLiteBuiltinChatPrompt();
    expect(result).toContain('即时聊天方式');
    expect(result).toContain('独立人格');
    expect(result).toContain('上下文与记忆');
    expect(result).not.toContain('SEND_EMOJI');
    expect(result).not.toContain('ACTION:TRANSFER');
  });
});
