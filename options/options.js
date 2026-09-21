// X 评论副驾 — 设置页逻辑（v0.4.0）
// 本页所有网络操作（OAuth 设备流/连通测试/更新检查）直接 fetch，
// 不依赖 service worker；settings 写入统一走 xccMutateSettings（读最新→改→写回）。
'use strict';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let SETTINGS = null;

// ---------- 孤儿页自愈 ----------
// 扩展重载后，旧实例打开的设置页不会被关闭，只会被切断（Extension context
// invalidated）：DOM 冻结在重载前状态，chrome.* 调用全部抛错。
// ⚠ v0.4.0 教训：事件监听器不能直接传本函数——Event 对象会填进 force 形参
// （!!Event 恒真），健康页在任何 focus/visibilitychange 上都被误判死亡，
// 先被静默 reload、第二次直接弹"无法自动恢复"。force 只认显式的 true。
let healReloading = false; // reload 已发起、文档尚未卸载：拦截重复触发

function healOrphanPage(force) {
  if (healReloading) return;
  let dead = force === true;
  if (!dead) {
    try {
      dead = !(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      dead = true;
    }
  }
  if (!dead) return;
  healReloading = true;
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
window.addEventListener('focus', () => healOrphanPage());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') healOrphanPage(); // 隐藏态无需自愈
});

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
  renderCustomModels();
  fillOAuthInputs();
  togglePanes();
  renderOAuthStatus();
  discoverGrokModels().catch(() => {}); // 已授权则拉一次模型目录

  $('xai-save').addEventListener('click', () => saveProvider('xai'));
  $('custom-save').addEventListener('click', () => saveProvider('custom'));
  $('custom-model-add').addEventListener('click', addCustomModel);
  $('custom-model-new').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addCustomModel();
  });

  // 模型即选即存：单独换模型不再依赖「开始授权」才落盘
  $('oauth-model').addEventListener('change', onOauthModelChange);
  $('oauth-model-custom').addEventListener('change', onOauthModelCustomChange);
  $('oauth-advanced-save').addEventListener('click', saveOauthAdvanced);

  $('oauth-start').addEventListener('click', startOAuth);
  $('oauth-logout').addEventListener('click', async () => {
    pollSeq++; // 取消进行中的轮询
    await clearOauthPending(); // 登出即放弃未完成的设备授权
    try {
      await saveMutate((m) => {
        m.grokOAuth = { ...m.grokOAuth, tokens: null, discoveredModels: [] };
      });
    } catch (e) {
      toast('登出失败：' + (e && e.message ? e.message : e), true);
      return;
    }
    await loadSettings();
    fillOAuthInputs();
    renderOAuthStatus();
    $('oauth-models-discovery').textContent = '';
    renderOauthModels(XCC_OAUTH_MODEL_FALLBACK); // 退回硬编码候选
    $('oauth-area').hidden = true;
    $('oauth-status').textContent = '已登出';
    toast('已登出 Grok 授权');
  });
}

function fillOAuthInputs() {
  const o = SETTINGS.grokOAuth;
  $('oauth-client-id').value = o.clientId;
  $('oauth-api-base').value = o.apiBase;
  $('oauth-device').value = o.deviceEndpoint;
  $('oauth-token').value = o.tokenEndpoint;
  $('oauth-scope').value = o.scope;
  // select 必须重建选项后才能选中当前值（datalist 时代 input.value= 的迁移点）
  renderOauthModels(XCC_OAUTH_MODEL_FALLBACK);
}

// select「自定义 ID…」选项的哨兵值（非真实模型 ID）
const XCC_OAUTH_MODEL_CUSTOM = '__custom__';

// select 当前值 → 模型 ID：选「自定义」时读输入框；为空则保底用已存模型
function readOauthModelField() {
  const sel = $('oauth-model');
  if (sel.value === XCC_OAUTH_MODEL_CUSTOM) {
    return (
      $('oauth-model-custom').value.trim() ||
      SETTINGS.grokOAuth.model ||
      XCC_OAUTH_MODEL_FALLBACK[0]
    );
  }
  return sel.value.trim();
}

