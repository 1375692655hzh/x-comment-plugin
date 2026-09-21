// =============================================================
// X 评论副驾 — MV3 Service Worker
// 职责：统一代理 LLM API 调用（绕开页面 CORS）、组装提示词、
//       管理 Grok OAuth 设备流、维护设置存储
// 页面（content/popup/options）不直接持有 API Key，全部经此转发
// =============================================================
importScripts('/shared/common.js');

// ---------- storage ----------

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return xccMergeSettings(settings);
}

async function updateSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

// ---------- 提示词组装 ----------

function findPreset(list, id) {
  return list.find((p) => p.id === id) || list[0];
}

function buildMessages(s, req) {
  const persona = findPreset(s.personaPresets, s.activePersonaId);
  const gen = findPreset(s.genPresets, s.activeGenId);
  const tweet = req && req.tweet ? req.tweet : null;
  const topic = req && req.topic ? String(req.topic).trim() : '';
  const tweetText = tweet && tweet.text ? String(tweet.text).trim() : '';
  const author = tweet && tweet.author ? String(tweet.author) : '';

  let prompt = gen ? String(gen.prompt) : '';
  const hadTweetPlaceholder = prompt.includes('{tweet_text}');
  const hadTopicPlaceholder = prompt.includes('{topic}');
  prompt = prompt
    .split('{tweet_text}')
    .join(tweetText)
    .split('{author}')
    .join(author)
    .split('{topic}')
    .join(topic);

  // 提示词里没放占位符时，自动把上下文附在末尾，保证模型能看见推文/主题
  const extra = [];
  if (tweetText && !hadTweetPlaceholder) {
    extra.push('推文作者：' + (author || '未知') + '\n推文内容：\n' + tweetText);
  }
  if (topic && !hadTopicPlaceholder) extra.push('主题：' + topic);
  if (extra.length) prompt += (prompt ? '\n\n---\n' : '') + extra.join('\n\n');

  if (!prompt.trim()) {
    prompt = tweetText || topic
      ? '请针对以下内容写一条高质量、口语化的 X 回复：\n' + (tweetText || topic)
      : '请写一条适合发布在 X 上的原创推文。';
  }

  let sys = persona ? String(persona.persona) : '你是 X 平台上的活跃用户，表达自然。';
  if (s.genParams.language === 'zh') sys += '\n\n务必使用中文撰写。';
  else if (s.genParams.language === 'en') sys += '\n\nAlways write in English.';
  else sys += '\n\n默认使用与推文相同的语言；无法判断时用中文。';

  return [
    { role: 'system', content: sys },
    { role: 'user', content: prompt }
  ];
}

function cleanOutput(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '');
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith('\u201c') && t.endsWith('\u201d'))) {
    t = t.slice(1, -1);
  }
  return t.trim();
}

// ---------- 接入方式解析 ----------

async function resolveProviderCfg(s) {
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
      tokens = await refreshGrokToken(o);
      await updateSettings({ grokOAuth: { ...o, tokens } });
    }
    return { baseUrl: o.apiBase, apiKey: tokens.access_token, model: o.model };
  }
  throw new Error('未知的接入方式：' + s.provider);
}

async function chatCompletion(cfg, messages, genParams) {
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
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
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
  return cleanOutput(text);
}

// ---------- Grok OAuth 设备流 ----------

