// =============================================================
// X 评论副驾 (X Comment Copilot) — 共享常量与工具
// 被四处共同引用：
//  - content script : manifest.json 中列于 content/content.js 之前
//  - service worker : importScripts('/shared/common.js')
//  - options / popup: <script src="../shared/common.js"></script>
// =============================================================

// xAI 常见模型候选（设置页 datalist 与面板顶部下拉共用；当前值另行合并进候选）
const XCC_XAI_MODEL_CANDIDATES = [
  'grok-4-fast-non-reasoning',
  'grok-4-fast-reasoning',
  'grok-4',
  'grok-3',
  'grok-3-mini'
];

// Grok OAuth 内置兜底候选（options 页与面板顶部下拉共用）
const XCC_OAUTH_MODEL_FALLBACK = [
  'grok-4.3',
  'grok-4.5',
  'grok-composer-2.5-fast',
  'grok-3-fast',
  'grok-code-fast-1'
];

const XCC_DEFAULTS = {
  enabled: true,
  provider: 'xai', // 'xai' | 'custom' | 'grok-oauth'

  xai: { apiKey: '', model: 'grok-4-fast-non-reasoning' },

  custom: {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini', // 当前使用（active），恒 ∈ models（v0.5.3 起约束）
    models: ['gpt-4o-mini'] // 可用模型列表（设置页可增删，面板顶部下拉数据源）
  },

  // Grok 账号授权（OAuth 2.0 Device Flow，grok CLI 同款）。
  // 端点与公开 client_id 取自 xai-org/grok-build 开源实现（社区包 @piex-dev/xai-oauth 同款），
  // 已实测可用：授权服务器 auth.x.ai；订阅额度（SuperGrok / X Premium+）的对话调用
  // 走 cli-chat-proxy.grok.com，需带 x-grok-client-* 请求头（见 service-worker.js）。
  grokOAuth: {
    clientId: 'b1a00492-073a-47ea-816f-4c329264a828',
    deviceEndpoint: 'https://auth.x.ai/oauth2/device/code',
    tokenEndpoint: 'https://auth.x.ai/oauth2/token',
    scope: 'openid profile email offline_access grok-cli:access api:access',
    apiBase: 'https://cli-chat-proxy.grok.com/v1',
    model: 'grok-4.3',
    discoveredModels: [], // 最近一次 /models 发现的账号目录（下拉区分「已验证」用）
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

  // 观点倾向（v0.5.2）：影响生成评论的观点方向。
  // 'objective' = 客观，零注入（不往提示词加任何倾向指令，保持纯人设+风格）
  // 'optimistic' = 乐观 / 'pessimistic' = 消极：buildMessages 注入对应方向指令
  stance: 'objective',

  genParams: {
    temperature: 0.9,
    maxTokens: 400,
    language: 'auto',
    // 思考强度：'default' 不发送该参数（对不支持的端点零影响）| 'low' | 'medium' | 'high'
    reasoningEffort: 'default',
    // 账号模式：'free' = X 免费用户（280 字符上限，生成时注入硬约束）| 'premium' = 付费不限长
    xPlan: 'free',
    targetLength: '' // 付费模式的目标字数（字符串，空 = 不加长度指令，仅模糊参考）
  },

  // 面板停靠侧：'left' | 'right'（全高侧边栏形态，v0.5.1 起默认右侧）
  panelSide: 'right'
};

// 把 chrome.storage.local 中保存的 settings 合并到默认值上（兼容旧版本缺字段）
function xccMergeSettings(saved) {
  const s = saved || {};
  // 旧版本（v0.1.x）预填的是 accounts.x.ai 错误端点且 clientId 为空：
  // 用户从未定制/授权过时，整体采用 v0.2 的新默认值；有 token 时保留原值不动
  const g = s.grokOAuth || {};
  const grokOAuth =
    !g.tokens && !g.clientId ? XCC_DEFAULTS.grokOAuth : { ...XCC_DEFAULTS.grokOAuth, ...g };
  // v0.5.3 迁移：旧数据只有单 custom.model（或 models 缺失/为空/脏值）→ 收敛为 [model]；
  // active 不在列表内（如别端删掉了 active 行）→ 重置为首个，保证 GENERATE 恒有合法模型。
  // ⚠ models 必须从"合并前的原始存储值"判断——先合并默认值会让 models:['gpt-4o-mini']
  //   恒存在，收敛分支成死代码，旧用户的 model 被静默重置（cursor 审查发现的 P0）
  const rawCustom = s.custom || {};
  let customModels = Array.isArray(rawCustom.models)
    ? rawCustom.models.map((m) => String(m || '').trim()).filter(Boolean)
    : [];
  const custom = { ...XCC_DEFAULTS.custom, ...rawCustom };
  if (!customModels.length) {
    customModels = [String(custom.model || '').trim() || XCC_DEFAULTS.custom.model];
  }
  if (!customModels.includes(custom.model)) custom.model = customModels[0];
  custom.models = [...new Set(customModels)];
  return {
    ...XCC_DEFAULTS,
    ...s,
    xai: { ...XCC_DEFAULTS.xai, ...(s.xai || {}) },
    custom,
    grokOAuth,
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

// 最新版 ZIP 下载地址（更新提示直达用，content/options 直接 window.open）
const XCC_ZIP_URL =
  'https://github.com/1375692655hzh/x-comment-plugin/archive/refs/heads/main.zip';

// 版本比较：a 是否大于 b（点分数字逐段比较）
function xccIsNewerVersion(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

// 脱敏的公开配置视图（content/popup 直接本地计算，不依赖后台 SW）
function xccPublicSettings(s) {
  const isXai = s.provider === 'xai';
  const isCustom = s.provider === 'custom';
  const model = isXai ? s.xai.model : isCustom ? s.custom.model : s.grokOAuth.model;
  const label =
    s.provider === 'xai'
      ? 'xAI API · ' + model
      : s.provider === 'custom'
        ? '自定义 · ' + model
        : 'Grok 授权 · ' + model;
  // v0.5.3：面板顶部模型下拉数据源（按接入方式合并去重，恒含当前值）
  let modelCandidates;
  let modelVerified = []; // 仅 grok-oauth 非空：已确认在账号目录内的 ID（「已验证」标注集合）
  if (isXai) {
    modelCandidates = [...new Set([...XCC_XAI_MODEL_CANDIDATES, model])];
  } else if (isCustom) {
    const arr = Array.isArray(s.custom.models) ? s.custom.models : [];
    modelCandidates = [...new Set([...(arr.length ? arr : [model]), model])];
  } else {
    const disc = Array.isArray(s.grokOAuth.discoveredModels) ? s.grokOAuth.discoveredModels : [];
    modelVerified = disc;
    modelCandidates = [...new Set([...disc, ...XCC_OAUTH_MODEL_FALLBACK, model])];
  }
  return {
    enabled: s.enabled !== false,
    provider: s.provider,
    providerLabel: label,
    model, // 当前使用的模型 ID（面板下拉选中项 = GENERATE 实际使用）
    modelCandidates, // 候选顺序即展示顺序
    modelVerified, // 空数组 = 不做「已验证/未验证」标注
    ready: {
      xai: !!s.xai.apiKey,
      custom: !!s.custom.baseUrl,
      'grok-oauth': !!(s.grokOAuth.tokens && s.grokOAuth.tokens.access_token)
    },
    personaPresets: s.personaPresets,
    genPresets: s.genPresets,
    activePersonaId: s.activePersonaId,
    activeGenId: s.activeGenId,
    stance: ['optimistic', 'pessimistic'].includes(s.stance) ? s.stance : 'objective', // 脏值一律按客观
    genParams: {
      xPlan: s.genParams.xPlan === 'premium' ? 'premium' : 'free', // 脏值一律按 free
      targetLength: String(s.genParams.targetLength || '')
    },
    panelSide: s.panelSide === 'left' ? 'left' : 'right' // 缺省/脏值一律按 right（v0.5.1 起新默认）
  };
}
