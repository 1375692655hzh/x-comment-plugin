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
// 3.5 oauth 模型控件门禁：必须是 select + 自定义输入（防退回 datalist 前缀过滤体验）
check(/<select[^>]*id="oauth-model"/.test(oh), 'oauth-model 是 select');
check(oh.includes('id="oauth-model-custom"'), '存在 #oauth-model-custom');
check(!oh.includes('id="oauth-models"'), '已移除 datalist#oauth-models');
check(oj.includes('XCC_OAUTH_MODEL_CUSTOM'), '自定义哨兵值存在');

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

// 5.6 v0.5.0 门禁：免费 280 约束 / 付费目标字数 / 输出清洗 / 面板模式控件
check(sw.includes('280 个字符'), 'SW 注入免费 280 字符硬约束');
check(sw.includes('目标约'), 'SW 注入付费目标字数（模糊参考）');
check(sw.includes('直接输出评论正文'), 'SW system 含输出格式硬约束');
check(read('shared/api.js').includes('function xccCleanReplyText'), 'api.js 存在输出清洗函数');
check(content.includes('plan-free') && content.includes('plan-premium'), '面板存在免费/付费切换按钮');
check(content.includes('xcc-target-len') && content.includes('xcc-count'), '面板存在目标字数输入与计数器');
check(/id="panel-side"/.test(oh), '设置页存在面板位置选择');
check(sw.includes('观点倾向'), 'SW 注入观点倾向指令（乐观/消极）');
check(
  content.includes('stance-pessimistic') && content.includes('stance-objective') && content.includes('stance-optimistic'),
  '面板存在消极/客观/乐观切换按钮'
);

// 5.7 v0.5.3 门禁：面板顶部模型下拉 + custom 多模型三端联动
const common = read('shared/common.js');
check(content.includes('xcc-model'), '面板存在模型下拉 .xcc-model');
check(content.includes('function renderModels'), '面板有 renderModels 渲染函数');
check(content.includes('m.xai.model = v'), '面板切换模型写 xai.model');
check(content.includes('m.custom.model = v'), '面板切换模型写 custom.model');
check(content.includes('m.grokOAuth.model = v'), '面板切换模型写 grokOAuth.model');
check(common.includes('XCC_XAI_MODEL_CANDIDATES'), 'common.js 定义 xai 候选常量（面板/设置页共用）');
check(common.includes('XCC_OAUTH_MODEL_FALLBACK'), 'common.js 定义 oauth 兜底候选（面板共用）');
check(!oj.includes('const XCC_OAUTH_MODEL_FALLBACK'), 'options.js 不重复声明兜底常量（防经典 script 共享全局 SyntaxError）');
check(/models:\s*\[/.test(common.split('custom:')[1] || ''), 'XCC_DEFAULTS.custom 含 models 数组');
check(/!customModels\.includes\(custom\.model\)/.test(common), 'xccMergeSettings 校正 active ∈ models');
check(common.includes('modelCandidates'), 'xccPublicSettings 透出 modelCandidates');
check(oh.includes('id="custom-models"'), '设置页存在模型列表容器 #custom-models');
check(oh.includes('id="custom-model-add"'), '设置页存在新增模型按钮');
check(!oh.includes('id="custom-model"'), '设置页已移除单模型输入框 #custom-model');
check(oj.includes('function renderCustomModels'), '设置页有 renderCustomModels');
check(oj.includes('至少保留一个模型'), '模型列表删除有「至少保留一个」兜底');
check(content.includes('function frameworkInsert'), '填入走框架优先插入（beforeinput 认领探测）');
check(content.includes('span[data-text="true"]'), '光标落位到框架文本叶子（死键根因修复）');
check(read('shared/api.js').includes('思考用完了生成长度上限'), 'api.js 有思考耗尽检测与提额重试');

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
