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
