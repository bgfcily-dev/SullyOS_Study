import { describe, expect, it } from 'vitest';
import { buildLiteBuiltinChatPrompt, buildLiteRoleContext, buildLiteTimeAwarenessPrompt, resolveLiteRolePreset } from './prompts';
import type { LiteIdentity } from './types';

const identity: LiteIdentity = {
  characterName: '小树',
  characterAvatar: '',
  userName: '小雨',
  userPrompt: '喜欢安静的晚上聊天。',
  systemPrompt: '你说话直接，但会认真倾听 {{userName}}。',
};

describe('Sully Lite prompts', () => {
  it('resolves names in the editable role template', () => {
    const result = resolveLiteRolePreset('我是 {{characterName}}，正在和 {{userName}} 聊天。', identity);
    expect(result).toContain('我是 小树');
    expect(result).toContain('小雨');
    expect(result).not.toContain('{{characterName}}');
  });

  it('builds an original-style role context', () => {
    const result = buildLiteRoleContext(identity);
    expect(result).toContain('[System: Roleplay Configuration]');
    expect(result).toContain('### 你的身份 (Character)');
    expect(result).toContain('### 互动对象 (User)');
    expect(result).toContain('会认真倾听 小雨');
    expect(result).toContain('喜欢安静的晚上聊天');
  });

  it('keeps general chat rules without unsupported original action directives', () => {
    const result = buildLiteBuiltinChatPrompt();
    expect(result).toContain('即时聊天方式');
    expect(result).toContain('独立人格');
    expect(result).toContain('上下文与记忆');
    expect(result).not.toContain('SEND_EMOJI');
    expect(result).not.toContain('ACTION:TRANSFER');
  });

  it('keeps built-in behavior out of the editable role context', () => {
    const result = buildLiteRoleContext(identity);
    expect(result).not.toContain('Lite 聊天行为规范');
    expect(result).not.toContain('不需要事事赞同');
  });

  it('adds deterministic local time and human-routine guidance', () => {
    const result = buildLiteTimeAwarenessPrompt(new Date(2026, 8, 7, 23, 5));
    expect(result).toContain('2026年9月7日');
    expect(result).toContain('23点05分');
    expect(result).toContain('正常人类作息');
    expect(result).toContain('不要机械套用作息');
  });
});
