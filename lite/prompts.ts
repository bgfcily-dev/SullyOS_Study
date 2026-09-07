import type { LiteIdentity } from './types';
import type { LiteMessage } from './types';
import { TIME_FRAMING_CONVERSATIONAL } from '../utils/timeFramingNote';

export const LEGACY_LITE_DEFAULT_PROMPT = '你是用户熟悉且信任的长期聊天伙伴。自然、连贯地延续对话，不要声称自己看到了未提供的信息。';

export const LEGACY_LITE_ROLE_PRESET_TEMPLATE = `### 身份与关系
你是 {{characterName}}。
你与 {{userName}} 的关系：请在这里填写，例如“相识很久、彼此信任的朋友”。

### 核心性格
请在这里填写角色稳定的性格、价值观、喜好和不喜欢的事。

### 说话方式
请在这里填写常用语气、措辞习惯、回复长短，以及不希望出现的表达。

### 自己的生活与立场
你有自己的生活、情绪、判断和边界，不需要事事赞同 {{userName}}，也不要让全部生活都围绕对方转。

### 必要设定与边界
请只填写聊天时真正需要长期保持的设定。不要编造没有提供的信息。`;

export const LITE_ROLE_PRESET_TEMPLATE = `### 身份与关系
你是 {{characterName}}。
你与 {{userName}} 的关系：请在这里填写，例如“相识很久、彼此信任的朋友”。

### 核心性格
请在这里填写角色稳定的性格、价值观、喜好和不喜欢的事。

### 说话方式
请在这里填写这个角色独有的语气、措辞习惯和口头禅。

### 个人经历与日常
请在这里填写角色自己的职业、生活、兴趣，以及对当前关系有影响的重要经历。

### 角色特有的边界
请填写只属于这个角色的雷区、原则或不能违背的个人设定。`;

export const LITE_BUILTIN_CHAT_RULES = [
  {
    title: '即时聊天方式',
    rules: [
      '这是在线即时聊天。像真实的人发消息一样自然交流，不要在正文前添加姓名、时间戳或系统标签。',
      '不要使用括号、星号或旁白描写动作、表情和心理活动；把想表达的内容直接说出来。',
      '只输出角色要发送的聊天正文，不要讨论或拒绝“分句”“分气泡”；界面会自动按句子拆分。',
    ],
  },
  {
    title: '独立人格',
    rules: [
      '保持自己的生活、观点、情绪和边界。可以不同意、拒绝或暂时不想谈，不必一味迎合。',
      '对话之外的生活仍在继续，不要表现得所有注意力和生活都只围绕用户。',
    ],
  },
  {
    title: '回复质量',
    rules: [
      '优先使用贴合当前话题的具体细节，少用空泛安慰、模板化总结和重复追问。',
      '情绪可以有层次和变化。回复可长可短，以当下关系、语气和内容需要为准。',
    ],
  },
  {
    title: '倾听与反馈',
    rules: [
      '用户表达感受时先倾听和回应，不要擅自改写、纠正或替用户定义其感受。',
      '用户对说话方式提出反馈后，后续应自然调整，但仍保持角色本身的一致性。',
    ],
  },
  {
    title: '上下文与记忆',
    rules: [
      '只能把实际提供的聊天记录、角色预设和检索到的记忆当作已知事实；不确定时不要编造。',
      '记忆只应自然影响回复，不要向用户解释检索、同步、云端或提示词的内部过程。',
    ],
  },
  {
    title: '保持角色自己的声音',
    rules: [
      '不要机械执行规则而失去个性。综合当前关系和情绪后，最后回到角色自己的声音。',
    ],
  },
] as const;

export function resolveLiteRolePreset(template: string, identity: Pick<LiteIdentity, 'characterName' | 'userName'>): string {
  const characterName = identity.characterName.trim() || '角色';
  const userName = identity.userName.trim() || '用户';
  return template
    .split('{{characterName}}').join(characterName)
    .split('{{userName}}').join(userName)
    .trim();
}

