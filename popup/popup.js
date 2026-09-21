// X 评论副驾 — 工具栏弹窗：快速开关 + 切换当前人设/风格
// 全部直接读写 chrome.storage，不依赖后台 SW（Edge 可能休眠扩展后台）
'use strict';

const $ = (id) => document.getElementById(id);

async function mutate(fn) {
  const { settings } = await chrome.storage.local.get('settings');
  const m = xccMergeSettings(settings);
  fn(m);
  await chrome.storage.local.set({ settings: m });
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
  try {
    const { settings } = await chrome.storage.local.get('settings');
    const pub = xccPublicSettings(xccMergeSettings(settings));
    $('enabled').checked = pub.enabled;
    const ok = pub.ready[pub.provider];
    $('provider-label').textContent = pub.providerLabel + (ok ? '' : '（未配置，点 ⚙ 去设置）');
    fill($('persona'), pub.personaPresets, pub.activePersonaId);
    fill($('gen'), pub.genPresets, pub.activeGenId);
  } catch (e) {
    $('provider-label').textContent = '设置读取失败，请重载扩展';
  }
}

$('enabled').addEventListener('change', () => {
  mutate((m) => {
    m.enabled = $('enabled').checked;
  }).catch(() => {});
});
$('persona').addEventListener('change', () => {
  const v = $('persona').value;
  mutate((m) => {
    m.activePersonaId = v;
  }).catch(() => {});
});
$('gen').addEventListener('change', () => {
  const v = $('gen').value;
  mutate((m) => {
    m.activeGenId = v;
  }).catch(() => {});
});
$('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('open-x').addEventListener('click', () => chrome.tabs.create({ url: 'https://x.com' }));

init();