function readOAuthFields() {
  return {
    clientId: $('oauth-client-id').value.trim(),
    model: readOauthModelField(),
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
      // 合并写：model/models 由模型列表控件即时管理，此处只动连接字段
      m.custom = {
        ...m.custom,
        baseUrl,
        apiKey: $('custom-key').value.trim()
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

// ---------- 自定义接口：模型列表（v0.5.3 多模型，增/删/改名/切换 active 全部即时落盘） ----------

function renderCustomModels() {
  const box = $('custom-models');
  box.textContent = '';
  for (const id of SETTINGS.custom.models) box.appendChild(customModelRow(id));
}

function customModelRow(id) {
  const row = document.createElement('div');
  row.className = 'model-row' + (id === SETTINGS.custom.model ? ' active' : '');
  row.dataset.model = id; // 供测试与精确定位（input 的 value 不体现在 innerText）

  const radio = document.createElement('input');
  radio.type = 'radio';
  radio.name = 'custom-active-model';
  radio.checked = id === SETTINGS.custom.model;
  radio.title = '设为当前使用（面板顶部下拉同步）';
  radio.addEventListener('change', async () => {
    if (!radio.checked) return;
    await saveMutate((m) => {
      m.custom.model = id;
    });
    renderCustomModels();
    toast('当前模型：' + id);
  });

  const input = document.createElement('input');
  input.className = 'model-id';
  input.value = id;
  input.placeholder = '模型 ID';
  input.addEventListener('change', async () => {
    const v = input.value.trim();
    if (!v || v === id) {
      input.value = id; // 空输入还原
      return;
    }
    if (SETTINGS.custom.models.includes(v)) {
      toast('模型 ' + v + ' 已存在，未保存', true);
      input.value = id;
      return;
    }
    await saveMutate((m) => {
      const i = m.custom.models.indexOf(id);
      if (i >= 0) m.custom.models[i] = v;
      if (m.custom.model === id) m.custom.model = v; // 改的是当前使用行则同步 active
    });
    await loadSettings();
    renderCustomModels();
    toast('模型已改为 ' + v);
  });

  const del = mkBtn('删除', 'small danger');
  del.addEventListener('click', async () => {
    if (SETTINGS.custom.models.length <= 1) {
      toast('至少保留一个模型', true);
      return;
    }
    if (!confirm('删除模型「' + id + '」？')) return;
    await saveMutate((m) => {
      m.custom.models = m.custom.models.filter((x) => x !== id);
      if (m.custom.model === id) m.custom.model = m.custom.models[0]; // 删的是 active：顺延首个
    });
    await loadSettings();
    renderCustomModels();
    toast('已删除');
  });

  row.append(radio, input, del);
  return row;
}

async function addCustomModel() {
  const input = $('custom-model-new');
  const v = input.value.trim();
  if (!v) {
    toast('模型 ID 不能为空', true);
    return;
  }
  if (SETTINGS.custom.models.includes(v)) {
    toast('模型 ' + v + ' 已存在', true);
    return;
  }
  await saveMutate((m) => {
    m.custom.models.push(v); // 不动 active：当前使用保持不变
  });
  await loadSettings();
  renderCustomModels();
  input.value = '';
  toast('已添加模型 ' + v);
}

// ---------- Grok OAuth 设备流（本页直连 auth.x.ai） ----------

// ---------- OAuth 轮询持久化：防页面刷新/关闭/孤儿自愈中断 ----------
// device_code 只存页面内存时，任何 reload（误刷、标签休眠、自愈）都会杀死
// 轮询循环——用户已在 xAI 完成授权但 token 永远落不了盘。持久化后新页面自动续上。
const XCC_OAUTH_PENDING_KEY = 'xccOauthPending';

async function saveOauthPending(p) {
  try {
    await chrome.storage.local.set({ [XCC_OAUTH_PENDING_KEY]: p });
  } catch (e) {
    /* 写不进时轮询仍可内存续命 */
  }
}

async function clearOauthPending() {
  try {
    await chrome.storage.local.remove(XCC_OAUTH_PENDING_KEY);
  } catch (e) {
    /* 忽略 */
  }
}

function showOAuthPending(p, restored) {
  $('oauth-area').hidden = false;
  $('oauth-code').textContent = p.user_code || '----';
  const link = $('oauth-link');
  link.href = p.verification_uri_complete || p.verification_uri || '#';
  link.textContent = link.href;
  $('oauth-status').textContent = restored ? '已恢复上次授权流程，等待登录…' : '已发起授权，等待登录…';
}

async function restoreOAuthPending() {
  let p = null;
  try {
    p = (await chrome.storage.local.get(XCC_OAUTH_PENDING_KEY))[XCC_OAUTH_PENDING_KEY];
  } catch (e) {
    return;
  }
  if (!p || !p.device_code) return;
  if (!p.expires_at || Date.now() > p.expires_at) {
    await clearOauthPending(); // 已过期：device_code 作废
    return;
  }
  if (SETTINGS.grokOAuth.tokens && SETTINGS.grokOAuth.tokens.access_token) {
    await clearOauthPending(); // 已授权成功：无需恢复
    return;
  }
  const seq = ++pollSeq; // 接管本页所有旧循环；后续 startOAuth/登出同样可接管它
  showOAuthPending(p, true);
  pollDevice(seq, p);
}

// ---------- Grok OAuth：模型目录发现（授权后自动列出可用模型） ----------
// 内置兜底候选 XCC_OAUTH_MODEL_FALLBACK 已上移到 shared/common.js（v0.5.3，
// 面板顶部下拉共用；本页不得重复声明——经典 script 共享全局词法环境）

// 重建模型下拉：传入候选 + 硬编码兜底 + 当前已存值 去重合并，末尾追加「自定义 ID…」。
// 有账号目录（发现落盘或本次发现）时区分「已验证 / 未验证」标注，避免盲选不可用模型。
// 程序化 sel.value= 不触发 change，不会误写盘/误 toast。
function renderOauthModels(models) {
  const sel = $('oauth-model');
  const custom = $('oauth-model-custom');
  const cur = String(SETTINGS.grokOAuth.model || '').trim() || XCC_OAUTH_MODEL_FALLBACK[0];
  // 「已验证」只认账号目录（discoveredModels）：传入候选（含兜底）不参与标注，
  // 否则未授权/离线时兜底项会被整排误标「已验证」（与面板 renderModels 语义对齐）
  const discovered = SETTINGS.grokOAuth.discoveredModels || [];
  const verified = new Set(discovered);
  const hasDiscovery = discovered.length > 0;
  const list = [...new Set([...(Array.isArray(models) ? models : []), ...XCC_OAUTH_MODEL_FALLBACK, cur])];
  sel.textContent = '';
  for (const m of list) {
    const opt = document.createElement('option');
    opt.value = m; // value 保持干净 ID：落盘与 selectOption 不受标注影响
    opt.textContent = hasDiscovery ? (verified.has(m) ? m + '（已验证）' : m + '（未验证）') : m;
    sel.appendChild(opt);
  }
  const customOpt = document.createElement('option');
  customOpt.value = XCC_OAUTH_MODEL_CUSTOM;
  customOpt.textContent = '自定义 ID…';
  sel.appendChild(customOpt);
  // 正在输入自定义 ID 时别打扰
  if (document.activeElement === custom) {
    sel.value = XCC_OAUTH_MODEL_CUSTOM;
    return;
  }
  if (list.includes(cur)) {
    sel.value = cur;
    custom.hidden = true;
  } else {
    // 已存的是列表外自定义 ID：选中哨兵项并回填
    sel.value = XCC_OAUTH_MODEL_CUSTOM;
    custom.value = cur;
    custom.hidden = false;
  }
}

// tokens 存在时拉 {apiBase}/models 动态填充候选；失败静默保持硬编码兜底
async function discoverGrokModels() {
  const o = SETTINGS.grokOAuth;
  if (!(o.tokens && o.tokens.access_token)) return;
  try {
    const discovered = await xccListGrokModels(o);
    if (discovered.length) {
      await saveMutate((m) => {
        m.grokOAuth = { ...m.grokOAuth, discoveredModels: discovered }; // 目录落盘，重开页面仍有「已验证」标注
      });
      await loadSettings();
      renderOauthModels(discovered); // 兜底与当前值在 renderOauthModels 内部合并
      $('oauth-models-discovery').textContent =
        '已发现 ' + discovered.length + ' 个可用模型；标注（已验证）的已确认在你账号可用，其余为内置候选（未验证）';
    }
  } catch (e) {
    /* 静默：端点不支持/不可达时保持硬编码候选 */
  }
}

// ---------- OAuth 模型即时落盘 ----------
// v0.4.1 教训：grokOAuth.model 原先只在「开始授权」时落盘，
// 已授权用户单独改模型后关闭页面即丢，生成一直用旧模型。

async function persistOauthModel(model) {
  await saveMutate((m) => {
    m.grokOAuth = { ...m.grokOAuth, model }; // 只写 model，不动 tokens
  });
  toast('模型已保存：' + model);
}

function onOauthModelChange() {
  const sel = $('oauth-model');
  const custom = $('oauth-model-custom');
  if (sel.value === XCC_OAUTH_MODEL_CUSTOM) {
    // 切到自定义：显示输入框并预填当前模型，输入完成（change）再落盘
    custom.hidden = false;
    custom.value = SETTINGS.grokOAuth.model || '';
    custom.focus();
    return;
  }
  custom.hidden = true;
  persistOauthModel(sel.value).catch((e) => {
    toast('模型保存失败：' + (e && e.message ? e.message : e), true);
  });
}

function onOauthModelCustomChange() {
  const v = $('oauth-model-custom').value.trim();
  if (!v) {
    toast('自定义模型 ID 不能为空，未保存', true);
    return;
  }
  persistOauthModel(v).catch((e) => {
    toast('模型保存失败：' + (e && e.message ? e.message : e), true);
  });
}

// 高级字段（clientId/apiBase/device/token/scope）显式保存：
// 原实现同样只在「开始授权」时顺带落盘，已授权用户改这些字段会被静默丢弃
async function saveOauthAdvanced() {
  const fields = readOAuthFields();
  for (const ep of [fields.deviceEndpoint, fields.tokenEndpoint, fields.apiBase]) {
    await requestOrigin(ep); // 换域名后补申请 host 权限（须在点击手势内）
  }
  try {
    await saveMutate((m) => {
      m.grokOAuth = { ...m.grokOAuth, ...fields }; // fields 不含 tokens，授权态不受影响
    });
    toast('高级设置已保存');
  } catch (e) {
    toast('高级设置保存失败：' + (e && e.message ? e.message : e), true);
  }
}

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
  const seq = ++pollSeq; // 新流程立即使旧轮询失效
  await clearOauthPending();
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

  const pending = {
    device_code: r.device_code,
    interval: r.interval || 5,
    expires_at: Date.now() + (Number(r.expires_in) || 600) * 1000,
    user_code: r.user_code || '',
    verification_uri: r.verification_uri || '',
    verification_uri_complete: r.verification_uri_complete || ''
  };
  await saveOauthPending(pending);
  showOAuthPending(pending, false);
  pollDevice(seq, pending);
}

async function pollDevice(seq, p) {
  let iv = Math.max(2, Number(p.interval) || 5);
  while (Date.now() < p.expires_at) {
    await sleep(iv * 1000);
    if (seq !== pollSeq) return; // 已被新的授权流程或登出取代
    let r;
    try {
      r = await xccPollDeviceToken(SETTINGS.grokOAuth, p.device_code);
    } catch (e) {
      await clearOauthPending(); // 硬错误：device_code 已作废，避免重载后死循环恢复
      if (seq === pollSeq) $('oauth-status').textContent = '✗ ' + (e && e.message ? e.message : e);
      return;
    }
    if (seq !== pollSeq) return;
    if (r.status === 'authorized') {
      await clearOauthPending(); // device_code 一次性：先清再落 token
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
      discoverGrokModels().catch(() => {}); // 授权成功即发现可用模型
      return;
    }
    if (r.slow_down) iv = Math.min(iv + 5, 30); // RFC 8628：被限流时加大轮询间隔
  }
  await clearOauthPending(); // 超时同样清理
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
  // 编辑即标脏；保存后 renderPresets 整卡重建自然清除
  const markDirty = () => card.classList.add('dirty');
  name.addEventListener('input', markDirty);
  ta.addEventListener('input', markDirty);

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
  $('reasoning').value = ['low', 'medium', 'high'].includes(SETTINGS.genParams.reasoningEffort)
    ? SETTINGS.genParams.reasoningEffort
    : 'default';
  $('panel-side').value = SETTINGS.panelSide === 'left' ? 'left' : 'right';
  $('temp').addEventListener('input', () => ($('temp-val').textContent = $('temp').value));
  $('params-save').addEventListener('click', async () => {
    const temp = parseFloat($('temp').value);
    const mt = parseInt($('maxtok').value, 10);
    const params = {
      temperature: Number.isFinite(temp) ? Math.min(1.5, Math.max(0, temp)) : 0.9,
      maxTokens: Number.isFinite(mt) ? Math.min(2000, Math.max(50, mt)) : 400,
      language: $('lang').value,
      reasoningEffort: ['low', 'medium', 'high'].includes($('reasoning').value)
        ? $('reasoning').value
        : 'default'
    };
    await saveMutate((m) => {
      // 合并写而非整体替换：面板侧的免费/付费模式与目标字数（xPlan/targetLength）
      // 在此页无控件，整份覆盖会把它们清掉
      m.genParams = { ...m.genParams, ...params };
      m.panelSide = $('panel-side').value === 'left' ? 'left' : 'right';
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
    // 能读到 storage 说明本页健康：清除自愈标记，把"reload 一次"的额度还给本标签页
    // （sessionStorage 跨 reload 保留，不清除的话一次自愈后就永久处于第二阶段）
    sessionStorage.removeItem('xccHealTried');
    initProviderUI();
    initPresetUI();
    initParamsUI();
    initUpdateBanner();
    restoreOAuthPending().catch(() => {}); // 有未完成的设备授权则自动续上
  } catch (e) {
    if (/Extension context invalidated/i.test(String(e && e.message))) healOrphanPage(true);
    else throw e;
  }
})();
