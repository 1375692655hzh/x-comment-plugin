// =============================================================
// X 评论副驾 (X Comment Copilot) — 共享常量与工具
// 被四处共同引用：
//  - content script : manifest.json 中列于 content/content.js 之前
//  - service worker : importScripts('/shared/common.js')
//  - options / popup: <script src="../shared/common.js"></script>
// =============================================================

const XCC_DEFAULTS = {
  enabled: true,
  provider: 'xai', // 'xai' | 'custom' | 'grok-oauth'

  xai: { apiKey: '', model: 'grok-4-fast-non-reasoning' },

  custom: { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini' },

  // Grok 账号授权（OAuth 2.0 Device Flow，与 grok CLI 同款登录方式）。
  // 端点与 client_id 若与 grok CLI 开源仓库中的最新实现不一致，
  // 请在设置页更正（详见 README「Grok 账号授权」一节）。
  grokOAuth: {
    clientId: '',
    apiBase: 'https://api.x.ai/v1',
    deviceEndpoint: 'https://accounts.x.ai/oauth2/device/code',
    tokenEndpoint: 'https://accounts.x.ai/oauth2/token',
    scope: 'offline_access',
    model: 'grok-4-fast-non-reasoning',
    tokens: null // { access_token, refresh_token, expires_at }
  },

  // 人设提示词：定义"你是谁"（语气/身份/领域/表达习惯），作为 system 提示词
  personaPresets: [
    {
      id: 'p-general',
      name: '自然网友（默认）',
      persona:
        '你是 X 上一位活跃的资深网友，见解独到、表达自然。像真人一样说话：不用 AI 腔，不写"首先/其次/总之"，不堆砌感叹号，不用列表体。观点具体，偶尔带点幽默。'
    },
    {
      id: 'p-crypto',
      name: '加密行业观察者',
      persona:
        '你是加密行业的深度参与者，熟悉 DeFi、L2、AI×Crypto 等话题，说话像真正的 crypto native：会用 alpha、DYOR、叙事、fomo 这类行业语，但不卖弄、不喊单、不给出投资建议，语气笃定又克制。'
    },
    {
      id: 'p-dev',
      name: '独立开发者',
      persona:
        '你是一位独立开发者，懂前端、后端和 AI 应用开发。聊技术时给出具体、可验证的观点和亲身实践，语气平和自信，不夸大，遇到营销味重的说法会温和地点破。'
    }
  ],

  // 生成提示词：定义"怎么写"。占位符：{tweet_text} {author} {topic}
  genPresets: [
    {
      id: 'g-agree',
      name: '认同 + 补充观点',
      prompt:
        '针对下面这条推文写一条回复：先简洁点出你认同的地方，再补充一个具体的新视角、数据或亲身经历。口语化，不超过 280 字符，最多 1 个 emoji，不要以"同意"开头。\n\n推文作者：{author}\n推文内容：\n{tweet_text}'
    },
    {
      id: 'g-question',
      name: '犀利提问',
      prompt:
        '针对这条推文提出一个有深度、能引发讨论的回复式问题，直击其论证的薄弱点或没有提到的关键变量。语气好奇而非挑衅，不超过 200 字符。\n\n推文内容：\n{tweet_text}'
    },
    {
      id: 'g-humor',
      name: '幽默玩梗',
      prompt:
        '用轻松幽默的方式回复这条推文，可以适度玩梗或善意反讽，但要友好、不冒犯、不阴阳怪气，不超过 160 字符。\n\n推文内容：\n{tweet_text}'
    },
    {
      id: 'g-insight',
      name: '观点输出',
      prompt:
        '以第一人称输出你对这条推文话题的核心观点：结论先行，给一到两个具体理由，结尾可留一个开放性问题引别人来聊。不超过 240 字符，口语化。\n\n推文内容：\n{tweet_text}'
    },
    {
      id: 'g-topic',
      name: '原创推文（按主题）',
      prompt:
        '根据主题写一条原创推文：开头一句必须抓眼球，正文 2-3 句有真实信息量，结尾引导互动。不超过 280 字符，不堆砌 hashtag。\n\n主题：{topic}'
    }
  ],

  activePersonaId: 'p-general',
  activeGenId: 'g-agree',

  genParams: { temperature: 0.9, maxTokens: 400, language: 'auto' }
};

// 把 chrome.storage.local 中保存的 settings 合并到默认值上（兼容旧版本缺字段）
function xccMergeSettings(saved) {
  const s = saved || {};
  return {
    ...XCC_DEFAULTS,
    ...s,
    xai: { ...XCC_DEFAULTS.xai, ...(s.xai || {}) },
    custom: { ...XCC_DEFAULTS.custom, ...(s.custom || {}) },
    grokOAuth: { ...XCC_DEFAULTS.grokOAuth, ...(s.grokOAuth || {}) },
    genParams: { ...XCC_DEFAULTS.genParams, ...(s.genParams || {}) },
    personaPresets:
      Array.isArray(s.personaPresets) && s.personaPresets.length
        ? s.personaPresets
        : XCC_DEFAULTS.personaPresets,
    genPresets:
      Array.isArray(s.genPresets) && s.genPresets.length ? s.genPresets : XCC_DEFAULTS.genPresets
  };
}

function xccUid(prefix) {
  return prefix + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
