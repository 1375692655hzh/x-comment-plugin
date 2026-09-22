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
    name: '自定义接口', // 供应商显示名（v0.5.12；首个自定义接口=主槽位，历史字段结构不变）
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini', // 当前使用（active），恒 ∈ models（v0.5.3 起约束）
    models: ['gpt-4o-mini'] // 可用模型列表（设置页可增删，面板顶部下拉数据源）
  },

  // 额外的 OpenAI 兼容供应商档案（v0.5.12 多供应商）：结构与主槽位 custom 一致，
  // 另带 id。供应商列表 = [xAI, 主槽位 custom, Grok 授权, ...customVendors]
  customVendors: [],
  // provider==='custom' 时，实际使用哪个自定义档案：'primary'（主槽位）或 customVendors 的 id
  activeCustomVendorId: 'primary',

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

  // 人设提示词：定义"你是谁"（语气/身份/领域/表达习惯），作为 system 提示词。
  // v0.5.11 起只内置一个「自然网友」（用户要求：预设人设只保留自然网友）
  personaPresets: [
    {
      id: 'p-general',
      name: '自然网友',
      persona:
        '你是 X 上一位活跃的资深网友，见解独到、表达自然。像真人一样说话：不用 AI 腔，不写"首先/其次/总之"，不堆砌感叹号，不用列表体。观点具体，偶尔带点幽默。'
    }
  ],

  // 生成提示词：定义"怎么写"。占位符：{tweet_text} {author} {topic}
  // v0.5.14 五件套文案升级：五引擎（K3/Grok4.7/GPT-6-Astra/Gemini-3.8）同题评审综合版。
  // 设计原则（评审共识）：风格层只管内容策略（选角度/给什么料/怎么收尾），文风戒律归人设层
  // 与去AI味层；每条带兜底分支防硬造；负向禁令配正向替代动作。
  genPresets: [
    {
      id: 'g-agree',
      name: '认同 + 补充观点',
      prompt:
        '回复这条推文：用自己的话点出一个你认同的具体点（别复述原句，也别用"说得好""深有同感"开头），再补一层对方没说的：一个新视角、实际影响或适用边界，让人接得上话。没有值得认同的点就中性接话，不硬夸；没经历过的别编。像顺手回帖。总长不超过 280 字符，最多 1 个 emoji。\n\n推文作者：{author}\n推文内容：\n{tweet_text}'
    },
    {
      id: 'g-question',
      name: '犀利提问',
      prompt:
        '只问一个具体、答得上来的问题：戳论证里最影响结论的缺口——缺的数据、没验证的假设或没覆盖的边界。要求：用半句自己的话点出卡在哪（别复述原推、别夹推文没有的事实），语气好奇较真、就事论事，不用"难道/为什么不"式反问，不预设对方错了；推文是经历或感受就追问细节，别让人自证。不超过 200 字符。\n\n推文内容：\n{tweet_text}'
    },
    {
      id: 'g-humor',
      name: '幽默玩梗',
      prompt:
        '用一句轻松的话回复这条推文：从内容里找反差或槽点，顺着推到荒谬一步，或抖个贴着这条推文的包袱、接地气的类比。要求：梗从这条推文长出来，不硬蹭热梗，也不解释笑点；笑点对准事，不对准人，不堆 emoji 和"哈哈哈"；没笑点就走机智观察，宁平淡不尬梗；遇到悲痛或求助的帖子就收起玩笑。不超过 160 字符。\n\n推文内容：\n{tweet_text}'
    },
    {
      id: 'g-tldr',
      name: '省流党',
      prompt:
        '以"省流："开头，一句话把这条推文压成更准的说法：它真正的结论，或它没说出口的前提。要求：一针见血、大白话，不替作者编动机；有标题党或贩卖焦虑的嫌疑就客观点破，没有就老实总结不硬挑刺；原帖本身很短就直接提炼重点，不复读。最后跟一句你的态度短评，只一句。全文不超过 120 字符。\n\n推文内容：\n{tweet_text}'
    },
    {
      id: 'g-deep',
      name: '深度分析',
      prompt:
        '回复这条推文，只抓一个别人容易漏掉的点：关键变量、逻辑断点或适用条件，讲清它怎么改变结论，收尾给出你的判断（不必提问）。要求：评论体，两三句写完，不写成小作文、不用学术腔；依据只写推文里有的或不用查也成立的常识，拿不准就删掉依据改说推测，不编数字案例和经历。不超过 280 字符。\n\n推文内容：\n{tweet_text}'
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
    // v0.5.11 起 1000（旧默认 400 对推理模型偏小，用户定 1000）
    maxTokens: 1000,
    // v0.5.11 起默认强制中文（旧默认 'auto' 跟随推文语言）；'en' 强制英文
    language: 'zh',
    // 思考强度：'default' 不发送该参数（对不支持的端点零影响）| 'low' | 'medium' | 'high'
    reasoningEffort: 'default',
    // 账号模式：'free' = X 免费用户（280 字符上限，生成时注入硬约束）| 'premium' = 付费不限长
    xPlan: 'free',
    targetLength: '', // 付费模式的目标字数（字符串，空 = 不加长度指令，仅模糊参考）
    // 去AI味（v0.5.9）：'on' = 生成后再走一遍"人味改写"二段调用（参考 blader/humanizer
    // 与 Humanizer-zh 的 AI 痕迹清单）。代价 = 每次生成两次请求；脏值一律按 off
    humanize: 'off'
  },

  // 面板停靠侧：'left' | 'right'（全高侧边栏形态，v0.5.1 起默认右侧）
  panelSide: 'right',

  // 预设结构版本标记（v0.5.11）：旧数据没有此标记 → xccMergeSettings 执行一次预设收敛迁移
  presetsV2: true,
  // 风格文案版本标记（v0.5.14）：旧数据没有此标记 → 内置五件套 prompt 按新文案升级
  // （用户自定义预设 id 不在内置集合内的原样保留，人设预设不动）
  presetsV3: true
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
  // v0.5.12 多供应商：额外档案逐个做与主槽位同款的规范化
  // （从"合并前的原始存储值"判断 models，收敛规则同 v0.5.3 的 P0 修复）
  const rawVendors = Array.isArray(s.customVendors) ? s.customVendors : [];
  const customVendors = [];
  const seenIds = new Set();
  for (const rv of rawVendors) {
    if (!rv || typeof rv !== 'object') continue;
    let id = String(rv.id || '').trim() || xccUid('cv');
    while (seenIds.has(id)) id = xccUid('cv'); // id 去重，防切换串档
    seenIds.add(id);
    const v = {
      id,
      kind: 'custom',
      name: String(rv.name || '').trim() || '未命名接口',
      baseUrl: String(rv.baseUrl || '').trim(),
      apiKey: String(rv.apiKey || ''),
      model: String(rv.model || '').trim() || 'gpt-4o-mini'
    };
    let vModels = Array.isArray(rv.models)
      ? rv.models.map((m) => String(m || '').trim()).filter(Boolean)
      : [];
    if (!vModels.length) vModels = [v.model];
    if (!vModels.includes(v.model)) v.model = vModels[0];
    v.models = [...new Set(vModels)];
    customVendors.push(v);
  }
  const activeCustomVendorId =
    s.activeCustomVendorId && s.activeCustomVendorId !== 'primary'
      ? customVendors.some((v) => v.id === s.activeCustomVendorId)
        ? s.activeCustomVendorId
        : 'primary'
      : 'primary';
  // v0.5.11 预设收敛迁移（presetsV2 标记，对旧数据只执行一次，写盘随任意一次
  // 设置变更持久化）：
  // ① 人设只留「自然网友」、生成风格换五件套（认同+补充/犀利提问/幽默玩梗/省流党/深度分析）
  // ② 从未动过的默认参数顺手升级：maxTokens 旧默认 400→1000、language 旧默认 auto→强制中文；
  //    用户自定义过的值不动（≠旧默认即视为动过）
  let personaPresets =
    Array.isArray(s.personaPresets) && s.personaPresets.length
      ? s.personaPresets
      : XCC_DEFAULTS.personaPresets;
  let genPresets =
    Array.isArray(s.genPresets) && s.genPresets.length ? s.genPresets : XCC_DEFAULTS.genPresets;
  let activePersonaId = s.activePersonaId;
  let activeGenId = s.activeGenId;
  const genParams = { ...XCC_DEFAULTS.genParams, ...(s.genParams || {}) };
  if (!s.presetsV2) {
    personaPresets = XCC_DEFAULTS.personaPresets;
    genPresets = XCC_DEFAULTS.genPresets;
    if (genParams.maxTokens === 400) genParams.maxTokens = 1000;
    if (!genParams.language || genParams.language === 'auto') genParams.language = 'zh';
  } else if (!s.presetsV3) {
    // v0.5.14：内置五件套文案升级（五引擎评审综合版）。只按 id 替换内置条目，
    // 用户自己新增的风格预设（id 不在内置集合）原样保留——不同于 v0.5.11 的整体收敛。
    const builtinIds = new Set(XCC_DEFAULTS.genPresets.map((g) => g.id));
    const extras = genPresets.filter((g) => g && g.id && !builtinIds.has(g.id));
    genPresets = [...XCC_DEFAULTS.genPresets, ...extras];
  }
  // active 指向已删除的预设时收敛到首个（防下拉空选中/GENERATE 走错预设）
  if (!personaPresets.some((p) => p.id === activePersonaId)) {
    activePersonaId = personaPresets[0].id;
  }
  if (!genPresets.some((g) => g.id === activeGenId)) activeGenId = genPresets[0].id;
  return {
    ...XCC_DEFAULTS,
    ...s,
    xai: { ...XCC_DEFAULTS.xai, ...(s.xai || {}) },
    custom,
    customVendors,
    activeCustomVendorId,
    grokOAuth,
    genParams,
    personaPresets,
    genPresets,
    activePersonaId,
    activeGenId,
    presetsV2: true,
    presetsV3: true
  };
}

