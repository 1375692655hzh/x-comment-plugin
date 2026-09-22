// =============================================================
// X 评论副驾 — 共享网络层（service worker 与 options 页共用）
// 加载方：SW importScripts('/shared/common.js','/shared/api.js')
//        options <script src="../shared/api.js">（common.js 之后）
// content script 不加载本文件：生成走 SW 消息，content 无跨域豁免。
// ⚠ 本文件禁止与 common.js 重复声明顶层 const（重复声明会让 SW 崩溃）。
// =============================================================
'use strict';

const XCC_REPO = '1375692655hzh/x-comment-plugin';
const XCC_UPDATE_SOURCES = [
  'https://cdn.jsdelivr.net/gh/' + XCC_REPO + '@main/manifest.json',
  'https://raw.githubusercontent.com/' + XCC_REPO + '/main/manifest.json',
  'https://api.github.com/repos/' + XCC_REPO + '/contents/manifest.json?ref=main'
];

// cli-chat-proxy.grok.com 依赖这三个头把请求识别为 grok CLI 客户端
const XCC_GROK_CLIENT_HEADERS = {
  'x-grok-client-version': '0.2.101',
  'x-grok-client-surface': 'grok-build',
  'x-grok-client-mode': 'grok-shell'
};

// ---------- settings 统一读改写（读最新 → 改 → 写回，禁止整份快照覆盖） ----------

async function xccGetSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return xccMergeSettings(settings);
}

async function xccMutateSettings(fn) {
  const m = await xccGetSettings();
  fn(m);
  await chrome.storage.local.set({ settings: m });
  return m;
}

// ---------- 更新检测 ----------

async function xccFetchRemoteVersion() {
  for (const url of XCC_UPDATE_SOURCES) {
    try {
      const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(6000) });
      if (!res.ok) continue;
      let version = '';
      if (url.startsWith('https://api.github.com')) {
        const data = await res.json();
        version = JSON.parse(atob((data.content || '').replace(/\s/g, ''))).version;
      } else {
        version = (await res.json()).version;
      }
      if (version) return version;
    } catch (e) {
      /* 换下一个源 */
    }
  }
  return null;
}

async function xccCheckUpdate() {
  const cur = chrome.runtime.getManifest().version;
  const latest = await xccFetchRemoteVersion();
  const info = {
    latest: latest || cur,
    hasUpdate: !!latest && xccIsNewerVersion(latest, cur),
    checkedAt: Date.now()
  };
  await chrome.storage.local.set({ xccUpdate: info });
  return info;
}

// ---------- Grok OAuth 设备流（纯函数，不写存储） ----------

async function xccOauthRequest(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(20000)
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (e) {
    /* 保留原始文本用于报错 */
  }
  return { ok: res.ok, status: res.status, data, text };
}

async function xccStartDeviceAuth(o) {
  if (!o.clientId) throw new Error('请先填写 Client ID（默认已内置，若被清空请重置）');
  const r = await xccOauthRequest(o.deviceEndpoint, {
    client_id: o.clientId,
    scope: o.scope || 'offline_access'
  });
  if (!r.ok) {
    throw new Error(
      '设备授权端点返回 ' + r.status + '：' + (r.text || '').slice(0, 200) + '。请核对端点地址与 Client ID。'
    );
  }
  return r.data; // { device_code, user_code, verification_uri[_complete], expires_in, interval }
}

// 返回 { status: 'authorized', tokens } | { status: 'pending' } | { status: 'pending', slow_down }
async function xccPollDeviceToken(o, device_code) {
  const r = await xccOauthRequest(o.tokenEndpoint, {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    client_id: o.clientId,
    device_code
  });
  if (r.ok && r.data && r.data.access_token) {
    return {
      status: 'authorized',
      tokens: {
        access_token: r.data.access_token,
        refresh_token: r.data.refresh_token || '',
        expires_at: Date.now() + (Number(r.data.expires_in) || 3600) * 1000 - 300000
      }
    };
  }
  const err = r.data && r.data.error;
  if (err === 'authorization_pending') return { status: 'pending' };
  if (err === 'slow_down') return { status: 'pending', slow_down: true };
  throw new Error('授权失败：' + (err || r.status + ' ' + (r.text || '').slice(0, 160)));
}

async function xccRefreshGrokToken(o) {
  if (!o.tokens || !o.tokens.refresh_token) throw new Error('Grok 授权已过期，请重新登录');
  const r = await xccOauthRequest(o.tokenEndpoint, {
    grant_type: 'refresh_token',
    client_id: o.clientId,
    refresh_token: o.tokens.refresh_token
  });
  if (r.ok && r.data && r.data.access_token) {
    return {
      access_token: r.data.access_token,
      refresh_token: r.data.refresh_token || o.tokens.refresh_token,
      expires_at: Date.now() + (Number(r.data.expires_in) || 3600) * 1000 - 300000
    };
  }
  throw new Error('刷新 Grok 授权失败，请重新登录');
}

