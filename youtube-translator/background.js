// Batch translation with free Google / Microsoft endpoints (no API key). Falls back to the other engine on failure.
const SEP = '\n';

async function google(texts, to) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(to)}&dt=t`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: 'q=' + encodeURIComponent(texts.join(SEP)),
  });
  if (!res.ok) throw new Error('Google HTTP ' + res.status);
  const data = await res.json();
  const out = (data[0] || []).map((seg) => seg[0] || '').join('');
  const lines = out.split(SEP).map((l) => l.trim());
  if (lines.length !== texts.length) {
    // Line structure lost: translate one by one so timing stays aligned.
    if (texts.length === 1) return [out.trim()];
    const single = [];
    for (const t of texts) single.push((await google([t], to))[0]);
    return single;
  }
  return lines;
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

async function microsoft(texts, to) {
  const token = await microsoftToken();
  const res = await fetch(
    `https://api-edge.cognitive.microsofttranslator.com/translate?to=${encodeURIComponent(to)}&api-version=3.0`,
    {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(texts.map((Text) => ({ Text }))),
    }
  );
  if (res.status === 401) msToken = null;
  if (!res.ok) throw new Error('Microsoft HTTP ' + res.status);
  const data = await res.json();
  return data.map((item) => item.translations[0].text);
}

const ENGINES = { google, microsoft };

async function translateBatch(texts, to, engine) {
  const order = engine === 'microsoft' ? ['microsoft', 'google'] : ['google', 'microsoft'];
  const errors = [];
  for (const name of order) {
    try {
      return await ENGINES[name](texts, to);
    } catch (e) {
      errors.push(`${name}: ${e.message || e}`);
    }
  }
  throw new Error(errors.join(' | '));
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'translateBatch') return;
  translateBatch(msg.texts, msg.to, msg.engine)
    .then((texts) => sendResponse({ ok: true, texts }))
    .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
  return true;
});
