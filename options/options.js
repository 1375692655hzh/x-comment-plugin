// X 评论副驾 — 设置页逻辑
'use strict';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let SETTINGS = null;

// ---------- 存储 ----------

async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  SETTINGS = xccMergeSettings(settings);
}
async function persist() {
  await chrome.storage.local.set({ settings: SETTINGS });
}

function send(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        void chrome.runtime.lastError;
        resolve(resp || { ok: false, error: '后台无响应，请重载扩展' });
      });
    } catch (e) {
      resolve({ ok: false, error: String(e) });
    }
  });
}

function toast(msg, isErr) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.className = 'toast'), 2600);
}

// ---------- 模型接入 ----------

function togglePanes() {
  $('pane-xai').hidden = SETTINGS.provider !== 'xai';
  $('pane-custom').hidden = SETTINGS.provider !== 'custom';
  $('pane-oauth').hidden = SETTINGS.provider !== 'grok-oauth';
}

function initProviderUI() {
  document.querySelectorAll('input[name=provider]').forEach((r) => {
    r.checked = r.value === SETTINGS.provider;
    r.closest('.provider-item').classList.toggle('checked', r.checked);
    r.addEventListener('change', async () => {
      if (!r.checked) return;
      SETTINGS.provider = r.value;
      await persist();
      document.querySelectorAll('.provider-item').forEach((it) =>
        it.classList.toggle('checked', it.contains(r))
      );
      togglePanes();
      toast('已切换接入方式：' + r.value);
    });
  });

  $('xai-key').value = SETTINGS.xai.apiKey;
  $('xai-model').value = SETTINGS.xai.model;
  $('custom-base').value = SETTINGS.custom.baseUrl;
  $('custom-key').value = SETTINGS.custom.apiKey;
  $('custom-model').value = SETTINGS.custom.model;
  fillOAuthInputs();
  togglePanes();
  renderOAuthStatus();

  $('xai-save').addEventListener('click', () => saveProvider('xai'));
  $('custom-save').addEventListener('click', () => saveProvider('custom'));

  $('oauth-start').addEventListener('click', startOAuth);
  $('oauth-logout').addEventListener('click', async () => {
    await send({ type: 'OAUTH_LOGOUT' });
    await loadSettings();
    fillOAuthInputs();
    renderOAuthStatus();
    toast('已登出 Grok 授权');
  });
}

function fillOAuthInputs() {
  const o = SETTINGS.grokOAuth;
  $('oauth-client-id').value = o.clientId;
  $('oauth-model').value = o.model;
  $('oauth-api-base').value = o.apiBase;
  $('oauth-device').value = o.deviceEndpoint;
  $('oauth-token').value = o.tokenEndpoint;
  $('oauth-scope').value = o.scope;
}

function collectOAuthFields() {
  SETTINGS.grokOAuth = {
    ...SETTINGS.grokOAuth,
    clientId: $('oauth-client-id').value.trim(),
    model: $('oauth-model').value.trim(),
    apiBase: $('oauth-api-base').value.trim(),
    deviceEndpoint: $('oauth-device').value.trim(),
    tokenEndpoint: $('oauth-token').value.trim(),
    scope: $('oauth-scope').value.trim() || 'offline_access'
  };
}

async function requestOrigin(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return false;
    return await chrome.permissions.request({ origins: [u.origin + '/*'] });
  } catch (e) {
    return false;
  }
}

async function saveProvider(kind) {
  const statusEl = $(kind + '-status');
  if (kind === 'xai') {
    SETTINGS.xai = {
      apiKey: $('xai-key').value.trim(),
      model: $('xai-model').value.trim() || 'grok-4-fast-non-reasoning'
    };
  } else {
    const baseUrl = $('custom-base').value.trim();
    if (!baseUrl) {
      statusEl.textContent = '✗ 请填写接口地址';
      return;
    }
    SETTINGS.custom = {
      baseUrl,
      apiKey: $('custom-key').value.trim(),
      model: $('custom-model').value.trim() || 'gpt-4o-mini'
    };
    // 自定义域名不在 manifest host_permissions 内，需用户点一下授权
    const granted = await requestOrigin(baseUrl);
    if (!granted) statusEl.textContent = '⚠ 未授予网络权限，调用可能被浏览器拦截';
  }
  await persist();
  statusEl.textContent = '测试中…';
  const r = await send({ type: 'TEST_PROVIDER' });
  if (r.ok) {
    statusEl.textContent = '✓ 连通正常';
    toast('已保存，接口连通');
  } else {
    statusEl.textContent = '✗ ' + r.error;
    toast('已保存，但测试失败：' + r.error, true);
  }
}

// ---------- Grok OAuth 设备流 ----------

function renderOAuthStatus() {
  const t = SETTINGS.grokOAuth.tokens;
  $('oauth-status').textContent = t
    ? '已授权 · 有效期至 ' + new Date(t.expires_at).toLocaleString()
    : '未授权';
  $('oauth-logout').hidden = !t;
}

let oauthPolling = false;

async function startOAuth() {
  collectOAuthFields();
  if (!SETTINGS.grokOAuth.clientId) {
    $('oauth-status').textContent = '✗ 请先填写 Client ID';
    return;
  }
  for (const ep of [
    SETTINGS.grokOAuth.deviceEndpoint,
    SETTINGS.grokOAuth.tokenEndpoint,
    SETTINGS.grokOAuth.apiBase
  ]) {
    await requestOrigin(ep);
  }
  await persist();

  const r = await send({ type: 'OAUTH_START' });
  if (!r.ok) {
    $('oauth-status').textContent = '✗ ' + r.error;
    return;
  }
  $('oauth-area').hidden = false;
  $('oauth-code').textContent = r.user_code || '----';
  const link = $('oauth-link');
  link.href = r.verification_uri || '#';
  link.textContent = r.verification_uri || '';
  $('oauth-status').textContent = '已发起授权，等待登录…';
  pollDevice(r.device_code, r.interval || 5, r.expires_in || 600);
}