// ---------- Grok OAuth：模型目录发现（GET {apiBase}/models） ----------
// 返回去重排序的模型 id 数组；失败抛错，由调用方静默兜底。
// 临近过期的 token 自动刷新并落盘。
async function xccListGrokModels(o) {
  let tokens = o.tokens;
  if (!tokens || !tokens.access_token) throw new Error('Grok 尚未授权');
  if (!tokens.expires_at || Date.now() > tokens.expires_at - 60000) {
    tokens = await xccRefreshGrokToken(o);
    await xccMutateSettings((m) => {
      m.grokOAuth = { ...m.grokOAuth, tokens };
    });
  }
  const url = String(o.apiBase || '').replace(/\/+$/, '') + '/models';
  const res = await fetch(url, {
    headers: { Authorization: 'Bearer ' + tokens.access_token, ...XCC_GROK_CLIENT_HEADERS },
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json().catch(() => null);
  const list = data && (Array.isArray(data.data) ? data.data : data.models);
  const ids = [];
  if (Array.isArray(list)) {
    for (const it of list) {
      const id = it && typeof it === 'object' ? it.id || it.name : it;
      if (id) ids.push(String(id));
    }
  }
  return [...new Set(ids)].sort();
}

// ---------- 模型接入解析与调用 ----------

async function xccResolveProviderCfg(s) {
  if (s.provider === 'xai') {
    if (!s.xai.apiKey) throw new Error('尚未配置 xAI API Key，请打开设置页填写');
    return { baseUrl: 'https://api.x.ai/v1', apiKey: s.xai.apiKey, model: s.xai.model };
  }
  if (s.provider === 'custom') {
    if (!s.custom.baseUrl) throw new Error('尚未配置自定义接口地址，请打开设置页填写');
    return { baseUrl: s.custom.baseUrl, apiKey: s.custom.apiKey || '', model: s.custom.model };
  }
  if (s.provider === 'grok-oauth') {
    const o = s.grokOAuth;
    if (!o.tokens || !o.tokens.access_token) {
      throw new Error('Grok 尚未授权，请打开设置页完成账号登录');
    }
    let tokens = o.tokens;
    if (!tokens.expires_at || Date.now() > tokens.expires_at - 60000) {
      tokens = await xccRefreshGrokToken(o);
      await xccMutateSettings((m) => {
        m.grokOAuth = { ...m.grokOAuth, tokens };
      });
    }
    return {
      baseUrl: o.apiBase,
      apiKey: tokens.access_token,
      model: o.model,
      extraHeaders: { ...XCC_GROK_CLIENT_HEADERS } // 勿直接给共享对象本体
    };
  }
  throw new Error('未知的接入方式：' + s.provider);
}

// 单次补全请求。返回 { text, finish, drained }：
// drained=true 表示"思考耗尽"形态（finish_reason=length、正文空、reasoning_content 非空）
async function xccChatOnce(cfg, url, body) {
  let res;
  try {
    const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey };
    if (cfg.extraHeaders) Object.assign(headers, cfg.extraHeaders);
    // 不设超时：慢模型/深推理由用户自行判断（面板可随时放弃等待）
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });
  } catch (e) {
    throw new Error(
      '网络请求失败（' + (e && e.message ? e.message : e) + '）。若为自定义接口，请检查地址与网络权限。'
    );
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error('API ' + res.status + '：' + t.slice(0, 300));
  }
  const data = await res.json().catch(() => null);
  const msg = data && data.choices && data.choices[0] ? data.choices[0].message : null;
  const finish = data && data.choices && data.choices[0] ? data.choices[0].finish_reason : '';
  const text = msg ? msg.content : null;
  const reasoning = msg ? msg.reasoning_content || msg.reasoning : '';
  if (text && String(text).trim()) return { text: String(text), finish, drained: false };
  if (finish === 'length' && reasoning && String(reasoning).trim()) {
    // 推理模型把 max_tokens 全用在思考上，正文一个字没生成就被截断
    return { text: '', finish, drained: true, raw: data };
  }
  throw new Error('模型未返回内容：' + JSON.stringify(data).slice(0, 200));
}

