// X 评论副驾 — 设置页逻辑（v0.4.0）
// 本页所有网络操作（OAuth 设备流/连通测试/更新检查）直接 fetch，
// 不依赖 service worker；settings 写入统一走 xccMutateSettings（读最新→改→写回）。
'use strict';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let SETTINGS = null;

// ---------- 孤儿页自愈 ----------
// 扩展重载后，旧实例打开的设置页不会被关闭，只会被切断（Extension context
// invalidated）：DOM 冻结在重载前状态（如过期横幅），chrome.* 调用全部抛错
// （表现为按钮点了没反应、保存静默失败）。失效上下文中 chrome.runtime.id 为 undefined。
function healOrphanPage(force) {
  let dead = !!force;
  try {
    dead = dead || !(chrome.runtime && chrome.runtime.id);
  } catch (e) {
    dead = true;
  }
  if (!dead) return;
  if (sessionStorage.getItem('xccHealTried')) {
    // 已自愈一次仍失效（扩展可能已被移除）：给人工指引，避免刷新死循环
    document.title = '页面已失效 · X 评论副驾';
    document.body.innerHTML =
      '<div style="font:14px/1.8 system-ui;max-width:540px;margin:80px auto;padding:0 16px;color:#333">' +
      '扩展已重新加载，但本页面无法自动恢复。请关闭本标签，从 X 面板的 ⚙ 或工具栏图标重新打开设置页。</div>';
    return;
  }
  sessionStorage.setItem('xccHealTried', '1');
  location.reload(); // 解压目录重载后扩展 ID 不变，同 URL 从新实例加载
}
window.addEventListener('focus', healOrphanPage);
document.addEventListener('visibilitychange', healOrphanPage);

// ---------- 存储 ----------

async function loadSettings() {
  SETTINGS = await xccGetSettings();
}

// 页内串行化：快速连点两个保存不会交错丢写
let saveChain = Promise.resolve();
function saveMutate(fn) {
  const run = saveChain.then(async () => {
    SETTINGS = await xccMutateSettings(fn);
  });
  saveChain = run.catch(() => {});
  return run;
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
    pollSeq++; // 取消进行中的轮询
    try {
      await saveMutate((m) => {
        m.grokOAuth = { ...m.grokOAuth, tokens: null };
      });
    } catch (e) {
      toast('登出失败：' + (e && e.message ? e.message : e), true);
      return;
    }
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
  try {
    const cfg = await xccResolveProviderCfg(SETTINGS); // 本页直连，不依赖后台
    await xccChatCompletion(
      cfg,
      [{ role: 'user', content: '这是一条连通性测试，请只回复：pong' }],
      { temperature: 0, maxTokens: 10 }
    );
    statusEl.textContent = '✓ 连通正常';
    toast('已保存，接口连通');
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    statusEl.textContent = '✗ ' + msg;
    toast('已保存，但测试失败：' + msg, true);
  }
}

// ---------- Grok OAuth 设备流（本页直连 auth.x.ai） ----------

function renderOAuthStatus() {
  const t = SETTINGS.grokOAuth.tokens;
  $('oauth-status').textContent = t
    ? '已授权 · 有效期至 ' + new Date(t.expires_at).toLocaleString()
    : '未授权';
  $('oauth-logout').hidden = !t;
}

// 每次开始授权/登出自增，使仍在运行的旧轮询循环失效
let pollSeq = 0;

async function startOAuth() {
  const btn = $('oauth-start');
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

  btn.disabled = true;
  btn.textContent = '发起中…';
  let r;
  try {
    r = await xccStartDeviceAuth(SETTINGS.grokOAuth);
  } catch (e) {
    $('oauth-status').textContent = '✗ ' + (e && e.message ? e.message : e);
    return;
  } finally {
    btn.disabled = false;
    btn.textContent = '开始授权';
  }

  const seq = ++pollSeq;
  $('oauth-area').hidden = false;
  $('oauth-code').textContent = r.user_code || '----';
  const link = $('oauth-link');
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
    let r;
    try {
      r = await xccPollDeviceToken(SETTINGS.grokOAuth, device_code);
    } catch (e) {
      if (seq === pollSeq) $('oauth-status').textContent = '✗ ' + (e && e.message ? e.message : e);
      return;
    }
    if (seq !== pollSeq) return;
    if (r.status === 'authorized') {
      await saveMutate((m) => {
        m.grokOAuth = { ...m.grokOAuth, tokens: r.tokens };
      });
      if (seq !== pollSeq) return;
      await loadSettings();
      fillOAuthInputs();
      renderOAuthStatus();
      $('oauth-area').hidden = true;
      $('oauth-status').textContent = '✓ 授权成功，可以使用 Grok 模型了';
      toast('Grok 授权成功');
      return;
    }
    if (r.slow_down) iv = Math.min(iv + 5, 30); // RFC 8628：被限流时加大轮询间隔
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

// ---------- 更新检测（本页直连，不依赖后台） ----------

function renderUpdateBanner(u) {
  // 显示时用「已装版本 vs 远端版本号」现场重算，不信存储里的 hasUpdate 旧结论
  const installed = chrome.runtime.getManifest().version;
  const has = !!(u && u.latest && xccIsNewerVersion(u.latest, installed));
  $('update-banner').hidden = !has;
  if (has) $('update-version').textContent = 'v' + u.latest;
}

function initUpdateBanner() {
  (async () => {
    const { xccUpdate } = await chrome.storage.local.get('xccUpdate');
    renderUpdateBanner(xccUpdate);
    try {
      const info = await Promise.race([xccCheckUpdate(), sleep(8000).then(() => null)]);
      if (info) renderUpdateBanner(info);
    } catch (e) {
      /* 检查失败不影响显示 */
    }
  })();
  $('update-open').addEventListener('click', () => window.open(XCC_ZIP_URL, '_blank'));
  $('update-check').addEventListener('click', async () => {
    $('update-check').textContent = '检查中…';
    const info = await xccCheckUpdate().catch(() => null);
    $('update-check').textContent = '重新检查';
    if (info) renderUpdateBanner(info);
    else {
      const { xccUpdate } = await chrome.storage.local.get('xccUpdate');
      renderUpdateBanner(xccUpdate);
    }
  });
}

// ---------- 启动 ----------

(async function init() {
  healOrphanPage(); // 必须最先：孤儿页下后续所有 chrome.* 调用都会抛错
  try {
    await loadSettings();
    initProviderUI();
    initPresetUI();
    initParamsUI();
    initUpdateBanner();
  } catch (e) {
    if (/Extension context invalidated/i.test(String(e && e.message))) healOrphanPage(true);
    else throw e;
  }
})();
