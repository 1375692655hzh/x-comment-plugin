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
check(content.includes('editorMatchesTarget'), '填入前校验编辑器匹配目标推文（防填错框/回错帖）');
check(content.includes('弹出的回复框'), '状态栏标明填入位置（弹层/页面框）');
check(content.includes("new InputEvent('input'"), 'insertInto 有 DOM 直插+input 派发兜底路径');

// 5.8 v0.5.9 门禁：去AI味（生成后二段"人味改写"）
check(sw.includes('function buildHumanizeMessages'), 'SW 有人味改写提示词组装函数');
check(sw.includes('人味改写器'), 'SW 人味改写 system 含身份标记（冒烟 mock 按此识别二段请求）');
check(sw.includes("s.genParams.humanize === 'on'"), 'GENERATE 挂接 humanize 开关分支');
check(sw.includes('humanizeError'), '改写失败回退原稿且不连坐第一段成果');
check(common.includes("humanize: 'off'"), 'XCC_DEFAULTS.genParams.humanize 默认关');
check(common.includes("humanize: s.genParams.humanize === 'on'"), 'xccPublicSettings 透出 humanize（脏值按关）');
check(content.includes('hum-toggle') && content.includes('function renderHumanize'), '面板存在去AI味开关与渲染函数');
check(content.includes('已去AI味'), '状态栏标注去AI味结果');
check(read('tools/smoke/smoke.js').includes('SMOKE-HUMANIZED'), '冒烟覆盖去AI味二段链路');

// 5.9 v0.5.10 门禁：指纹浏览器/海外代理分流说明（同事场景实测解法固化进设置页）
check(oh.includes('id="custom-proxy-help"'), '设置页存在分流说明折叠块 #custom-proxy-help');
check(oh.includes('代理IP黑名单') && oh.includes('*模型域名'), '分流说明含比特浏览器具体操作路径');
check(oj.includes("help.open = true"), '诊断命中网络不通时自动展开分流说明');

// 5.10 v0.5.11 门禁：预设收敛 + 默认参数 + 醒目控件 + 分流说明标红
{
  const personaCount = (common.match(/id: 'p-/g) || []).length;
  check(personaCount === 1 && common.includes("name: '自然网友'"), '人设预设只含「自然网友」');
  for (const nm of ['认同 + 补充观点', '犀利提问', '幽默玩梗', '省流党', '深度分析']) {
    check(common.includes(`name: '${nm}'`), `生成风格预设存在「${nm}」`);
  }
  check(
    !common.includes('p-crypto') && !common.includes('p-dev') && !common.includes('g-topic') && !common.includes('g-insight'),
    '旧预设（加密观察者/独立开发者/观点输出/原创推文）已移除'
  );
  check(common.includes('maxTokens: 1000'), '默认最大生成长度 1000');
  check(common.includes("language: 'zh'"), '默认语言强制中文');
  check(common.includes('presetsV2'), '存在 presetsV2 迁移标记');
  check(content.includes('button.xcc-set') && content.includes('>⚙ 设置<'), '面板设置入口为醒目「⚙ 设置」按钮');
  check(content.includes('border-radius: 999px') && content.includes('button.xcc-hum.on'), '去AI味开关为胶囊按钮样式');
  check(read('options/options.css').includes('#custom-proxy-help > summary'), '分流说明 summary 标红样式');

// 5.11 v0.5.12 门禁：多供应商（xAI / 主槽位 custom / Grok 授权 + customVendors 额外档案）
check(common.includes('customVendors: []') && common.includes("activeCustomVendorId: 'primary'"), 'XCC_DEFAULTS 含 customVendors 与 activeCustomVendorId');
check(common.includes('function xccActiveCustom'), 'common 有活动档案解析 xccActiveCustom');
check(common.includes('vendorList'), 'xccPublicSettings 透出 vendorList');
check(read('shared/api.js').includes('xccActiveCustom(s)'), 'api.js custom 分支走活动档案');
check(oh.includes('id="vendor-list"') && oh.includes('id="vendor-add"'), '设置页存在供应商列表与新增按钮');
check(oj.includes('function mutateActiveCustom') && oj.includes('activeCustomVendorId'), '设置页写回走活动档案');
check(content.includes('xcc-vendor') && content.includes('function renderVendors'), '面板存在供应商下拉与渲染函数');
check(sw.includes('xccResolveProviderCfg'), 'GENERATE 经供应商解析取配置');

// 5.12 v0.5.14 门禁：五件套文案升级（五引擎评审）+ presetsV3 按 id 替换 + 省流锚点保留
check(common.includes('presetsV3'), '存在 presetsV3 文案版本迁移标记');
check(common.includes('builtinIds'), 'presetsV3 迁移按 id 替换（用户自定义预设保留）');
check(common.includes('别复述原句'), '认同条防复述原话（评审共识）');
check(common.includes('不替作者编动机'), '省流条收敛攻击性（不编动机/不硬挑刺）');
check(common.includes('收尾给出你的判断'), '深度分析收尾给判断（与犀利提问区分）');
check(sw.includes('省流：」）必须原样保留'), '人味改写保留风格锚点前缀（防洗掉"省流："）');

// 5.13 v0.5.15 门禁：改写层三不改 + 句数回查 + 态度多样化（A/B 盲评修订版）
check(sw.includes('只改措辞') && sw.includes('句子数量不得增减'), '人味改写三不改（只改措辞/句数不增/事实零增改）');
check(sw.includes('改写疑似加戏') && sw.includes('countSent(rewritten) > countSent(text)'), 'GENERATE 有句数回查（改写加戏回退初稿）');
check(sw.includes('改写结果为空'), '改写空串守卫（围栏壳清洗后为空回退初稿）');
check(sw.includes('不可改出病句'), '改写层防病句条款');
check(common.includes('谁买单'), '省流条态度多样化（治"最后谁买单"式同质化）');
check(common.includes('不替当事方编动机'), '深析条补编动机禁令');
check(common.includes('presetsV4'), '存在 presetsV4 迁移标记');

// 5.14 v0.5.16 门禁：配置备份（导出/导入——换路径/换电脑/给朋友配机不丢设置）
check(oh.includes('id="config-export"') && oh.includes('id="config-import"'), '设置页存在配置导出/导入控件');
check(oj.includes('function exportConfig') && oj.includes('function importConfigFile'), 'options 有导出/导入实现');
check(oj.includes("a.download = 'xcc-config-"), '导出文件名带前缀与时间戳');
check(oj.includes('xccMergeSettings(raw)'), '导入走合并规范化（旧备份缺字段自动补齐）');
check(oh.includes('别公开转发'), '导出含明文 Key 的安全提示');
check(oj.includes('storage.onChanged.addListener'), '设置页监听外部配置变更自动刷新（防陈旧页静默覆盖）');
check(oj.includes("data.app !== 'x-comment-plugin'"), '导入信封校验（拒绝非本产品配置文件）');
check(oj.includes('healOrphanPage(true)'), '备份操作孤儿页自愈对接');

// 5.15 v0.5.18 门禁：manifest key 固定扩展 ID（换路径/重装/上架同 ID，配置永驻）
check(/"key":\s*"[A-Za-z0-9+/]{300,}={0,2}"/.test(read('manifest.json')), 'manifest 含 key 字段（RSA 公钥，固定扩展 ID）');
check(!fs.readFileSync(path.join(root, 'manifest.json'), 'utf8').includes('PRIVATE KEY'), 'manifest 只含公钥（无私钥泄漏）');
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
