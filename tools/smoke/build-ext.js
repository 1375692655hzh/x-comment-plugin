// 生成冒烟测试用的扩展副本：按白名单拷贝扩展文件 + 给 manifest 追加 localhost 匹配
// 运行：node tools/smoke/build-ext.js
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const dest = path.join(__dirname, 'ext');
const FILES = ['manifest.json', 'shared', 'background', 'content', 'options', 'popup', 'icons'];

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest);
for (const f of FILES) {
  fs.cpSync(path.join(root, f), path.join(dest, f), { recursive: true });
}

const manPath = path.join(dest, 'manifest.json');
const man = JSON.parse(fs.readFileSync(manPath, 'utf8'));
const test = 'http://localhost:8787/*';
if (!man.content_scripts[0].matches.includes(test)) {
  man.content_scripts[0].matches.push(test);
}
for (const war of man.web_accessible_resources || []) {
  if (!war.matches.includes(test)) war.matches.push(test);
}
// 本地 OAuth 模拟端点需要 host_permissions（扩展页直连 fetch）
if (!(man.host_permissions || []).includes(test)) {
  man.host_permissions = man.host_permissions || [];
  man.host_permissions.push(test);
}
fs.writeFileSync(manPath, JSON.stringify(man, null, 2));

// 诊断注入：在测试版 SW 各关键点写 storage 标记，用于定位卡死位置
const swPath = path.join(dest, 'background', 'service-worker.js');
let sw = fs.readFileSync(swPath, 'utf8');
sw = sw.replace(
  "importScripts('/shared/common.js');",
  `importScripts('/shared/common.js');
chrome.storage.local.set({ swBoot: 'import-ok' }).catch(function(e){});`
);
sw = sw.replace(
  'chrome.runtime.onMessage.addListener(',
  `chrome.storage.local.set({ swBoot: 'before-onMessage' }).catch(function(e){});
chrome.runtime.onMessage.addListener(`
);
sw = sw.replace(
  "(async () => {\n    switch (msg && msg.type) {",
  `(async () => {
    try { chrome.storage.local.set({ swMsg: (msg && msg.type) + '@' + Date.now() }).catch(function(e){}); } catch (e) {}
    switch (msg && msg.type) {`
);
fs.writeFileSync(swPath, sw);
console.log('test extension built at', dest, 'v' + man.version);
