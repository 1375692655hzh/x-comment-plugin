// X 评论副驾 — 设置页逻辑
'use strict';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let SETTINGS = null;

// ---------- 存储 ----------
// 所有写入必须走 saveMutate（读最新值 → 改 → 写回）。
// 不能拿页面打开时的快照整份覆盖，否则会把别处的更新回滚掉
// （例如后台刚刷新的 OAuth token、弹窗里的开关、X 页面切换的预设）。
async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  SETTINGS = xccMergeSettings(settings);
}

async function saveMutate(fn) {
  const { settings } = await chrome.storage.local.get('settings');
  const fresh = xccMergeSettings(settings);
  fn(fresh);
  await chrome.storage.local.set({ settings: fresh });
  SETTINGS = fresh; // 保持本地快照与存储同步
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
      const value = r.value;
      await saveMutate((m) => {
        m.provider = value;
      });
      document.querySelectorAll('.provider-item').forEach((it) =>
        it.classList.toggle('checked', it.contains(r))
      );
      togglePanes();
      toast('已切换接入方式：' + value);
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
    pollSeq++; // 取消进行中的轮询，避免旧轮询成功后把 token 写回
    await send({ type: 'OAUTH_LOGOUT' });
    await loadSettings();
    fillOAuthInputs();
    renderOAuthStatus();
    $('oauth-area').hidden = true;
    $('oauth-status').textContent = '已登出';
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

function readOAuthFields() {
  return {
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
    const xai = {
      apiKey: $('xai-key').value.trim(),
      model: $('xai-model').value.trim() || 'grok-4-fast-non-reasoning'
    };
    await saveMutate((m) => {
      m.xai = xai;
    });
  } else {
    const baseUrl = $('custom-base').value.trim();
    if (!baseUrl) {
      statusEl.textContent = '✗ 请填写接口地址';
      return;
    }
    // 权限申请要在按钮手势内最先做（自定义域名不在 manifest 静态授权里）
    const granted = await requestOrigin(baseUrl);
    if (!granted) statusEl.textContent = '⚠ 未授予网络权限，调用可能被浏览器拦截';
    await saveMutate((m) => {
      m.custom = {
        baseUrl,
        apiKey: $('custom-key').value.trim(),
        model: $('custom-model').value.trim() || 'gpt-4o-mini'
      };
    });
  }
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

// 每次开始授权/登出自增，使仍在运行的旧轮询循环失效：
// 否则界面展示的是新设备码、实际轮询的却是旧 device_code
let pollSeq = 0;

async function startOAuth() {
  const fields = readOAuthFields();
  if (!fields.clientId) {
    $('oauth-status').textContent = '✗ 请先填写 Client ID';
    return;
  }
  for (const ep of [fields.deviceEndpoint, fields.tokenEndpoint, fields.apiBase]) {
    await requestOrigin(ep);
  }
  await saveMutate((m) => {
    m.grokOAuth = { ...m.grokOAuth, ...fields }; // tokens 等其余字段以存储最新值为准
  });

  const r = await send({ type: 'OAUTH_START' });
  if (!r.ok) {
    $('oauth-status').textContent = '✗ ' + r.error;
    return;
  }
  const seq = ++pollSeq;
  $('oauth-area').hidden = false;
  $('oauth-code').textContent = r.user_code || '----';
  const link = $('oauth-link');
  // 优先用带验证码的一步到位链接（verification_uri_complete）
  link.href = r.verification_uri_complete || r.verification_uri || '#';
  link.textContent = link.href;
  $('oauth-status').textContent = '已发起授权，等待登录…';
  pollDevice(seq, r.device_code, r.interval || 5, r.expires_in || 600);
}

async function pollDevice(seq, device_code, interval, expires_in) {
  const deadline = Date.now() + expires_in * 1000;
  let iv = Math.max(2, interval);
  while (Date.now() < deadline) {
    await sleep(iv * 1000);
    if (seq !== pollSeq) return; // 已被新的授权流程或登出取代
    const r = await send({ type: 'OAUTH_POLL', device_code });
    if (seq !== pollSeq) return;
    if (r.ok && r.status === 'authorized') {
      await loadSettings();
      if (seq !== pollSeq) return;
      fillOAuthInputs();
      renderOAuthStatus();
      $('oauth-area').hidden = true;
      $('oauth-status').textContent = '✓ 授权成功，可以使用 Grok 模型了';
      toast('Grok 授权成功');
      return;
    }
    if (r.ok && r.status === 'pending') {
      if (r.slow_down) iv = Math.min(iv + 5, 30); // RFC 8628：被限流时加大轮询间隔
      continue;
    }
    if (!r.ok) {
      $('oauth-status').textContent = '✗ ' + r.error;
      return;
    }
  }
  if (seq === pollSeq) $('oauth-status').textContent = '授权超时，请重试';
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

  const listKey = kind === 'persona' ? 'personaPresets' : 'genPresets';
  const bodyKey = kind === 'persona' ? 'persona' : 'prompt';
  const actKey = kind === 'persona' ? 'activePersonaId' : 'activeGenId';

  radio.addEventListener('change', async () => {
    if (!radio.checked) return;
    await saveMutate((m) => {
      m[actKey] = p.id;
    });
    renderPresets();
    toast('已设为当前使用');
  });

  // 按预设 id 在最新存储里定位后修改，不依赖页面快照里的对象引用
  saveB.addEventListener('click', async () => {
    const newName = name.value.trim() || p.name;
    const body = ta.value;
    await saveMutate((m) => {
      const t = m[listKey].find((x) => x.id === p.id);
      if (t) {
        t.name = newName;
        t[bodyKey] = body;
      }
    });
    renderPresets();
    toast('已保存');
  });

  delB.addEventListener('click', async () => {
    if (!confirm('删除「' + p.name + '」？')) return;
    let removed = false;
    await saveMutate((m) => {
      const next = m[listKey].filter((x) => x.id !== p.id);
      if (!next.length) return; // 至少保留一个
      m[listKey] = next;
      if (m[actKey] === p.id) m[actKey] = next[0].id;
      removed = true;
    });
    if (!removed) {
      toast('至少保留一个预设', true);
      return;
    }
    renderPresets();
    toast('已删除');
  });

  return card;
}

function initPresetUI() {
  $('add-persona').addEventListener('click', async () => {
    await saveMutate((m) => {
      m.personaPresets.push({ id: xccUid('p'), name: '新人设', persona: '你是……' });
    });
    renderPresets();
  });
  $('add-gen').addEventListener('click', async () => {
    await saveMutate((m) => {
      m.genPresets.push({ id: xccUid('g'), name: '新风格', prompt: '针对 {tweet_text} 写一条……' });
    });
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
    const temp = parseFloat($('temp').value);
    const mt = parseInt($('maxtok').value, 10);
    const params = {
      temperature: Number.isFinite(temp) ? Math.min(1.5, Math.max(0, temp)) : 0.9,
      maxTokens: Number.isFinite(mt) ? Math.min(2000, Math.max(50, mt)) : 400,
      language: $('lang').value
    };
    await saveMutate((m) => {
      m.genParams = params;
    });
    $('params-status').textContent = '✓ 已保存';
    toast('参数已保存');
  });
}

// ---------- 更新检测 ----------

function renderUpdateBanner(u) {
  $('update-banner').hidden = !(u && u.hasUpdate);
  if (u && u.hasUpdate) $('update-version').textContent = 'v' + u.latest;
}

function initUpdateBanner() {
  (async () => {
    const { xccUpdate } = await chrome.storage.local.get('xccUpdate');
    renderUpdateBanner(xccUpdate);
  })();
  $('update-open').addEventListener('click', () => window.open(XCC_ZIP_URL, '_blank'));
  $('update-check').addEventListener('click', async () => {
    const r = await send({ type: 'CHECK_UPDATE' });
    if (r.ok) renderUpdateBanner(r.update);
  });
}

// ---------- 启动 ----------

(async function init() {
  await loadSettings();
  initProviderUI();
  initPresetUI();
  initParamsUI();
  initUpdateBanner();
})();