async function xccChatCompletion(cfg, messages, genParams) {
  const url = String(cfg.baseUrl || '').replace(/\/+$/, '') + '/chat/completions';
  const body = {
    model: cfg.model,
    messages,
    temperature: Number.isFinite(Number(genParams && genParams.temperature))
      ? Number(genParams.temperature)
      : 0.9,
    max_tokens: Number.isFinite(Number(genParams && genParams.maxTokens))
      ? Number(genParams && genParams.maxTokens)
      : 400,
    stream: false
  };
  // 思考强度：白名单后注入；'default'/脏值一律不发送，
  // 保证对不认识该参数的端点（DeepSeek/Kimi/Ollama 等）零影响
  const effort = genParams && genParams.reasoningEffort;
  if (effort === 'low' || effort === 'medium' || effort === 'high') {
    body.reasoning_effort = effort;
  }
  const first = await xccChatOnce(cfg, url, body);
  if (!first.drained) return xccCleanReplyText(first.text);
  // 思考耗尽：自动提高上限重试一次（3000 对免费模式 280 字符的回复绰绰有余）
  const retryBody = { ...body, max_tokens: Math.max(body.max_tokens * 3, 3000) };
  const second = await xccChatOnce(cfg, url, retryBody);
  if (!second.drained) return xccCleanReplyText(second.text);
  throw new Error(
    '模型思考用完了生成长度上限（max_tokens=' + body.max_tokens + ' 被推理消耗殆尽，正文为空；' +
      '已自动提高到 ' + retryBody.max_tokens + ' 重试仍失败）。请到设置页把「最大生成长度」调大' +
      '（推荐 3000+），或改选非推理模型，或把思考强度调低/设为默认'
  );
}

// ---------- 输出清洗：剥 AI 格式残留（保守原则：宁可少剥，不误杀正文） ----------
// 同时服务于生成与 options 连通测试（期望原样返回 pong）：
// 所有规则都要求"成对出现/成段存在/剥后仍有内容"，pong 一条都不会命中。
function xccCleanReplyText(raw) {
  let s = String(raw).trim();
  if (!s) return s;

  // 1) 代码围栏：仅首尾成对时剥壳（语言标记放宽到含 - _ +）
  s = s.replace(/^```[a-zA-Z0-9_+-]*[ \t]*\r?\n?/, '').replace(/\r?\n?[ \t]*```$/, '');

  // 2) 整条引号包裹：内部不得再出现同类引号（防误判对话体引语）
  for (const [q1, q2] of [
    ['"', '"'],
    ['\u201c', '\u201d']
  ]) {
    if (s.length > 1 && s.startsWith(q1) && s.endsWith(q2) && !s.slice(1, -1).includes(q1)) {
      s = s.slice(1, -1).trim();
    }
  }

  // 3) 整条 **加粗** 包裹（最常见的 AI 输出残留）：首尾成对且剥后非空，只剥一层
  if (/^\*\*[\s\S]+\*\*$/.test(s) && s.slice(2, -2).trim()) {
    s = s.slice(2, -2).trim();
  }

  // 4) 前言套话：第一行是"好的，以下是…评论："类引导语（以冒号/感叹号收尾）才整行丢弃
  const intro = s.split(/\r?\n/)[0] || '';
  if (
    intro.trim().length <= 40 &&
    /^(好的|当然|没问题|明白|收到)[，,!！。.\s]*(以下|这是)?|(以下|这是)(为(你|您))?(撰写|生成|准备|创作)的?[^\n]{0,12}(评论|回复|推文|内容)[：:!！]\s*$/.test(
      intro.trim()
    ) &&
    s.slice(intro.length).trim()
  ) {
    s = s.slice(intro.length).trim();
  }

  // 5) 后缀套话：结尾一句是"希望…有帮助"类才丢弃，剥后必须仍有正文
  const tail = /(希望|但愿|祝)[^\n]{0,30}(对你|们)?(有所)?(帮助|用处|有用|喜欢)[。.!！]?\s*$/.exec(s);
  if (tail && s.slice(0, tail.index).trim()) {
    s = s.slice(0, tail.index).trim();
  }

  // 6) 行内 **加粗** → 纯文字：单行内成对、中间非空才动（跨行加粗不动，防误杀长强调段）
  s = s.replace(/(^|[^*])\*\*([^*\n]+)\*\*(?!\*)/g, '$1$2');

  // 7) 行首 ATX 标题：#{1..6} 后必须跟空格才剥；#hashtag（#后无空格）永不命中
  s = s.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '');

  // 8) 行首列表符：-/•/*/· 后必须跟空格才剥（"-5°C"、"a-b" 不受影响）
  s = s.replace(/^[ \t]{0,3}[-*•·][ \t]+/gm, '');

  // 9) 行内 `code`：单行内成对单反引号才剥（双/三反引号不动）
  s = s.replace(/(^|[^`])`([^`\n]+)`(?!`)/g, '$1$2');

  // 10) 3+ 连续空行压成 1 个空行
  return s.replace(/\n{3,}/g, '\n\n').trim();
}
