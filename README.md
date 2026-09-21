# X 评论副驾 (X Comment Copilot)

Chrome / Edge 通用的 MV3 浏览器扩展（Chromium 内核均可加载）。定位参考 SoPilot：在 X（Twitter）页面上提供交互壳——识别推文、用你自定义的**人设提示词 + 生成提示词**生成高质量评论并填入回复框。与 SoPilot 不同的是：**没有自建后端、没有积分体系**，模型调用完全走你自己配置的 API Key 或 Grok 账号授权，数据只存在本地。

## 功能

- **推文识别**：鼠标悬停任意推文，右上角出现 ✦ 按钮，一键捕获作者 + 文本 + 链接
- **悬浮面板**：页面右侧浮动球 → 打开面板，选择「人设 × 生成风格」组合
- **提示词自定义**：设置页可无限新增/编辑人设与生成提示词预设，占位符见下文
- **一键填入**：自动点开该推文的回复框并把生成内容写入草稿（兼容 Draft.js），**由你人工审核后手动发送**
- **三种接入方式**：
  1. xAI API Key（开箱即用）
  2. 任意 OpenAI 兼容接口（OpenAI / DeepSeek / Kimi / OpenRouter / Ollama …）
  3. Grok 账号授权（OAuth 2.0 设备码登录，Beta）
- **原创模式**：不捕获推文时输入主题，直接生成原创推文填入发帖框

## 目录结构

```
x-comment-plugin/
├── manifest.json              # MV3 清单（Chrome/Edge 通用）
├── shared/common.js           # 默认配置、预设与工具函数
├── background/service-worker.js  # API 代理 + 提示词组装 + OAuth 设备流
├── content/content.js         # 注入 x.com：捕获推文、悬浮面板、填入输入框
├── options/                   # 设置页（接入方式 / 提示词管理 / 生成参数）
├── popup/                     # 工具栏弹窗（开关 + 快速切换预设）
└── icons/                     # 图标 + gen-icons.js（零依赖重新生成）
```

## 安装

**Chrome**：打开 `chrome://extensions` → 右上角开启「开发者模式」→「加载已解压的扩展程序」→ 选择本目录。

**Edge**：打开 `edge://extensions` → 左下角开启「开发人员模式」→「加载解压缩的扩展」→ 选择本目录。同一份代码，无需改动。

## 配置模型

打开扩展设置页（工具栏图标 → ⚙，或 X 页面悬浮面板右上角 ⚙）：

### 方式一：xAI API Key（推荐，开箱即用）

1. 到 [console.x.ai](https://console.x.ai) 创建 API Key（`xai-` 开头）
2. 设置页选「xAI API Key」，粘贴 Key，选模型，点「保存并测试」

### 方式二：自定义 OpenAI 兼容接口

填 Base URL + Key + 模型名即可。常用端点：

| 服务商 | Base URL | 模型示例 |
|---|---|---|
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
- 请遵守 X 服务条款与所用 API 的使用条款；本工具定位是个人辅助写作，请勿用于批量刷评、垃圾信息等自动化滥用
- X 前端改版可能导致选择器失效（`data-testid` 变动），届时更新 `content/content.js` 中的选择器即可
- 推文中的图片/视频内容目前不参与识别（纯文本上下文）

## 二次开发

- 重新生成图标：`node icons/gen-icons.js`（零依赖）
- 改默认预设：`shared/common.js`
- 加新的接入方式：`background/service-worker.js` 的 `resolveProviderCfg`

## Roadmap

- [ ] 图文推文的多模态识别（传入图片给视觉模型）
- [ ] 楼中楼（回复的回复）上下文携带
- [ ] 配置导入/导出 JSON
- [ ] 多条候选批量生成