async function oauthRequest(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(params)
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

async function startDeviceAuth(o) {
  if (!o.clientId) throw new Error('请先填写 Client ID（可从 grok CLI 开源仓库获取，见 README）');
  const r = await oauthRequest(o.deviceEndpoint, {
    client_id: o.clientId,
    scope: o.scope || 'offline_access'
  });
  if (!r.ok) {
    throw new Error(
      '设备授权端点返回 ' + r.status + '：' + (r.text || '').slice(0, 200) +
      '。请核对设置页中的端点地址与 Client ID。'
    );
  }
  return r.data; // { device_code, user_code, verification_uri, expires_in, interval }
}

async function pollDeviceToken(o, device_code) {
  const r = await oauthRequest(o.tokenEndpoint, {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    client_id: o.clientId,
    device_code
  });
  if (r.ok && r.data && r.data.access_token) {
    const tokens = {
      access_token: r.data.access_token,
      refresh_token: r.data.refresh_token || '',
      expires_at: Date.now() + (Number(r.data.expires_in) || 3600) * 1000
    };
    await updateSettings({ grokOAuth: { ...o, tokens } });
    return { status: 'authorized' };
  }
  const err = r.data && r.data.error;
  if (err === 'authorization_pending') return { status: 'pending' };
  if (err === 'slow_down') return { status: 'pending', slow_down: true };
  throw new Error('授权失败：' + (err || r.status + ' ' + (r.text || '').slice(0, 160)));
}

async function refreshGrokToken(o) {
  if (!o.tokens || !o.tokens.refresh_token) throw new Error('Grok 授权已过期，请重新登录');
  const r = await oauthRequest(o.tokenEndpoint, {
    grant_type: 'refresh_token',
    client_id: o.clientId,
    refresh_token: o.tokens.refresh_token
  });
  if (r.ok && r.data && r.data.access_token) {
    return {
      access_token: r.data.access_token,
      refresh_token: r.data.refresh_token || o.tokens.refresh_token,
      expires_at: Date.now() + (Number(r.data.expires_in) || 3600) * 1000
    };
  }
  throw new Error('刷新 Grok 授权失败，请重新登录');
}

// ---------- 面向页面的脱敏配置 ----------

function publicSettings(s) {
  const label =
    s.provider === 'xai'
      ? 'xAI API · ' + s.xai.model
      : s.provider === 'custom'
        ? '自定义 · ' + s.custom.model
        : 'Grok 授权 · ' + s.grokOAuth.model;
  return {
    enabled: s.enabled !== false,
    provider: s.provider,
    providerLabel: label,
    // 键名与 provider 的取值一致（xai / custom / grok-oauth），消费端用 pub.ready[pub.provider]
    ready: {
      xai: !!s.xai.apiKey,
      custom: !!s.custom.baseUrl, // Ollama 等本地无 Key 接口同样视为已配置
      'grok-oauth': !!(s.grokOAuth.tokens && s.grokOAuth.tokens.access_token)
    },
    personaPresets: s.personaPresets,
    genPresets: s.genPresets,
    activePersonaId: s.activePersonaId,
    activeGenId: s.activeGenId
  };
}

// ---------- 消息路由 ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg && msg.type) {
      case 'GET_PUBLIC_SETTINGS': {
        return sendResponse({ ok: true, settings: publicSettings(await getSettings()) });
      }
      case 'SAVE_ACTIVE': {
        const patch = {};
        if (msg.personaId) patch.activePersonaId = msg.personaId;
        if (msg.genId) patch.activeGenId = msg.genId;
        await updateSettings(patch);
        return sendResponse({ ok: true });
      }
      case 'OPEN_OPTIONS': {
        chrome.runtime.openOptionsPage();
        return sendResponse({ ok: true });
      }
      case 'GENERATE': {
        const s = await getSettings();
        const cfg = await resolveProviderCfg(s);
        const messages = buildMessages(s, msg);
        const text = await chatCompletion(cfg, messages, s.genParams);
        return sendResponse({ ok: true, text });
      }
      case 'TEST_PROVIDER': {
        const s = await getSettings();
        const cfg = await resolveProviderCfg(s);
        const text = await chatCompletion(
          cfg,
          [{ role: 'user', content: '这是一条连通性测试，请只回复：pong' }],
          { temperature: 0, maxTokens: 10 }
        );
        return sendResponse({ ok: true, text });
      }
      case 'OAUTH_START': {
        const s = await getSettings();
        const data = await startDeviceAuth(s.grokOAuth);
        return sendResponse({ ok: true, ...data });
      }
      case 'OAUTH_POLL': {
        const s = await getSettings();
        const r = await pollDeviceToken(s.grokOAuth, msg.device_code);
        return sendResponse({ ok: true, ...r });
      }
      case 'OAUTH_LOGOUT': {
        const s = await getSettings();
        await updateSettings({ grokOAuth: { ...s.grokOAuth, tokens: null } });
        return sendResponse({ ok: true });
      }
      default:
        return sendResponse({ ok: false, error: '未知消息类型' });
    }
  })().catch((e) => sendResponse({ ok: false, error: e && e.message ? e.message : String(e) }));
  return true; // 异步 sendResponse
});

chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings) await chrome.storage.local.set({ settings: XCC_DEFAULTS });
});
