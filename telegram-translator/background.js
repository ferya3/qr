// Translation engines (no API key needed). Runs in the service worker so requests aren't blocked by CORS.
const cache = new Map(); // "to|text" -> { text, src }
const CACHE_MAX = 3000;

async function google(text, to) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(to)}&dt=t`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: 'q=' + encodeURIComponent(text),
  });
  if (!res.ok) throw new Error('Google HTTP ' + res.status);
  const data = await res.json();
  const out = (data[0] || []).map((seg) => seg[0] || '').join('');
  if (!out) throw new Error('Google: empty response');
  return { text: out, src: data[2] || '' };
}

let msToken = null;
let msTokenTime = 0;
async function microsoftToken() {
  if (msToken && Date.now() - msTokenTime < 8 * 60 * 1000) return msToken;
  const res = await fetch('https://edge.microsoft.com/translate/auth');
  if (!res.ok) throw new Error('Microsoft auth HTTP ' + res.status);
  msToken = await res.text();
  msTokenTime = Date.now();
  return msToken;
}

async function microsoft(text, to) {
  const token = await microsoftToken();
  const res = await fetch(
    `https://api-edge.cognitive.microsofttranslator.com/translate?to=${encodeURIComponent(to)}&api-version=3.0`,
    {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify([{ Text: text }]),
    }
  );
  if (res.status === 401) msToken = null;
  if (!res.ok) throw new Error('Microsoft HTTP ' + res.status);
  const data = await res.json();
  const item = data[0];
  return { text: item.translations[0].text, src: item.detectedLanguage?.language || '' };
}

const ENGINES = { google, microsoft };

async function translate(text, to, engine) {
  const key = to + '|' + text;
  if (cache.has(key)) return cache.get(key);
  const order = engine === 'microsoft' ? ['microsoft', 'google'] : ['google', 'microsoft'];
  let lastErr;
  for (const name of order) {
    try {
      const result = await ENGINES[name](text, to);
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
      cache.set(key, result);
      return result;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'translate') return;
  translate(msg.text, msg.to, msg.engine)
    .then((r) => sendResponse({ ok: true, ...r }))
    .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
  return true;
});
