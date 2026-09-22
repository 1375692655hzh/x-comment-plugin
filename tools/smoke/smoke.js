// 端到端冒烟测试：真实 Edge（有头）加载测试版扩展，验证核心链路
// 1. 启动本地假 X 页面服务  2. 跑断言  3. 输出 PASS/FAIL 并截图
// 运行：node tools/smoke/smoke.js   （需先 node tools/smoke/build-ext.js）
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

// ---- 可观测性（v0.5.3）：所有输出同步落盘 progress.log（绕过 stdout 管道缓冲/无读端挂起），
// 供 schtasks/后台等无终端环境轮询进度；stdout 同时照常输出 ----
const _progPath = path.join(__dirname, 'progress.log');
try { fs.unlinkSync(_progPath); } catch (e) { /* 首次无文件 */ }
console.log = function () {
  const s = Array.from(arguments)
    .map((x) => (typeof x === 'string' ? x : require('util').inspect(x, { depth: 4 })))
    .join(' ');
  try { fs.appendFileSync(_progPath, s + '\n'); } catch (e) { /* 忽略 */ }
};
setInterval(() => {
  try { fs.appendFileSync(_progPath, '[hb ' + new Date().toISOString() + ']\n'); } catch (e) { /* 忽略 */ }
}, 5000).unref();
console.log('[boot] smoke starting, node ' + process.version);

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
  const line = (ok ? 'PASS' : 'FAIL') + '  ' + name + (extra !== undefined ? '  — ' + extra : '');
  results.push(line);
  console.log(line); // 实时落盘 progress.log（console.log 已包装为 appendFileSync）
  if (!ok) process.exitCode = 1;
};

