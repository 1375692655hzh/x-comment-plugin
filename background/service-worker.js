// =============================================================
// X 评论副驾 — MV3 Service Worker（薄壳，v0.4.0）
// 职责：GENERATE（content 发起，需要跨域豁免）+ 兼容兜底消息。
// 设置页的网络操作（OAuth 设备流/连通测试/更新检查）已迁移至
// options 页直连（见 shared/api.js），不再依赖本文件存活。
//
// ⚠⚠ 本文件严禁声明 shared/*.js 已有的顶层 const！
//   classic script 共享全局词法环境，跨文件重复声明 const 会导致
//   整个 SW 实例化时 SyntaxError、一行都不会执行。
//   v0.3.1–v0.3.3 的"后台注册了但永不响应"正是这个原因（const XCC_ZIP_URL
//   与 shared/common.js 重复声明），曾被误诊为 Edge 休眠问题。
// =============================================================
importScripts('/shared/common.js', '/shared/api.js');

// ---------- 提示词组装（仅 GENERATE 使用） ----------

function findPreset(list, id) {
  return list.find((p) => p.id === id) || list[0];
}

function buildMessages(s, req) {
  const persona = findPreset(s.personaPresets, s.activePersonaId);
  const gen = findPreset(s.genPresets, s.activeGenId);
  const tweet = req && req.tweet ? req.tweet : null;
  const topic = req && req.topic ? String(req.topic).trim() : '';
  const tweetText = tweet && tweet.text ? String(tweet.text).trim() : '';
  const author = tweet && tweet.author ? String(tweet.author) : '';

  let prompt = gen ? String(gen.prompt) : '';
  const hadTweetPlaceholder = prompt.includes('{tweet_text}');
  const hadTopicPlaceholder = prompt.includes('{topic}');
  prompt = prompt
    .split('{tweet_text}')
    .join(tweetText)
    .split('{author}')
    .join(author)
    .split('{topic}')
    .join(topic);

  // 提示词里没放占位符时，自动把上下文附在末尾，保证模型能看见推文/主题
  const extra = [];
  if (tweetText && !hadTweetPlaceholder) {
    extra.push('推文作者：' + (author || '未知') + '\n推文内容：\n' + tweetText);
  }
  if (topic && !hadTopicPlaceholder) extra.push('主题：' + topic);
  if (extra.length) prompt += (prompt ? '\n\n---\n' : '') + extra.join('\n\n');

  if (!prompt.trim()) {
    prompt =
      tweetText || topic
        ? '请针对以下内容写一条高质量、口语化的 X 回复：\n' + (tweetText || topic)
        : '请写一条适合发布在 X 上的原创推文。';
  }

  let sys = persona ? String(persona.persona) : '你是 X 平台上的活跃用户，表达自然。';
  if (s.genParams.language === 'zh') sys += '\n\n务必使用中文撰写。';
  else if (s.genParams.language === 'en') sys += '\n\nAlways write in English.';
  else sys += '\n\n默认使用与推文相同的语言；无法判断时用中文。';

  return [
    { role: 'system', content: sys },
    { role: 'user', content: prompt }
  ];
}

// ---------- 消息路由（GENERATE 为主；其余为兼容兜底） ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg && msg.type) {
      case 'GENERATE': {
        const s = await xccGetSettings();
        const cfg = await xccResolveProviderCfg(s);
        const messages = buildMessages(s, msg);
        const text = await xccChatCompletion(cfg, messages, s.genParams);
        return sendResponse({ ok: true, text });
      }
      case 'OPEN_OPTIONS': {
        chrome.runtime.openOptionsPage();
        return sendResponse({ ok: true });
      }
      case 'CHECK_UPDATE': {
        return sendResponse({ ok: true, update: await xccCheckUpdate() });
      }
      case 'TEST_PROVIDER': {
        const s = await xccGetSettings();
        const cfg = await xccResolveProviderCfg(s);
        const text = await xccChatCompletion(
          cfg,
          [{ role: 'user', content: '这是一条连通性测试，请只回复：pong' }],
          { temperature: 0, maxTokens: 10 }
        );
        return sendResponse({ ok: true, text });
      }
      case 'OAUTH_START': {
        const s = await xccGetSettings();
        const data = await xccStartDeviceAuth(s.grokOAuth);
        return sendResponse({ ok: true, ...data });
      }
      case 'OAUTH_POLL': {
        const s = await xccGetSettings();
        const r = await xccPollDeviceToken(s.grokOAuth, msg.device_code);
        if (r.status === 'authorized' && r.tokens) {
          await xccMutateSettings((m) => {
            m.grokOAuth = { ...m.grokOAuth, tokens: r.tokens };
          });
        }
        return sendResponse({ ok: true, status: r.status, slow_down: !!r.slow_down });
      }
      case 'OAUTH_LOGOUT': {
        await xccMutateSettings((m) => {
          m.grokOAuth = { ...m.grokOAuth, tokens: null };
        });
        return sendResponse({ ok: true });
      }
      default:
        return sendResponse({ ok: false, error: '未知消息类型' });
    }
  })().catch((e) => sendResponse({ ok: false, error: e && e.message ? e.message : String(e) }));
  return true; // 异步 sendResponse
});

chrome.runtime.onStartup.addListener(() => xccCheckUpdate());

chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings) await chrome.storage.local.set({ settings: XCC_DEFAULTS });
  xccCheckUpdate();
});
