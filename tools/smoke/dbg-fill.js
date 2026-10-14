// 聚焦调试：只跑 v0.5.21 新增的"清不干净/残渣可清"两个填入场景，
// 捕获页面全部 console（含 content script 隔离世界转发）+ 给构建副本注入的打点。
// 用法：node tools/smoke/build-ext.js && node tools/smoke/dbg-fill.js（必须 schtasks 跑）
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const _logPath = path.join(__dirname, 'dbg-fill.log');
try { fs.unlinkSync(_logPath); } catch (e) {}
const _log = (...a) => {
  const s = a.map((x) => (typeof x === 'string' ? x : require('util').inspect(x, { depth: 5 }))).join(' ');
  fs.appendFileSync(_logPath, s + '\n');
};

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  const gnm = path.join(process.env.APPDATA || '', 'npm', 'node_modules');
  const cand = [path.join(gnm, 'playwright')];
  if (fs.existsSync(gnm)) for (const p of fs.readdirSync(gnm)) cand.push(path.join(gnm, p, 'node_modules', 'playwright'));
  for (const c of cand) if (fs.existsSync(path.join(c, 'package.json'))) { ({ chromium } = require(c)); break; }
}

const PORT = 8787; // 必须与 build-ext.js 放行的测试白名单一致
const here = __dirname;
const server = http.createServer((req, res) => {
  const file = req.url === '/' || req.url === '/page.html' ? 'page.html' : req.url.replace(/\//g, '');
  const p = path.join(here, file);
  if (fs.existsSync(p) && fs.statSync(p).isFile()) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(p));
  } else { res.writeHead(404); res.end('not found'); }
});

