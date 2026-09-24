// v0.5.18 固定 ID 实证测试：同 key 换路径加载，chrome.storage 是否保留
// 场景：A 路径加载→写标记→删 A 文件夹→B 路径加载（同 key）→标记应仍在
// 运行：node tools/smoke/key-test.js
'use strict';
const fs = require('fs');
const path = require('path');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  const gnm = path.join(process.env.APPDATA || '', 'npm', 'node_modules');
  const candidates = [path.join(gnm, 'playwright')];
  if (fs.existsSync(gnm)) {
    for (const pkg of fs.readdirSync(gnm)) {
      const p = path.join(gnm, pkg, 'node_modules', 'playwright');
      if (fs.existsSync(p)) candidates.push(p);
    }
  }
  let loaded = false;
  for (const c of candidates) {
    try {
      ({ chromium } = require(c));
      loaded = true;
      break;
    } catch (e2) { /* 下一个 */ }
  }
  if (!loaded) throw new Error('未找到 playwright');
}

const here = __dirname;
const dirA = path.join(here, 'keytest', 'a');
const dirB = path.join(here, 'keytest', 'b');
const profile = path.join(here, 'keytest', 'profile');

// 准备两份同 key 的扩展副本
fs.rmSync(path.join(here, 'keytest'), { recursive: true, force: true });
fs.cpSync(path.join(here, 'ext'), dirA, { recursive: true });
fs.cpSync(path.join(here, 'ext'), dirB, { recursive: true });

const EXT_HOST = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
const edgeCandidates = [
  path.join(EXT_HOST, 'Microsoft\\Edge\\Application\\msedge.exe'),
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];
const edge = edgeCandidates.find((p) => fs.existsSync(p));

async function launch(extPath) {
  return chromium.launchPersistentContext(profile, {
    headless: false,
    executablePath: edge,
    args: [
      `--disable-extensions-except=${extPath}`,
      `--load-extension=${extPath}`,
      '--no-first-run'
    ]
  });
}

async function readExt(ctx) {
  // SW 目标拿扩展 ID → 开设置页 → 读写 storage
  let id = null;
  for (let i = 0; i < 40 && !id; i++) {
    for (const sw of ctx.serviceWorkers()) {
      const m = /chrome-extension:\/\/([a-p]{32})\//.exec(sw.url());
      if (m) id = m[1];
    }
    if (!id) await new Promise((r) => setTimeout(r, 500));
  }
  if (!id) return null;
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${id}/options/options.html`);
  return { id, page };
}

(async () => {
  // 第一轮：A 路径加载，写标记
  const ctx1 = await launch(dirA);
  const r1 = await readExt(ctx1);
  if (!r1) throw new Error('A 未加载');
  await r1.page.evaluate(async () => {
    await chrome.storage.local.set({ keytestMarker: 'set-in-A' });
  });
  console.log('ROUND1 id=' + r1.id + ' marker=set-in-A');
  await ctx1.close();

  // 删掉 A（模拟用户解压到新文件夹前的旧文件夹清理）
  fs.rmSync(dirA, { recursive: true, force: true });

  // 第二轮：B 路径（同 key）加载，读标记
  const ctx2 = await launch(dirB);
  const r2 = await readExt(ctx2);
  if (!r2) throw new Error('B 未加载');
  const marker = await r2.page.evaluate(async () => {
    const { keytestMarker } = await chrome.storage.local.get('keytestMarker');
    return keytestMarker || null;
  });
  console.log('ROUND2 id=' + r2.id + ' marker=' + marker);
  await ctx2.close();

  const verdict =
    r1.id === r2.id && marker === 'set-in-A'
      ? 'PASS: 同 key 换路径，ID 一致且 storage 保留'
      : 'FAIL: id1=' + r1.id + ' id2=' + r2.id + ' marker=' + marker;
  console.log(verdict);
  process.exit(verdict.startsWith('PASS') ? 0 : 1);
})().catch((e) => {
  console.error('KEYTEST ERROR:', e && e.message ? e.message : e);
  process.exit(1);
});
