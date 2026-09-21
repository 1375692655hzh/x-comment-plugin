// X 评论副驾 — 工具栏弹窗：快速开关 + 切换当前人设/风格
'use strict';

const $ = (id) => document.getElementById(id);

function send(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        void chrome.runtime.lastError;
        resolve(resp || null);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

async function mutate(fn) {
  const { settings } = await chrome.storage.local.get('settings');
  const merged = xccMergeSettings(settings);
  fn(merged);
  await chrome.storage.local.set({ settings: merged });
}

function fill(sel, list, activeId) {
  sel.textContent = '';
  for (const p of list) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.name || p.id;
    sel.appendChild(o);
  }
  sel.value = list.some((p) => p.id === activeId) ? activeId : (list[0] && list[0].id) || '';
}

async function init() {
  const r = await send({ type: 'GET_PUBLIC_SETTINGS' });
  if (!r || !r.ok) {
    $('provider-label').textContent = '后台无响应，请重载扩展';
    return;
  }
  const pub = r.settings;
  $('enabled').checked = pub.enabled !== false;
  const ok = pub.ready && pub.ready[pub.provider];
  $('provider-label').textContent = pub.providerLabel + (ok ? '' : '（未配置，点 ⚙ 去设置）');
  fill($('persona'), pub.personaPresets, pub.activePersonaId);
  fill($('gen'), pub.genPresets, pub.activeGenId);
}

$('enabled').addEventListener('change', () => {
  mutate((m) => {
    m.enabled = $('enabled').checked;
  });
});
$('persona').addEventListener('change', () => {
  mutate((m) => {
    m.activePersonaId = $('persona').value;
  });
});
$('gen').addEventListener('change', () => {
  mutate((m) => {
    m.activeGenId = $('gen').value;
  });
});
$('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('open-x').addEventListener('click', () => chrome.tabs.create({ url: 'https://x.com' }));

init();