(async () => {
  // 给构建副本注入打点（console 跨隔离/主世界共享，Playwright 能收到）。
  // 只动 ext/ 构建副本，下次 build-ext.js 重建即还原。
  const extCjs = path.join(here, 'ext', 'content', 'content.js');
  let src = fs.readFileSync(extCjs, 'utf8');
  const injectHelper = "function __dbg(s){try{console.log('[XCCDBG] '+s);}catch(e){}}\n";
  const rep = (from, to, once) => {
    if (!src.includes(from)) { _log('[probe MISS] ' + from.slice(0, 60)); return; }
    src = once ? src.replace(from, to) : src.split(from).join(to);
  };
  rep("  function visibleEditors() {", injectHelper + "  function visibleEditors() {", true);
  rep("async function insertInto(editor, text) {", "async function insertInto(editor, text) { __dbg('insertInto editor=' + (editor.id || editor.getAttribute('data-testid')) + ' text=' + JSON.stringify(text).slice(0, 24));", true);
  rep("async function insertResult() {", "async function insertResult() { __dbg('insertResult ENTER hosts=' + document.querySelectorAll('#xcc-host').length + ' out=' + JSON.stringify((function(){var o=document.querySelector('#xcc-host').shadowRoot.querySelector('.xcc-out');return o&&o.value||'';})()).slice(0,30));", true);
  rep("async function clearEditorVerified(editor) {", "async function clearEditorVerified(editor) { __dbg('cvv-start ed=' + (editor.id || 'composer') + ' inner=' + JSON.stringify(normEditorText(editor.innerText)).slice(0, 50));", true);
  rep("return !normEditorText(editor.innerText);\n  }", "__dbg('cvv-exhausted inner=' + JSON.stringify(normEditorText(editor.innerText)).slice(0, 50));\n    return !normEditorText(editor.innerText);\n  }", true);
  rep("function frameworkInsert(editor, text) {", "function frameworkInsert(editor, text) { __dbg('fwInsert ed=' + (editor.id || 'composer'));", true);
  rep("function pasteInsert(editor, text) {", "function pasteInsert(editor, text) { __dbg('PASTE ed=' + (editor.id || 'composer'));", true);
  rep("function clearByBackspace(editor) {", "function clearByBackspace(editor) { __dbg('backspace-clear ed=' + (editor.id || 'composer') + ' n=' + Math.min(2000, editor.innerText.length + 3));", true);
  rep("return 'recovered';", "{ __dbg('gate-recovered'); return 'recovered'; }", false);
  rep("if (await sendReadySoon(editor)) return 'ok';", "if (await sendReadySoon(editor)) { __dbg('gate-ok'); return 'ok'; }", true);
  rep("await clearEditorVerified(editor); // 彻底失败：尽力清场，走剪贴板兜底", "await clearEditorVerified(editor); __dbg('final-fail');", true);
  rep("const r = await insertInto(editor, text);\n        const where =", "const r = await insertInto(editor, text);\n        __dbg('insertInto-r=' + r);\n        const where =", true);
  rep("const r = await insertInto(editor, text);\n        if (r === 'ok' || r === 'recovered') {\n          setStatus((r === 'recovered' ?", "const r = await insertInto(editor, text);\n        __dbg('insertInto-r-origmode=' + r);\n        if (r === 'ok' || r === 'recovered') {\n          setStatus((r === 'recovered' ?", true);
  fs.writeFileSync(extCjs, src);
  _log('[probe] injected');

  await new Promise((r) => server.listen(PORT, r));
  const profileDir = path.join(here, 'profile-dbg');
  fs.rmSync(profileDir, { recursive: true, force: true });
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: 'msedge',
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${path.join(here, 'ext')}`, `--load-extension=${path.join(here, 'ext')}`, '--no-first-run', '--no-default-browser-check']
  });
  const page = context.pages()[0] || (await context.newPage());
  page.on('console', (m) => _log('[console:' + m.type() + ']', m.text().slice(0, 300)));
  page.on('pageerror', (e) => _log('[pageerror]', String(e.message).slice(0, 300)));

  await page.goto(`http://localhost:${PORT}/page.html`);
  await page.waitForTimeout(1200);

  // 捕获推文 → 面板
  await page.locator('article[data-testid="tweet"]').first().hover();
  await page.waitForTimeout(300);
  await page.locator('.xcc-hover-btn').click();
  await page.waitForTimeout(500);

  // 场景 0：微观实验——execCommand('delete') 到底发不发 beforeinput、删不删 DOM/state
  _log('=== scenario 0: execCommand delete mechanics ===');
  const s0 = await page.evaluate(() => {
    const root = document.getElementById('modal-editor');
    document.getElementById('modal').style.display = 'block';
    window.__fw.reset();
    window.__fw.setText('微观实验文本 probe-text');
    const events = [];
    const h = (e) => events.push(e.type + ':' + e.inputType + ':prevented=' + e.defaultPrevented);
    root.addEventListener('beforeinput', h);
    root.addEventListener('input', h);
    root.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(root);
    sel.removeAllRanges();
    sel.addRange(range);
    const ret = document.execCommand('delete', false, null);
    root.removeEventListener('beforeinput', h);
    root.removeEventListener('input', h);
    return {
      ret,
      events,
      innerAfter: root.innerText,
      stateAfter: window.__fw.text(),
      hasFocus: document.activeElement === root,
      docHasFocus: document.hasFocus()
    };
  });
  _log('[S0]', s0);


  const readPanel = () => page.evaluate(() => ({
    text: window.__fw.text(),
    stats: { ...window.__fw.stats },
    dom: document.getElementById('modal-editor').innerText,
    status: document.querySelector('#xcc-host').shadowRoot.querySelector('.xcc-status').textContent,
    btnDisabled: document.querySelector('#xcc-host').shadowRoot.querySelector('.xcc-row [data-act="insert"]').disabled
  }));
  const fence = (ms) => page.waitForFunction(() => {
    const b = document.querySelector('#xcc-host').shadowRoot.querySelector('.xcc-row [data-act="insert"]');
    return !!(b && !b.disabled);
  }, null, { timeout: ms || 15000 });

  // 场景 B：残渣 + 清不干净
  _log('=== scenario B: residue + lockClear ===');
  await page.evaluate(() => {
    document.getElementById('modal').style.display = 'block';
    window.__fw.reset();
    window.__fw.setText('残留半截文案 residue-tail');
    window.__fw.lockClear(true);
  });
  await page.locator('.xcc-out').fill('清不干净回复 no-clear');
  await page.locator('.xcc-panel [data-act="insert"]').click();
  await fence(25000);
  _log('[B result]', await readPanel());

  // 场景 C：残渣可清
  _log('=== scenario C: residue clearable ===');
  await page.evaluate(() => {
    document.getElementById('modal').style.display = 'block';
    window.__fw.reset();
    window.__fw.setText('互动这事确实得勤快点，不然算法都快忘了我是谁了。');
  });
  const want = '街溜子已上线，先从你家门口溜达一圈 互动这事确实得勤快点，不然算法都快忘了我是谁了。';
  await page.locator('.xcc-out').fill(want);
  await page.locator('.xcc-panel [data-act="insert"]').click();
  await fence(25000);
  _log('[C result]', await readPanel());

  await page.screenshot({ path: path.join(here, 'dbg-fill.png') });
  await context.close();
  server.close();
  _log('[done]');
  process.exit(0);
})().catch((e) => { _log('[fatal]', e && e.stack || e); process.exit(1); });
