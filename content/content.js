// =============================================================
// X 评论副驾 — Content Script（注入 x.com / twitter.com）
// 功能：
//   1. 悬停任意推文 → 右上角出现 ✦ 捕获按钮（识别推文文本/作者）
//   2. 右侧悬浮面板：选人设 + 生成风格 → 调后台生成评论
//   3. 「填入回复框」：自动点开该推文的回复框并写入草稿（Draft.js 兼容）
// 所有 UI 挂在 Shadow DOM 中，避免被 X 的样式污染
// =============================================================
(function () {
  'use strict';

  const state = {
    settings: null,
    captured: null, // { author, name, text, href } 当前捕获的推文
    generatedFor: null, // 生成结果对应的推文快照（防止回错帖）
    generating: false,
    inserting: false, // 填入进行中：防双击竞态
    genCancel: null // 生成中点按钮触发的"放弃等待"回调
  };

  // ---------- 界面文案多语言（v0.5.23） ----------

  // 面板高频文案按 uiLanguage 切换（设置页配置，默认 zh）。zh 条目 = 历史文案
  // 原样（冒烟断言基准，一字不能差）；{x} 占位符由 T(key, params) 替换。
  // 长尾排障类错误文案不进表保持中文——面向装机人（中文用户替朋友装机场景）。
  const XCC_UI_TEXT = {
    zh: {
      vendor: '供应商', model: '模型', persona: '人设', style: '生成风格',
      stanceNeg: '消极', stanceObj: '客观', stancePos: '乐观',
      langAuto: '跟推文', langTitle: '输出语种：生成回复与去AI味改写都跟随；跟推文=随原推语言',
      uiLangAuto: '跟浏览器', uiLangTitle: '界面语言：切换本面板的按钮与提示文案（不影响生成语种）',
      planFree: '免费 · ≤280 字符', planPremium: '付费 · 不限长',
      targetLenPh: '目标字数（选填，如 120，模糊参考）',
      captured: '已捕获推文', clearTitle: '清除捕获', captureTitle: '捕获这条推文',
      captureHint: '把鼠标悬停在任意推文上，点 ✦ 即可捕获',
      topicPh: '或输入主题（生成原创推文用）',
      gen: '✦ 生成', genStop: '⏹ 放弃等待',
      humLabel: '去AI味', humOn: '开', humOff: '关',
      insert: '填入回复框', copy: '复制', regen: '换一条',
      outPh: '生成结果（可手动修改后再填入）',
      settings: '⚙ 设置', closeTitle: '收起面板',
      countUnit: '字',
      updBanner: '🆕 有新版 v{v}：点击下载 ZIP，解压替换后重新加载扩展',
      unreadyTip: '当前接入方式未配置完成（{p}）。点右上角 ⚙ 打开设置完成配置后再生成',
      whereReply: '回复框', whereDialog: '弹出的回复框', wherePost: '发帖框',
      stNoContent: '还没有内容可填入',
      stCopied: '已复制',
      stCopyFail: '复制失败：剪贴板不可用，请手动全选输出框复制',
      stGenerating: '正在生成…',
      stGenWait: '仍在生成中…已耗时 {s} 秒。不想等可点「{stop}」；结果返回后会自动填入',
      stGenDone: '已生成，可编辑后填入',
      stGenDoneHum: '已生成（已去AI味），可编辑后填入',
      stGenDoneHumFail: '已生成，可编辑后填入（去AI味未成功，已用原稿）',
      stInserted: '✓ 已填入{where}，检查后手动点发送',
      stInsertedBy: '✓ 已按生成时的推文（{a}）填入{where}，检查后手动发送',
      stInsertedPost: '✓ 已填入发帖框，检查后手动发送',
      stAutoCorrected: '已自动纠正一次异常插入，请检查。',
      stDupSkip: '回复框已包含该内容，未重复填入',
      stDupSkipPost: '发帖框已包含该内容，未重复填入',
      stFillFail: '填入异常（未能确认唯一内容或编辑器清不干净），已复制，请手动粘贴',
      stFillFailPost: '填入异常（未能确认唯一内容或编辑器清不干净），已复制',
      stNoTweet: '页面上找不到原推文（可能已滚出屏幕），请滚回该推文附近再试',
      stNoReplyBtn: '找不到该推文的回复按钮',
      stBoxNotOpen: '回复框未能打开，内容已复制，请手动粘贴',
      stNoComposer: '未找到发帖输入框：请先打开 X 首页，或手动点开发帖框后重试',
      stCaptured: '已捕获 {a} 的推文，点「{gen}」',
      stTweetNoText: '该推文没有可识别的文本（可能只有图片/视频）',
      stImgOnly: '该推文没有可识别文本（仅图片/视频）：可改为在下方输入主题生成原创推文',
      stNeedInput: '请先捕获一条推文，或在下方输入主题',
      stReloaded: '⚠ 扩展已重新加载，请刷新本页（F5）后继续使用',
      stSettingsFail: '⚠ 设置读取失败：请在扩展管理页点「重新加载」后刷新页面'
    },
    en: {
      vendor: 'Provider', model: 'Model', persona: 'Persona', style: 'Style',
      stanceNeg: 'Negative', stanceObj: 'Neutral', stancePos: 'Positive',
      langAuto: 'Auto', langTitle: 'Output language (used for generation and humanize pass); Auto = follow the tweet',
      uiLangAuto: 'Browser', uiLangTitle: 'UI language: switches this panel’s labels and messages (does not change the output language)',
      planFree: 'Free · ≤280 chars', planPremium: 'Paid · unlimited',
      targetLenPh: 'Target length (optional, e.g. 120)',
      captured: 'Captured tweet', clearTitle: 'Clear capture', captureTitle: 'Capture this tweet',
      captureHint: 'Hover any tweet and click ✦ to capture',
      topicPh: 'Or type a topic (for original posts)',
      gen: '✦ Generate', genStop: '⏹ Stop waiting',
      humLabel: 'Humanize', humOn: 'On', humOff: 'Off',
      insert: 'Insert', copy: 'Copy', regen: 'Retry',
      outPh: 'Result (you can edit before inserting)',
      settings: '⚙ Settings', closeTitle: 'Hide panel',
      countUnit: ' chars',
      updBanner: '🆕 New version v{v}: download ZIP, replace files, reload the extension',
      unreadyTip: 'Current provider is not configured ({p}). Open ⚙ Settings to finish setup first',
      whereReply: 'the reply box', whereDialog: 'the dialog reply box', wherePost: 'the post box',
      stNoContent: 'Nothing to insert yet',
      stCopied: 'Copied',
      stCopyFail: 'Copy failed: clipboard unavailable, select the output box and copy manually',
      stGenerating: '⏳ Generating…',
      stGenWait: 'Still generating… {s}s elapsed. Click "{stop}" to give up; the result will auto-insert when it arrives',
      stGenDone: 'Generated — edit, then insert',
      stGenDoneHum: 'Generated (humanized) — edit, then insert',
      stGenDoneHumFail: 'Generated — edit, then insert (humanize failed, kept draft)',
      stInserted: '✓ Inserted into {where} — check it, then hit Send yourself',
      stInsertedBy: '✓ Inserted into {where} for the tweet captured at generation time ({a}) — check, then send',
      stInsertedPost: '✓ Inserted into the post box — check it, then post',
      stAutoCorrected: 'Auto-corrected one abnormal insertion, please review. ',
      stDupSkip: 'The reply box already contains this content — not inserted again',
      stDupSkipPost: 'The post box already contains this content — not inserted again',
      stFillFail: 'Insert failed (could not confirm unique content or clear the editor) — copied, please paste manually',
      stFillFailPost: 'Insert failed (could not confirm unique content or clear the editor) — copied',
      stNoTweet: 'Original tweet not found on this page (may have scrolled away) — scroll back near it and retry',
      stNoReplyBtn: 'Reply button not found for this tweet',
      stBoxNotOpen: 'Reply box failed to open — content copied, please paste manually',
      stNoComposer: 'Post box not found: open the X home page first, or open the composer and retry',
      stCaptured: 'Captured a tweet by {a} — click "{gen}"',
      stTweetNoText: 'This tweet has no recognizable text (maybe only image/video)',
      stImgOnly: 'No recognizable text (image/video only): type a topic below to generate an original post instead',
      stNeedInput: 'Capture a tweet first, or type a topic below',
      stReloaded: '⚠ Extension was reloaded — refresh this page (F5) to continue',
      stSettingsFail: '⚠ Failed to read settings: click "Reload" on the extensions page, then refresh'
    },
    ja: {
      vendor: 'プロバイダー', model: 'モデル', persona: 'ペルソナ', style: 'スタイル',
      stanceNeg: '悲観', stanceObj: '客観', stancePos: '楽観',
      langAuto: 'ツイートに合わせる', langTitle: '出力言語（生成・AI消し両方に適用）。ツイートに合わせる=元ツイートの言語に従う',
      uiLangAuto: 'ブラウザー', uiLangTitle: '表示言語：このパネルのボタンやメッセージを切り替えます（出力言語には影響しません）',
      planFree: '無料 · ≤280字', planPremium: '有料 · 無制限',
      targetLenPh: '目標文字数（任意・例 120）',
      captured: '取得済みツイート', clearTitle: '取得を消す', captureTitle: 'このツイートを取得',
      captureHint: 'ツイートにカーソルを合わせ、✦ をクリックで取得',
      topicPh: 'またはテーマを入力（オリジナル投稿用）',
      gen: '✦ 生成', genStop: '⏹ 中止',
      humLabel: 'AI消し', humOn: '入', humOff: '切',
      insert: '挿入', copy: 'コピー', regen: 'もう一件',
      outPh: '生成結果（挿入前に編集できます）',
      settings: '⚙ 設定', closeTitle: 'パネルを閉じる',
      countUnit: '文字',
      updBanner: '🆕 新版 v{v}：ZIP をダウンロード・置換して拡張を再読み込み',
      unreadyTip: 'プロバイダー未設定（{p}）。右上の ⚙ で設定を完了してください',
      whereReply: '返信ボックス', whereDialog: 'ダイアログの返信ボックス', wherePost: '投稿ボックス',
      stNoContent: '挿入する内容がありません',
      stCopied: 'コピーしました',
      stCopyFail: 'コピー失敗：クリップボード利用不可。出力欄を手動で全選択してコピーしてください',
      stGenerating: '⏳ 生成中…',
      stGenWait: '生成中…{s}秒経過。待ちたくない場合は「{stop}」を押してください。結果は届き次第自動挿入されます',
      stGenDone: '生成完了 — 編集してから挿入',
      stGenDoneHum: '生成完了（AI消し済み） — 編集してから挿入',
      stGenDoneHumFail: '生成完了 — 編集してから挿入（AI消し失敗、初稿を使用）',
      stInserted: '✓ {where}に挿入しました。確認してから送信してください',
      stInsertedBy: '✓ 生成時のツイート（{a}）の{where}に挿入しました。確認してから送信',
      stInsertedPost: '✓ 投稿ボックスに挿入しました。確認してから投稿',
      stAutoCorrected: '異常挿入を一度自動修正しました。確認してください。 ',
      stDupSkip: '返信ボックスに同内容が既にあるため、再挿入しません',
      stDupSkipPost: '投稿ボックスに同内容が既にあるため、再挿入しません',
      stFillFail: '挿入異常（内容の一意性を確認できないか編集枠を空にできません）— コピー済み、手動貼り付けください',
      stFillFailPost: '挿入異常（内容の一意性を確認できないか編集枠を空にできません）— コピー済み',
      stNoTweet: 'ページ上に元ツイートが見つかりません（スクロールアウトした可能性）— 付近まで戻って再試行',
      stNoReplyBtn: 'このツイートの返信ボタンが見つかりません',
      stBoxNotOpen: '返信ボックスを開けませんでした — コピー済み、手動貼り付けください',
      stNoComposer: '投稿入力欄が見つかりません：X ホームを開くか、投稿欄を開いてから再試行',
      stCaptured: '{a} のツイートを取得しました。「{gen}」を押してください',
      stTweetNoText: 'このツイートには認識可能なテキストがありません（画像/動画のみの可能性）',
      stImgOnly: '認識可能なテキストなし（画像/動画のみ）：下のテーマ入力でオリジナル投稿を生成できます',
      stNeedInput: 'まずツイートを取得するか、下にテーマを入力してください',
      stReloaded: '⚠ 拡張が再読み込みされました — このページを更新（F5）して続行',
      stSettingsFail: '⚠ 設定の読み取り失敗：拡張管理ページで「再読み込み」→ ページ更新'
    },
    es: {
      vendor: 'Proveedor', model: 'Modelo', persona: 'Persona', style: 'Estilo',
      stanceNeg: 'Negativo', stanceObj: 'Neutral', stancePos: 'Positivo',
      langAuto: 'Seguir al tuit', langTitle: 'Idioma de salida (aplica a generación y reescritura); Seguir = idioma del tuit',
      uiLangAuto: 'Navegador', uiLangTitle: 'Idioma de la interfaz: cambia los textos de este panel (no afecta al idioma de salida)',
      planFree: 'Gratis · ≤280', planPremium: 'Premium · ilimitado',
      targetLenPh: 'Longitud objetivo (opcional, p. ej. 120)',
      captured: 'Tuit capturado', clearTitle: 'Borrar captura', captureTitle: 'Capturar este tuit',
      captureHint: 'Pasa el cursor sobre un tuit y pulsa ✦ para capturarlo',
      topicPh: 'O escribe un tema (para publicaciones propias)',
      gen: '✦ Generar', genStop: '⏹ Cancelar',
      humLabel: 'Humanizar', humOn: 'Sí', humOff: 'No',
      insert: 'Insertar', copy: 'Copiar', regen: 'Otro',
      outPh: 'Resultado (puedes editarlo antes de insertar)',
      settings: '⚙ Ajustes', closeTitle: 'Ocultar panel',
      countUnit: ' car.',
      updBanner: '🆕 Nueva versión v{v}: descarga el ZIP, reemplaza los archivos y recarga la extensión',
      unreadyTip: 'Proveedor sin configurar ({p}). Abre ⚙ Ajustes para completarlo',
      whereReply: 'el cuadro de respuesta', whereDialog: 'el cuadro de respuesta del diálogo', wherePost: 'el cuadro de publicación',
      stNoContent: 'Aún no hay nada que insertar',
      stCopied: 'Copiado',
      stCopyFail: 'Fallo al copiar: portapapeles no disponible; selecciona y copia manualmente',
      stGenerating: '⏳ Generando…',
      stGenWait: 'Sigue generando… {s}s transcurridos. Pulsa "{stop}" para cancelar; el resultado se insertará solo al llegar',
      stGenDone: 'Generado — edítalo e insértalo',
      stGenDoneHum: 'Generado (humanizado) — edítalo e insértalo',
      stGenDoneHumFail: 'Generado — edítalo e insértalo (humanizar falló, se usó el borrador)',
      stInserted: '✓ Insertado en {where} — revísalo y pulsa Enviar tú mismo',
      stInsertedBy: '✓ Insertado en {where} para el tuit capturado al generar ({a}) — revisa y envía',
      stInsertedPost: '✓ Insertado en el cuadro de publicación — revísalo y publica',
      stAutoCorrected: 'Se corrigió automáticamente una inserción anómala; revisa. ',
      stDupSkip: 'El cuadro de respuesta ya contiene este contenido — no se inserta de nuevo',
      stDupSkipPost: 'El cuadro de publicación ya contiene este contenido — no se inserta de nuevo',
      stFillFail: 'Fallo al insertar (contenido no único o editor sin vaciar) — copiado, pégalo manualmente',
      stFillFailPost: 'Fallo al insertar (contenido no único o editor sin vaciar) — copiado',
      stNoTweet: 'No se encuentra el tuit original (quizá se desplazó) — vuelve cerca de él y reintenta',
      stNoReplyBtn: 'No se encontró el botón de responder de este tuit',
      stBoxNotOpen: 'No se pudo abrir el cuadro de respuesta — copiado, pégalo manualmente',
      stNoComposer: 'Cuadro de publicación no encontrado: abre el inicio de X o el editor y reintenta',
      stCaptured: 'Tuit de {a} capturado — pulsa "{gen}"',
      stTweetNoText: 'Este tuit no tiene texto reconocible (quizá solo imagen/vídeo)',
      stImgOnly: 'Sin texto reconocible (solo imagen/vídeo): escribe un tema abajo para generar una publicación propia',
      stNeedInput: 'Captura primero un tuit o escribe un tema abajo',
      stReloaded: '⚠ La extensión se recargó — actualiza esta página (F5) para continuar',
      stSettingsFail: '⚠ Error al leer ajustes: pulsa «Recargar» en la página de extensiones y refresca'
    },
    de: {
      vendor: 'Anbieter', model: 'Modell', persona: 'Persona', style: 'Stil',
      stanceNeg: 'Negativ', stanceObj: 'Neutral', stancePos: 'Positiv',
      langAuto: 'Wie Tuit', langTitle: 'Ausgabesprache (gilt für Generierung und Umformung); Wie Tuit = Sprache des Tweets',
      uiLangAuto: 'Browser', uiLangTitle: 'Oberflächensprache: wechselt die Texte dieses Panels (ändert nicht die Ausgabesprache)',
      planFree: 'Gratis · ≤280', planPremium: 'Premium · unbegrenzt',
      targetLenPh: 'Ziellänge (optional, z. B. 120)',
      captured: 'Erfasster Tweet', clearTitle: 'Erfassung löschen', captureTitle: 'Diesen Tweet erfassen',
      captureHint: 'Tweet mit der Maus überfahren und ✦ klicken',
      topicPh: 'Oder Thema eingeben (für eigene Beiträge)',
      gen: '✦ Erstellen', genStop: '⏹ Abbrechen',
      humLabel: 'Humanisieren', humOn: 'ein', humOff: 'aus',
      insert: 'Einfügen', copy: 'Kopieren', regen: 'Neu',
      outPh: 'Ergebnis (vor dem Einfügen bearbeitbar)',
      settings: '⚙ Einstellungen', closeTitle: 'Panel ausblenden',
      countUnit: ' Zeich.',
      updBanner: '🆕 Neue Version v{v}: ZIP herunterladen, Dateien ersetzen, Erweiterung neu laden',
      unreadyTip: 'Anbieter nicht konfiguriert ({p}). Zuerst über ⚙ Einstellungen abschließen',
      whereReply: 'das Antwortfeld', whereDialog: 'das Antwortfeld des Dialogs', wherePost: 'das Beitragsfeld',
      stNoContent: 'Noch nichts zum Einfügen',
      stCopied: 'Kopiert',
      stCopyFail: 'Kopieren fehlgeschlagen: Zwischenablage nicht verfügbar — manuell auswählen und kopieren',
      stGenerating: '⏳ Generiere…',
      stGenWait: 'Generiert noch… {s}s vergangen. „{stop}" zum Abbrechen; das Ergebnis wird automatisch eingefügt',
      stGenDone: 'Erstellt — bearbeiten, dann einfügen',
      stGenDoneHum: 'Erstellt (humanisiert) — bearbeiten, dann einfügen',
      stGenDoneHumFail: 'Erstellt — bearbeiten, dann einfügen (Humanisieren fehlgeschlagen, Entwurf verwendet)',
      stInserted: '✓ In {where} eingefügt — prüfen und selbst senden',
      stInsertedBy: '✓ In {where} für den beim Generieren erfassten Tweet ({a}) eingefügt — prüfen und senden',
      stInsertedPost: '✓ Ins Beitragsfeld eingefügt — prüfen und selbst posten',
      stAutoCorrected: 'Eine fehlerhafte Einfügung wurde automatisch korrigiert — bitte prüfen. ',
      stDupSkip: 'Das Antwortfeld enthält diesen Inhalt bereits — nicht erneut eingefügt',
      stDupSkipPost: 'Das Beitragsfeld enthält diesen Inhalt bereits — nicht erneut eingefügt',
      stFillFail: 'Einfügen fehlgeschlagen (Inhalt nicht eindeutig oder Editor nicht leerbar) — kopiert, manuell einfügen',
      stFillFailPost: 'Einfügen fehlgeschlagen (Inhalt nicht eindeutig oder Editor nicht leerbar) — kopiert',
      stNoTweet: 'Original-Tweet nicht auf der Seite (wohl weggerollt) — dorthin zurückscrollen und erneut versuchen',
      stNoReplyBtn: 'Antworten-Schaltfläche dieses Tweets nicht gefunden',
      stBoxNotOpen: 'Antwortfeld ließ sich nicht öffnen — kopiert, manuell einfügen',
      stNoComposer: 'Beitragsfeld nicht gefunden: X-Startseite öffnen oder Verfassen öffnen, dann erneut',
      stCaptured: 'Tweet von {a} erfasst — „{gen}" klicken',
      stTweetNoText: 'Dieser Tweet hat keinen erkennbaren Text (evtl. nur Bild/Video)',
      stImgOnly: 'Kein erkennbarer Text (nur Bild/Video): unten ein Thema eingeben und stattdessen einen eigenen Beitrag erstellen',
      stNeedInput: 'Zuerst einen Tweet erfassen oder unten ein Thema eingeben',
      stReloaded: '⚠ Erweiterung wurde neu geladen — Seite aktualisieren (F5) und fortfahren',
      stSettingsFail: '⚠ Einstellungen nicht lesbar: auf der Erweiterungsseite „Neu laden" klicken, dann aktualisieren'
    }
  };

  // 当前界面语言：'auto' 时按浏览器 locale 解析（ja/es/de/en 前缀命中即用，回落 zh）
  let uiLang = 'zh';
  function resolveUiLang(pref) {
    if (pref && pref !== 'auto' && XCC_UI_TEXT[pref]) return pref;
    if (pref === 'auto') {
      const langs = (navigator.languages && navigator.languages.length
        ? navigator.languages
        : [navigator.language || 'zh']
      ).map((x) => String(x || '').toLowerCase());
      for (const l of langs) {
        const hit = ['ja', 'es', 'de', 'en', 'zh'].find((k) => l === k || l.startsWith(k + '-'));
        if (hit && XCC_UI_TEXT[hit]) return hit;
      }
    }
    return 'zh';
  }

  // 取当前界面语言文案；{x} 占位符用 params 替换；缺 key/缺语言回落 zh（冒烟基准）
  function T(key, params) {
    let v = XCC_UI_TEXT[uiLang] && XCC_UI_TEXT[uiLang][key];
    if (v === undefined) v = XCC_UI_TEXT.zh[key];
    if (params) {
      for (const k of Object.keys(params)) v = String(v).split('{' + k + '}').join(params[k]);
    }
    return v;
  }

  // ---------- 基础工具 ----------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          const le = chrome.runtime.lastError;
          resolve(
            resp || {
              ok: false,
              noBackend: true,
              error: le && le.message
                ? '后台不可用（' + String(le.message).slice(0, 80) + '）'
                : '后台无响应'
            }
          );
        });
      } catch (e) {
        resolve({ ok: false, noBackend: true, error: '扩展上下文已失效（扩展可能刚更新）' });
      }
    });
  }

  // ---------- UI（Shadow DOM） ----------

  const host = document.createElement('div');
  host.id = 'xcc-host';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
  <style>
    :host { all: initial; color-scheme: dark; }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI",
        Roboto, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif; }
    button { cursor: pointer; }
    .xcc-launcher {
      position: fixed; right: 16px; top: 42%;
      width: 44px; height: 44px; border-radius: 50%;
      border: none; color: #fff; font-size: 20px; line-height: 1;
      background: linear-gradient(135deg, #8b5cfa, #4f46e5);
      box-shadow: 0 4px 14px rgba(79, 70, 229, .45);
      z-index: 2147483000; transition: transform .12s ease;
    }
    .xcc-launcher:hover { transform: scale(1.08); }
    .xcc-launcher.left { right: auto; left: 16px; }
    .xcc-hover-btn {
      position: fixed; display: none;
      width: 26px; height: 26px; border-radius: 8px;
      border: 1px solid rgba(255,255,255,.18);
      color: #fff; font-size: 13px; line-height: 23px; text-align: center; padding: 0;
      background: linear-gradient(135deg, #8b5cfa, #4f46e5);
      box-shadow: 0 2px 8px rgba(0,0,0,.35);
      z-index: 2147483000;
    }
    /* v0.5.0：全高侧边栏（SoPilot 式），默认停靠右侧，.left 切左侧（v0.5.1 翻转） */
    .xcc-panel {
      position: fixed; top: 0; bottom: 0; right: 0;
      width: 380px; height: 100vh;
      background: rgba(21, 24, 31, .98); color: #e7e9ea;
      border: 1px solid rgba(255,255,255,.12); border-right: none;
      border-radius: 16px 0 0 16px;
      padding: 14px; z-index: 2147483000;
      box-shadow: -8px 0 32px rgba(0, 0, 0, .5);
      display: flex; flex-direction: column; gap: 5px;
      overflow: hidden; /* 滚动下放给内部滚动区（推文框/输出框） */
    }
    .xcc-panel.left {
      right: auto; left: 0;
      border-right: 1px solid rgba(255,255,255,.12); border-left: none;
      border-radius: 0 16px 16px 0;
      box-shadow: 8px 0 32px rgba(0, 0, 0, .5);
    }
    /* .xcc-panel 的 display:flex 会盖掉浏览器默认的 [hidden]{display:none}，必须显式声明 */
    .xcc-panel[hidden] { display: none; }
    .xcc-head { display: flex; align-items: center; justify-content: space-between; }
    .xcc-title { font-weight: 700; font-size: 14px; }
    .xcc-mini {
      background: transparent; border: none; color: #9ca3af;
      font-size: 13px; padding: 2px 5px; border-radius: 6px;
    }
    .xcc-mini:hover { background: rgba(255,255,255,.1); color: #e7e9ea; }
    /* 设置入口（v0.5.11 用户要求加醒目）：头部主视觉按钮，带文字不再只是小齿轮 */
    button.xcc-set {
      background: linear-gradient(135deg, rgba(139,92,250,.4), rgba(79,70,229,.4));
      border: 1px solid rgba(124,143,245,.6); color: #e0e5ff;
      font-size: 12.5px; font-weight: 600; padding: 4px 12px; border-radius: 999px;
    }
    button.xcc-set:hover { filter: brightness(1.15); color: #fff; }
    /* 界面语言下拉（v0.5.24）：放面板头部——受众是外语用户自己，设置页全中文他们
       找不到入口。选项用自称（中文/English/日本語/...），任何界面语言下都认得出 */
    select.xcc-uilang {
      width: 86px; padding: 3px 4px; font-size: 12px;
      border-radius: 8px; border-color: rgba(255,255,255,.18);
      margin-right: 2px;
    }
    .xcc-update {
      font-size: 11.5px; color: #fbbf24; cursor: pointer;
      padding: 4px 8px; border-radius: 7px;
      background: rgba(251, 191, 36, .08);
    }
    .xcc-update:hover { background: rgba(251, 191, 36, .16); }
    .xcc-lb { font-size: 11px; color: #9ca3af; margin-top: 2px; }
    select, input.xcc-topic {
      background: rgba(255,255,255,.06); color: #e7e9ea;
      border: 1px solid rgba(255,255,255,.14); border-radius: 8px;
      padding: 7px 8px; font-size: 13px; outline: none; width: 100%;
    }
    select:focus, input.xcc-topic:focus { border-color: #7c8ff5; }
    /* 原生下拉列表默认走系统浅色渲染，会白底配浅字看不清：强制深色 */
    select option { background: #1f2733; color: #e7e9ea; }
    .xcc-tweet {
      border: 1px dashed rgba(255,255,255,.18); border-radius: 10px;
      padding: 6px 10px; font-size: 12px;
      flex: 1 1 0; min-height: 64px; max-height: 180px;
      display: flex; flex-direction: column; overflow: hidden;
    }
    .xcc-tweet-hd {
      display: flex; justify-content: space-between; align-items: center;
      color: #9ca3af; font-size: 11px; margin-bottom: 4px;
    }
    /* 已捕获推文：弹性伸展 + 内部滚动（v0.5.0 侧栏形态，内容多时自己滚） */
    .xcc-tweet-bd { color: #d1d5db; white-space: pre-wrap; word-break: break-word;
      flex: 1 1 auto; overflow: auto; line-height: 1.45; }
    .xcc-plan-row { display: flex; gap: 6px; }
    .xcc-plan-btn {
      flex: 1; border-radius: 9px; padding: 6px 0; font-size: 12px;
      border: 1px solid rgba(255,255,255,.16);
      background: rgba(255,255,255,.05); color: #9ca3af;
    }
    .xcc-plan-btn.on { color: #fff; border-color: #7c8ff5; background: rgba(124,143,245,.18); }
    .xcc-stance-row { display: flex; gap: 6px; }
    .xcc-stance-btn {
      flex: 1; border-radius: 9px; padding: 5px 0; font-size: 12px;
      border: 1px solid rgba(255,255,255,.16);
      background: rgba(255,255,255,.05); color: #9ca3af;
    }
    .xcc-stance-btn.on { color: #fff; border-color: #7c8ff5; background: rgba(124,143,245,.18); }
    /* 语种下拉（v0.5.23 注册表驱动，N 种语言不再用按钮堆）：与倾向按钮同排，
       借用全局 select 深色底、覆盖成行内紧凑尺寸 */
    select.xcc-lang {
      flex: 0 0 116px; width: 116px; padding: 5px 4px; font-size: 12px;
      border-radius: 9px; border-color: rgba(255,255,255,.16);
    }
    input.xcc-target-len { padding: 6px 8px; font-size: 12.5px; height: 30px; }
    .xcc-gen-btn {
      border: none; border-radius: 10px; padding: 9px 0;
      color: #fff; font-size: 14px; font-weight: 600;
      background: linear-gradient(135deg, #8b5cfa, #4f46e5);
    }
    .xcc-gen-btn:disabled { opacity: .55; cursor: not-allowed; }
    .xcc-out-bar { display: flex; justify-content: space-between; align-items: center; flex: 0 0 auto;
      min-height: 14px; margin-bottom: -2px; }
    /* 去AI味开关（v0.5.9）：常驻输出框上方左侧；开启后每次生成多走一遍"人味改写"。
       v0.5.11 起改为胶囊按钮（用户要求加醒目），样式与倾向/模式按钮同族 */
    button.xcc-hum {
      background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.16);
      border-radius: 999px; padding: 4px 12px; cursor: pointer;
      font-size: 12px; color: #9ca3af; line-height: 1.3;
    }
    button.xcc-hum:hover { background: rgba(255,255,255,.1); color: #e7e9ea; }
    button.xcc-hum.on {
      color: #fff; font-weight: 600; border-color: #7c8ff5;
      background: linear-gradient(135deg, rgba(139,92,250,.5), rgba(79,70,229,.5));
    }
    .xcc-count { font-size: 11px; color: #9ca3af; line-height: 1.2; }
    .xcc-count.over { color: #f87171; font-weight: 600; }
    /* 生成输出框：v0.5.0 侧栏形态的主区，弹性伸展且占比最大（约为推文框 2.4 倍） */
    textarea.xcc-out {
      background: rgba(255,255,255,.04); color: #e7e9ea;
      border: 1px solid rgba(255,255,255,.14); border-radius: 10px;
      padding: 9px 10px; font-size: 13px;
      flex: 2.4 1 0; min-height: 260px; resize: none;
      outline: none; line-height: 1.45; overflow: auto;
    }
    textarea.xcc-out:focus { border-color: #7c8ff5; }
    .xcc-row { display: flex; gap: 6px; }
    .xcc-row button {
      flex: 1; border-radius: 9px; padding: 7px 0; font-size: 12.5px;
      border: 1px solid rgba(255,255,255,.16);
      background: rgba(255,255,255,.05); color: #e7e9ea;
    }
    .xcc-row button:hover { background: rgba(255,255,255,.1); }
    .xcc-row button:disabled { opacity: .55; cursor: not-allowed; }
    .xcc-row .xcc-main {
      background: linear-gradient(135deg, #8b5cfa, #4f46e5);
      border: none; color: #fff; font-weight: 600; flex: 1.4;
    }
    .xcc-status { font-size: 11.5px; color: #9ca3af; min-height: 15px; line-height: 1.4; }
    .xcc-status.err { color: #f87171; }
  </style>

  <button class="xcc-launcher" title="X 评论副驾">✦</button>
  <div class="xcc-hover-btn" title="捕获这条推文" data-i18n-title="captureTitle">✦</div>

  <div class="xcc-panel" hidden>
    <div class="xcc-head">
      <span class="xcc-title">✦ 评论副驾</span>
      <span>
        <select class="xcc-uilang" title="界面语言"></select>
        <button class="xcc-set" data-act="settings" title="打开设置（模型接入 / 提示词 / 生成参数）" data-i18n="settings">⚙ 设置</button>
        <button class="xcc-mini" data-act="close" title="收起面板" data-i18n-title="closeTitle">✕</button>
      </span>
    </div>
    <label class="xcc-lb" data-i18n="vendor">供应商</label>
    <select class="xcc-vendor" title="当前供应商，切换即生效；新增供应商与配置请到设置页"></select>
    <label class="xcc-lb" data-i18n="model">模型</label>
    <select class="xcc-model" title="当前供应商的可用模型，切换即生效；完整列表与自定义 ID 请到设置页"></select>
    <div class="xcc-update" hidden>🆕 有新版</div>
    <label class="xcc-lb" data-i18n="persona">人设</label>
    <select class="xcc-persona"></select>
    <label class="xcc-lb" data-i18n="style">生成风格</label>
    <select class="xcc-gen"></select>
    <div class="xcc-stance-row">
      <button class="xcc-stance-btn" data-act="stance-pessimistic" data-i18n="stanceNeg">消极</button>
      <button class="xcc-stance-btn" data-act="stance-objective" data-i18n="stanceObj">客观</button>
      <button class="xcc-stance-btn" data-act="stance-optimistic" data-i18n="stancePos">乐观</button>
      <select class="xcc-lang" title="输出语种"></select>
    </div>
    <div class="xcc-plan-row">
      <button class="xcc-plan-btn" data-act="plan-free" data-i18n="planFree">免费 · ≤280 字符</button>
      <button class="xcc-plan-btn" data-act="plan-premium" data-i18n="planPremium">付费 · 不限长</button>
    </div>
    <input class="xcc-target-len" type="number" min="1" max="2000"
      placeholder="目标字数（选填，如 120，模糊参考）" data-i18n-ph="targetLenPh" hidden>
    <div class="xcc-tweet">
      <div class="xcc-tweet-hd">
        <span data-i18n="captured">已捕获推文</span>
        <button class="xcc-mini" data-act="clear" title="清除捕获" data-i18n-title="clearTitle">✕</button>
      </div>
      <div class="xcc-tweet-bd">把鼠标悬停在任意推文上，点 ✦ 即可捕获</div>
    </div>
    <input class="xcc-topic" placeholder="或输入主题（生成原创推文用）" data-i18n-ph="topicPh">
    <button class="xcc-gen-btn" data-i18n="gen">✦ 生成</button>
    <div class="xcc-out-bar">
      <button class="xcc-hum" data-act="hum-toggle"
        title="去AI味：开启后每次生成会先出初稿、再自动走一遍「人味改写」（更像真人随手发的，AI 味更少）。代价：耗时与额度翻倍">去AI味：关</button>
      <span class="xcc-count">0/280</span>
    </div>
    <textarea class="xcc-out" placeholder="生成结果（可手动修改后再填入）" data-i18n-ph="outPh"></textarea>
    <div class="xcc-row">
      <button class="xcc-main" data-act="insert" data-i18n="insert">填入回复框</button>
      <button data-act="copy" data-i18n="copy">复制</button>
      <button data-act="regen" data-i18n="regen">换一条</button>
    </div>
    <div class="xcc-status"></div>
  </div>`;
  document.documentElement.appendChild(host);

  const els = {
    launcher: shadow.querySelector('.xcc-launcher'),
    hoverBtn: shadow.querySelector('.xcc-hover-btn'),
    panel: shadow.querySelector('.xcc-panel'),
    update: shadow.querySelector('.xcc-update'),
    modelSel: shadow.querySelector('.xcc-model'),
    vendorSel: shadow.querySelector('.xcc-vendor'),
    personaSel: shadow.querySelector('.xcc-persona'),
    genSel: shadow.querySelector('.xcc-gen'),
    stanceBtns: shadow.querySelectorAll('.xcc-stance-btn'),
    langSel: shadow.querySelector('.xcc-lang'),
    uilangSel: shadow.querySelector('.xcc-uilang'),
    planFree: shadow.querySelector('[data-act="plan-free"]'),
    planPremium: shadow.querySelector('[data-act="plan-premium"]'),
    targetLen: shadow.querySelector('.xcc-target-len'),
    tweetBd: shadow.querySelector('.xcc-tweet-bd'),
    topic: shadow.querySelector('.xcc-topic'),
    genBtn: shadow.querySelector('.xcc-gen-btn'),
    insertBtn: shadow.querySelector('.xcc-row [data-act="insert"]'),
    out: shadow.querySelector('.xcc-out'),
    hum: shadow.querySelector('.xcc-hum'),
    count: shadow.querySelector('.xcc-count'),
    status: shadow.querySelector('.xcc-status')
  };

  // ---------- 状态渲染 ----------

  function setStatus(text, isError) {
    els.status.textContent = text || '';
    els.status.classList.toggle('err', !!isError);
  }

  function renderTweetBox() {
    const c = state.captured;
    if (c && (c.text || c.author)) {
      els.tweetBd.textContent =
        (c.author || c.name || '') + '：' + (c.text || '（无文本，仅图片/视频）');
    } else {
      els.tweetBd.textContent = T('captureHint');
    }
  }

  function fillSelect(sel, list, activeId) {
    sel.textContent = '';
    for (const p of list) {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.name || p.id;
      sel.appendChild(o);
    }
    // 显示严格 = 存储里的 activeId（v0.5.19 去掉 prev 保留：设置页远端改预设后面板
    // 曾显示旧选项、实际生成却用新值——与 v0.5.3 模型下拉同类的"显示≠实际"问题）
    sel.value = list.some((p) => p.id === activeId) ? activeId : (list[0] && list[0].id) || '';
  }

  // 生成按钮态：当前接入方式未配置完成时禁用；
  // ready 变化经 storage.onChanged → refreshSettings → applySettings 联动刷新。
  // 生成中不禁用——按钮变为「⏹ 放弃等待」，超时与否由用户自行判断
  function syncGenBtn() {
    const s = state.settings;
    const ready = !!(s && s.ready && s.ready[s.provider]);
    els.genBtn.disabled = !state.generating && !ready;
    els.genBtn.title = ready
      ? ''
      : T('unreadyTip', { p: s ? s.providerLabel : T('model') });
  }

  // 观点倾向渲染：消极/客观/乐观三按钮高亮当前值
  function renderStance() {
    const v = (state.settings && state.settings.stance) || 'objective';
    els.stanceBtns.forEach((b) => {
      b.classList.toggle('on', b.dataset.act === 'stance-' + v);
    });
  }

  // 界面语言下拉渲染（v0.5.24）：选项 = 跟浏览器(T) + 各语种自称；值严格=存储的
  // uiLanguage。auto 标签随当前界面语言刷新（切语言后自己也能看懂）
  function renderUiLang() {
    if (!els.uilangSel) return;
    const cur = (state.settings && state.settings.uiLanguage) || 'zh';
    const want = cur === 'auto' || XCC_UI_TEXT[cur] ? cur : 'zh';
    if (!els.uilangSel.options.length || els.uilangSel.options.length !== XCC_UI_LANGS.length + 1) {
      els.uilangSel.textContent = '';
      const auto = document.createElement('option');
      auto.value = 'auto';
      auto.textContent = T('uiLangAuto');
      els.uilangSel.appendChild(auto);
      for (const id of XCC_UI_LANGS) {
        const o = document.createElement('option');
        o.value = id;
        const e = XCC_LANGUAGES.find((x) => x.id === id);
        o.textContent = e ? e.label : id;
        els.uilangSel.appendChild(o);
      }
    } else {
      els.uilangSel.options[0].textContent = T('uiLangAuto');
    }
    els.uilangSel.title = T('uiLangTitle');
    els.uilangSel.value = want;
  }

  // 界面语言应用（v0.5.23）：data-i18n/-ph/-title 三属性批量刷文案 + 语言相关的
  // 动态渲染刷新。语言未变时跳过（applySettings 每次存储变更都会跑）
  function applyUiLang(pref) {
    const next = resolveUiLang(pref);
    const changed = next !== uiLang;
    uiLang = next;
    shadow.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = T(el.getAttribute('data-i18n'));
    });
    shadow.querySelectorAll('[data-i18n-ph]').forEach((el) => {
      el.placeholder = T(el.getAttribute('data-i18n-ph'));
    });
    shadow.querySelectorAll('[data-i18n-title]').forEach((el) => {
      el.title = T(el.getAttribute('data-i18n-title'));
    });
    if (changed || !els.tweetBd.textContent) {
      if (!state.captured) els.tweetBd.textContent = T('captureHint');
    }
    if (state.settings) {
      renderUiLang();
      renderLang();
      renderHumanize();
      updateCount();
      if (!state.generating) els.genBtn.textContent = T('gen');
    }
  }

  // 输出语种渲染（v0.5.23 注册表）：选项按 XCC_LANGUAGES 生成，auto 用界面语言
  // 文案、其余用自称；选中值严格 = 存储的 genParams.language（显示≠实际零容忍）
  function renderLang() {
    if (!els.langSel) return;
    const cur = state.settings && state.settings.genParams && state.settings.genParams.language;
    const want = XCC_LANG_IDS.includes(cur) ? cur : 'zh';
    if (!els.langSel.options.length || els.langSel.options.length !== XCC_LANGUAGES.length) {
      els.langSel.textContent = '';
      for (const l of XCC_LANGUAGES) {
        const o = document.createElement('option');
        o.value = l.id;
        o.textContent = l.id === 'auto' ? T('langAuto') : l.label;
        els.langSel.appendChild(o);
      }
      els.langSel.title = T('langTitle');
    } else {
      els.langSel.options[0].textContent = T('langAuto'); // auto 标签随界面语言
      els.langSel.title = T('langTitle');
    }
    els.langSel.value = want;
  }

  // 账号模式渲染：免费/付费按钮态 + 目标字数输入框显隐 + 计数器刷新
  function renderPlan() {
    const gp = (state.settings && state.settings.genParams) || {};
    const premium = gp.xPlan === 'premium';
    if (els.planFree) els.planFree.classList.toggle('on', !premium);
    if (els.planPremium) els.planPremium.classList.toggle('on', premium);
    if (els.targetLen) {
      els.targetLen.hidden = !premium;
      if (premium && document.activeElement !== els.targetLen) {
        els.targetLen.value = gp.targetLength || '';
      }
    }
    updateCount();
  }

  // 去AI味开关渲染（v0.5.9）：输出框上方的小开关，开=生成后走二段"人味改写"
  function renderHumanize() {
    if (!els.hum) return;
    const on = !!(state.settings && state.settings.genParams && state.settings.genParams.humanize === 'on');
    els.hum.textContent = T('humLabel') + '：' + (on ? T('humOn') : T('humOff'));
    els.hum.classList.toggle('on', on);
  }

  // 输出框字符计数：免费 n/280（超限标红仅提示不截断）；付费 n 字
  function updateCount() {
    if (!els.count) return;
    const gp = (state.settings && state.settings.genParams) || {};
    const n = els.out.value.length;
    if (gp.xPlan === 'premium') {
      els.count.textContent = n + T('countUnit');
      els.count.classList.remove('over');
    } else {
      els.count.textContent = n + '/280';
      els.count.classList.toggle('over', n > 280);
    }
  }

  // 悬浮球显隐：设置启用 且 面板关闭 时可见（面板开着时让位）
  function syncLauncher() {
    const enabled = !(state.settings && state.settings.enabled === false);
    els.launcher.style.display = enabled && els.panel.hidden ? '' : 'none';
    els.launcher.classList.toggle('left', (state.settings && state.settings.panelSide) === 'left');
  }

  // 供应商下拉（v0.5.12）：选项=vendorList（未配置的标后缀），选中=activeVendorId
  function renderVendors() {
    const pub = state.settings;
    if (!pub || !els.vendorSel) return;
    const sel = els.vendorSel;
    const list = pub.vendorList || [];
    sel.textContent = '';
    for (const v of list) {
      const o = document.createElement('option');
      o.value = v.id;
      o.textContent = v.name + (v.ready ? '' : '（未配置）');
      sel.appendChild(o);
    }
    sel.value = list.some((x) => x.id === pub.activeVendorId)
      ? pub.activeVendorId
      : list[0]
        ? list[0].id
        : '';
  }

  // 模型下拉（v0.5.3）：按接入方式渲染候选；grok 授权通道复用「已验证/未验证」标注。
  // 与 fillSelect 不同：不做 prev 保留——显示值必须严格等于 pub.model（= GENERATE 实际
  // 使用的模型），远端（设置页）改模型后本面板立即跟真，杜绝"显示 A 实际生成用 B"
  function renderModels() {
    const pub = state.settings;
    if (!pub || !els.modelSel) return;
    const sel = els.modelSel;
    const candidates = pub.modelCandidates || [];
    const verified = new Set(pub.modelVerified || []);
    const hasMark = (pub.modelVerified || []).length > 0;
    sel.textContent = '';
    for (const m of candidates) {
      const o = document.createElement('option');
      o.value = m; // value 保持干净 ID：落盘不受标注影响（与设置页 renderOauthModels 同规）
      o.textContent = hasMark ? (verified.has(m) ? m + '（已验证）' : m + '（未验证）') : m;
      sel.appendChild(o);
    }
    sel.value = candidates.includes(pub.model) ? pub.model : candidates[0] || '';
  }

  function applySettings(pub) {
    state.settings = pub;
    if (pub.enabled === false) els.panel.hidden = true;
    els.panel.classList.toggle('left', pub.panelSide === 'left');
    fillSelect(els.personaSel, pub.personaPresets, pub.activePersonaId);
    fillSelect(els.genSel, pub.genPresets, pub.activeGenId);
    renderVendors();
    renderModels();
    // 界面语言（v0.5.23）：设置页可切 auto/zh/ja/es/de/en，面板文案整批跟换
    applyUiLang(pub.uiLanguage);
    // 同设置页：现场用已装版本重算，不用存储里的旧结论
    const upd = pub.update;
    const installed = chrome.runtime.getManifest().version;
    const show = !!(upd && upd.latest && xccIsNewerVersion(upd.latest, installed));
    els.update.hidden = !show;
    if (show) {
      els.update.textContent = T('updBanner', { v: upd.latest });
    }
    renderStance();
    renderLang();
    renderPlan();
    renderHumanize();
    syncGenBtn();
    syncLauncher();
  }

  async function refreshSettings() {
    // 直接读 chrome.storage，不经过后台消息——
    // Edge 对扩展后台的休眠/唤醒不可靠，UI 功能不能依赖它
    try {
      const store = await chrome.storage.local.get(['settings', 'xccUpdate']);
      const pub = {
        ...xccPublicSettings(xccMergeSettings(store.settings)),
        update: store.xccUpdate || null
      };
      applySettings(pub);
    } catch (e) {
      if (!(chrome.runtime && chrome.runtime.id)) {
        // 本内容脚本属于重载前的旧实例：storage 已不可用，停止重试
        setStatus(T('stReloaded'), true);
        syncGenBtn();
        return;
      }
      if (!state.settings) {
        setStatus(T('stSettingsFail'), true);
        setTimeout(refreshSettings, 5000);
      }
    }
  }

  async function mutateSettings(fn) {
    const { settings } = await chrome.storage.local.get('settings');
    const m = xccMergeSettings(settings);
    fn(m);
    await chrome.storage.local.set({ settings: m });
  }

  // ---------- 面板开关 ----------

  els.launcher.addEventListener('click', () => {
    els.panel.hidden = !els.panel.hidden;
    if (!els.panel.hidden) refreshSettings();
    syncLauncher();
  });

  // ---------- 悬停推文捕获 ----------

  let hoverArticle = null;

  function isEnabled() {
    // fail-open：设置尚未加载成功时按"启用"处理，只有明确关闭才禁用，
    // 避免后台消息偶发失败导致悬停捕获/面板整体失效
    return !(state.settings && state.settings.enabled === false);
  }

  document.addEventListener(
    'mouseover',
    (e) => {
      if (!isEnabled()) return;
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (t.closest('#xcc-host')) return; // 我们自己的 UI
      const art = t.closest('article[data-testid="tweet"]');
      if (art === hoverArticle) return;
      hoverArticle = art;
      if (!art) {
        els.hoverBtn.style.display = 'none';
        return;
      }
      const r = art.getBoundingClientRect();
      const b = els.hoverBtn;
      b.style.display = 'block';
      b.style.top = Math.max(8, r.top + 6) + 'px';
      b.style.left = Math.max(8, r.right - 64) + 'px';
    },
    true
  );

  // X 虚拟列表滚动会重挂节点，直接隐藏按钮等下一次悬停
  window.addEventListener(
    'scroll',
    () => {
      els.hoverBtn.style.display = 'none';
      hoverArticle = null;
    },
    { capture: true, passive: true }
  );

  els.hoverBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (!hoverArticle || !isEnabled()) return;
    captureTweet(hoverArticle);
    els.panel.hidden = false;
    refreshSettings();
    syncLauncher();
  });

  function extractTweet(art) {
    const textEl = art.querySelector('[data-testid="tweetText"]');
    const nameEl = art.querySelector('[data-testid="User-Name"]');
    let author = '';
    let name = '';
    if (nameEl) {
      const t = (nameEl.innerText || '').trim();
      const m = t.match(/@([A-Za-z0-9_]+)/);
      if (m) author = '@' + m[1];
      name = t.split('\n')[0] || '';
    }
    let href = '';
    const time = art.querySelector('a[href*="/status/"] time');
    if (time) href = (time.closest('a') || {}).getAttribute('href') || '';
    return {
      author,
      name,
      text: textEl ? textEl.innerText.trim() : '',
      href
    };
  }

  function captureTweet(art) {
    const t = extractTweet(art);
    state.captured = t;
    renderTweetBox();
    if (!t.text) {
      setStatus(T('stTweetNoText'), true);
    } else {
      setStatus(T('stCaptured', { a: t.author || '', gen: T('gen') }));
    }
  }

  // ---------- 生成 ----------

  async function generate() {
    if (state.generating) return;
    // 兜底：正常情况按钮已被 syncGenBtn 禁用；拦截"换一条"与点击瞬间配置变化的竞态
    const s = state.settings;
    if (!(s && s.ready && s.ready[s.provider])) {
      setStatus(
        '尚未配置模型：点 ⚙ 打开设置完成「' + (s ? s.providerLabel : '模型接入') + '」后再生成',
        true
      );
      return;
    }
    const topic = els.topic.value.trim();
    const hasTweetText = !!(state.captured && String(state.captured.text || '').trim());
    if (!hasTweetText && !topic) {
      setStatus(
        state.captured
          ? T('stImgOnly')
          : T('stNeedInput'),
        true
      );
      return;
    }
    state.generating = true;
    els.genBtn.textContent = T('genStop');
    setStatus(T('stGenerating'));
    // 快照本次生成的目标推文：填入时绑定它，
    // 避免生成等待期间误触捕获其他推文导致回错帖
    const target = state.captured;
    // 不设硬超时：请求不切断、结果晚到也自动填入；用户可随时点按钮放弃等待
    let giveUp;
    const cancelled = new Promise((res) => {
      giveUp = res;
    });
    state.genCancel = () => giveUp(true);
    let elapsed = 0;
    const ticker = setInterval(() => {
      elapsed += 15;
      setStatus(
        T('stGenWait', { s: elapsed, stop: T('genStop') })
      );
    }, 15000);
    try {
      const r = await Promise.race([
        send({ type: 'GENERATE', tweet: target, topic: topic || null }),
        cancelled
      ]);
      if (r === true) {
        setStatus('已放弃本次生成（可稍后重试或换已验证的模型）');
        return;
      }
      if (r && r.ok) {
        els.out.value = r.text;
        state.generatedFor = target;
        setStatus(
          r.humanized
            ? T('stGenDoneHum')
            : r.humanizeError
              ? T('stGenDoneHumFail')
              : T('stGenDone')
        );
        updateCount();
      } else if (!r) {
        setStatus('生成失败：扩展后台无响应，请到扩展管理页「重新加载」扩展后刷新本页重试', true);
      } else {
        const msg = String(r.error || '生成失败，请重试');
        setStatus(
          msg.includes('生成长度上限')
            ? msg // 思考耗尽的指引已自带准确动作，别再追加"换模型"画蛇添足
            : /API 4\d\d|model|not\s*found|reasoning|模型/i.test(msg)
              ? msg + '。该模型可能不在你账号的可用列表或参数不被支持：试试设置页下拉里标注（已验证）的模型；若刚改过思考强度请切回「默认」'
              : msg,
          true
        );
      }
    } finally {
      clearInterval(ticker);
      state.generating = false;
      state.genCancel = null;
      syncGenBtn(); // 不再无条件解禁：若配置仍为空则保持禁用
      els.genBtn.textContent = T('gen');
    }
  }

  // ---------- 填入 X 输入框（Draft.js 兼容） ----------

  function visibleEditors() {
    return Array.from(
      document.querySelectorAll('[data-testid="tweetTextarea_0"][contenteditable="true"]')
    ).filter((el) => el.offsetParent !== null);
  }

  // 推文详情页的回复框是常驻内联的（点回复不会新增 DOM 节点），
  // 短暂等待新编辑器未果且确在详情页时，退回使用已可见的那个，避免白等 6 秒
  function isDetailPage() {
    return /\/status\/\d+/.test(location.pathname);
  }

  async function waitForNewEditor(beforeSet, timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const eds = visibleEditors();
      const fresh = eds.find((e) => !beforeSet.has(e));
      if (fresh) return fresh;
      if (eds.length && isDetailPage() && Date.now() - t0 > 1200) return eds[eds.length - 1];
      await sleep(120);
    }
    return null;
  }

  // 编辑器当前文本（X 把换行渲染成 <br>/nbsp，比较前归一化）
  function normEditorText(s) {
    return String(s || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\r\n?/g, '\n')
      .replace(/\u200b/g, '')
      .trim();
  }

  function countOccurrences(hay, needle) {
    if (!needle) return 0;
    let n = 0;
    let i = hay.indexOf(needle);
    while (i !== -1) {
      n++;
      i = hay.indexOf(needle, i + needle.length);
    }
    return n;
  }

  // 把选区严格锚定在编辑器内部（Range API，非文档级 selectAll）
  function selectEditorContents(editor) {
    try {
      editor.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      sel.removeAllRanges();
      sel.addRange(range);
      return true;
    } catch (e) {
      return false;
    }
  }

  // 空编辑器：把光标落进框架托管的最深文本叶子（Draft span[data-text] /
  // Lexical [data-lexical-text]）。⚠ 逗号选择器按文档序返回首个匹配——块容器
  // （[data-contents]/<p>）是文本叶子的祖先、永远排在前，旧写法实际把光标落在
  // 块容器末尾（托管区之外），execCommand 由此把裸文本插进框架不认的位置：
  // Draft 的 EditorState 与 DOM 分叉后编辑器"死键"（能发送但键盘/退格/光标全失灵）。
  // 必须按优先级逐个查：Draft 文本叶子 → Lexical 文本叶子 → 空块容器兜底。
  function placeCaretInLeaf(editor) {
    try {
      editor.focus();
      const sel = window.getSelection();
      if (sel.rangeCount && editor.contains(sel.anchorNode) && sel.anchorNode !== editor) return;
      const leaf =
        editor.querySelector('span[data-text="true"]') || // Draft.js 文本叶子
        editor.querySelector('[data-lexical-text="true"]') || // Lexical 文本叶子
        editor.querySelector('p, div[data-block="true"]') || // 空块（尚无文本叶子）
        editor;
      const range = document.createRange();
      range.selectNodeContents(leaf);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
      return true;
    } catch (e) {
      return false;
    }
  }

  function rawInsert(editor, text) {
    try {
      return document.execCommand('insertText', false, text);
    } catch (e) {
      return false;
    }
  }

  // 框架优先插入（v0.5.3）：先派发可取消的合成 beforeinput。Lexical 的输入主通道
  // 与 Draft.js 的 editOnBeforeInput 都监听原生 beforeinput：preventDefault 后以框架
  // 自身 EditorState 应用插入——文本必然落在框架状态内、编辑器保持可编辑。
  // defaultPrevented === true 即框架已认领 → 跳过 execCommand 防二次插入；
  // 无人认领（裸 contenteditable / 未接 beforeinput 的构建）→ 回落 execCommand
  // （Chromium 会再派发一次 beforeinput，框架仍有第二次接管机会，且光标已在叶子内）。
  // 返回 'framework' | 'raw' | 'none'
  function frameworkInsert(editor, text) {
    try {
      const bi = new InputEvent('beforeinput', {
        inputType: 'insertText',
        data: text,
        bubbles: true,
        cancelable: true
      });
      editor.dispatchEvent(bi);
      if (bi.defaultPrevented) return 'framework';
    } catch (e) {
      /* 无 InputEvent 构造器：直接 execCommand */
    }
    return rawInsert(editor, text) ? 'raw' : 'none';
  }

  // state 探针：发送按钮的解禁由框架 EditorState 驱动，是"state 是否真拿到文本"的
  // 唯一外部可见信号——innerText 校验看不见 execCommand 幽灵（DOM 有字、state 空、
  // 编辑器死键）。找不到按钮（改版/非回复场景）不误伤。
  function sendReady(editor) {
    const dlg = editor.closest('[role="dialog"]') || document;
    const btn = dlg.querySelector(
      '[data-testid="tweetButton"], [data-testid="tweetButtonInline"], [data-testid="replyButton"]'
    );
    if (!btn) return true;
    return !(btn.disabled || btn.getAttribute('aria-disabled') === 'true');
  }

  // 发送钮解禁由框架 state→props 异步驱动，固定等一次会把慢渲染误判成幽灵插入
  // （→ 白白触发高危的清空重插路径）。轮询最多 timeout 毫秒，期间解禁即认定
  // state 已拿到文本。
  async function sendReadySoon(editor, timeout) {
    const until = timeout == null ? 1500 : timeout;
    const t0 = Date.now();
    while (!sendReady(editor)) {
      if (Date.now() - t0 >= until) return false;
      await sleep(100);
    }
    return true;
  }

  // 清空编辑器（范围内全选后 delete，连托管树外的孤儿碎片一并清掉）
  function clearEditor(editor) {
    try {
      if (!selectEditorContents(editor)) return false;
      return document.execCommand('delete', false, null);
    } catch (e) {
      return false;
    }
  }

  // 清空策略一：光标落托管叶子末尾后逐字符派发合成 beforeinput 退格——与首次
  // 插入同通道走框架输入管线改 state。Lexical 不认脚本设置的 DOM 选区，全选 +
  // execCommand delete 只能原生清 DOM（state 残留→回填/半截残渣的来源）。
  function clearByBackspace(editor) {
    try {
      const n = Math.min(2000, editor.innerText.length + 3);
      for (let i = 0; i < n; i++) {
        editor.dispatchEvent(
          new InputEvent('beforeinput', {
            inputType: 'deleteContentBackward',
            bubbles: true,
            cancelable: true
          })
        );
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  // 清空并确认（v0.5.21）：残渣清不干净时绝不重插——"半截残渣 + 完整文案"仍恰好
  // 含一份完整文本，出现次数式校验测不出来（用户实测：回复框文案重复两遍还报
  // "已自动纠正成功"）。⚠ 实测 execCommand('delete') 只发 input 不发 beforeinput：
  // 原生清的是 DOM、框架 state 原封不动，随后框架会把自己的 state 回填 DOM——
  // 清空后必须等过长于框架回填窗口（本仓 mock 600ms）再信"空"。
  async function clearEditorVerified(editor) {
    for (let i = 0; i < 3; i++) {
      if (!normEditorText(editor.innerText)) return true;
      // 策略一：合成 beforeinput 逐字符退格——走框架输入管线改 state，DOM 由框架渲染，
      // 不会出现 DOM/state 分叉；清不掉（框架不认合成事件/被吞）再试策略二
      placeCaretInLeaf(editor);
      await sleep(80); // 等 selectionchange → 框架内部选区同步
      clearByBackspace(editor);
      await sleep(700);
      if (!normEditorText(editor.innerText)) return true;
      // 策略二：脚本全选 + execCommand delete——原生清 DOM（连托管树外孤儿碎片），
      // 框架 state 若残留会回填，由 700ms 后的复查与下一轮迭代兜住
      clearEditor(editor);
      await sleep(700);
    }
    return !normEditorText(editor.innerText);
  }

  // 兜底通道：合成 paste 走框架粘贴管线，插入必然落在框架状态内。
  // isTrusted=false 所以只作最后回退，不当主路径。
  function pasteInsert(editor, text) {
    try {
      editor.focus();
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      editor.dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt })
      );
      return true;
    } catch (e) {
      return false;
    }
  }

  // 填入并校验（v0.5.21 收紧）：成功 = 编辑器内容与目标文本严格一致——旧的
  // "恰好包含一份"标准测不出半截残渣（残渣+完整文案也恰好含一份完整文本）。
  // 返回 'ok' | 'skip' | 'recovered' | 'fail'；失败时清场不留半份/重复内容。
  async function insertInto(editor, text) {
    const want = normEditorText(text);
    if (!want) return 'fail';
    // 幂等防重：编辑器已含同样内容（上轮残留/双击第二次）则跳过
    if (countOccurrences(normEditorText(editor.innerText), want) > 0) return 'skip';

    // 第一次：空编辑器只落位光标（不动选区）；已有旧草稿才全选替换
    editor.focus();
    if (normEditorText(editor.innerText)) {
      if (!selectEditorContents(editor)) return 'fail';
      await sleep(80); // selectionchange 异步：等框架内部选区同步到"全选"，否则替换被插到旧光标处
    } else {
      placeCaretInLeaf(editor);
      await sleep(80); // 等 selectionchange → 框架内部选区同步（Lexical 异步一帧）
    }
    let ok = frameworkInsert(editor, text) !== 'none';
    await sleep(200); // 等 Draft/Lexical 完成 模型↔DOM 同步再校验
    if (ok && normEditorText(editor.innerText) === want) {
      if (await sendReadySoon(editor)) return 'ok';
      // DOM 有字但发送钮迟迟未解禁：state 为空的幽灵插入 → 落入下方清空重插
    }

    // 异常（有残渣/内容不符/state 空）：确认清空后重插；清不干净绝不重插，
    // 直接判失败走剪贴板兜底（往残渣上叠文本正是"回复框重复两遍"的成因）
    if (!(await clearEditorVerified(editor))) return 'fail';
    placeCaretInLeaf(editor);
    await sleep(80);
    ok = frameworkInsert(editor, text) !== 'none';
    await sleep(200);
    if (ok && normEditorText(editor.innerText) === want && (await sendReadySoon(editor))) {
      return 'recovered';
    }

    // 仍异常：DOM 直插进叶子 + 派发 input（部分框架构建不认领合成 beforeinput，
    // 但会从 DOM 重读内容重建 state——Draft 的 Android 兼容路径 editOnInput 同型）
    if (!(await clearEditorVerified(editor))) return 'fail';
    placeCaretInLeaf(editor);
    try {
      const leaf =
        editor.querySelector('span[data-text="true"]') ||
        editor.querySelector('[data-lexical-text="true"]') ||
        editor;
      leaf.appendChild(document.createTextNode(text));
      editor.dispatchEvent(
        new InputEvent('input', { inputType: 'insertText', data: text, bubbles: true })
      );
    } catch (e) {
      /* 忽略，走 paste 兜底 */
    }
    await sleep(300);
    if (normEditorText(editor.innerText) === want && (await sendReadySoon(editor))) {
      return 'recovered';
    }

    // 最后兜底：合成 paste（走框架粘贴管线，插入必然落在框架状态内）
    if (!(await clearEditorVerified(editor))) return 'fail';
    pasteInsert(editor, text);
    await sleep(400);
    if (normEditorText(editor.innerText) === want && (await sendReadySoon(editor))) {
      return 'recovered';
    }

    await clearEditorVerified(editor); // 彻底失败：尽力清场，走剪贴板兜底
    return 'fail';
  }

  // 复制：clipboard API → execCommand 兜底；返回是否成功（v0.5.19：失败不再假报"已复制"）
  async function copyText(t) {
    try {
      await navigator.clipboard.writeText(t);
      return true;
    } catch (e) {
      try {
        const ta = document.createElement('textarea');
        ta.value = t;
        ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return !!ok;
      } catch (e2) {
        return false;
      }
    }
  }

  // 每条推文自己的永久链接 = 时间戳外层的 <a>；
  // 只按它精确定位，避免误命中推文内引用转发（quote tweet）的链接
  function articlePermalink(art) {
    const time = art.querySelector('a[href*="/status/"] time');
    const a = time && time.closest('a');
    return a ? (a.getAttribute('href') || '').split('?')[0] : '';
  }

  function findArticleByHref(href) {
    const clean = href.split('?')[0];
    if (!clean) return null;
    for (const a of document.querySelectorAll('article[data-testid="tweet"]')) {
      if (articlePermalink(a) === clean) return a;
    }
    return null;
  }

  // 弹层/详情页内的编辑器是否正对目标推文——防止把回复填进"别的推文"的框
  function editorMatchesTarget(editor, href) {
    const clean = String(href || '').split('?')[0];
    if (!clean || !editor || !editor.closest) return false;
    const inDialog = !!editor.closest('[role="dialog"]');
    // 详情页常驻回复框：URL 即目标推文永久链接（dialog 内的走下面的弹层校验，
    // 防止把详情页上打开的转发框误当回复框）
    if (isDetailPage() && !inDialog && location.pathname.split('?')[0] === clean) return true;
    // 弹层：dialog 内渲染的原推文 permalink 与目标一致
    if (!inDialog) return false;
    const dlg = editor.closest('[role="dialog"]');
    for (const a of dlg.querySelectorAll('article[data-testid="tweet"]')) {
      if (articlePermalink(a) === clean) return true;
    }
    return false;
  }

  async function insertResult() {
    if (state.inserting) return;
    const text = els.out.value.trim();
    if (!text) {
      setStatus(T('stNoContent'), true);
      return;
    }
    state.inserting = true;
    els.insertBtn.disabled = true; // 操作期间禁用，防双击竞态
    try {
      // 结果绑定生成时的推文；纯手写内容（从未生成过）才用当前捕获
      const target = state.generatedFor || state.captured;
      if (target && target.href) {
        const existing = visibleEditors();
        // 已有可见编辑器包含同样内容（此前已填过/弹层还开着）：直接视为成功
        const dup = existing.find(
          (e) => countOccurrences(normEditorText(e.innerText), normEditorText(text)) > 0
        );
        if (dup) {
          setStatus(T('stDupSkip'));
          return;
        }
        // v0.5.5：已有打开且正对目标推文的回复框 → 直接填入，不再点回复按钮开新框。
        // 旧逻辑总是再点一次 reply，在弹层/详情页并存时会把内容填进用户看不见的
        // 背景框（用户面前的弹层是空的）。只认弹层内编辑器与详情页常驻框——
        // 首页发帖框不算回复框，且必须匹配目标推文，防止回错帖
        let editor = existing.find((e) => editorMatchesTarget(e, target.href)) || null;
        if (!editor) {
          // 回复模式：找到原推文 → 点回复按钮 → 等编辑器出现 → 写入
          const art = findArticleByHref(target.href);
          if (!art) {
            setStatus(T('stNoTweet'), true);
            return;
          }
          const replyBtn = art.querySelector('[data-testid="reply"]');
          if (!replyBtn) {
            setStatus(T('stNoReplyBtn'), true);
            return;
          }
          const before = new Set(visibleEditors());
          replyBtn.click();
          editor = await waitForNewEditor(before, 6000);
          if (!editor) {
            setStatus(T('stBoxNotOpen'), true);
            copyText(text);
            return;
          }
          // 回退路径拿到的编辑器可能不是目标推文的（背景框）：有匹配项则纠正
          if (!editorMatchesTarget(editor, target.href)) {
            const m = visibleEditors().find((e) => editorMatchesTarget(e, target.href));
            if (m) editor = m;
          }
        }
        const r = await insertInto(editor, text);
        const where = T(
          editor && editor.closest && editor.closest('[role="dialog"]') ? 'whereDialog' : 'whereReply'
        );
        if (r === 'ok' || r === 'recovered') {
          setStatus(
            (r === 'recovered' ? T('stAutoCorrected') : '') +
              (target !== state.captured
                ? T('stInsertedBy', { a: target.author || '', where })
                : T('stInserted', { where }))
          );
        } else if (r === 'skip') {
          setStatus(T('stDupSkip'));
        } else {
          setStatus(T('stFillFail'), true);
          copyText(text);
        }
      } else {
        // 原创模式：优先用首页发帖框，没有就点侧栏发帖按钮
        let editor = visibleEditors()[0] || null;
        if (!editor) {
          const fab = document.querySelector('[data-testid="SideNav_NewTweet_Button"]');
          if (fab) {
            const before = new Set(visibleEditors());
            fab.click();
            editor = await waitForNewEditor(before, 6000);
          }
        }
        if (!editor) {
          setStatus(T('stNoComposer'), true);
          return;
        }
        const r = await insertInto(editor, text);
        if (r === 'ok' || r === 'recovered') {
          setStatus((r === 'recovered' ? T('stAutoCorrected') : '') + T('stInsertedPost'));
        } else if (r === 'skip') {
          setStatus(T('stDupSkipPost'));
        } else {
          setStatus(T('stFillFailPost'), true);
          copyText(text);
       }
      }
    } finally {
      state.inserting = false;
      els.insertBtn.disabled = false;
    }
  }

  // ---------- 事件绑定 ----------

  if (els.update) {
    els.update.addEventListener('click', () => {
      window.open(XCC_ZIP_URL, '_blank');
    });
  }

  els.genBtn.addEventListener('click', () => {
    if (state.generating) {
      // 生成中点击 = 放弃等待（不切断请求，晚到的结果将被忽略）
      if (state.genCancel) state.genCancel();
      return;
    }
    generate();
  });

  els.panel.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'settings') {
      // web_accessible_resources 已声明本页可从 x.com 打开；
      // 若仍被拦截（返回 null），回退到后台 openOptionsPage
      const w = window.open(chrome.runtime.getURL('options/options.html'), '_blank');
      if (!w) send({ type: 'OPEN_OPTIONS' });
    } else if (act === 'close') {
      els.panel.hidden = true;
      syncLauncher();
    } else if (act === 'clear') {
      state.captured = null;
      state.generatedFor = null;
      renderTweetBox();
      setStatus('');
    } else if (act === 'insert') {
      insertResult();
    } else if (act === 'copy') {
      const ok = await copyText(els.out.value);
      setStatus(ok ? T('stCopied') : T('stCopyFail'), !ok);
    } else if (act === 'regen') {
      generate();
    } else if (act === 'plan-free' || act === 'plan-premium') {
      const v = act === 'plan-premium' ? 'premium' : 'free';
      // 本地即时切换（不等 storage 往返），落盘后 onChanged 会再同步一次
      if (state.settings && state.settings.genParams) state.settings.genParams.xPlan = v;
      renderPlan();
      mutateSettings((m) => {
        m.genParams.xPlan = v;
      }).catch(() => {});
    } else if (act === 'stance-pessimistic' || act === 'stance-objective' || act === 'stance-optimistic') {
      const v = act.slice('stance-'.length);
      if (state.settings) state.settings.stance = v;
      renderStance();
      mutateSettings((m) => {
        m.stance = v;
      }).catch(() => {});
    } else if (act === 'hum-toggle') {
      // 去AI味开关：本地即时翻转（不等 storage 往返），落盘后 onChanged 会再同步
      const v = state.settings && state.settings.genParams && state.settings.genParams.humanize === 'on' ? 'off' : 'on';
      if (state.settings && state.settings.genParams) state.settings.genParams.humanize = v;
      renderHumanize();
      mutateSettings((m) => {
        m.genParams.humanize = v;
      }).catch(() => {});
    }
  });

  els.personaSel.addEventListener('change', () => {
    const v = els.personaSel.value;
    mutateSettings((m) => {
      m.activePersonaId = v;
    }).catch(() => {});
  });
  els.genSel.addEventListener('change', () => {
    const v = els.genSel.value;
    mutateSettings((m) => {
      m.activeGenId = v;
    }).catch(() => {});
  });
  // 输出语种（v0.5.23 注册表下拉）：与设置页「语言」共用 genParams.language，合并写
  els.langSel.addEventListener('change', () => {
    const v = els.langSel.value;
    if (!XCC_LANG_IDS.includes(v)) return;
    if (state.settings && state.settings.genParams) state.settings.genParams.language = v;
    mutateSettings((m) => {
      m.genParams.language = v;
    }).catch(() => {});
  });
  // 界面语言（v0.5.24 面板头部下拉）：本地即时切文案（applyUiLang 全量重刷），
  // 落盘后 storage.onChanged 会再同步一次远端变化
  els.uilangSel.addEventListener('change', () => {
    const v = els.uilangSel.value;
    if (!(v === 'auto' || XCC_UI_TEXT[v])) return;
    if (state.settings) state.settings.uiLanguage = v;
    applyUiLang(v);
    mutateSettings((m) => {
      m.uiLanguage = v;
    }).catch(() => {});
  });

  // 供应商切换（v0.5.12）：写 provider/activeCustomVendorId，刷新公共视图后模型下拉联动。
  // SW 每次 GENERATE 都重读 settings，落盘即生效
  els.vendorSel.addEventListener('change', () => {
    const v = els.vendorSel.value;
    if (!v) return;
    mutateSettings((m) => {
      if (v === 'xai' || v === 'grok-oauth') m.provider = v;
      else {
        m.provider = 'custom';
        m.activeCustomVendorId = v === 'primary' ? 'primary' : v;
      }
    })
      .then(() => refreshSettings())
      .catch(() => {});
  });

  // 模型切换（v0.5.3）：写当前供应商对应的 model 字段；SW 每次 GENERATE 都重读
  // settings，落盘即生效。
  els.modelSel.addEventListener('change', () => {
    const v = els.modelSel.value;
    if (!v) return;
    if (state.settings) state.settings.model = v;
    mutateSettings((m) => {
      if (m.provider === 'xai') m.xai.model = v;
      else if (m.provider === 'custom') {
        // v0.5.12：写当前活动的自定义档案（主槽位或额外供应商）
        const c =
          m.activeCustomVendorId && m.activeCustomVendorId !== 'primary'
            ? (m.customVendors || []).find((x) => x.id === m.activeCustomVendorId)
            : null;
        if (c) {
          if (!c.models.includes(v)) c.models.push(v); // 防御：候选必含 active
          c.model = v;
        } else {
          if (!m.custom.models.includes(v)) m.custom.models.push(v);
          m.custom.model = v;
        }
      } else m.grokOAuth.model = v;
    }).catch(() => {});
  });

  // 目标字数（付费模式）：即时落盘；输入时仅允许数字
  els.targetLen.addEventListener('input', () => {
    els.targetLen.value = els.targetLen.value.replace(/\D/g, '').slice(0, 4);
  });
  els.targetLen.addEventListener('change', () => {
    const v = els.targetLen.value.trim();
    if (state.settings && state.settings.genParams) state.settings.genParams.targetLength = v;
    mutateSettings((m) => {
      m.genParams.targetLength = v;
    }).catch(() => {});
  });

  // 输出框编辑时实时刷新字符计数
  els.out.addEventListener('input', updateCount);

  // 设置在别处（设置页/弹窗）被改动时同步面板
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) refreshSettings();
  });

  // ---------- 初始化 ----------

  renderTweetBox();
  refreshSettings();
})();