function xccUid(prefix) {
  return prefix + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// 当前生效的自定义接口配置（v0.5.12 多供应商）：
// provider==='custom' 时按 activeCustomVendorId 取额外档案，否则（含脏值/缺省）回落主槽位 s.custom。
// 返回的带 id 字段（'primary' 或档案 id），供 UI 反写定位。
function xccActiveCustom(s) {
  const wantId = s.activeCustomVendorId;
  const list = Array.isArray(s.customVendors) ? s.customVendors : [];
  const v = wantId && wantId !== 'primary' ? list.find((x) => x && x.id === wantId) : null;
  return v ? { ...v, id: v.id } : { ...s.custom, id: 'primary' };
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
  const acc = xccActiveCustom(s); // provider 非 custom 时也返回主槽位（供列表 ready 计算）
  const model = isXai ? s.xai.model : isCustom ? acc.model : s.grokOAuth.model;
  // v0.5.12 供应商列表：xAI / 首个自定义（主槽位）/ Grok 授权 / 额外自定义档案
  const vendorList = [
    { id: 'xai', name: 'xAI API', ready: !!s.xai.apiKey },
    { id: 'primary', name: s.custom.name || '自定义接口', ready: !!s.custom.baseUrl },
    { id: 'grok-oauth', name: 'Grok 授权', ready: !!(s.grokOAuth.tokens && s.grokOAuth.tokens.access_token) },
    ...(Array.isArray(s.customVendors) ? s.customVendors : []).map((v) => ({
      id: v.id,
      name: v.name,
      ready: !!v.baseUrl
    }))
  ];
  const activeVendorId = isXai ? 'xai' : !isCustom ? 'grok-oauth' : acc.id;
  const activeVendorName = (vendorList.find((v) => v.id === activeVendorId) || vendorList[0]).name;
  const label = activeVendorName + ' · ' + model;
  // v0.5.3：面板顶部模型下拉数据源（按接入方式合并去重，恒含当前值）
  let modelCandidates;
  let modelVerified = []; // 仅 grok-oauth 非空：已确认在账号目录内的 ID（「已验证」标注集合）
  if (isXai) {
    modelCandidates = [...new Set([...XCC_XAI_MODEL_CANDIDATES, model])];
  } else if (isCustom) {
    const arr = Array.isArray(acc.models) ? acc.models : [];
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
    vendorList, // 全部供应商（id/name/ready），面板供应商下拉数据源
    activeVendorId,
    activeVendorName,
    model, // 当前使用的模型 ID（面板下拉选中项 = GENERATE 实际使用）
    modelCandidates, // 候选顺序即展示顺序
    modelVerified, // 空数组 = 不做「已验证/未验证」标注
    ready: {
      xai: !!s.xai.apiKey,
      custom: isCustom ? !!acc.baseUrl : !!s.custom.baseUrl,
      'grok-oauth': !!(s.grokOAuth.tokens && s.grokOAuth.tokens.access_token)
    },
    personaPresets: s.personaPresets,
    genPresets: s.genPresets,
    activePersonaId: s.activePersonaId,
    activeGenId: s.activeGenId,
    stance: ['optimistic', 'pessimistic'].includes(s.stance) ? s.stance : 'objective', // 脏值一律按客观
    genParams: {
      xPlan: s.genParams.xPlan === 'premium' ? 'premium' : 'free', // 脏值一律按 free
      targetLength: String(s.genParams.targetLength || ''),
      humanize: s.genParams.humanize === 'on' ? 'on' : 'off' // 脏值一律按 off
    },
    panelSide: s.panelSide === 'left' ? 'left' : 'right' // 缺省/脏值一律按 right（v0.5.1 起新默认）
  };
}
