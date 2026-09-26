const DEFAULTS = { enabled: true, target: 'fa', engine: 'google', hideOriginal: false, showOriginal: true, voice: false, voiceRate: 1.2, fontSize: 100 };
const LANGS = ['fa', 'en', 'ar', 'tr', 'ru', 'de', 'fr', 'es', 'it', 'zh-CN', 'ja', 'ko', 'hi', 'ur', 'az', 'ps', 'tg'];
const names = new Intl.DisplayNames(['fa'], { type: 'language' });
const $ = (id) => document.getElementById(id);

for (const code of LANGS) {
  const o = document.createElement('option');
  o.value = code;
  o.textContent = `${names.of(code)} (${code})`;
  $('target').appendChild(o);
}

function checkVoice() {
  const target = $('target').value;
  const has = speechSynthesis.getVoices().some((v) => v.lang.split('-')[0].toLowerCase() === target.split('-')[0]);
  const warn = $('voiceWarn');
  warn.style.display = $('voice').checked && !has ? 'block' : 'none';
  warn.textContent = 'صدای این زبان روی سیستم شما نصب نیست. در ویندوز: Settings ← Time & Language ← Speech ← Add voices و زبان را اضافه کنید، سپس کروم را ری‌استارت کنید.';
}
speechSynthesis.onvoiceschanged = checkVoice;

function showRanges() {
  $('voiceRateVal').textContent = Number($('voiceRate').value).toFixed(1) + '×';
  $('fontSizeVal').textContent = $('fontSize').value + '%';
}

chrome.storage.sync.get(DEFAULTS, (s) => {
  for (const id of ['enabled', 'hideOriginal', 'showOriginal', 'voice']) $(id).checked = s[id];
  for (const id of ['target', 'engine', 'voiceRate', 'fontSize']) $(id).value = s[id];
  showRanges();
  checkVoice();
});

for (const id of ['enabled', 'hideOriginal', 'showOriginal', 'voice']) {
  $(id).addEventListener('change', (e) => {
    chrome.storage.sync.set({ [id]: e.target.checked });
    checkVoice();
  });
}
for (const id of ['target', 'engine']) {
  $(id).addEventListener('change', (e) => {
    chrome.storage.sync.set({ [id]: e.target.value });
    checkVoice();
  });
}
for (const id of ['voiceRate', 'fontSize']) {
  $(id).addEventListener('input', showRanges);
  $(id).addEventListener('change', (e) => chrome.storage.sync.set({ [id]: Number(e.target.value) }));
}
