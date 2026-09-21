// =============================================================
// X 评论副驾 — Content Script（注入 x.com / twitter.com）
// 功能：
//   1. 悬停任意推文 → 右上角出现 ✦ 捕获按钮（识别推文文本/作者）
//   2. 右侧悬浮面板：选人设 + 生成风格 → 调后台生成评论
//   3. 「填入回复框」：自动点开该推文的回复框并写入草稿（Draft.js 兼容）
// 所有 UI 挂在 Shadow DOM 中，避免被 X 的样式污染
// =============================================================
(function () {
  'use strict';

  const state = {
    settings: null,
    captured: null, // { author, name, text, href } 当前捕获的推文
    generatedFor: null, // 生成结果对应的推文快照（防止回错帖）
    generating: false,
    inserting: false, // 填入进行中：防双击竞态
    genCancel: null // 生成中点按钮触发的"放弃等待"回调
  };

  // ---------- 基础工具 ----------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          const le = chrome.runtime.lastError;
          resolve(
            resp || {
              ok: false,
              noBackend: true,
              error: le && le.message
                ? '后台不可用（' + String(le.message).slice(0, 80) + '）'
                : '后台无响应'
            }
          );
        });
      } catch (e) {
        resolve({ ok: false, noBackend: true, error: '扩展上下文已失效（扩展可能刚更新）' });
      }
    });
  }

  // ---------- UI（Shadow DOM） ----------

  const host = document.createElement('div');
  host.id = 'xcc-host';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
  <style>
    :host { all: initial; color-scheme: dark; }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI",
        Roboto, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif; }
    button { cursor: pointer; }
    .xcc-launcher {
      position: fixed; right: 16px; top: 42%;
      width: 44px; height: 44px; border-radius: 50%;
      border: none; color: #fff; font-size: 20px; line-height: 1;
      background: linear-gradient(135deg, #8b5cfa, #4f46e5);
      box-shadow: 0 4px 14px rgba(79, 70, 229, .45);
      z-index: 2147483000; transition: transform .12s ease;
    }
    .xcc-launcher:hover { transform: scale(1.08); }
    .xcc-launcher.left { right: auto; left: 16px; }
    .xcc-hover-btn {
      position: fixed; display: none;
      width: 26px; height: 26px; border-radius: 8px;
      border: 1px solid rgba(255,255,255,.18);
      color: #fff; font-size: 13px; line-height: 23px; text-align: center; padding: 0;
      background: linear-gradient(135deg, #8b5cfa, #4f46e5);
      box-shadow: 0 2px 8px rgba(0,0,0,.35);
      z-index: 2147483000;
    }
    /* v0.5.0：全高侧边栏（SoPilot 式），默认停靠右侧，.left 切左侧（v0.5.1 翻转） */
    .xcc-panel {
      position: fixed; top: 0; bottom: 0; right: 0;
      width: 380px; height: 100vh;
      background: rgba(21, 24, 31, .98); color: #e7e9ea;
      border: 1px solid rgba(255,255,255,.12); border-right: none;
      border-radius: 16px 0 0 16px;
      padding: 14px; z-index: 2147483000;
      box-shadow: -8px 0 32px rgba(0, 0, 0, .5);
      display: flex; flex-direction: column; gap: 6px;
      overflow: hidden; /* 滚动下放给内部滚动区（推文框/输出框） */
    }
    .xcc-panel.left {
      right: auto; left: 0;
      border-right: 1px solid rgba(255,255,255,.12); border-left: none;
      border-radius: 0 16px 16px 0;
      box-shadow: 8px 0 32px rgba(0, 0, 0, .5);
    }
    /* .xcc-panel 的 display:flex 会盖掉浏览器默认的 [hidden]{display:none}，必须显式声明 */
    .xcc-panel[hidden] { display: none; }
    .xcc-head { display: flex; align-items: center; justify-content: space-between; }
    .xcc-title { font-weight: 700; font-size: 14px; }
    .xcc-mini {
      background: transparent; border: none; color: #9ca3af;
      font-size: 13px; padding: 2px 5px; border-radius: 6px;
    }
    .xcc-mini:hover { background: rgba(255,255,255,.1); color: #e7e9ea; }
    .xcc-provider { font-size: 11px; color: #9ca3af; }
    .xcc-provider.warn { color: #f59e0b; }
    .xcc-update {
      font-size: 11.5px; color: #fbbf24; cursor: pointer;
      padding: 4px 8px; border-radius: 7px;
      background: rgba(251, 191, 36, .08);
    }
    .xcc-update:hover { background: rgba(251, 191, 36, .16); }
    .xcc-lb { font-size: 11px; color: #9ca3af; margin-top: 2px; }
    select, input.xcc-topic {
      background: rgba(255,255,255,.06); color: #e7e9ea;
      border: 1px solid rgba(255,255,255,.14); border-radius: 8px;
      padding: 7px 8px; font-size: 13px; outline: none; width: 100%;
    }
    select:focus, input.xcc-topic:focus { border-color: #7c8ff5; }
    /* 原生下拉列表默认走系统浅色渲染，会白底配浅字看不清：强制深色 */
    select option { background: #1f2733; color: #e7e9ea; }
    .xcc-tweet {
      border: 1px dashed rgba(255,255,255,.18); border-radius: 10px;
      padding: 6px 10px; font-size: 12px;
      flex: 1 1 0; min-height: 64px; max-height: 180px;
      display: flex; flex-direction: column; overflow: hidden;
    }
    .xcc-tweet-hd {
      display: flex; justify-content: space-between; align-items: center;
      color: #9ca3af; font-size: 11px; margin-bottom: 4px;
    }
    /* 已捕获推文：弹性伸展 + 内部滚动（v0.5.0 侧栏形态，内容多时自己滚） */
    .xcc-tweet-bd { color: #d1d5db; white-space: pre-wrap; word-break: break-word;
      flex: 1 1 auto; overflow: auto; line-height: 1.45; }
    .xcc-plan-row { display: flex; gap: 6px; }
    .xcc-plan-btn {
      flex: 1; border-radius: 9px; padding: 6px 0; font-size: 12px;
      border: 1px solid rgba(255,255,255,.16);
      background: rgba(255,255,255,.05); color: #9ca3af;
    }
    .xcc-plan-btn.on { color: #fff; border-color: #7c8ff5; background: rgba(124,143,245,.18); }
    .xcc-stance-row { display: flex; gap: 6px; }
    .xcc-stance-btn {
      flex: 1; border-radius: 9px; padding: 5px 0; font-size: 12px;
      border: 1px solid rgba(255,255,255,.16);
      background: rgba(255,255,255,.05); color: #9ca3af;
    }
    .xcc-stance-btn.on { color: #fff; border-color: #7c8ff5; background: rgba(124,143,245,.18); }
    input.xcc-target-len { padding: 6px 8px; font-size: 12.5px; height: 30px; }
    .xcc-gen-btn {
      border: none; border-radius: 10px; padding: 9px 0;
      color: #fff; font-size: 14px; font-weight: 600;
      background: linear-gradient(135deg, #8b5cfa, #4f46e5);
    }
    .xcc-gen-btn:disabled { opacity: .55; cursor: not-allowed; }
    .xcc-out-bar { display: flex; justify-content: flex-end; align-items: center; flex: 0 0 auto;
      min-height: 14px; margin-bottom: -2px; }
    .xcc-count { font-size: 11px; color: #9ca3af; line-height: 1.2; }
    .xcc-count.over { color: #f87171; font-weight: 600; }
    /* 生成输出框：v0.5.0 侧栏形态的主区，弹性伸展且占比最大（约为推文框 2.4 倍） */
    textarea.xcc-out {
      background: rgba(255,255,255,.04); color: #e7e9ea;
      border: 1px solid rgba(255,255,255,.14); border-radius: 10px;
      padding: 9px 10px; font-size: 13px;
      flex: 2.4 1 0; min-height: 260px; resize: none;
      outline: none; line-height: 1.45; overflow: auto;
    }
    textarea.xcc-out:focus { border-color: #7c8ff5; }
    .xcc-row { display: flex; gap: 6px; }
    .xcc-row button {
      flex: 1; border-radius: 9px; padding: 7px 0; font-size: 12.5px;
      border: 1px solid rgba(255,255,255,.16);
      background: rgba(255,255,255,.05); color: #e7e9ea;
    }
    .xcc-row button:hover { background: rgba(255,255,255,.1); }
    .xcc-row button:disabled { opacity: .55; cursor: not-allowed; }
    .xcc-row .xcc-main {
      background: linear-gradient(135deg, #8b5cfa, #4f46e5);
      border: none; color: #fff; font-weight: 600; flex: 1.4;
    }
    .xcc-status { font-size: 11.5px; color: #9ca3af; min-height: 15px; line-height: 1.4; }
    .xcc-status.err { color: #f87171; }
  </style>

  <button class="xcc-launcher" title="X 评论副驾">✦</button>
  <div class="xcc-hover-btn" title="捕获这条推文">✦</div>

  <div class="xcc-panel" hidden>
    <div class="xcc-head">
      <span class="xcc-title">✦ 评论副驾</span>
      <span>
        <button class="xcc-mini" data-act="settings" title="打开设置">⚙</button>
        <button class="xcc-mini" data-act="close" title="收起面板">✕</button>
      </span>
    </div>
    <div class="xcc-provider">加载中…</div>
    <div class="xcc-update" hidden>🆕 有新版</div>
    <label class="xcc-lb">人设</label>
    <select class="xcc-persona"></select>
    <label class="xcc-lb">生成风格</label>
    <select class="xcc-gen"></select>
    <div class="xcc-stance-row">
      <button class="xcc-stance-btn" data-act="stance-pessimistic">消极</button>
      <button class="xcc-stance-btn" data-act="stance-objective">客观</button>
      <button class="xcc-stance-btn" data-act="stance-optimistic">乐观</button>
    </div>
    <div class="xcc-plan-row">
      <button class="xcc-plan-btn" data-act="plan-free">免费 · ≤280 字符</button>
      <button class="xcc-plan-btn" data-act="plan-premium">付费 · 不限长</button>
    </div>
    <input class="xcc-target-len" type="number" min="1" max="2000"
      placeholder="目标字数（选填，如 120，模糊参考）" hidden>
    <div class="xcc-tweet">
      <div class="xcc-tweet-hd">
        <span>已捕获推文</span>
        <button class="xcc-mini" data-act="clear" title="清除捕获">✕</button>
      </div>
      <div class="xcc-tweet-bd">把鼠标悬停在任意推文上，点 ✦ 即可捕获</div>
    </div>
    <input class="xcc-topic" placeholder="或输入主题（生成原创推文用）">
    <button class="xcc-gen-btn">✦ 生成</button>
    <div class="xcc-out-bar"><span class="xcc-count">0/280</span></div>
    <textarea class="xcc-out" placeholder="生成结果（可手动修改后再填入）"></textarea>
    <div class="xcc-row">
      <button class="xcc-main" data-act="insert">填入回复框</button>
      <button data-act="copy">复制</button>
      <button data-act="regen">换一条</button>
    </div>
    <div class="xcc-status"></div>
  </div>`;
  document.documentElement.appendChild(host);

  const els = {
    launcher: shadow.querySelector('.xcc-launcher'),
    hoverBtn: shadow.querySelector('.xcc-hover-btn'),
    panel: shadow.querySelector('.xcc-panel'),
    provider: shadow.querySelector('.xcc-provider'),
    update: shadow.querySelector('.xcc-update'),
    personaSel: shadow.querySelector('.xcc-persona'),
    genSel: shadow.querySelector('.xcc-gen'),
    stanceBtns: shadow.querySelectorAll('.xcc-stance-btn'),
    planFree: shadow.querySelector('[data-act="plan-free"]'),
    planPremium: shadow.querySelector('[data-act="plan-premium"]'),
    targetLen: shadow.querySelector('.xcc-target-len'),
    tweetBd: shadow.querySelector('.xcc-tweet-bd'),
    topic: shadow.querySelector('.xcc-topic'),
    genBtn: shadow.querySelector('.xcc-gen-btn'),
    insertBtn: shadow.querySelector('.xcc-row [data-act="insert"]'),
    out: shadow.querySelector('.xcc-out'),
    count: shadow.querySelector('.xcc-count'),
    status: shadow.querySelector('.xcc-status')
  };

  // ---------- 状态渲染 ----------

  function setStatus(text, isError) {
    els.status.textContent = text || '';
    els.status.classList.toggle('err', !!isError);
  }

  function renderTweetBox() {
    const c = state.captured;
    if (c && (c.text || c.author)) {
      els.tweetBd.textContent =
        (c.author || c.name || '') + '：' + (c.text || '（无文本，仅图片/视频）');
    } else {
      els.tweetBd.textContent = '把鼠标悬停在任意推文上，点 ✦ 即可捕获';
    }
  }

  function fillSelect(sel, list, activeId) {
    const prev = sel.value;
    sel.textContent = '';
    for (const p of list) {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.name || p.id;
      sel.appendChild(o);
    }
    sel.value = list.some((p) => p.id === activeId) ? activeId : (list[0] && list[0].id) || '';
    // 面板开着时刷新，保留用户在当前页面已选的项
    if (prev && list.some((p) => p.id === prev)) sel.value = prev;
  }

  // 生成按钮态：当前接入方式未配置完成时禁用；
  // ready 变化经 storage.onChanged → refreshSettings → applySettings 联动刷新。
  // 生成中不禁用——按钮变为「⏹ 放弃等待」，超时与否由用户自行判断
  function syncGenBtn() {
    const s = state.settings;
    const ready = !!(s && s.ready && s.ready[s.provider]);
    els.genBtn.disabled = !state.generating && !ready;
    els.genBtn.title = ready
      ? ''
      : '当前接入方式未配置完成（' + (s ? s.providerLabel : '模型') +
        '）。点右上角 ⚙ 打开设置完成配置后再生成';
  }

  // 观点倾向渲染：消极/客观/乐观三按钮高亮当前值
  function renderStance() {
    const v = (state.settings && state.settings.stance) || 'objective';
    els.stanceBtns.forEach((b) => {
      b.classList.toggle('on', b.dataset.act === 'stance-' + v);
    });
  }

  // 账号模式渲染：免费/付费按钮态 + 目标字数输入框显隐 + 计数器刷新
  function renderPlan() {
    const gp = (state.settings && state.settings.genParams) || {};
    const premium = gp.xPlan === 'premium';
    if (els.planFree) els.planFree.classList.toggle('on', !premium);
    if (els.planPremium) els.planPremium.classList.toggle('on', premium);
    if (els.targetLen) {
      els.targetLen.hidden = !premium;
      if (premium && document.activeElement !== els.targetLen) {
        els.targetLen.value = gp.targetLength || '';
      }
    }
    updateCount();
  }

  // 输出框字符计数：免费 n/280（超限标红仅提示不截断）；付费 n 字
  function updateCount() {
    if (!els.count) return;
    const gp = (state.settings && state.settings.genParams) || {};
    const n = els.out.value.length;
    if (gp.xPlan === 'premium') {
      els.count.textContent = n + ' 字';
      els.count.classList.remove('over');
    } else {
      els.count.textContent = n + '/280';
      els.count.classList.toggle('over', n > 280);
    }
  }

  // 悬浮球显隐：设置启用 且 面板关闭 时可见（面板开着时让位）
  function syncLauncher() {
    const enabled = !(state.settings && state.settings.enabled === false);
    els.launcher.style.display = enabled && els.panel.hidden ? '' : 'none';
    els.launcher.classList.toggle('left', (state.settings && state.settings.panelSide) === 'left');
  }

  function applySettings(pub) {
    state.settings = pub;
    if (pub.enabled === false) els.panel.hidden = true;
    els.panel.classList.toggle('left', pub.panelSide === 'left');
    fillSelect(els.personaSel, pub.personaPresets, pub.activePersonaId);
    fillSelect(els.genSel, pub.genPresets, pub.activeGenId);
    const ok = pub.ready && pub.ready[pub.provider];
    els.provider.textContent = pub.providerLabel + (ok ? '' : ' · 未配置，点 ⚙ 去设置');
    els.provider.classList.toggle('warn', !ok);
    // 同设置页：现场用已装版本重算，不用存储里的旧结论
    const upd = pub.update;
    const installed = chrome.runtime.getManifest().version;
    const show = !!(upd && upd.latest && xccIsNewerVersion(upd.latest, installed));
    els.update.hidden = !show;
    if (show) {
      els.update.textContent = '🆕 有新版 v' + upd.latest + '：点击下载 ZIP，解压替换后重新加载扩展';
    }
    renderStance();
    renderPlan();
    syncGenBtn();
    syncLauncher();
  }

  async function refreshSettings() {
    // 直接读 chrome.storage，不经过后台消息——
    // Edge 对扩展后台的休眠/唤醒不可靠，UI 功能不能依赖它
    try {
      const store = await chrome.storage.local.get(['settings', 'xccUpdate']);
      const pub = {
        ...xccPublicSettings(xccMergeSettings(store.settings)),
        update: store.xccUpdate || null
      };
      applySettings(pub);
    } catch (e) {
      if (!(chrome.runtime && chrome.runtime.id)) {
        // 本内容脚本属于重载前的旧实例：storage 已不可用，停止重试
        els.provider.textContent = '⚠ 扩展已重新加载，请刷新本页（F5）后继续使用';
        els.provider.classList.add('warn');
        syncGenBtn();
        return;
      }
      if (!state.settings) {
        els.provider.textContent = '⚠ 设置读取失败：请在扩展管理页点「重新加载」后刷新页面';
        els.provider.classList.add('warn');
        setTimeout(refreshSettings, 5000);
      }
    }
  }

  async function mutateSettings(fn) {
    const { settings } = await chrome.storage.local.get('settings');
    const m = xccMergeSettings(settings);
    fn(m);
    await chrome.storage.local.set({ settings: m });
  }

  // ---------- 面板开关 ----------

  els.launcher.addEventListener('click', () => {
    els.panel.hidden = !els.panel.hidden;
    if (!els.panel.hidden) refreshSettings();
    syncLauncher();
  });

  // ---------- 悬停推文捕获 ----------

  let hoverArticle = null;

  function isEnabled() {
    // fail-open：设置尚未加载成功时按"启用"处理，只有明确关闭才禁用，
    // 避免后台消息偶发失败导致悬停捕获/面板整体失效
    return !(state.settings && state.settings.enabled === false);
  }

  document.addEventListener(
    'mouseover',
    (e) => {
      if (!isEnabled()) return;
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (t.closest('#xcc-host')) return; // 我们自己的 UI
      const art = t.closest('article[data-testid="tweet"]');
      if (art === hoverArticle) return;
      hoverArticle = art;
      if (!art) {
        els.hoverBtn.style.display = 'none';
        return;
      }
      const r = art.getBoundingClientRect();
      const b = els.hoverBtn;
      b.style.display = 'block';
      b.style.top = Math.max(8, r.top + 6) + 'px';
      b.style.left = Math.max(8, r.right - 64) + 'px';
    },
    true
  );

  // X 虚拟列表滚动会重挂节点，直接隐藏按钮等下一次悬停
  window.addEventListener(
    'scroll',
    () => {
      els.hoverBtn.style.display = 'none';
      hoverArticle = null;
    },
    { capture: true, passive: true }
  );

  els.hoverBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (!hoverArticle || !isEnabled()) return;
    captureTweet(hoverArticle);
    els.panel.hidden = false;
    refreshSettings();
    syncLauncher();
  });

  function extractTweet(art) {
    const textEl = art.querySelector('[data-testid="tweetText"]');
    const nameEl = art.querySelector('[data-testid="User-Name"]');
    let author = '';
    let name = '';
    if (nameEl) {
      const t = (nameEl.innerText || '').trim();
      const m = t.match(/@([A-Za-z0-9_]+)/);
      if (m) author = '@' + m[1];
      name = t.split('\n')[0] || '';
    }
    let href = '';
    const time = art.querySelector('a[href*="/status/"] time');
    if (time) href = (time.closest('a') || {}).getAttribute('href') || '';
    return {
      author,
      name,
      text: textEl ? textEl.innerText.trim() : '',
      href
    };
  }

  function captureTweet(art) {
    const t = extractTweet(art);
    state.captured = t;
    renderTweetBox();
    if (!t.text) {
      setStatus('该推文没有可识别的文本（可能只有图片/视频）', true);
    } else {
      setStatus('已捕获 ' + (t.author || '') + ' 的推文，点「✦ 生成」');
    }
  }

  // ---------- 生成 ----------

  async function generate() {
    if (state.generating) return;
    // 兜底：正常情况按钮已被 syncGenBtn 禁用；拦截"换一条"与点击瞬间配置变化的竞态
    const s = state.settings;
    if (!(s && s.ready && s.ready[s.provider])) {
      setStatus(
        '尚未配置模型：点 ⚙ 打开设置完成「' + (s ? s.providerLabel : '模型接入') + '」后再生成',
        true
      );
      return;
    }
    const topic = els.topic.value.trim();
    const hasTweetText = !!(state.captured && String(state.captured.text || '').trim());
    if (!hasTweetText && !topic) {
      setStatus(
        state.captured
          ? '该推文没有可识别文本（仅图片/视频）：可改为在下方输入主题生成原创推文'
          : '请先捕获一条推文，或在下方输入主题',
        true
      );
      return;
    }
    state.generating = true;
    els.genBtn.textContent = '⏹ 放弃等待';
    setStatus('正在生成…');
    // 快照本次生成的目标推文：填入时绑定它，
    // 避免生成等待期间误触捕获其他推文导致回错帖
    const target = state.captured;
    // 不设硬超时：请求不切断、结果晚到也自动填入；用户可随时点按钮放弃等待
    let giveUp;
    const cancelled = new Promise((res) => {
      giveUp = res;
    });
    state.genCancel = () => giveUp(true);
    let elapsed = 0;
    const ticker = setInterval(() => {
      elapsed += 15;
      setStatus(
        '仍在生成中…已耗时 ' + elapsed + ' 秒。不想等可点「⏹ 放弃等待」；结果返回后会自动填入'
      );
    }, 15000);
    try {
      const r = await Promise.race([
        send({ type: 'GENERATE', tweet: target, topic: topic || null }),
        cancelled
      ]);
      if (r === true) {
        setStatus('已放弃本次生成（可稍后重试或换已验证的模型）');
        return;
      }
      if (r && r.ok) {
        els.out.value = r.text;
        state.generatedFor = target;
        setStatus('已生成，可编辑后填入');
        updateCount();
      } else if (!r) {
        setStatus('生成失败：扩展后台无响应，请到扩展管理页「重新加载」扩展后刷新本页重试', true);
      } else {
        const msg = String(r.error || '生成失败，请重试');
        setStatus(
          /API 4\d\d|model|not\s*found|reasoning|模型/i.test(msg)
            ? msg + '。该模型可能不在你账号的可用列表或参数不被支持：试试设置页下拉里标注（已验证）的模型；若刚改过思考强度请切回「默认」'
            : msg,
          true
        );
      }
    } finally {
      clearInterval(ticker);
      state.generating = false;
      state.genCancel = null;
      syncGenBtn(); // 不再无条件解禁：若配置仍为空则保持禁用
      els.genBtn.textContent = '✦ 生成';
    }
  }

  // ---------- 填入 X 输入框（Draft.js 兼容） ----------

  function visibleEditors() {
    return Array.from(
      document.querySelectorAll('[data-testid="tweetTextarea_0"][contenteditable="true"]')
    ).filter((el) => el.offsetParent !== null);
  }

  // 推文详情页的回复框是常驻内联的（点回复不会新增 DOM 节点），
  // 短暂等待新编辑器未果且确在详情页时，退回使用已可见的那个，避免白等 6 秒
  function isDetailPage() {
    return /\/status\/\d+/.test(location.pathname);
  }

  async function waitForNewEditor(beforeSet, timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const eds = visibleEditors();
      const fresh = eds.find((e) => !beforeSet.has(e));
      if (fresh) return fresh;
      if (eds.length && isDetailPage() && Date.now() - t0 > 1200) return eds[eds.length - 1];
      await sleep(120);
    }
    return null;
  }

  // 编辑器当前文本（X 把换行渲染成 <br>/nbsp，比较前归一化）
  function normEditorText(s) {
    return String(s || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\r\n?/g, '\n')
      .replace(/\u200b/g, '')
      .trim();
  }

  function countOccurrences(hay, needle) {
    if (!needle) return 0;
    let n = 0;
    let i = hay.indexOf(needle);
    while (i !== -1) {
      n++;
      i = hay.indexOf(needle, i + needle.length);
    }
    return n;
  }

  // 把选区严格锚定在编辑器内部（Range API，非文档级 selectAll）
  function selectEditorContents(editor) {
    try {
      editor.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      sel.removeAllRanges();
      sel.addRange(range);
      return true;
    } catch (e) {
      return false;
    }
  }

  // 空编辑器：把光标落进框架托管的最深文本块（Draft [data-contents] /
  // Lexical 块级节点），避免 execCommand 把裸文本节点插到托管子树之外——
  // 那正是"两段重复、上面一段退格删不掉"的幽灵碎片来源
  function placeCaretInLeaf(editor) {
    try {
      editor.focus();
      const sel = window.getSelection();
      if (sel.rangeCount && editor.contains(sel.anchorNode) && sel.anchorNode !== editor) return;
      const leaf =
        editor.querySelector('[data-block], [data-lexical-text="true"], [data-contents], p, span') ||
        editor;
      const range = document.createRange();
      range.selectNodeContents(leaf);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) {
      /* 保持 focus 默认位置 */
    }
  }

  function rawInsert(editor, text) {
    try {
      return document.execCommand('insertText', false, text);
    } catch (e) {
      return false;
    }
  }

  // 清空编辑器（范围内全选后 delete，连托管树外的孤儿碎片一并清掉）
  function clearEditor(editor) {
    try {
      if (!selectEditorContents(editor)) return false;
      return document.execCommand('delete', false, null);
    } catch (e) {
      return false;
    }
  }

  // 兜底通道：合成 paste 走框架粘贴管线，插入必然落在框架状态内。
  // isTrusted=false 所以只作最后回退，不当主路径。
  function pasteInsert(editor, text) {
    try {
      editor.focus();
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      editor.dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt })
      );
      return true;
    } catch (e) {
      return false;
    }
  }

  // 填入并校验：成功 = innerText 恰好包含一次目标文本。
  // 返回 'ok' | 'skip' | 'recovered' | 'fail'；失败时清场不留半份/重复内容。
  async function insertInto(editor, text) {
    const want = normEditorText(text);
    if (!want) return 'fail';
    // 幂等防重：编辑器已含同样内容（上轮残留/双击第二次）则跳过
    if (countOccurrences(normEditorText(editor.innerText), want) > 0) return 'skip';

    // 第一次：空编辑器只落位光标（不动选区）；已有旧草稿才全选替换
    editor.focus();
    if (normEditorText(editor.innerText)) {
      if (!selectEditorContents(editor)) return 'fail';
    } else {
      placeCaretInLeaf(editor);
    }
    let ok = rawInsert(editor, text);
    await sleep(200); // 等 Draft/Lexical 完成 模型↔DOM 同步再校验
    if (ok && countOccurrences(normEditorText(editor.innerText), want) === 1) return 'ok';

    // 异常（0 份或 ≥2 份）：清空后重插
    clearEditor(editor);
    placeCaretInLeaf(editor);
    ok = rawInsert(editor, text);
    await sleep(200);
    if (ok && countOccurrences(normEditorText(editor.innerText), want) === 1) return 'recovered';

    // 仍异常：合成 paste 兜底
    clearEditor(editor);
    pasteInsert(editor, text);
    await sleep(200);
    if (countOccurrences(normEditorText(editor.innerText), want) === 1) return 'recovered';

    clearEditor(editor); // 彻底失败：清场，走剪贴板兜底
    return 'fail';
  }

  async function copyText(t) {
    try {
      await navigator.clipboard.writeText(t);
    } catch (e) {
      /* 剪贴板不可用时静默 */
    }
  }

  // 每条推文自己的永久链接 = 时间戳外层的 <a>；
  // 只按它精确定位，避免误命中推文内引用转发（quote tweet）的链接
  function articlePermalink(art) {
    const time = art.querySelector('a[href*="/status/"] time');
    const a = time && time.closest('a');
    return a ? (a.getAttribute('href') || '').split('?')[0] : '';
  }

  function findArticleByHref(href) {
    const clean = href.split('?')[0];
    if (!clean) return null;
    for (const a of document.querySelectorAll('article[data-testid="tweet"]')) {
      if (articlePermalink(a) === clean) return a;
    }
    return null;
  }

  async function insertResult() {
    if (state.inserting) return;
    const text = els.out.value.trim();
    if (!text) {
      setStatus('还没有内容可填入', true);
      return;
    }
    state.inserting = true;
    els.insertBtn.disabled = true; // 操作期间禁用，防双击竞态
    try {
      // 结果绑定生成时的推文；纯手写内容（从未生成过）才用当前捕获
      const target = state.generatedFor || state.captured;
      if (target && target.href) {
        // 已有可见编辑器包含同样内容（此前已填过/弹层还开着）：直接视为成功，
        // 不再点回复按钮——避免二次开框与双份内容
        const dup = visibleEditors().find(
          (e) => countOccurrences(normEditorText(e.innerText), normEditorText(text)) > 0
        );
        if (dup) {
          setStatus('回复框已包含该内容，未重复填入');
          return;
        }
        // 回复模式：找到原推文 → 点回复按钮 → 等编辑器出现 → 写入
        const art = findArticleByHref(target.href);
        if (!art) {
          setStatus('页面上找不到原推文（可能已滚出屏幕），请滚回该推文附近再试', true);
          return;
        }
        const replyBtn = art.querySelector('[data-testid="reply"]');
        if (!replyBtn) {
          setStatus('找不到该推文的回复按钮', true);
          return;
        }
        const before = new Set(visibleEditors());
        replyBtn.click();
        const editor = await waitForNewEditor(before, 6000);
        if (!editor) {
          setStatus('回复框未能打开，内容已复制，请手动粘贴', true);
          copyText(text);
          return;
        }
        const r = await insertInto(editor, text);
        if (r === 'ok' || r === 'recovered') {
          setStatus(
            (r === 'recovered' ? '已自动纠正一次异常插入，请检查。' : '') +
              (target !== state.captured
                ? '✓ 已按生成时的推文（' + (target.author || '') + '）填入，检查后手动发送'
                : '✓ 已填入回复框，检查后手动点发送')
          );
        } else if (r === 'skip') {
          setStatus('回复框已包含该内容，未重复填入');
        } else {
          setStatus('填入异常（未能确认唯一内容），已复制，请手动粘贴', true);
          copyText(text);
        }
      } else {
        // 原创模式：优先用首页发帖框，没有就点侧栏发帖按钮
        let editor = visibleEditors()[0] || null;
        if (!editor) {
          const fab = document.querySelector('[data-testid="SideNav_NewTweet_Button"]');
          if (fab) {
            const before = new Set(visibleEditors());
            fab.click();
            editor = await waitForNewEditor(before, 6000);
          }
        }
        if (!editor) {
          setStatus('未找到发帖输入框：请先打开 X 首页，或手动点开发帖框后重试', true);
          return;
        }
        const r = await insertInto(editor, text);
        if (r === 'ok' || r === 'recovered') {
          setStatus((r === 'recovered' ? '已自动纠正一次异常插入，请检查。' : '') + '✓ 已填入发帖框，检查后手动发送');
        } else if (r === 'skip') {
          setStatus('发帖框已包含该内容，未重复填入');
        } else {
          setStatus('填入异常（未能确认唯一内容），已复制', true);
          copyText(text);
        }
      }
    } finally {
      state.inserting = false;
      els.insertBtn.disabled = false;
    }
  }

  // ---------- 事件绑定 ----------

  if (els.update) {
    els.update.addEventListener('click', () => {
      window.open(XCC_ZIP_URL, '_blank');
    });
  }

  els.genBtn.addEventListener('click', () => {
    if (state.generating) {
      // 生成中点击 = 放弃等待（不切断请求，晚到的结果将被忽略）
      if (state.genCancel) state.genCancel();
      return;
    }
    generate();
  });

  els.panel.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'settings') {
      // web_accessible_resources 已声明本页可从 x.com 打开；
      // 若仍被拦截（返回 null），回退到后台 openOptionsPage
      const w = window.open(chrome.runtime.getURL('options/options.html'), '_blank');
      if (!w) send({ type: 'OPEN_OPTIONS' });
    } else if (act === 'close') {
      els.panel.hidden = true;
      syncLauncher();
    } else if (act === 'clear') {
      state.captured = null;
      state.generatedFor = null;
      renderTweetBox();
      setStatus('');
    } else if (act === 'insert') {
      insertResult();
    } else if (act === 'copy') {
      copyText(els.out.value);
      setStatus('已复制');
    } else if (act === 'regen') {
      generate();
    } else if (act === 'plan-free' || act === 'plan-premium') {
      const v = act === 'plan-premium' ? 'premium' : 'free';
      // 本地即时切换（不等 storage 往返），落盘后 onChanged 会再同步一次
      if (state.settings && state.settings.genParams) state.settings.genParams.xPlan = v;
      renderPlan();
      mutateSettings((m) => {
        m.genParams.xPlan = v;
      }).catch(() => {});
    } else if (act === 'stance-pessimistic' || act === 'stance-objective' || act === 'stance-optimistic') {
      const v = act.slice('stance-'.length);
      if (state.settings) state.settings.stance = v;
      renderStance();
      mutateSettings((m) => {
        m.stance = v;
      }).catch(() => {});
    }
  });

  els.personaSel.addEventListener('change', () => {
    const v = els.personaSel.value;
    mutateSettings((m) => {
      m.activePersonaId = v;
    }).catch(() => {});
  });
  els.genSel.addEventListener('change', () => {
    const v = els.genSel.value;
    mutateSettings((m) => {
      m.activeGenId = v;
    }).catch(() => {});
  });

  // 目标字数（付费模式）：即时落盘；输入时仅允许数字
  els.targetLen.addEventListener('input', () => {
    els.targetLen.value = els.targetLen.value.replace(/\D/g, '').slice(0, 4);
  });
  els.targetLen.addEventListener('change', () => {
    const v = els.targetLen.value.trim();
    if (state.settings && state.settings.genParams) state.settings.genParams.targetLength = v;
    mutateSettings((m) => {
      m.genParams.targetLength = v;
    }).catch(() => {});
  });

  // 输出框编辑时实时刷新字符计数
  els.out.addEventListener('input', updateCount);

  // 设置在别处（设置页/弹窗）被改动时同步面板
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) refreshSettings();
  });

  // ---------- 初始化 ----------

  renderTweetBox();
  refreshSettings();
})();
