const DEFAULTS = { enabled: true, target: 'fa', reply: 'ru', engine: 'google' };
const LANGS = ['fa', 'en', 'ru', 'uk', 'ar', 'tr', 'de', 'fr', 'es', 'it', 'zh-CN', 'ja', 'ko', 'hi', 'ur', 'az', 'hy', 'ka', 'kk', 'uz', 'tg', 'ps'];
const names = new Intl.DisplayNames(['fa'], { type: 'language' });

for (const id of ['target', 'reply']) {
  const sel = document.getElementById(id);
  for (const code of LANGS) {
    const o = document.createElement('option');
    o.value = code;
    o.textContent = `${names.of(code)} (${code})`;
    sel.appendChild(o);
  }
}

chrome.storage.sync.get(DEFAULTS, (s) => {
  document.getElementById('enabled').checked = s.enabled;
  for (const id of ['target', 'reply', 'engine']) document.getElementById(id).value = s[id];
});

document.getElementById('enabled').addEventListener('change', (e) => chrome.storage.sync.set({ enabled: e.target.checked }));
for (const id of ['target', 'reply', 'engine']) {
  document.getElementById(id).addEventListener('change', (e) => chrome.storage.sync.set({ [id]: e.target.value }));
}
