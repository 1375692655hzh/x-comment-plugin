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

async function xccChatCompletion(cfg, messages, genParams) {
  const url = String(cfg.baseUrl || '').replace(/\/+$/, '') + '/chat/completions';
  const body = {
    model: cfg.model,
    messages,
    temperature: Number.isFinite(Number(genParams && genParams.temperature))
      ? Number(genParams.temperature)
      : 0.9,
    max_tokens: Number.isFinite(Number(genParams && genParams.maxTokens))
      ? Number(genParams.maxTokens)
      : 400,
    stream: false
  };
  // 思考强度：白名单后注入；'default'/脏值一律不发送，
  // 保证对不认识该参数的端点（DeepSeek/Kimi/Ollama 等）零影响
  const effort = genParams && genParams.reasoningEffort;
  if (effort === 'low' || effort === 'medium' || effort === 'high') {
    body.reasoning_effort = effort;
  }
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
  const text =
    data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : null;
  if (!text) throw new Error('模型未返回内容：' + JSON.stringify(data).slice(0, 200));
  let out = String(text).trim();
  out = out.replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '');
  if ((out.startsWith('"') && out.endsWith('"')) || (out.startsWith('\u201c') && out.endsWith('\u201d'))) {
    out = out.slice(1, -1);
  }
  return out.trim();
}
