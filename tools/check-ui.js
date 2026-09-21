// 静态一致性检查：UI 元素 ↔ 事件绑定 ↔ 消息处理器 ↔ manifest 引用
// 运行：node tools/check-ui.js   （退出码非 0 = 有 FAIL）
'use strict';

const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let fail = 0;
const check = (cond, msg) => {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + msg);
  if (!cond) fail++;
};

// 1. content.js：面板里每个 data-act 都有处理分支
const content = read('content/content.js');
const acts = new Set([...content.matchAll(/data-act="([^"]+)"/g)].map((m) => m[1]));
for (const a of acts) check(content.includes(`act === '${a}'`), `面板 data-act="${a}" 有处理分支`);
check(acts.size >= 6, `面板 data-act 数量正常（${acts.size} 个）`);

// 2. content.js：els 引用的每个类名都存在于 shadow 模板
const elsClasses = new Set(
  [...content.matchAll(/querySelector\('\.([a-z][a-z-]*)'\)/g)].map((m) => m[1])
);
for (const c of elsClasses) {
  check(content.includes(`class="${c}"`), `面板模板存在 .${c}`);
}

// 3. options：options.js 引用的每个 id 都在 options.html 里
const oh = read('options/options.html');
const oj = read('options/options.js');
const oids = new Set([...oj.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]));
for (const id of oids) check(oh.includes(`id="${id}"`), `options #${id} 存在`);

// 4. popup：popup.js 引用的每个 id 都在 popup.html 里
const ph = read('popup/popup.html');
const pj = read('popup/popup.js');
const pids = new Set([...pj.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]));
for (const id of pids) check(ph.includes(`id="${id}"`), `popup #${id} 存在`);

// 5. 消息协议：三端 send 的每个 type 在后台都有处理器
const sw = read('background/service-worker.js');
const sentTypes = new Set([
  ...[...content.matchAll(/type: '([A-Z_]+)'/g)].map((m) => m[1]),
  ...[...oj.matchAll(/type: '([A-Z_]+)'/g)].map((m) => m[1]),
  ...[...pj.matchAll(/type: '([A-Z_]+)'/g)].map((m) => m[1])
]);
for (const t of sentTypes) check(sw.includes(`case '${t}'`), `消息 ${t} 后台有处理器`);
check(sentTypes.size >= 2, `消息类型覆盖正常（${sentTypes.size} 个）`);

// 5.5 共享网络层（options 与 SW 共用）
check(fs.existsSync(path.join(root, 'shared/api.js')), 'shared/api.js 存在');
check(sw.includes("importScripts('/shared/common.js', '/shared/api.js')"), 'SW 加载 api.js');
check(oh.includes('../shared/api.js'), 'options.html 引用 api.js');
// SW 顶层不得与共享文件重复声明 const（重复声明 = SW 实例化崩溃）
{
  const swBody = sw.replace(/^importScripts.*$/m, '');
  const sharedSrc = read('shared/common.js') + read('shared/api.js');
  const sharedConsts = [...sharedSrc.matchAll(/^const ([A-Z_]+)/gm)].map((m) => m[1]);
  for (const c of new Set(sharedConsts)) {
    check(!new RegExp(`^(const|let) ${c}\\b`, 'm').test(swBody), `SW 无重复声明 const ${c}`);
  }
}

// 6. manifest 引用的文件都存在
const man = JSON.parse(read('manifest.json'));
const refs = [
  man.background && man.background.service_worker,
  man.options_page,
  man.action && man.action.default_popup,
  ...Object.values(man.icons || {}),
  ...(man.content_scripts || []).flatMap((c) => [...(c.js || []), ...(c.css || [])])
].filter(Boolean);
for (const f of refs) check(fs.existsSync(path.join(root, f)), `manifest 文件 ${f} 存在`);

// 7. HTML 引用的本地 js/css 都存在（相对页面目录解析，path.join 自动处理 ../）
for (const [html, base] of [[oh, 'options'], [ph, 'popup']]) {
  for (const m of html.matchAll(/(?:src|href)="(?!https?:|#)([^"]+)"/g)) {
    const p = path.join(root, base, m[1]);
    check(fs.existsSync(p), `${base} 页面引用 ${m[1]} 存在`);
  }
}

console.log(fail ? `\n${fail} 项 FAIL` : '\n全部通过');
process.exit(fail ? 1 : 0);
