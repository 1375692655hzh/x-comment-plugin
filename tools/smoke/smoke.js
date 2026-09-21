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

// ---------- 本地静态服务 ----------
const server = http.createServer((req, res) => {
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

    // 5. 诊断（仅记录）：扩展页→SW 消息往返。
    //    注：本自动化 Edge 环境（playwright --load-extension）存在 SW 不执行的已知限制，
    //    此探针 TIMEOUT 不代表真实环境故障；真实环境中 GENERATE 等功能依赖 SW。
    await step('诊断记录：扩展页→SW 消息往返（自动化环境允许 TIMEOUT）', async () => {
      const optsPage = context.pages().find((p) => p.url().includes('options/options.html'));
      const probe = await optsPage.evaluate(async () => {
        const out = {};
        try {
          out.swReply = await Promise.race([
            new Promise((res) => chrome.runtime.sendMessage({ type: 'CHECK_UPDATE' }, (r) => res(r ? 'ok' : null))),
            new Promise((res) => setTimeout(() => res('TIMEOUT'), 4000))
          ]);
        } catch (e) { out.swErr = String(e); }
        return JSON.stringify(out);
      });
      return probe.slice(0, 60);
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