async function pollDevice(device_code, interval, expires_in) {
  if (oauthPolling) return;
  oauthPolling = true;
  const deadline = Date.now() + expires_in * 1000;
  try {
    while (Date.now() < deadline) {
      await sleep(Math.max(2, interval) * 1000);
      const r = await send({ type: 'OAUTH_POLL', device_code });
      if (r.ok && r.status === 'authorized') {
        $('oauth-area').hidden = true;
        $('oauth-status').textContent = '✓ 授权成功，可以使用 Grok 模型了';
        await loadSettings();
        fillOAuthInputs();
        renderOAuthStatus();
        toast('Grok 授权成功');
        return;
      }
      if (!r.ok) {
        $('oauth-status').textContent = '✗ ' + r.error;
        return;
      }
    }
    $('oauth-status').textContent = '授权超时，请重试';
  } finally {
    oauthPolling = false;
  }
}

// ---------- 提示词管理 ----------

function mkBtn(text, cls) {
  const b = document.createElement('button');
  b.textContent = text;
  if (cls) b.className = cls;
  return b;
}

function renderPresets() {
  renderList($('persona-list'), SETTINGS.personaPresets, 'persona');
  renderList($('gen-list'), SETTINGS.genPresets, 'gen');
}

function renderList(container, list, kind) {
  container.textContent = '';
  const activeId = kind === 'persona' ? SETTINGS.activePersonaId : SETTINGS.activeGenId;
  list.forEach((p) => container.appendChild(presetCard(kind, p, p.id === activeId)));
}

function presetCard(kind, p, isActive) {
  const card = document.createElement('div');
  card.className = 'preset-card' + (isActive ? ' active' : '');

  const head = document.createElement('div');
  head.className = 'preset-head';
  const radio = document.createElement('input');
  radio.type = 'radio';
  radio.name = 'active-' + kind;
  radio.checked = isActive;
  radio.title = '设为当前使用';
  const name = document.createElement('input');
  name.className = 'preset-name';
  name.value = p.name;
  name.placeholder = '名称';
  const saveB = mkBtn('保存', 'small');
  const delB = mkBtn('删除', 'small danger');
  head.append(radio, name, saveB, delB);

  const ta = document.createElement('textarea');
  ta.className = 'preset-body';
  ta.rows = kind === 'gen' ? 5 : 3;
  ta.value = kind === 'persona' ? p.persona : p.prompt;
  if (kind === 'gen') {
    ta.placeholder = '例：针对 {tweet_text} 写一条…… 可用占位符 {author} {topic}';
  }
  card.append(head, ta);

  radio.addEventListener('change', async () => {
    if (!radio.checked) return;
    if (kind === 'persona') SETTINGS.activePersonaId = p.id;
    else SETTINGS.activeGenId = p.id;
    await persist();
    renderPresets();
    toast('已设为当前使用');
  });

  saveB.addEventListener('click', async () => {
    p.name = name.value.trim() || p.name;
    if (kind === 'persona') p.persona = ta.value;
    else p.prompt = ta.value;
    await persist();
    renderPresets();
    toast('已保存');
  });

  delB.addEventListener('click', async () => {
    const key = kind === 'persona' ? 'personaPresets' : 'genPresets';
    if (SETTINGS[key].length <= 1) {
      toast('至少保留一个预设', true);
      return;
    }
    if (!confirm('删除「' + p.name + '」？')) return;
    SETTINGS[key] = SETTINGS[key].filter((x) => x.id !== p.id);
    const actKey = kind === 'persona' ? 'activePersonaId' : 'activeGenId';
    if (SETTINGS[actKey] === p.id) SETTINGS[actKey] = SETTINGS[key][0].id;
    await persist();
    renderPresets();
    toast('已删除');
  });

  return card;
}

function initPresetUI() {
  $('add-persona').addEventListener('click', async () => {
    SETTINGS.personaPresets.push({ id: xccUid('p'), name: '新人设', persona: '你是……' });
    await persist();
    renderPresets();
  });
  $('add-gen').addEventListener('click', async () => {
    SETTINGS.genPresets.push({
      id: xccUid('g'),
      name: '新风格',
      prompt: '针对 {tweet_text} 写一条……'
    });
    await persist();
    renderPresets();
  });
  renderPresets();
}

// ---------- 生成参数 ----------

function initParamsUI() {
  $('temp').value = SETTINGS.genParams.temperature;
  $('temp-val').textContent = SETTINGS.genParams.temperature;
  $('maxtok').value = SETTINGS.genParams.maxTokens;
  $('lang').value = SETTINGS.genParams.language;
  $('temp').addEventListener('input', () => ($('temp-val').textContent = $('temp').value));
  $('params-save').addEventListener('click', async () => {
    SETTINGS.genParams = {
      temperature: parseFloat($('temp').value) || 0.9,
      maxTokens: parseInt($('maxtok').value, 10) || 400,
      language: $('lang').value
    };
    await persist();
    $('params-status').textContent = '✓ 已保存';
    toast('参数已保存');
  });
}

// ---------- 启动 ----------

(async function init() {
  await loadSettings();
  initProviderUI();
  initPresetUI();
  initParamsUI();
})();