// ---------- 本地静态服务 + OAuth 模拟端点 ----------
const oauthState = { grant: false };
// 真实生成链路 mock：记录请求体供断言；reply 可注入自定义回复；
// emptyLength='once' 模拟"推理模型思考耗尽"一次（finish_reason=length+空 content+reasoning_content），'always' 持续耗尽
const mockLLM = { count: 0, lastBody: null, lastAuth: '', reply: null, humReply: null, emptyLength: null, emptyLengthHit: 0 };

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
      let sysTxt = '';
      try {
        const parsed = JSON.parse(raw);
        model = parsed.model;
        sysTxt = parsed.messages && parsed.messages[0] ? String(parsed.messages[0].content) : '';
      } catch (e) {
        /* 忽略 */
      }
      if (model === 'missing-model') {
        return send(404, { error: { message: 'model not found: missing-model' } });
      }
      // 去AI味二段"人味改写"请求：返回可识别的改写结果（供输出框断言）
      if (sysTxt.includes('人味改写器')) {
        return send(200, {
          id: 'chatcmpl-smoke-hum',
          object: 'chat.completion',
          model,
          choices: [
            { index: 0, message: { role: 'assistant', content: mockLLM.humReply || 'SMOKE-HUMANIZED 人味改写结果' }, finish_reason: 'stop' }
          ]
        });
      }
      if (mockLLM.emptyLength && (mockLLM.emptyLength === 'always' || mockLLM.emptyLengthHit < 1)) {
        // 推理模型思考耗尽形态：思考占满 max_tokens，正文为空
        mockLLM.emptyLengthHit++;
        return send(200, {
          id: 'chatcmpl-smoke-len',
          model,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: '', reasoning_content: '（模拟思考）我们要写一条不超过 280 字符的回复…' },
              finish_reason: 'length'
            }
          ]
        });
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
  // ⚠ 必须 headful：Edge channel 的 headless 不注入 content_scripts（v0.5.3 实测
  // #xcc-host 不存在），扩展冒烟只能真窗口跑。
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
      console.log('[start] ' + name);
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
      await step('预设收敛（v0.5.11）：人设仅自然网友，生成风格五件套', async () => {
        const personas = await page.locator('.xcc-persona option').allInnerTexts();
        if (personas.length !== 1 || !personas[0].includes('自然网友')) {
          throw new Error('人设预设异常: ' + JSON.stringify(personas));
        }
        const gens = (await page.locator('.xcc-gen option').allInnerTexts()).map((t) => t.trim());
        if (gens.length !== 5) throw new Error('生成风格应 5 个: ' + JSON.stringify(gens));
        for (const want of ['认同', '犀利提问', '幽默玩梗', '省流党', '深度分析']) {
          if (!gens.some((n) => n.includes(want))) {
            throw new Error('缺风格预设 ' + want + ': ' + JSON.stringify(gens));
          }
        }
        return gens.join('、');
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

      // 填入防双击：双击只产生一份（v0.5.3 起编辑器是框架 mock，重置必须走 state 通道）
      await step('填入防双击竞态：只保留一份', async () => {
        await page.evaluate(() => {
          document.getElementById('modal').style.display = 'none';
          window.__fw.reset();
        });
        await page.locator('.xcc-out').fill('防抖测试 unique-dbl');
        await page.locator('.xcc-panel [data-act="insert"]').dblclick();
        await page.waitForTimeout(1500);
        const txt = await page.locator('#modal-editor').innerText();
        const n = txt.split('unique-dbl').length - 1;
        if (n !== 1) throw new Error('出现 ' + n + ' 份');
      });

      // 框架编辑器：填入必须走框架路径（state 与 DOM 一致、可继续编辑）
      // v0.5.5：弹层回复框已打开且正对目标推文 → 直接填入，不点 reply 开新框
      await step('弹层回复框已开时直接填入（不点 reply，背景发帖框不误写）', async () => {
        await page.evaluate(() => {
          document.getElementById('modal').style.display = 'block';
          document.getElementById('composer').textContent = '';
          window.__fw.reset();
        });
        await page.locator('.xcc-out').fill('弹层直填 dlg-direct');
        await page.locator('.xcc-panel [data-act="insert"]').click();
        // 等真实结果落进 mock state（等状态栏文案会被上一断言遗留的"已填入弹出的
        // 回复框"假命中——v0.5.5 起 reply 流程开的框也叫弹出的回复框）
        await page.waitForFunction(() => window.__fw.text() === '弹层直填 dlg-direct', null, {
          timeout: 8000
        });
        // 围栏：insertResult 的 finally 才解禁按钮 = 本次插入彻底收尾（含恢复链尾部 sleep）
        await page.waitForFunction(() => {
          const b = document.querySelector('#xcc-host').shadowRoot.querySelector('.xcc-row [data-act="insert"]');
          return !!(b && !b.disabled);
        }, null, { timeout: 8000 });
        const stTxt = await page.locator('.xcc-status').innerText();
        if (!stTxt.includes('弹出')) throw new Error('状态栏未标明弹层: ' + stTxt);
        const composer = await page.locator('#composer').innerText();
        if (composer.includes('dlg-direct')) throw new Error('误写背景发帖框');
        await page.evaluate(() => {
          document.getElementById('modal').style.display = 'none';
        });
        return 'ok';
      });

      await step('框架编辑器：填入走框架路径（state 与 DOM 一致，不退化不纠正）', async () => {
        await page.evaluate(() => {
          document.getElementById('modal').style.display = 'none';
          window.__fw.reset();
        });
        await page.locator('.xcc-out').fill('框架路径回复 fw-insert');
        await page.locator('.xcc-panel [data-act="insert"]').click();
        // 围栏：等 insertResult 彻底收尾（applied>0 命中太早——insertInto 恢复链的
        // 尾部校验/清场还在跑，期间读 state 会拿到中间态）
        await page.waitForFunction(() => {
          const b = document.querySelector('#xcc-host').shadowRoot.querySelector('.xcc-row [data-act="insert"]');
          return !!(b && !b.disabled);
        }, null, { timeout: 8000 });
        const st = await page.evaluate(() => ({
          text: window.__fw.text(),
          stats: window.__fw.stats,
          dom: document.getElementById('modal-editor').innerText,
          status: document.querySelector('#xcc-host').shadowRoot.querySelector('.xcc-status').textContent
        }));
        if (st.text !== '框架路径回复 fw-insert') {
          throw new Error('框架 state 未获得文本: ' + JSON.stringify(st.text)); // innerText 校验看不见的盲区
        }
        if (!st.dom.includes('fw-insert')) throw new Error('DOM 未渲染');
        if (st.stats.dropped > 0) throw new Error('存在悬空选区丢弃: ' + JSON.stringify(st.stats));
        if (st.stats.paste > 0) throw new Error('退化了 paste 兜底');
        if (st.status.includes('自动纠正')) throw new Error('走了异常恢复路径');
        return 'applied=' + st.stats.applied;
      });

      await step('框架编辑器：填入后打字/退格仍生效（死键回归门禁）', async () => {
        await page.locator('#modal-editor').click();
        const before = await page.evaluate(() => window.__fw.text());
        await page.keyboard.type('X');
        await page.waitForTimeout(300);
        const typed = await page.evaluate(() => window.__fw.text());
        if (!(typed.length === before.length + 1 && typed.includes('X'))) {
          throw new Error('打字未进 state: ' + JSON.stringify({ before: before.length, typed: typed.length }));
        }
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(300);
        const after = await page.evaluate(() => window.__fw.text());
        if (after.length !== before.length) throw new Error('退格未生效');
        if (!(await page.evaluate(() => window.__fw.canSend()))) throw new Error('state 探针 canSend=false');
      });

      await step('框架编辑器：未经 beforeinput 的 DOM 直插被 reconcile 擦除（mock 有效性）', async () => {
        // 直接 DOM 写入（不派发任何输入事件），周期 reconcile 必须把它擦掉——
        // 这才是"execCommand 幽灵"的真实形态：DOM 有字、state 没有。
        // ⚠ 先显示 modal：mock 的 reconcile 对 offsetParent===null 的编辑器跳过
        await page.evaluate(() => {
          document.getElementById('modal').style.display = 'block';
          const root = document.getElementById('modal-editor');
          root.querySelector('p').appendChild(document.createTextNode('ghost-fragment'));
        });
        const survived = await page.waitForFunction(() => {
          const live = document.querySelector('#modal-editor span[data-lexical-text="true"]');
          return live && live.textContent.indexOf('ghost') === -1 && window.__fw.stats.rerender >= 1;
        }, null, { timeout: 8000 }).then(() => false).catch(() => true);
        if (survived) throw new Error('mock 未擦除幽灵直插');
        const text = await page.evaluate(() => window.__fw.text());
        if (text.includes('ghost')) throw new Error('幽灵文本渗入 state');
        await page.evaluate(() => {
          document.getElementById('modal').style.display = 'none';
          window.__fw.reset();
        });
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
      await step('侧栏输出框显著加大（900px 视口下 >260px，推文框可伸缩）', async () => {
        const box = await page.evaluate(() => {
          const sr = document.querySelector('#xcc-host').shadowRoot;
          return {
            oh: sr.querySelector('.xcc-out').getBoundingClientRect().height,
            th: sr.querySelector('.xcc-tweet-bd').getBoundingClientRect().height
          };
        });
        // 900px 冒烟视口基准（v0.5.3 加模型下拉+倾向行后约 280px）；真实用户视口普遍 ≥950，输出框更大
        if (box.oh < 260) throw new Error('输出框太小: ' + box.oh);
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
      // 全局自动接受 confirm：删除模型等确认框一旦无人处理，页面所有后续操作会被
      // Playwright 永久挂起（v0.5.3 实测卡死根因）。测试内 confirm 全部意图为"允许"。
      optsPage.on('dialog', (d) => {
        d.accept().catch(() => {});
      });
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

    // v0.5.3 面板顶部模型下拉（provider 行之下、人设之上）
    await step('面板顶部模型下拉：列出 custom models 且当前值选中', async () => {
      const optsPage = context.pages().find((p) => p.url().includes('options/options.html'));
      await optsPage.evaluate(async () => {
        const { settings } = await chrome.storage.local.get('settings');
        const m = xccMergeSettings(settings);
        m.provider = 'custom';
        m.custom = { baseUrl: 'http://localhost:8787/v1', apiKey: 'smoke-key', model: 'm-a', models: ['m-a', 'm-b'] };
        await chrome.storage.local.set({ settings: m });
      });
      await page.bringToFront();
      await page.waitForTimeout(700);
      const n = await page.locator('.xcc-model option').count();
      if (n !== 2) throw new Error('候选数异常: ' + n);
      const v = await page.locator('.xcc-model').inputValue();
      if (v !== 'm-a') throw new Error('当前值未选中: ' + v);
      return v;
    });

    await step('面板切换模型：即时落盘 + provider 行刷新 + 生成请求 model 变化', async () => {
      await page.locator('.xcc-model').selectOption('m-b');
      const optsPage = context.pages().find((p) => p.url().includes('options/options.html'));
      // 轮询存储收敛（content 侧 mutateSettings 是 fire-and-forget，固定 sleep 有竞态）
      await optsPage.waitForFunction(async () => {
        const { settings } = await chrome.storage.local.get('settings');
        return settings.custom && settings.custom.model === 'm-b';
      }, null, { timeout: 8000 });
      const saved = await optsPage.evaluate(async () => {
        const { settings } = await chrome.storage.local.get('settings');
        return settings.custom.model;
      });
      if (saved !== 'm-b') throw new Error('未落盘: ' + saved);
      const label = await page.locator('.xcc-provider').innerText();
      if (!label.includes('m-b')) throw new Error('provider 行未刷新: ' + label);
      const before = mockLLM.count;
      await page.locator('.xcc-panel [data-act="regen"]').click();
      const t0 = Date.now();
      while (Date.now() - t0 < 15000 && mockLLM.count < before + 1) {
        await new Promise((r) => setTimeout(r, 200));
      }
      if (mockLLM.count < before + 1) throw new Error('请求未到达');
      const body = JSON.parse(mockLLM.lastBody || '{}');
      if (body.model !== 'm-b') throw new Error('生成 model 未切换: ' + body.model);
      return body.model;
    });

    await step('grok-oauth 面板候选：发现∪兜底∪当前值去重 + 已验证标注 + 不混入哨兵', async () => {
      const optsPage = context.pages().find((p) => p.url().includes('options/options.html'));
      await optsPage.evaluate(async () => {
        const { settings } = await chrome.storage.local.get('settings');
        const m = xccMergeSettings(settings);
        m.provider = 'grok-oauth';
        m.grokOAuth.discoveredModels = ['grok-4.3', 'grok-smoke-disc'];
        await chrome.storage.local.set({ settings: m });
      });
      await page.bringToFront();
      await page.waitForTimeout(700);
      const infos = await page.evaluate(() =>
        [...document.querySelector('#xcc-host').shadowRoot.querySelectorAll('.xcc-model option')]
          .map((o) => ({ v: o.value, t: o.textContent }))
      );
      const vals = infos.map((x) => x.v);
      if (new Set(vals).size !== vals.length) throw new Error('候选未去重');
      if (!vals.includes('grok-smoke-disc') || !vals.includes('grok-4.5')) {
        throw new Error('合并缺项: ' + vals.join(','));
      }
      if (!infos.find((x) => x.v === 'grok-smoke-disc').t.includes('已验证')) {
        throw new Error('发现模型未标注已验证');
      }
      if (!infos.find((x) => x.v === 'grok-4.5').t.includes('未验证')) {
        throw new Error('兜底模型应标注未验证');
      }
      if (vals.includes('__custom__')) throw new Error('面板混入自定义哨兵');
      await optsPage.evaluate(async () => {
        // 收尾恢复 custom 供后续步骤
        const { settings } = await chrome.storage.local.get('settings');
        const m = xccMergeSettings(settings);
        m.provider = 'custom';
        m.custom = { baseUrl: 'http://localhost:8787/v1', apiKey: 'smoke-key', model: 'm-a', models: ['m-a', 'm-b'] };
        await chrome.storage.local.set({ settings: m });
      });
      return vals.length + ' 个候选';
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

    await step('去AI味开关：开启后二段人味改写请求与改写结果回填', async () => {
      const humBtn = page.locator('.xcc-hum');
      const initTxt = await humBtn.innerText();
      if (!initTxt.includes('关')) throw new Error('去AI味开关初始态异常: ' + initTxt);
      await humBtn.click();
      await page.waitForTimeout(600); // mutateSettings → storage.onChanged → refreshSettings
      if (!(await humBtn.evaluate((el) => el.classList.contains('on')))) throw new Error('开关未高亮');
      // storage 读取走扩展页（普通网页主世界无 chrome.storage）
      const optsPage = context.pages().find((p) => p.url().includes('options/options.html'));
      const saved = await optsPage.evaluate(async () => {
        const { settings } = await chrome.storage.local.get('settings');
        return settings.genParams.humanize;
      });
      if (saved !== 'on') throw new Error('humanize 未落盘: ' + saved);
      // 生成 → 恰好 2 次请求；第二次=人味改写（system 标记 + 280 硬约束 + 携带第一段结果）
      const before = mockLLM.count;
      await page.locator('.xcc-panel [data-act="regen"]').click();
      const t0 = Date.now();
      while (Date.now() - t0 < 15000 && mockLLM.count < before + 2) {
        await new Promise((r) => setTimeout(r, 200));
      }
      if (mockLLM.count !== before + 2) {
        throw new Error('应恰好 2 次请求（初稿+改写），实际 ' + (mockLLM.count - before));
      }
      const body = JSON.parse(mockLLM.lastBody || '{}');
      const sys = String((body.messages || [])[0] && body.messages[0].content);
      const usr = String((body.messages || [])[1] && body.messages[1].content);
      if (!sys.includes('人味改写器')) throw new Error('二段请求 system 非人味改写: ' + sys.slice(0, 40));
      if (!sys.includes('280')) throw new Error('免费模式改写段未带 280 硬约束');
      if (!usr.includes('SMOKE-GEN 固定回复')) throw new Error('二段请求未携带第一段结果: ' + usr.slice(0, 40));
      const out = await page.locator('.xcc-out').inputValue();
      if (!out.includes('SMOKE-HUMANIZED')) throw new Error('输出框非改写结果: ' + out.slice(0, 40));
      await page.waitForFunction(() => {
        const st = document.querySelector('#xcc-host').shadowRoot.querySelector('.xcc-status');
        return !!(st && st.textContent.includes('已去AI味'));
      }, null, { timeout: 10000 });
      // 收尾关掉，避免污染后续步骤的"每次生成恰好 1 次请求"断言
      await humBtn.click();
      await page.waitForTimeout(600);
      return '2 次请求，改写回填';
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

    await step('观点倾向：乐观注入方向指令，客观零注入，消极注入且即时落盘', async () => {
      const waitReq = async (before) => {
        const t0 = Date.now();
        while (Date.now() - t0 < 15000 && mockLLM.count < before + 1) {
          await new Promise((r) => setTimeout(r, 200));
        }
        if (mockLLM.count < before + 1) throw new Error('请求未到达');
        return JSON.parse(mockLLM.lastBody || '{}').messages.map((m) => String(m.content)).join('\n');
      };
      // 乐观
      let before = mockLLM.count;
      await page.locator('.xcc-panel [data-act="stance-optimistic"]').click();
      await page.waitForTimeout(500);
      await page.locator('.xcc-panel [data-act="regen"]').click();
      let all = await waitReq(before);
      if (!all.includes('观点倾向') || !all.includes('乐观')) throw new Error('乐观未注入');
      const onOpt = await page.locator('.xcc-panel [data-act="stance-optimistic"]').evaluate((el) => el.classList.contains('on'));
      if (!onOpt) throw new Error('乐观按钮未高亮');
      // 客观（切回默认）：不应再有倾向指令
      before = mockLLM.count;
      await page.locator('.xcc-panel [data-act="stance-objective"]').click();
      await page.waitForTimeout(500);
      await page.locator('.xcc-panel [data-act="regen"]').click();
      all = await waitReq(before);
      if (all.includes('观点倾向')) throw new Error('客观仍带倾向指令');
      // 消极
      before = mockLLM.count;
      await page.locator('.xcc-panel [data-act="stance-pessimistic"]').click();
      await page.waitForTimeout(500);
      await page.locator('.xcc-panel [data-act="regen"]').click();
      all = await waitReq(before);
      if (!all.includes('观点倾向') || !all.includes('审慎')) throw new Error('消极未注入');
      // 落盘校验（走扩展页读存储）
      const optsPage = context.pages().find((p) => p.url().includes('options/options.html'));
      const saved = await optsPage.evaluate(async () => {
        const { settings } = await chrome.storage.local.get('settings');
        return settings.stance;
      });
      if (saved !== 'pessimistic') throw new Error('未落盘: ' + saved);
      // 收尾恢复客观默认
      await page.locator('.xcc-panel [data-act="stance-objective"]').click();
      await page.waitForTimeout(500);
      return saved;
    });

    await step('思考耗尽自动重试：首次 length+空正文，提额后成功', async () => {
      mockLLM.emptyLength = 'once';
      mockLLM.emptyLengthHit = 0;
      const before = mockLLM.count;
      await page.bringToFront();
      await page.locator('.xcc-out').fill(''); // 清旧值，防 waitForFunction 立即命中
      await page.locator('.xcc-panel [data-act="regen"]').click();
      await page.waitForFunction(() => {
        const out = document.querySelector('#xcc-host').shadowRoot.querySelector('.xcc-out');
        return !!(out && out.value.includes('SMOKE-GEN'));
      }, null, { timeout: 20000 });
      if (mockLLM.count < before + 2) throw new Error('未自动重试: ' + (mockLLM.count - before) + ' 次请求');
      const body = JSON.parse(mockLLM.lastBody || '{}');
      if (!(body.max_tokens >= 3000)) throw new Error('重试未提额: max_tokens=' + body.max_tokens);
      const st = await page.locator('.xcc-status').innerText();
      if (!st.includes('已生成')) throw new Error('状态栏异常: ' + st.slice(0, 60));
      mockLLM.emptyLength = null;
      return '重试 max_tokens=' + body.max_tokens;
    });

    await step('持续思考耗尽：报错含准确指引（调大生成长度/换非推理模型）', async () => {
      mockLLM.emptyLength = 'always';
      mockLLM.emptyLengthHit = 0;
      await page.locator('.xcc-panel [data-act="regen"]').click();
      await page.waitForFunction(() => {
        const st = document.querySelector('#xcc-host').shadowRoot.querySelector('.xcc-status');
        return !!(st && st.classList.contains('err') && st.textContent.includes('生成长度上限'));
      }, null, { timeout: 20000 });
      const st = await page.locator('.xcc-status').innerText();
      if (!st.includes('调大') || !st.includes('非推理模型')) throw new Error('指引不全: ' + st.slice(0, 80));
      if (st.includes('已验证')) throw new Error('误追加换模型提示: ' + st.slice(0, 80));
      mockLLM.emptyLength = null;
      return st.slice(0, 40);
    });

    await step('生成失败链路：4xx 原文透出并追加换模型提示', async () => {
      const optsPage = context.pages().find((p) => p.url().includes('options/options.html'));
      await optsPage.evaluate(async () => {
        const { settings } = await chrome.storage.local.get('settings');
        settings.provider = 'custom';
        settings.custom.model = 'missing-model';
        settings.custom.models = ['missing-model']; // 不写则 merge 会校正回 models[0]，404 不触发
        settings.genParams.reasoningEffort = 'default';
        await chrome.storage.local.set({ settings });
      });
      await page.bringToFront();
      await page.waitForTimeout(700); // storage.onChanged → refreshSettings
      // 确认面板已按 missing-model 渲染（generate() 用 state.settings 快照，未收敛会打到旧模型）
      await page.waitForFunction(() => {
        const sel = document.querySelector('#xcc-host').shadowRoot.querySelector('.xcc-model');
        return !!(sel && sel.value === 'missing-model');
      }, null, { timeout: 8000 });
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

    // v0.5.3 设置页：自定义接口模型列表管理
    await step('设置页模型列表：新增/切换 active/删除（删 active 顺延）即时落盘', async () => {
      const optsPage = context.pages().find((p) => p.url().includes('options/options.html'));
      await optsPage.evaluate(async () => {
        const { settings } = await chrome.storage.local.get('settings');
        const m = xccMergeSettings(settings);
        m.provider = 'custom';
        m.custom = { baseUrl: 'http://localhost:8787/v1', apiKey: 'smoke-key', model: 'm-a', models: ['m-a', 'm-b'] };
        await chrome.storage.local.set({ settings: m });
      });
      await optsPage.reload();
      await optsPage.waitForTimeout(900);
      // 新增 m-c（不动 active）
      await optsPage.locator('#custom-model-new').fill('m-c');
      await optsPage.locator('#custom-model-add').click();
      await optsPage.waitForTimeout(700);
      let saved = await optsPage.evaluate(async () => {
        const { settings } = await chrome.storage.local.get('settings');
        return { models: settings.custom.models, model: settings.custom.model };
      });
      if (!saved.models.includes('m-c') || saved.model !== 'm-a') {
        throw new Error('新增异常: ' + JSON.stringify(saved));
      }
      // 切 active 到 m-c
      await optsPage.locator('.model-row[data-model="m-c"] input[type=radio]').check();
      await optsPage.waitForTimeout(700);
      saved = await optsPage.evaluate(async () => (await chrome.storage.local.get('settings')).settings.custom.model);
      if (saved !== 'm-c') throw new Error('active 未切换: ' + saved);
      // 删除 active 行 m-c → active 顺延（confirm 已由全局 dialog handler 自动 accept）
      await optsPage.locator('.model-row[data-model="m-c"] button').click();
      await optsPage.waitForTimeout(700);
      saved = await optsPage.evaluate(async () => {
        const { settings } = await chrome.storage.local.get('settings');
        return { models: settings.custom.models, model: settings.custom.model };
      });
      if (saved.models.includes('m-c') || saved.model !== 'm-a') {
        throw new Error('删除/顺延异常: ' + JSON.stringify(saved));
      }
      return JSON.stringify(saved.models);
    });

    await step('模型列表至少保留一个：删除唯一行被拒', async () => {
      const optsPage = context.pages().find((p) => p.url().includes('options/options.html'));
      await optsPage.locator('.model-row[data-model="m-b"] button').click(); // confirm 全局 accept
      // 等 SETTINGS 重载并重渲染为 1 行（固定 sleep 有竞态：重载未完成时点删会走 confirm 被自动 dismiss）
      await optsPage.waitForFunction(() => document.querySelectorAll('.model-row').length === 1, null, {
        timeout: 8000
      });
      // 只剩 m-a，再删：应 toast 拒绝且存储不变
      await optsPage.locator('.model-row[data-model="m-a"] button').click();
      await optsPage.waitForTimeout(500);
      const txt = await optsPage.locator('#toast').innerText();
      if (!txt.includes('至少保留一个模型')) throw new Error('未拦截: ' + txt);
      const models = await optsPage.evaluate(
        async () => (await chrome.storage.local.get('settings')).settings.custom.models
      );
      if (models.length !== 1 || models[0] !== 'm-a') throw new Error('存储被误删: ' + JSON.stringify(models));
    });

    await step('旧数据迁移：无 custom.models 的单值进数组且面板同步', async () => {
      const optsPage = context.pages().find((p) => p.url().includes('options/options.html'));
      await optsPage.evaluate(async () => {
        const { settings } = await chrome.storage.local.get('settings');
        delete settings.custom.models;
        settings.custom.model = 'legacy-model';
        await chrome.storage.local.set({ settings });
      });
      const rb = await optsPage.evaluate(async () => {
        const m = xccMergeSettings((await chrome.storage.local.get('settings')).settings);
        return { models: m.custom.models, model: m.custom.model };
      });
      if (JSON.stringify(rb.models) !== JSON.stringify(['legacy-model']) || rb.model !== 'legacy-model') {
        throw new Error('迁移异常: ' + JSON.stringify(rb));
      }
      await page.bringToFront();
      await page.waitForTimeout(700);
      const v = await page.locator('.xcc-model').inputValue();
      if (v !== 'legacy-model') throw new Error('面板未同步迁移值: ' + v);
      await optsPage.evaluate(async () => {
        // 收尾恢复
        const { settings } = await chrome.storage.local.get('settings');
        const m = xccMergeSettings(settings);
        m.custom = { baseUrl: 'http://localhost:8787/v1', apiKey: 'smoke-key', model: 'm-a', models: ['m-a', 'm-b'] };
        await chrome.storage.local.set({ settings: m });
      });
    });

    // v0.5.11 预设收敛迁移：旧数据一次性升级（纯 merge 校验，不写盘）
    await step('预设收敛迁移：旧预设/旧默认参数一次性升级且保留自定义值', async () => {
      const optsPage = context.pages().find((p) => p.url().includes('options/options.html'));
      const r = await optsPage.evaluate(async () => {
        const { settings } = await chrome.storage.local.get('settings');
        const clone = (o) => JSON.parse(JSON.stringify(o));
        // 旧数据形态：无 presetsV2、自定义过的旧预设、旧默认参数
        const old = clone(settings);
        delete old.presetsV2;
        old.personaPresets = [{ id: 'p-old', name: '旧人设', persona: 'x' }];
        old.genPresets = [{ id: 'g-topic', name: '原创推文', prompt: 'x' }];
        old.activePersonaId = 'p-old';
        old.activeGenId = 'g-topic';
        old.genParams = { ...(old.genParams || {}), maxTokens: 400, language: 'auto' };
        const m1 = xccMergeSettings(old);
        // 用户明确自定义过的参数不被迁移覆盖（≠旧默认即视为动过）
        const customParams = clone(old);
        customParams.genParams = { ...(customParams.genParams || {}), maxTokens: 2000, language: 'en' };
        const m2 = xccMergeSettings(customParams);
        return {
          n: m1.personaPresets.length + '/' + m1.genPresets.length,
          ids: m1.activePersonaId + '/' + m1.activeGenId,
          gp: m1.genParams.maxTokens + '/' + m1.genParams.language + '/' + m1.presetsV2,
          keep: m2.genParams.maxTokens + '/' + m2.genParams.language
        };
      });
      if (r.n !== '1/5') throw new Error('预设未收敛: ' + r.n);
      if (r.ids !== 'p-general/g-agree') throw new Error('active 未重置到新预设: ' + r.ids);
      if (r.gp !== '1000/zh/true') throw new Error('默认参数未升级: ' + r.gp);
      if (r.keep !== '2000/en') throw new Error('自定义参数被覆盖: ' + r.keep);
      return r.n + ' / ' + r.gp;
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
