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
    generating: false
  };

  // ---------- 基础工具 ----------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          void chrome.runtime.lastError; // 扩展重载后静默降级
          resolve(resp || null);
        });
      } catch (e) {
        resolve(null); // Extension context invalidated
      }
    });
  }

  // ---------- UI（Shadow DOM） ----------

  const host = document.createElement('div');
  host.id = 'xcc-host';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
  <style>
    :host { all: initial; }
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
    .xcc-hover-btn {
      position: fixed; display: none;
      width: 26px; height: 26px; border-radius: 8px;
      border: 1px solid rgba(255,255,255,.18);
      color: #fff; font-size: 13px; line-height: 23px; text-align: center; padding: 0;
      background: linear-gradient(135deg, #8b5cfa, #4f46e5);
      box-shadow: 0 2px 8px rgba(0,0,0,.35);
      z-index: 2147483000;
    }
    .xcc-panel {
      position: fixed; right: 16px; bottom: 16px;
      width: 332px; max-height: calc(100vh - 32px); overflow: auto;
      background: rgba(21, 24, 31, .97); color: #e7e9ea;
      border: 1px solid rgba(255,255,255,.12); border-radius: 16px;
      padding: 14px; z-index: 2147483000;
      box-shadow: 0 12px 40px rgba(0,0,0,.5);
      display: flex; flex-direction: column; gap: 8px;
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
    .xcc-tweet {
      border: 1px dashed rgba(255,255,255,.18); border-radius: 10px;
      padding: 8px 10px; font-size: 12px;
    }
    .xcc-tweet-hd {
      display: flex; justify-content: space-between; align-items: center;
      color: #9ca3af; font-size: 11px; margin-bottom: 4px;
    }
    .xcc-tweet-bd { color: #d1d5db; white-space: pre-wrap; word-break: break-word;
      max-height: 88px; overflow: auto; line-height: 1.45; }
    .xcc-gen-btn {
      border: none; border-radius: 10px; padding: 9px 0;
      color: #fff; font-size: 14px; font-weight: 600;
      background: linear-gradient(135deg, #8b5cfa, #4f46e5);
    }
    .xcc-gen-btn:disabled { opacity: .55; cursor: wait; }
    textarea.xcc-out {
      background: rgba(255,255,255,.04); color: #e7e9ea;
      border: 1px solid rgba(255,255,255,.14); border-radius: 10px;
      padding: 9px 10px; font-size: 13px; min-height: 84px; resize: vertical;
      outline: none; line-height: 1.5;
    }
    textarea.xcc-out:focus { border-color: #7c8ff5; }
    .xcc-row { display: flex; gap: 6px; }
    .xcc-row button {
      flex: 1; border-radius: 9px; padding: 7px 0; font-size: 12.5px;
      border: 1px solid rgba(255,255,255,.16);
      background: rgba(255,255,255,.05); color: #e7e9ea;
    }
    .xcc-row button:hover { background: rgba(255,255,255,.1); }
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
    <div class="xcc-tweet">
      <div class="xcc-tweet-hd">
        <span>已捕获推文</span>
        <button class="xcc-mini" data-act="clear" title="清除捕获">✕</button>
      </div>
      <div class="xcc-tweet-bd">把鼠标悬停在任意推文上，点 ✦ 即可捕获</div>
    </div>
    <input class="xcc-topic" placeholder="或输入主题（生成原创推文用）">
    <button class="xcc-gen-btn">✦ 生成</button>
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
    tweetBd: shadow.querySelector('.xcc-tweet-bd'),
    topic: shadow.querySelector('.xcc-topic'),
    genBtn: shadow.querySelector('.xcc-gen-btn'),
    out: shadow.querySelector('.xcc-out'),
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

  function applySettings(pub) {
    state.settings = pub;
    const enabled = pub.enabled !== false;
    els.launcher.style.display = enabled ? '' : 'none';
    if (!enabled) els.panel.hidden = true;
    fillSelect(els.personaSel, pub.personaPresets, pub.activePersonaId);
    fillSelect(els.genSel, pub.genPresets, pub.activeGenId);
    const ok = pub.ready && pub.ready[pub.provider];
    els.provider.textContent = pub.providerLabel + (ok ? '' : ' · 未配置，点 ⚙ 去设置');
    els.provider.classList.toggle('warn', !ok);
    const upd = pub.update;
    els.update.hidden = !(upd && upd.hasUpdate);
    if (upd && upd.hasUpdate) {
      els.update.textContent = '🆕 有新版 v' + upd.latest + '：点击下载 ZIP，解压替换后重新加载扩展';
    }
  }

  async function refreshSettings() {
    const r = await send({ type: 'GET_PUBLIC_SETTINGS' });
    if (r && r.ok) applySettings(r.settings);
  }

  // ---------- 面板开关 ----------

  els.launcher.addEventListener('click', () => {
    els.panel.hidden = !els.panel.hidden;
    if (!els.panel.hidden) refreshSettings();
  });

  // ---------- 悬停推文捕获 ----------

  let hoverArticle = null;

  function isEnabled() {
    return !!(state.settings && state.settings.enabled !== false);
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
    const topic = els.topic.value.trim();
    if (!state.captured && !topic) {
      setStatus('请先捕获一条推文，或在下方输入主题', true);
      return;
    }
    state.generating = true;
    els.genBtn.disabled = true;
    els.genBtn.textContent = '生成中…';
    setStatus('正在生成…');
    // 快照本次生成的目标推文：填入时绑定它，
    // 避免生成等待期间误触捕获其他推文导致回错帖
    const target = state.captured;
    try {
      const r = await send({ type: 'GENERATE', tweet: target, topic: topic || null });
      if (r && r.ok) {
        els.out.value = r.text;
        state.generatedFor = target;
        setStatus('已生成，可编辑后填入');
      } else {
        setStatus(
          (r && r.error) || '生成失败（扩展可能已更新，请刷新页面后重试）',
          true
        );
      }
    } finally {
      state.generating = false;
      els.genBtn.disabled = false;
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

  function insertInto(editor, text) {
    editor.focus();
    try {
      document.execCommand('selectAll', false, null);
    } catch (e) {
      /* 空编辑器无选区，忽略 */
    }
    // Draft.js 监听 input 事件，execCommand insertText 会触发完整的输入链路
    return document.execCommand('insertText', false, text);
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
    const text = els.out.value.trim();
    if (!text) {
      setStatus('还没有内容可填入', true);
      return;
    }
    // 结果绑定生成时的推文；纯手写内容（从未生成过）才用当前捕获
    const target = state.generatedFor || state.captured;
    if (target && target.href) {
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
      const ok = insertInto(editor, text);
      if (ok) {
        setStatus(
          target !== state.captured
            ? '✓ 已按生成时的推文（' + (target.author || '') + '）填入，检查后手动发送'
            : '✓ 已填入回复框，检查后手动点发送'
        );
      } else {
        setStatus('填入失败，内容已复制，请手动粘贴', true);
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
      const ok = insertInto(editor, text);
      if (ok) setStatus('✓ 已填入发帖框，检查后手动发送');
      else {
        setStatus('填入失败，内容已复制', true);
        copyText(text);
      }
    }
  }

  // ---------- 事件绑定 ----------

  els.update.addEventListener('click', () => {
    send({ type: 'OPEN_DOWNLOAD' });
  });

  els.genBtn.addEventListener('click', generate);

  els.panel.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'settings') {
      send({ type: 'OPEN_OPTIONS' });
    } else if (act === 'close') {
      els.panel.hidden = true;
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
    }
  });

  els.personaSel.addEventListener('change', () => {
    send({ type: 'SAVE_ACTIVE', personaId: els.personaSel.value });
  });
  els.genSel.addEventListener('change', () => {
    send({ type: 'SAVE_ACTIVE', genId: els.genSel.value });
  });

  // 设置在别处（设置页/弹窗）被改动时同步面板
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) refreshSettings();
  });

  // ---------- 初始化 ----------

  renderTweetBox();
  refreshSettings();
})();