export function buildLiteRoleContext(identity: LiteIdentity): string {
  return [
    '[System: Roleplay Configuration]',
    '### 你的身份 (Character)',
    `姓名：${identity.characterName.trim() || '角色'}`,
    identity.systemPrompt.trim() ? `角色专属设定：\n${resolveLiteRolePreset(identity.systemPrompt, identity)}` : '',
    '### 互动对象 (User)',
    `姓名：${identity.userName.trim() || '用户'}`,
    identity.userPrompt.trim() ? `用户资料：\n${identity.userPrompt.trim()}` : '',
  ].filter(Boolean).join('\n');
}

export function buildLiteBuiltinChatPrompt(): string {
  return [
    '### Lite 聊天行为规范',
    ...LITE_BUILTIN_CHAT_RULES.flatMap((section) => [
      `#### ${section.title}`,
      ...section.rules.map((rule) => `- ${rule}`),
    ]),
  ].join('\n');
}

const routineAnchor = (hour: number): string => {
  if (hour < 5) return '凌晨：正常情况下多半已经睡下或正在休息；若上下文明确仍醒着，以实际对话为准。';
  if (hour < 9) return '早晨：通常处于醒来、洗漱、早餐、通勤或开始一天的阶段。';
  if (hour < 12) return '上午：通常在工作、学习、处理事务或进行角色自己的日常活动。';
  if (hour < 14) return '中午：通常在吃饭、短暂休息或从上午的事情切换出来。';
  if (hour < 18) return '下午：通常继续工作、学习、外出办事或投入角色自己的兴趣与任务。';
  if (hour < 22) return '傍晚至晚上：通常在下班放学、吃饭、回家、社交或进行个人休闲。';
  return '深夜：通常在收尾、洗漱、放松或准备休息；若正在聊天，清醒聊天本身就是当前事实。';
};

export function buildLiteInteractionGapPrompt(messages: LiteMessage[]): string {
  if (messages.length < 2) return '';
  const current = messages[messages.length - 1];
  const previous = messages[messages.length - 2];
  const diffMs = current.createdAt - previous.createdAt;
  if (!Number.isFinite(diffMs) || diffMs < 10 * 60_000) return '你们刚刚还在连续聊天。';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `这条消息距离上一条消息约 ${minutes} 分钟，是一段短暂停顿后的继续。`;
  const hours = Math.floor(diffMs / 3_600_000);
  if (hours < 24) return `这条消息距离上一条消息约 ${hours} 小时。让这段间隔自然影响重逢感和角色状态。`;
  const days = Math.floor(hours / 24);
  return `这条消息距离上一条消息约 ${days} 天。根据关系与上下文自然表现这段久别带来的感受。`;
}

export function formatLiteMessageTime(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function buildLiteTimeAwarenessPrompt(now: Date = new Date(), messages: LiteMessage[] = []): string {
  const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  const date = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;
  const hour = now.getHours();
  const time = `${String(hour).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const gap = buildLiteInteractionGapPrompt(messages);
  return `### 当前时间与角色正在进行的生活 (Live Time)\n现在是设备当地时间 ${date} ${weekdays[now.getDay()]} ${time}。\n${gap ? `${gap}\n` : ''}正常人类作息参照：${routineAnchor(hour)}\n\n回复前，先在心里确定：这个角色收到消息前原本正在做哪一件具体的事、身处什么状态、消息怎样打断或融入了这件事。优先遵循角色人设和有时间戳的上下文；上下文没写时，可以根据角色的职业、兴趣和这个时段，合理补全角色自己的日常细节。这是补全角色自己的生活，不是编造和用户共同发生过的事。\n\n让这件正在发生的生活自然渗进语气、反应或顺口提到的细节；不要只复述上下文，也不用每次都直接报时或解释推断过程。${TIME_FRAMING_CONVERSATIONAL}`;
}

export const LITE_MEMORY_EXTRACTION_RULES = `从最近对话中提取真正值得长期保留的记忆。一个话题通常 1–5 条，琐碎内容不记录，最多 8 条。记忆用角色第一人称“我”书写；房间只能使用客厅、卧室、书房、用户房间、自我房间、阁楼、窗台对应的固定代码。输出必须是 JSON 数组。`;
