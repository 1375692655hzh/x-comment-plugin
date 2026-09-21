// 端到端冒烟测试：真实 Edge（有头）加载测试版扩展，验证核心链路
// 1. 启动本地假 X 页面服务  2. 跑断言  3. 输出 PASS/FAIL 并截图
// 运行：node tools/smoke/smoke.js   （需先 node tools/smoke/build-ext.js）
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

// playwright 解析：项目内 → npm 全局顶层 → 全局包的嵌套依赖
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  const gnm = path.join(process.env.APPDATA || '', 'npm', 'node_modules');
  const candidates = [path.join(gnm, 'playwright')];
  if (fs.existsSync(gnm)) {
    for (const pkg of fs.readdirSync(gnm)) {
      candidates.push(path.join(gnm, pkg, 'node_modules', 'playwright'));
    }
  }
  let loaded = false;
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'package.json'))) {
      ({ chromium } = require(c));
      loaded = true;
      break;
    }
  }
  if (!loaded) throw new Error('未找到 playwright，请先 npm i -g playwright 或安装到项目内');
}

const PORT = 8787;
const here = __dirname;
const results = [];
const t = (name, ok, extra) => {
  results.push((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra !== undefined ? '  — ' + extra : ''));
  if (!ok) process.exitCode = 1;
};

// ---------- 本地静态服务 + OAuth 模拟端点 ----------
const oauthState = { grant: false };
const mockLLM = { count: 0, lastBody: null, lastAuth: '', reply: null }; // 真实生成链路 mock：记录请求体供断言；reply 可注入自定义回复

const server = http.createServer((req, res) => {
  const send = (code, body, type) => {
    res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  if (req.method === 'POST' && req.url === '/oauth/device') {
    return send(200, {
      device_code: 'dev-smoke',
      user_code: 'SMOKE-CODE',
      verification_uri: 'http://localhost:8787/oauth/device',
      verification_uri_complete: 'http://localhost:8787/oauth/device?uc=SMOKE-CODE',
      expires_in: 120,
      interval: 1
    });
  }
  if (req.method === 'POST' && req.url === '/oauth/token') {
    return oauthState.grant
      ? send(200, { access_token: 'smoke-at', refresh_token: 'smoke-rt', expires_in: 3600 })
      : send(400, { error: 'authorization_pending' });
  }
  if (req.method === 'GET' && req.url === '/v1/models') {
    return send(200, {
      object: 'list',
      data: [{ id: 'grok-4.3' }, { id: 'grok-4.6-discovered' }, { id: 'grok-code-fast-1' }]
    });
  }
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      mockLLM.lastBody = raw;
      mockLLM.lastAuth = req.headers['authorization'] || '';
      mockLLM.count++;
      let model = '';
      try {
        model = JSON.parse(raw).model;
      } catch (e) {
        /* 忽略 */
      }
      if (model === 'missing-model') {
        return send(404, { error: { message: 'model not found: missing-model' } });
      }
      send(200, {
        id: 'chatcmpl-smoke',
        object: 'chat.completion',
        model,
        choices: [
          { index: 0, message: { role: 'assistant', content: mockLLM.reply || 'SMOKE-GEN 固定回复' }, finish_reason: 'stop' }
        ]
      });
    });
    return;
  }
  const file = req.url === '/' || req.url === '/page.html' ? 'page.html' : req.url.replace(/\//g, '');
  const p = path.join(here, file);
  if (fs.existsSync(p) && fs.statSync(p).isFile()) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(p));
  } else {
    res.writeHead(404);
    res.end('not found');
  }
});

