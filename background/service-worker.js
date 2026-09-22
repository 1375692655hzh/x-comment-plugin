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

  // 输出格式硬约束：压制 markdown 残留与"好的/以下是…"类前后缀
  sys +=
    '\n\n输出格式硬约束：直接输出评论正文本身。不要使用任何 markdown（# 标题、**加粗**、' +
    '列表符号、`代码` 都不要），不要任何前言或后语（如"好的""以下是评论""希望有帮助"），' +
    '不要用引号把正文包起来；话题标签（#hashtag）允许使用。';

  // 观点倾向：客观零注入；乐观/消极注入方向指令（影响观点走向，不改变人设与风格）
  if (s.stance === 'optimistic') {
    sys +=
      '\n\n观点倾向：整体持乐观视角。看到机会、进展与积极面，语气有热忱但不盲目吹捧，' +
      '可以承认风险但要给出"为什么仍然值得看好"的理由。';
  } else if (s.stance === 'pessimistic') {
    sys +=
      '\n\n观点倾向：整体持审慎/批判视角。关注风险、隐患与被忽视的问题，语气冷静克制、不阴阳怪气，' +
      '可以肯定局部但要说清"哪里仍然令人担忧"。';
  }

  // 账号模式长度指令（脏值一律按免费处理）
  if (s.genParams.xPlan === 'premium') {
    const n = parseInt(s.genParams.targetLength, 10);
    if (Number.isFinite(n) && n >= 1 && n <= 2000) {
      sys += '\n\n长度参考：目标约 ' + n + ' 字，不必严格，以自然表达为准。';
    }
  } else {
    sys +=
      '\n\n长度硬约束：X 免费账户单条回复上限 280 个字符，你的输出总长不得超过 280 个字符（含标点、空格与 emoji）。';
  }

  return [
    { role: 'system', content: sys },
    { role: 'user', content: prompt }
  ];
}

// 去AI味二段改写（v0.5.9）：第一段生成结果再走一遍"人味改写"。
// 规则参考 blader/humanizer 与 op7418/Humanizer-zh 的 AI 痕迹清单（杀"不只是X更是Y"
// 句式/三项排比/AI 高频词/总结升华句，注入长短句交错与具体细节），按短评场景自写。
// 硬约束：不改观点倾向、不新增事实、长度不超第一段的账号模式约束，语言跟随原设置。
function buildHumanizeMessages(s, text) {
  let sys =
    '你是社交平台评论的"人味改写器"：把给出的评论改写得像真人随手发的帖子，' +
    '只输出改写后的评论本身，不要任何说明或前后语。改写规则：\n' +
    '- 直接说事：删掉"不只是X，更是Y"句式、总结升华句、"其实/说白了/值得注意的是"类铺垫\n' +
    '- 打破工整：不用三项排比、不用整齐对仗，长短句随意交错，能短则短\n' +
    '- 说人话：不用"深入、格局、赋能、无疑、彰显、令人"这类 AI 高频词，换最平实的说法\n' +
    '- 像打字不像写作：可以有口语、省略、轻微的语气和情绪，别堆 emoji，不用 markdown\n' +
    '- 具体优先：抽象概括换成具体细节；没有可换的就保持原样，绝不编造新事实\n' +
    '- 原评论开头的固定前缀（如「省流：」）必须原样保留——那是风格标记，不是正文';
  if (s.genParams.language === 'zh') sys += '\n\n保持中文。';
  else if (s.genParams.language === 'en') sys += '\n\nKeep it in English.';
  else sys += '\n\n保持原评论的语言不变。';
  // 长度约束与第一段一致：免费 280 硬约束（改写不得变长突破上限）；付费模糊参考
  if (s.genParams.xPlan === 'premium') {
    sys += '\n\n长度与原评论相近即可，不得明显变长。';
  } else {
    sys += '\n\n长度硬约束：改写结果总长不得超过 280 个字符（含标点、空格与 emoji）。';
  }
  return [
    { role: 'system', content: sys },
    { role: 'user', content: '原评论：\n' + text }
  ];
}

// ---------- 消息路由（GENERATE 为主；其余为兼容兜底） ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg && msg.type) {
      case 'GENERATE': {
        const s = await xccGetSettings();
        const cfg = await xccResolveProviderCfg(s);
        let text = await xccChatCompletion(cfg, buildMessages(s, msg), s.genParams);
        let humanized = false;
        let humanizeError = '';
        // 去AI味：第二段"人味改写"。失败不连坐第一段成果——回退原稿继续可用
        if (s.genParams.humanize === 'on' && text) {
          try {
            text = await xccChatCompletion(cfg, buildHumanizeMessages(s, text), s.genParams);
            humanized = true;
          } catch (e) {
            humanizeError = e && e.message ? e.message : String(e);
          }
        }
        return sendResponse({ ok: true, text, humanized, humanizeError });
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
