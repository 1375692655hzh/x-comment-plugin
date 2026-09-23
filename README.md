# X 评论副驾 (X Comment Copilot)

Chrome / Edge 通用的 MV3 浏览器扩展（Chromium 内核均可加载）。定位参考 SoPilot：在 X（Twitter）页面上提供交互壳——识别推文、用你自定义的**人设提示词 + 生成提示词**生成高质量评论并填入回复框。与 SoPilot 不同的是：**没有自建后端、没有积分体系**，模型调用完全走你自己配置的 API Key 或 Grok 账号授权，数据只存在本地。

## 功能

- **推文识别**：鼠标悬停任意推文，右上角出现 ✦ 按钮，一键捕获作者 + 文本 + 链接
- **全高侧边栏面板**（SoPilot 式）：页面右侧悬浮球 → 打开 380px 全高面板，已捕获推文与生成结果都有大展示区（生成结果区最大）；面板停靠侧可在设置页切换左/右
- **提示词自定义**：设置页可无限新增/编辑人设与生成提示词预设，占位符见下文
- **免费 / 付费模式**：免费模式面向 X 免费账户——生成时注入 280 字符上限硬约束，输出框实时计数 `n/280`（超限标红提醒，不自动截断）；付费模式不限字数，可填「目标字数」作为模糊参考（提示词写"目标约 N 字，不必严格"，留空则不加长度指令）
- **AI 格式清洗**：自动剥掉生成结果里的 markdown 残留（`**加粗**`、`# 标题`、列表符、代码标记）和 AI 前后缀（"好的，以下是…""希望有帮助"），`#hashtag` 不受影响；提示词层同步注入"直接输出正文"硬约束
- **去AI味（可选）**：面板输出框上方的「去AI味」开关——开启后每次生成先出初稿，再自动走一遍"人味改写"（参考 [blader/humanizer](https://github.com/blader/humanizer) 与 [Humanizer-zh](https://github.com/op7418/Humanizer-zh) 的 AI 痕迹清单：杀"不只是X，更是Y"句式、三项排比、AI 高频词，注入长短句交错与具体细节；不改观点、不加事实、不超长度约束）。代价：每条评论两次请求，耗时与额度翻倍；改写失败自动回退初稿
- **一键填入**：自动点开该推文的回复框并把生成内容写入草稿（兼容 Draft.js），**由你人工审核后手动发送**
- **三种接入方式**（可同时保存多家，面板顶部一键切换）：
  1. xAI API Key（开箱即用）
  2. 任意 OpenAI 兼容接口（OpenAI / DeepSeek / Kimi / OpenRouter / Ollama …）——**支持多供应商档案**：每家独立保存名称、地址、Key 与模型列表（如同时配火山方舟 + DeepSeek + 中转站），设置页可增删改名
  3. Grok 账号授权（OAuth 2.0 设备码登录，订阅额度，与 grok CLI 同款）
- 面板顶部为「供应商 → 模型」两级下拉：切供应商自动带出那家的模型列表，点生成立即生效
- **配置备份（导出 / 导入）**：设置页一键导出全部配置（供应商与 Key、模型列表、提示词、参数、Grok 授权）为 JSON 文件；升级新版、换电脑、给朋友的浏览器配同款时导入即恢复，不再重填。导出文件含明文 Key，请自行妥善保管
- **原创模式**：不捕获推文时输入主题，直接生成原创推文填入发帖框

## 目录结构

```
x-comment-plugin/
├── manifest.json              # MV3 清单（Chrome/Edge 通用）
├── shared/
│   ├── common.js            # 默认配置、预设与纯工具（三端共用）
│   └── api.js               # 共享网络层：OAuth 设备流/模型调用/更新检测（SW 与设置页共用，content 不加载）
├── background/service-worker.js  # 薄壳：GENERATE + 兼容消息（提示词组装在此）
├── content/content.js         # 注入 x.com：捕获推文、悬浮面板、填入输入框
├── options/                   # 设置页（接入方式 / 提示词管理 / 生成参数）
├── popup/                     # 工具栏弹窗（开关 + 快速切换预设）
├── tools/                     # update.cmd / update.ps1 一键更新脚本
└── icons/                     # 图标 + gen-icons.js（零依赖重新生成）
```

## 安装（从 GitHub 下载开始）

扩展未上架商店，需以开发者模式加载，全程约 2 分钟。**Chrome 与 Edge 操作相同**（路径不同）。

**第 1 步 · 下载**：打开 [仓库页面](https://github.com/1375692655hzh/x-comment-plugin) → 绿色 **`<> Code`** 按钮 → **Download ZIP**，得到 `x-comment-plugin-main.zip`。

**第 2 步 · 解压**：解压到任意**固定位置**（加载后别删除/移动该文件夹，扩展一直引用它；建议如 `C:\Users\<你>\Extensions\xcc-extension`）。

⚠️ **常见坑：ZIP 解压后是双层文件夹**（`x-comment-plugin-main\x-comment-plugin-main\`，里面那层才有 `manifest.json`）。加载时要选**直接包含 `manifest.json` 的那一层**——选错会报「无法加载扩展…清单文件缺失」。

**第 3 步 · 加载**：

- **Chrome**：地址栏输入 `chrome://extensions` 回车 → 右上角开「开发者模式」→ 左上角「加载已解压的扩展程序」→ 选中第 2 步那层文件夹
- **Edge**：地址栏输入 `edge://extensions` 回车 → 左下角开「开发人员模式」→ 点「加载解压缩的扩展」→ 同上

出现「X 评论副驾」卡片即安装成功。打开 [x.com](https://x.com)，页面右侧出现紫色 ✦ 悬浮球就能用了。

**升级（重点）**：开发者模式加载的扩展不会自动更新。有新版时插件会在面板/设置页顶部显示「🆕 有新版」黄条，按提示：下载新 ZIP → 解压 → **用新文件夹整体替换旧文件夹（保持原路径）** → 扩展管理页点扩展卡片上的「↻ 重新加载」。别删掉旧文件夹再加载新路径——路径一换浏览器就报「File path cannot be resolved」，还得重新加载一次。

> Windows 用户可用仓库里的 `tools/update.cmd` 一键完成下载替换（直连失败自动尝试本地代理端口）。

## 配置模型

打开扩展设置页（工具栏图标 → ⚙，或 X 页面悬浮面板右上角 ⚙）：

### 方式一：xAI API Key（推荐，开箱即用）

1. 到 [console.x.ai](https://console.x.ai) 创建 API Key（`xai-` 开头）
2. 设置页选「xAI API Key」，粘贴 Key，选模型，点「保存并测试」

### 方式二：自定义 OpenAI 兼容接口

填 Base URL + Key + 模型名即可。常用端点：

| 服务商 | Base URL | 模型示例 |
|---|---|---|
| 火山方舟（豆包） | `https://ark.cn-beijing.volces.com/api/v3` | `doubao-...` 系列 / `deepseek-...` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| Kimi (Moonshot) | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
| OpenRouter | `https://openrouter.ai/api/v1` | 任意聚合模型 |
| Ollama 本地 | `http://localhost:11434/v1` | `qwen2.5:7b` 等 |

保存时会请求该域名的网络权限（MV3 要求），点允许即可。

### 方式三：Grok 账号授权（SuperGrok / X Premium+ 订阅额度）

与 grok CLI 同款的 OAuth 2.0 设备码登录，模型调用走订阅额度、不消耗 API Key：

1. 设置页选「Grok 账号授权」→ 点「**开始授权**」（无需填写任何 ID）
2. 点击面板里显示的链接（已自动带上验证码）→ 登录 xAI 账号 → 点允许
3. 设置页自动显示「✓ 授权成功」，之后生成即走订阅额度

技术说明：端点与公开 Client ID 取自 [xai-org/grok-build](https://github.com/xai-org/grok-build) 开源实现（社区包 `@piex-dev/xai-oauth` 同款），并经真实请求验证——授权服务器为 `auth.x.ai`（OIDC discovery 可查），订阅对话调用走 `cli-chat-proxy.grok.com/v1` 并携带 `x-grok-client-*` 识别头。默认模型 `grok-4.3`，可换 `grok-4.5`、`grok-composer-2.5-fast` 等。若 xAI 调整端点，在设置页「高级」中更正即可。

## 获取更新

开发者模式加载的扩展**不会自动更新**，有新版本时插件会自己发现并提醒你（面板和设置页顶部出现「🆕 有新版」黄条），按提示操作即可。三种更新方式任选：

1. **点提示里的链接**：下载最新 ZIP → 解压 → 用新文件夹替换旧的扩展文件夹（保持原路径）→ 扩展管理页点「重新加载」
2. **一键更新（Windows）**：下载仓库后双击 `tools/update.cmd`，脚本自动下载最新版并放到 `C:\Users\<你>\Extensions\xcc-extension`（首次使用后，建议把浏览器的加载路径指向该文件夹，以后双击一次 + 重新加载就完成更新；直连失败会自动尝试本地代理端口）
3. **手动**：GitHub 仓库页重新下载 ZIP

插件内检测逻辑：浏览器启动/扩展安装时后台对比 GitHub main 分支的版本号（jsDelivr → raw.githubusercontent → GitHub API 三源回退，国内可直连 jsDelivr），设置页也可「重新检查」。

**思考强度**：设置页「生成参数 → 思考强度」可选 low / medium / high（对应 `reasoning_effort` 参数，仅 Grok 4.5 / 4.6 等推理模型生效；不发送时服务端默认 high 且推理无法关闭，不想思考请选 non-reasoning 模型）。默认「不发送」以兼容所有接口；Grok 订阅授权通道若不认该参数报错，切回默认即可。生成慢时优先试 low 档。

**模型可用性与生成等待**：Grok 授权后模型下拉自动发现你账号实际可用的模型并标注「（已验证）」；内置候选标「（未验证）」，选未验证模型可能被服务端拒绝或长时间不回包。生成请求**不设超时**：等待期间每 15 秒播报耗时，按钮变为「⏹ 放弃等待」可随时点击结束本次等待（不切断请求，晚到的结果会被忽略）；生成快慢由你自行判断。

长期方案：上架 Chrome Web Store / Edge Add-ons 后即可全自动更新（见 Roadmap）。

## 使用

1. 打开 x.com，页面右侧出现紫色 ✦ 悬浮球
2. 鼠标悬停任意推文 → 点推文右上角小 ✦ 捕获
3. 面板里选「人设」和「生成风格」→ 点「✦ 生成」
4. 结果可手动修改 → 点「填入回复框」（自动打开该推文的回复框并写入草稿）
5. 检查内容 → 手动点发送

不想回复而是发原创：清除捕获、在面板输入主题 → 生成 → 「填入回复框」会写入发帖框。

## 提示词占位符

生成提示词中可用：

- `{tweet_text}` — 捕获的推文全文
- `{author}` — 推文作者（如 `@elonmusk`）
- `{topic}` — 面板里输入的主题

未放置占位符时，扩展会自动把推文/主题附在提示词末尾，保证模型能看到上下文。人设提示词作为 system 角色发送。

## 隐私与安全

- 所有配置（含 API Key、OAuth token）仅存于 `chrome.storage.local`，不上传任何服务器
- 模型请求由扩展后台直达你配置的服务商，无中间层
- 权限最小化：`storage` + x.ai 域名；自定义接口按需逐域授权

## 注意事项

- 生成内容**只填入草稿，不会自动发送**——请保持人工审核的习惯，对自己账号发的内容负责
- 架构（v0.4.0 起）：面板/弹窗/设置页全部直接读写本地存储或本页直连网络，**不依赖扩展后台**；只有 X 页面里的「生成」走后台（content script 无跨域豁免）。若生成长时间无响应会明确报错并指引到扩展管理页重新加载
- 扩展更新重载后，重载前打开的设置页会自动检测并刷新（孤儿页自愈）；若提示页面失效，关掉该标签从 ⚙ 重新打开即可
- 请遵守 X 服务条款与所用 API 的使用条款；本工具定位是个人辅助写作，请勿用于批量刷评、垃圾信息等自动化滥用
- X 前端改版可能导致选择器失效（`data-testid` 变动），届时更新 `content/content.js` 中的选择器即可
- 推文中的图片/视频内容目前不参与识别（纯文本上下文）

## 二次开发

- 重新生成图标：`node icons/gen-icons.js`（零依赖）
- 改默认预设：`shared/common.js`
- 加新的接入方式：`background/service-worker.js` 的 `resolveProviderCfg`

## Roadmap

- [ ] 上架 Chrome Web Store / Edge Add-ons（自动更新）
- [ ] 图文推文的多模态识别（传入图片给视觉模型）
- [ ] 楼中楼（回复的回复）上下文携带
- [ ] 配置导入/导出 JSON
- [ ] 多条候选批量生成