(async () => {
  await new Promise((r) => server.listen(PORT, r));

  // 全新 profile：持久 profile 下 Chromium 会缓存扩展 SW 的编译字节码，
  // 同路径重建扩展后旧代码可能继续运行（版本号变更也未必失效）
  const profileDir = path.join(here, 'profile');
  fs.rmSync(profileDir, { recursive: true, force: true });

  const extPath = path.join(here, 'ext');
  const context = await chromium.launchPersistentContext(path.join(here, 'profile'), {
    channel: 'msedge',
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: [
      `--disable-extensions-except=${extPath}`,
      `--load-extension=${extPath}`,
      '--no-first-run',
      '--no-default-browser-check'
    ]
  });

  const errors = [];
  const page = context.pages()[0] || (await context.newPage());
  context.on('serviceworker', (w) => console.log('[SW registered]', w.url()));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console: ' + m.text());
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  try {
    await page.goto(`http://localhost:${PORT}/page.html`);
    await page.waitForTimeout(1500); // 等内容脚本初始化 + 后台设置往返

    // 诊断：SW 是否注册、扩展 ID 是否可取
    const swList = context.serviceWorkers().map((w) => w.url());
    console.log('[SW list]', swList.length ? swList : '(空)');
    const extId = await page.evaluate(() => (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) || null).catch(() => null);
    console.log('[extension id]', extId);

    // 每步独立 try/catch，失败记录后继续
    const step = async (name, fn) => {
      try {
        const extra = await fn();
        t(name, true, extra);
      } catch (e) {
        t(name, false, String(e.message || e).slice(0, 90));
      }
    };

    // 1. 悬浮球注入
    await step('悬浮球注入', async () => {
      if ((await page.locator('#xcc-host .xcc-launcher').count()) === 0) throw new Error('未找到 #xcc-host');
    });

    // 2. 悬停推文 → ✦ 捕获按钮出现
    let hoverVisible = false;
    await step('悬停推文出现 ✦ 捕获按钮', async () => {
      await page.locator('article[data-testid="tweet"]').first().hover();
      await page.waitForTimeout(300);
      hoverVisible = (await page.locator('.xcc-hover-btn').isVisible().catch(() => false));
      if (!hoverVisible) throw new Error('hover 按钮不可见');
    });

    // 3. 点捕获 → 面板打开
    if (hoverVisible) {
      await step('捕获后面板自动打开', async () => {
        await page.locator('.xcc-hover-btn').click();
        await page.waitForTimeout(500);
        if (!(await page.locator('.xcc-panel').isVisible().catch(() => false))) throw new Error('面板不可见');
      });
      await step('捕获内容含作者与推文文本', async () => {
        const tweetBd = await page.locator('.xcc-tweet-bd').innerText();
        if (!(tweetBd.includes('@alpha') && tweetBd.includes('Grok 4.5'))) throw new Error(JSON.stringify(tweetBd.slice(0, 50)));
        return tweetBd.slice(0, 40);
      });
      await step('后台消息链路(SW)正常', async () => {
        const provider = await page.locator('.xcc-provider').innerText();
        if (provider.includes('加载中') || provider.includes('连接后台失败')) throw new Error(provider);
        return provider;
      });
      await step('生成风格下拉有选项且可切换', async () => {
        const n = await page.locator('.xcc-gen option').count();
        if (!n) throw new Error('下拉无选项（后台设置未填充）');
        await page.locator('.xcc-gen').selectOption({ index: 1 });
        return n + ' 个选项';
      });
      await step('填入回复框（定位推文→开框→写入）', async () => {
        await page.locator('.xcc-out').fill('测试回复内容 smoke-test');
        await page.locator('.xcc-panel [data-act="insert"]').click();
        await page.waitForTimeout(1500);
        const modalText = await page.locator('#modal-editor').innerText();
        if (!modalText.includes('测试回复内容')) throw new Error(JSON.stringify(modalText));
        return modalText.slice(0, 20);
      });
      // 填入防重：编辑器已含同样内容时，二次点击直接跳过（不点回复按钮）
      await step('填入防重：已含内容时跳过重复填入', async () => {
        await page.locator('.xcc-out').fill('测试回复内容 smoke-test'); // 与首次填入相同
        await page.locator('.xcc-panel [data-act="insert"]').click();
        await page.waitForTimeout(900);
        const txt = await page.locator('#modal-editor').innerText();
        const n = txt.split('测试回复内容 smoke-test').length - 1;
        if (n !== 1) throw new Error('出现 ' + n + ' 份');
        const st = await page.locator('.xcc-status').innerText();
        if (!st.includes('未重复填入')) throw new Error('未走防重分支：' + st);
      });

      // 填入防双击：双击只产生一份
      await step('填入防双击竞态：只保留一份', async () => {
        await page.evaluate(() => {
          document.getElementById('modal').style.display = 'none';
          document.getElementById('modal-editor').textContent = '';
        });
        await page.locator('.xcc-out').fill('防抖测试 unique-dbl');
        await page.locator('.xcc-panel [data-act="insert"]').dblclick();
        await page.waitForTimeout(1500);
        const txt = await page.locator('#modal-editor').innerText();
        const n = txt.split('unique-dbl').length - 1;
        if (n !== 1) throw new Error('出现 ' + n + ' 份');
      });

      // v0.5.0 全高侧边栏形态（v0.5.1 起默认右侧）
      await step('面板为全高侧边栏：高≈视口、宽 380、默认贴右缘', async () => {
        const box = await page.evaluate(() => {
          const sr = document.querySelector('#xcc-host').shadowRoot;
          const p = sr.querySelector('.xcc-panel');
          const r = p.getBoundingClientRect();
          return { ph: p.offsetHeight, pw: p.offsetWidth, right: window.innerWidth - r.right, ih: window.innerHeight };
        });
        if (Math.abs(box.ph - box.ih) > 2) throw new Error(`面板高 ${box.ph} ≠ 视口 ${box.ih}`);
        if (Math.abs(box.pw - 380) > 2) throw new Error('面板宽异常: ' + box.pw);
        if (Math.abs(box.right) > 2) throw new Error('未贴右缘: 距右 ' + box.right);
        return box.pw + 'x' + box.ph;
      });
      await step('侧栏输出框显著加大（高度 > 300px）且推文框可伸缩', async () => {
        const box = await page.evaluate(() => {
          const sr = document.querySelector('#xcc-host').shadowRoot;
          return {
            oh: sr.querySelector('.xcc-out').getBoundingClientRect().height,
            th: sr.querySelector('.xcc-tweet-bd').getBoundingClientRect().height
          };
        });
        if (box.oh <= 300) throw new Error('输出框太小: ' + box.oh);
        if (box.th < 40) throw new Error('推文框异常: ' + box.th);
        return 'out=' + Math.round(box.oh) + 'px tweet=' + Math.round(box.th) + 'px';
      });
      await step('面板打开时悬浮球隐藏，✕ 关闭后恢复', async () => {
        if (!(await page.locator('.xcc-launcher').isHidden())) throw new Error('面板开着悬浮球未隐藏');
        await page.locator('.xcc-panel [data-act="close"]').click();
        if (await page.locator('.xcc-panel').isVisible()) throw new Error('✕ 未关闭面板');
        if (!(await page.locator('.xcc-launcher').isVisible())) throw new Error('关闭后悬浮球未恢复');
        await page.locator('.xcc-launcher').click(); // 重新打开，维持后续断言前提
        await page.waitForTimeout(300);
      });

      await page.screenshot({ path: path.join(here, 'panel.png') });
    }

    // 4. ⚙ 打开设置页（web_accessible_resources 修复验证）
    await step('⚙ 直开设置页（不再被拦截）', async () => {
      await page.locator('.xcc-panel [data-act="settings"]').click();
      await page.waitForTimeout(1800);
      const optsPage = context.pages().find((p) => p.url().includes('options/options.html'));
      if (!optsPage) throw new Error('未发现设置页标签');
      const ready = await optsPage.locator('.provider-item').count();
      if (ready < 3) throw new Error('设置页渲染异常');
      return optsPage.url().slice(-24);
    });

    // 5. SW 启动探针（硬断言）：const 重复声明崩溃的回归门禁
    await step('SW 脚本已执行（防 const 重复声明回归）', async () => {
      const optsPage = context.pages().find((p) => p.url().includes('options/options.html'));
      const boot = await optsPage.evaluate(
        () =>
          new Promise((res) =>
            chrome.storage.local.get(['swBoot', 'swMsg'], (r) => res(r.swBoot || r.swMsg || null))
          )
      );
      if (!boot) throw new Error('swBoot 缺失：SW 脚本未执行（疑似实例化崩溃）');
      return boot;
    });

    // 6. 生成按钮门控：未配置禁用 → 配置后联动解禁（storage.onChanged 链路）
    await step('未配置模型时生成按钮禁用', async () => {
      const optsPage = context.pages().find((p) => p.url().includes('options/options.html'));
      await optsPage.evaluate(async () => {
        const { settings } = await chrome.storage.local.get('settings');
        const m = xccMergeSettings(settings);
        m.provider = 'xai';
        m.xai.apiKey = '';
        await chrome.storage.local.set({ settings: m });
      });
      await page.bringToFront();
      await page.waitForTimeout(700);
      if (!(await page.locator('.xcc-gen-btn').isDisabled())) throw new Error('按钮未禁用');
    });
    await step('配置 Key 后生成按钮联动解禁', async () => {
      const optsPage = context.pages().find((p) => p.url().includes('options/options.html'));
      await optsPage.evaluate(async () => {
        const { settings } = await chrome.storage.local.get('settings');
        settings.xai.apiKey = 'xai-smoke-key';
        await chrome.storage.local.set({ settings });
      });
      await page.waitForTimeout(700);
      if (await page.locator('.xcc-gen-btn').isDisabled()) throw new Error('按钮未解禁');
    });

    // 6.5 真实生成链路端到端：content → SW → xccChatCompletion → 本地 mock
    await step('真实生成端到端：mock 回填输出框，system=人设、含推文、默认不发 reasoning_effort', async () => {
      const optsPage = context.pages().find((p) => p.url().includes('options/options.html'));
      await optsPage.evaluate(async () => {
        const { settings } = await chrome.storage.local.get('settings');
        const m = xccMergeSettings(settings);
        m.provider = 'custom';
        m.custom = { baseUrl: 'http://localhost:8787/v1', apiKey: 'smoke-key', model: 'smoke-model' };
        m.genParams = { ...m.genParams, reasoningEffort: 'default' };
        await chrome.storage.local.set({ settings: m });
      });
      await page.bringToFront();
      // 前面的插入测试打开了全屏模拟弹窗，会挡住推文的可操作性检查：先收起
      await page.evaluate(() => {
        document.getElementById('modal').style.display = 'none';
      });
      // 重新捕获确保上下文就绪，并等按钮解禁（storage.onChanged → syncGenBtn）
      await page.locator('article[data-testid="tweet"]').first().hover();
      await page.waitForTimeout(300);
      await page.locator('.xcc-hover-btn').click();
      await page.waitForTimeout(500);
      if (await page.locator('.xcc-gen-btn').isDisabled()) throw new Error('生成按钮未解禁');
      await page.locator('.xcc-gen-btn').click();
      await page.waitForFunction(() => {
        const host = document.querySelector('#xcc-host');
        const out = host && host.shadowRoot && host.shadowRoot.querySelector('.xcc-out');
        return !!(out && out.value.includes('SMOKE-GEN'));
      }, null, { timeout: 20000 });
      const st = await page.locator('.xcc-status').innerText();
      if (!st.includes('已生成')) throw new Error('状态栏异常: ' + st.slice(0, 60));
      const body = JSON.parse(mockLLM.lastBody || '{}');
      if (body.model !== 'smoke-model') throw new Error('模型不符: ' + body.model);
      if (!Array.isArray(body.messages) || body.messages[0].role !== 'system') throw new Error('messages[0] 非 system');
      if (!String(body.messages[0].content).includes('资深网友')) throw new Error('system 未携带人设');
      if (!body.messages.some((x) => String(x.content || '').includes('Grok 4.5 的上下文长度'))) throw new Error('user 未含推文文本');
      if ('reasoning_effort' in body) throw new Error('默认档不应发送 reasoning_effort');
      if (mockLLM.lastAuth !== 'Bearer smoke-key') throw new Error('鉴权头未透传: ' + mockLLM.lastAuth);
      return body.messages.length + ' 条 messages';
    });

    await step('真实生成端到端：reasoning_effort=high 注入请求体', async () => {
      const optsPage = context.pages().find((p) => p.url().includes('options/options.html'));
      await optsPage.evaluate(async () => {
        const { settings } = await chrome.storage.local.get('settings');
        settings.genParams.reasoningEffort = 'high';
        await chrome.storage.local.set({ settings });
      });
      // 写后读回校验：确认落盘的是 high
      const rb = await optsPage.evaluate(async () => {
        const { settings } = await chrome.storage.local.get('settings');
        return settings.genParams && settings.genParams.reasoningEffort;
      });
      if (rb !== 'high') throw new Error('写回校验失败: ' + JSON.stringify(rb));
      const before = mockLLM.count;
      await page.bringToFront();
      if (!(await page.locator('.xcc-panel').isVisible().catch(() => false))) {
        await page.locator('.xcc-launcher').click();
      }
      await page.locator('.xcc-panel [data-act="regen"]').click();
      const t0 = Date.now();
      while (Date.now() - t0 < 15000 && mockLLM.count < before + 1) {
        await new Promise((r) => setTimeout(r, 200));
      }
      if (mockLLM.count < before + 1) throw new Error('第二次请求未到达');
      const body = JSON.parse(mockLLM.lastBody || '{}');
      if (body.reasoning_effort !== 'high') {
        throw new Error(
          'reasoning_effort 未注入: ' + JSON.stringify(body.reasoning_effort) +
          ' | 完整请求体 keys: ' + Object.keys(body).join(',') +
          ' | genParams=' + JSON.stringify(body.messages && body.messages.length)
        );
      }
    });

    await step('清洗：剥 markdown/前言后语且保留 #hashtag，system 含格式硬约束', async () => {
      mockLLM.reply =
        '好的！以下是为你生成的评论：\n\n**面板输出已清洗测试**\n#评论副驾 的价值在格式。\n' +
        '## 二级标题应被剥\n- 列表项一\n• 列表项二\n`代码片段`\n\n希望这条评论对你有所帮助。';
      const before = mockLLM.count;
      await page.bringToFront();
      if (!(await page.locator('.xcc-panel').isVisible().catch(() => false))) {
        await page.locator('.xcc-launcher').click();
      }
      await page.locator('.xcc-panel [data-act="regen"]').click();
      await page.waitForFunction(() => {
        const out = document.querySelector('#xcc-host').shadowRoot.querySelector('.xcc-out');
        return !!(out && out.value.includes('已清洗') && !out.value.includes('好的'));
      }, null, { timeout: 20000 });
      const v = await page.locator('.xcc-out').inputValue();
      if (v.includes('**') || v.includes('`') || v.includes('## ') || v.includes('\n- ')
        || v.includes('• ') || v.includes('好的') || v.includes('希望')) {
        throw new Error('清洗不全: ' + v.slice(0, 80));
      }
      if (!v.includes('#评论副驾')) throw new Error('误杀 hashtag: ' + v.slice(0, 80));
      const body = JSON.parse(mockLLM.lastBody || '{}');
      if (!String(body.messages[0].content).includes('直接输出评论正文')) throw new Error('system 未含格式硬约束');
      mockLLM.reply = null; // 复位，避免污染后续
      return v.split('\n')[0].slice(0, 30);
    });

    await step('免费模式：system 注入 280 硬约束，计数器 n/280 超限标红', async () => {
      mockLLM.reply = null; // 前一步若失败可能未复位
      const before = mockLLM.count;
      await page.locator('.xcc-panel [data-act="regen"]').click();
      const t0 = Date.now();
      while (Date.now() - t0 < 15000 && mockLLM.count < before + 1) {
        await new Promise((r) => setTimeout(r, 200));
      }
      if (mockLLM.count < before + 1) throw new Error('请求未到达');
      const body = JSON.parse(mockLLM.lastBody || '{}');
      if (!body.messages.some((m) => /280\s*个?\s*字符/.test(String(m.content)))) {
        throw new Error('免费模式未注入 280 硬约束');
      }
      const cnt = await page.locator('.xcc-count').innerText();
      if (!/^\d+\/280$/.test(cnt)) throw new Error('计数器格式异常: ' + cnt);
      await page.locator('.xcc-out').fill('a'.repeat(300));
      await page.locator('.xcc-out').dispatchEvent('input');
      const over = await page.locator('.xcc-count').evaluate((el) => el.classList.contains('over'));
      if (!over) throw new Error('超 280 未标红');
      if ((await page.locator('.xcc-target-len').isVisible())) throw new Error('免费模式不应显示目标字数');
      return cnt;
    });

    await step('面板切换付费模式：目标字数输入出现并即时落盘', async () => {
      await page.locator('.xcc-panel [data-act="plan-premium"]').click();
      await page.waitForTimeout(600); // mutateSettings → storage.onChanged → refreshSettings
      if (!(await page.locator('.xcc-target-len').isVisible())) throw new Error('付费目标字数输入未显示');
      await page.locator('.xcc-target-len').fill('120');
      await page.locator('.xcc-target-len').dispatchEvent('change');
      await page.waitForTimeout(600);
      // storage 读取走扩展页（普通网页主世界无 chrome.storage）
      const optsPage = context.pages().find((p) => p.url().includes('options/options.html'));
      const saved = await optsPage.evaluate(async () => {
        const { settings } = await chrome.storage.local.get('settings');
        return settings.genParams.xPlan + '/' + settings.genParams.targetLength;
      });
      if (saved !== 'premium/120') throw new Error('未落盘: ' + saved);
      const cnt = await page.locator('.xcc-count').innerText();
      if (!/^\d+\s*字$/.test(cnt)) throw new Error('付费计数格式异常: ' + cnt);
      return saved;
    });

    await step('付费模式：注入"目标约 120 字"且 280 约束消失；留空则无长度指令', async () => {
      const before = mockLLM.count;
      await page.locator('.xcc-panel [data-act="regen"]').click();
      let t0 = Date.now();
      while (Date.now() - t0 < 15000 && mockLLM.count < before + 1) {
        await new Promise((r) => setTimeout(r, 200));
      }
      let all = JSON.parse(mockLLM.lastBody || '{}').messages.map((m) => String(m.content)).join('\n');
      if (!all.includes('目标约 120 字')) throw new Error('目标字数未注入');
      if (/280\s*个?\s*字符/.test(all)) throw new Error('付费模式仍带 280 硬约束');

      // 留空 → 无长度指令
      await page.locator('.xcc-target-len').fill('');
      await page.locator('.xcc-target-len').dispatchEvent('change');
      await page.waitForTimeout(500);
      const before2 = mockLLM.count;
      await page.locator('.xcc-panel [data-act="regen"]').click();
      t0 = Date.now();
      while (Date.now() - t0 < 15000 && mockLLM.count < before2 + 1) {
        await new Promise((r) => setTimeout(r, 200));
      }
      all = JSON.parse(mockLLM.lastBody || '{}').messages.map((m) => String(m.content)).join('\n');
      if (all.includes('目标约')) throw new Error('留空仍注入了目标字数');
      if (/280\s*个?\s*字符/.test(all)) throw new Error('留空错误回落到 280 约束');
      // 收尾切回免费，避免污染后续步骤
      await page.locator('.xcc-panel [data-act="plan-free"]').click();
      await page.waitForTimeout(500);
    });

    await step('生成失败链路：4xx 原文透出并追加换模型提示', async () => {
      const optsPage = context.pages().find((p) => p.url().includes('options/options.html'));
      await optsPage.evaluate(async () => {
        const { settings } = await chrome.storage.local.get('settings');
        settings.provider = 'custom';
        settings.custom.model = 'missing-model';
        settings.genParams.reasoningEffort = 'default';
        await chrome.storage.local.set({ settings });
      });
      await page.bringToFront();
      await page.waitForTimeout(700);
      if (await page.locator('.xcc-gen-btn').isDisabled()) throw new Error('按钮被误禁用');
      await page.locator('.xcc-gen-btn').click();
      await page.waitForFunction(() => {
        const host = document.querySelector('#xcc-host');
        const st = host && host.shadowRoot && host.shadowRoot.querySelector('.xcc-status');
        return !!(st && st.classList.contains('err') && st.textContent.includes('API 404'));
      }, null, { timeout: 20000 });
      const st = await page.locator('.xcc-status').innerText();
      if (!st.includes('已验证')) throw new Error('未追加换模型提示: ' + st.slice(0, 80));
      // 收尾恢复，避免污染后续步骤
      await optsPage.evaluate(async () => {
        const { settings } = await chrome.storage.local.get('settings');
        settings.provider = 'xai';
        settings.custom = { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini' };
        await chrome.storage.local.set({ settings });
      });
      await page.waitForTimeout(500);
    });

    // 7. 更新横幅免疫：伪造 hasUpdate=true 但版本相同 → 必须隐藏
    await step('横幅不信旧结论（等版本+hasUpdate=true 仍隐藏）', async () => {
      const optsPage = context.pages().find((p) => p.url().includes('options/options.html'));
      await optsPage.evaluate(async () => {
        await chrome.storage.local.set({
          xccUpdate: { latest: chrome.runtime.getManifest().version, hasUpdate: true, checkedAt: Date.now() }
        });
      });
      await optsPage.reload();
      await optsPage.waitForTimeout(900);
      const visible = await optsPage.locator('#update-banner').isVisible();
      if (visible) {
        const txt = await optsPage.locator('#update-banner').innerText().catch(() => '');
        const stored = await optsPage.evaluate(async () => {
          const { xccUpdate } = await chrome.storage.local.get('xccUpdate');
          return JSON.stringify(xccUpdate) + ' | installed=' + chrome.runtime.getManifest().version;
        });
        throw new Error('横幅误报：' + txt.slice(0, 60) + ' || ' + stored);
      }
    });

    // 8. OAuth 设备流全流程（本页直连，全程零 SW 消息）
    await step('OAuth 设备流：发起授权显示验证码（无 SW）', async () => {
      const optsPage = context.pages().find((p) => p.url().includes('options/options.html'));
      await optsPage.evaluate(async () => {
        const { settings } = await chrome.storage.local.get('settings');
        const m = xccMergeSettings(settings);
        m.provider = 'grok-oauth';
        m.grokOAuth.deviceEndpoint = 'http://localhost:8787/oauth/device';
        m.grokOAuth.tokenEndpoint = 'http://localhost:8787/oauth/token';
        await chrome.storage.local.set({ settings: m });
      });
      await optsPage.reload();
      await optsPage.waitForTimeout(900);
      if (!(await optsPage.locator('#pane-oauth').isVisible())) throw new Error('oauth 面板未显示');
      await optsPage.locator('#oauth-start').click();
      await optsPage.waitForTimeout(1500);
      const code = await optsPage.locator('#oauth-code').innerText();
      if (!code.includes('SMOKE-CODE')) throw new Error('验证码错误：' + code);
    });
    // OAuth 轮询持久化：pending 期间 reload 后自动恢复（问题3 场景）
    await step('OAuth 轮询跨 reload 自动恢复', async () => {
      const optsPage = context.pages().find((p) => p.url().includes('options/options.html'));
      await optsPage.reload(); // 模拟误刷/孤儿自愈杀掉轮询
      await optsPage.waitForTimeout(1000);
      const code = await optsPage.locator('#oauth-code').innerText();
      if (!code.includes('SMOKE-CODE')) throw new Error('验证码未恢复: ' + code);
      const st = await optsPage.locator('#oauth-status').innerText();
      if (!st.includes('已恢复')) throw new Error('未显示恢复状态: ' + st);
    });
    await step('OAuth 设备流：授权成功并持久化 token', async () => {
      const optsPage = context.pages().find((p) => p.url().includes('options/options.html'));
      oauthState.grant = true; // 模拟用户在授权页点了允许
      await optsPage.waitForFunction(
        () => document.getElementById('oauth-status').textContent.includes('授权成功'),
        null,
        { timeout: 15000 }
      );
      const at = await optsPage.evaluate(async () => {
        const { settings } = await chrome.storage.local.get('settings');
        return settings.grokOAuth.tokens && settings.grokOAuth.tokens.access_token;
      });
      if (at !== 'smoke-at') throw new Error('token 未持久化: ' + at);
      const pend = await optsPage.evaluate(
        async () => (await chrome.storage.local.get('xccOauthPending')).xccOauthPending
      );
      if (pend) throw new Error('成功后 pending 未清除');
    });
    await step('模型目录发现：授权后自动填充 select', async () => {
      const optsPage = context.pages().find((p) => p.url().includes('options/options.html'));
      await optsPage.evaluate(async () => {
        const { settings } = await chrome.storage.local.get('settings');
        settings.grokOAuth.apiBase = 'http://localhost:8787/v1';
        await chrome.storage.local.set({ settings });
      });
      await optsPage.reload();
      await optsPage.waitForFunction(
        () => [...document.querySelectorAll('#oauth-model option')].some((o) => o.value === 'grok-4.6-discovered'),
        null,
        { timeout: 15000 }
      );
      const txt = await optsPage.locator('#oauth-models-discovery').innerText();
      if (!txt.includes('3')) throw new Error('发现数异常: ' + txt);
      const n = await optsPage.locator('#oauth-model option').count();
      if (n < 7) throw new Error('发现+兜底合并异常: ' + n); // 3 发现 ∪ 5 兜底（重叠2）+ 当前值 + 自定义项
    });
    // 模型选择即时落盘（v0.4.1 问题回归门禁：改模型不再依赖「开始授权」）
    await step('模型选择变更即时落盘，reload 后保持', async () => {
      const optsPage = context.pages().find((p) => p.url().includes('options/options.html'));
      await optsPage.locator('#oauth-model').selectOption('grok-4.6-discovered');
      await optsPage.waitForTimeout(700); // change → saveMutate → storage
      const saved = await optsPage.evaluate(async () => {
        const { settings } = await chrome.storage.local.get('settings');
        return settings.grokOAuth.model;
      });
      if (saved !== 'grok-4.6-discovered') throw new Error('未落盘: ' + saved);
      await optsPage.reload(); // 模拟关页重开
      await optsPage.waitForFunction(
        () => document.getElementById('oauth-model').value === 'grok-4.6-discovered',
        null,
        { timeout: 15000 }
      );
    });
    await step('自定义模型 ID 输入生效并落盘', async () => {
      const optsPage = context.pages().find((p) => p.url().includes('options/options.html'));
      await optsPage.locator('#oauth-model').selectOption('__custom__');
      const custom = optsPage.locator('#oauth-model-custom');
      await custom.waitFor({ state: 'visible' });
      await custom.fill('grok-smoke-custom-id');
      await custom.dispatchEvent('change');
      await optsPage.waitForTimeout(700);
      const saved = await optsPage.evaluate(async () => {
        const { settings } = await chrome.storage.local.get('settings');
        return settings.grokOAuth.model;
      });
      if (saved !== 'grok-smoke-custom-id') throw new Error('未落盘: ' + saved);
      // 收尾：选回默认模型
      await optsPage.locator('#oauth-model').selectOption('grok-4.3');
      await optsPage.waitForTimeout(600);
      const back = await optsPage.evaluate(async () => {
        const { settings } = await chrome.storage.local.get('settings');
        return settings.grokOAuth.model;
      });
      if (back !== 'grok-4.3') throw new Error('收尾回选失败: ' + back);
    });
    await step('OAuth 登出清除 token', async () => {
      const optsPage = context.pages().find((p) => p.url().includes('options/options.html'));
      await optsPage.locator('#oauth-logout').click();
      await optsPage.waitForTimeout(800);
      const t = await optsPage.evaluate(async () => {
        const { settings } = await chrome.storage.local.get('settings');
        return settings.grokOAuth.tokens;
      });
      if (t) throw new Error('token 未清除');
      const pend = await optsPage.evaluate(
        async () => (await chrome.storage.local.get('xccOauthPending')).xccOauthPending
      );
      if (pend) throw new Error('登出后 pending 未清除');
      // 收尾：恢复 xai + 真实 apiBase 供下次运行
      await optsPage.evaluate(async () => {
        const { settings } = await chrome.storage.local.get('settings');
        settings.provider = 'xai';
        settings.grokOAuth.apiBase = 'https://cli-chat-proxy.grok.com/v1';
        await chrome.storage.local.set({ settings });
      });
      oauthState.grant = false;
    });

    // v0.5.0 面板左右切换（storage.onChanged → applySettings → .left 类）；v0.5.1 默认右侧
    await step('面板位置切换：panelSide=left 贴左缘，恢复 right 贴右缘', async () => {
      const optsPage = context.pages().find((p) => p.url().includes('options/options.html'));
      await optsPage.evaluate(async () => {
        const { settings } = await chrome.storage.local.get('settings');
        settings.panelSide = 'left';
        await chrome.storage.local.set({ settings });
      });
      await page.bringToFront();
      await page.waitForTimeout(700);
      let r = await page.evaluate(() => {
        const p = document.querySelector('#xcc-host').shadowRoot.querySelector('.xcc-panel');
        const b = p.getBoundingClientRect();
        return { x: b.x, right: window.innerWidth - b.right };
      });
      if (Math.abs(r.x) > 2 || r.right < 100) throw new Error('未贴左缘: ' + JSON.stringify(r));
      await optsPage.evaluate(async () => {
        const { settings } = await chrome.storage.local.get('settings');
        settings.panelSide = 'right';
        await chrome.storage.local.set({ settings });
      });
      await page.waitForTimeout(700);
      r = await page.evaluate(() => {
        const p = document.querySelector('#xcc-host').shadowRoot.querySelector('.xcc-panel');
        return { right: window.innerWidth - p.getBoundingClientRect().right };
      });
      if (Math.abs(r.right) > 2) throw new Error('未恢复右缘: 距右 ' + r.right);
    });

    // 健康页免疫：切标签/事件触发绝不自愈（问题1 回归门禁）
    await step('健康设置页免疫 focus/visibilitychange', async () => {
      const optsPage = context.pages().find((p) => p.url().includes('options/options.html'));
      await optsPage.evaluate(() => {
        window.__alive = 1;
        window.dispatchEvent(new Event('focus'));
        document.dispatchEvent(new Event('visibilitychange'));
        window.dispatchEvent(new Event('focus'));
      });
      await page.bringToFront(); // 真实切走再切回
      await optsPage.bringToFront();
      await optsPage.waitForTimeout(700);
      const r = await optsPage.evaluate(() => ({
        alive: window.__alive === 1,
        flag: sessionStorage.getItem('xccHealTried'),
        dead: document.body.textContent.includes('无法自动恢复')
      }));
      if (!r.alive) throw new Error('健康页被误 reload');
      if (r.flag) throw new Error('健康页写入了自愈标记');
      if (r.dead) throw new Error('出现误报死页文案');
    });

    // 真孤儿自愈恰好一次（放最后：会 reload 设置页）
    await step('强制判死恰好自愈一次，成功后额度重置', async () => {
      const optsPage = context.pages().find((p) => p.url().includes('options/options.html'));
      await optsPage.evaluate(() => healOrphanPage(true)); // 第一次：set 标记 + reload
      await optsPage.waitForLoadState('load');
      await optsPage.waitForTimeout(900);
      if ((await optsPage.locator('.provider-item').count()) < 3) throw new Error('首次自愈后 UI 异常');
      const flag = await optsPage.evaluate(() => sessionStorage.getItem('xccHealTried'));
      if (flag) throw new Error('自愈成功后标记未清除'); // v0.4.0 在此失败
      await optsPage.evaluate(() => healOrphanPage(true)); // 第二次：应再次自愈而非死页
      await optsPage.waitForLoadState('load');
      await optsPage.waitForTimeout(900);
      if ((await optsPage.locator('.provider-item').count()) < 3) throw new Error('第二次自愈失败');
      if ((await optsPage.title()).includes('页面已失效')) throw new Error('误入第二阶段');
    });

    // 汇总
    console.log('\n===== 冒烟测试结果 =====');
    results.forEach((r) => console.log(r));
    console.log('===== 页面错误（应为空）=====');
    console.log(errors.length ? errors.join('\n') : '(无)');
  } finally {
    console.log('\n===== 结果（finally 兜底输出）=====');
    results.forEach((r) => console.log(r));
    await context.close();
    server.close();
  }
})().catch((e) => {
  console.error('SMOKE ERROR:', e);
  process.exitCode = 1;
  server.close();
});
