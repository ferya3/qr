// YouTube live translator: turns the video's subtitles into translated, time-synced
// sentences shown over the player, and can read them aloud (speechSynthesis).
(() => {
  const DEFAULTS = { enabled: true, target: 'fa', engine: 'google', hideOriginal: false, showOriginal: true, voice: false, voiceRate: 1.2, fontSize: 100 };
  let settings = { ...DEFAULTS };

  let videoId = null;
  let sentences = []; // { start, end, text, tr }
  let captionLang = '';
  let status = '';
  let lastShown = -2; // -2: nothing rendered yet, -1: no sentence at this time

  // ---------- helpers ----------
  const sameLang = (a, b) => !!a && !!b && a.split('-')[0].toLowerCase() === b.split('-')[0].toLowerCase();

  function currentVideoId() {
    const u = new URL(location.href);
    if (u.pathname === '/watch') return u.searchParams.get('v');
    const m = u.pathname.match(/^\/(shorts|live)\/([\w-]+)/);
    return m ? m[2] : null;
  }

  function video() {
    return document.querySelector('#movie_player video, video.html5-main-video');
  }

  // ---------- subtitles -> sentences ----------
  function buildChunks(events) {
    const chunks = [];
    for (const ev of events) {
      if (!ev.segs) continue;
      const start = ev.tStartMs || 0;
      const end = start + (ev.dDurationMs || 0);
      const segs = ev.segs.filter((s) => s.utf8 && s.utf8.trim());
      if (!segs.length) continue;
      const wordLevel = segs.length > 1 && segs.some((s) => s.tOffsetMs);
      if (!wordLevel) {
        chunks.push({ start, end, text: segs.map((s) => s.utf8).join('').replace(/\s+/g, ' ').trim() });
        continue;
      }
      segs.forEach((s, i) => {
        const ws = start + (s.tOffsetMs || 0);
        const we = i + 1 < segs.length ? start + (segs[i + 1].tOffsetMs || 0) : end;
        chunks.push({ start: ws, end: Math.max(we, ws + 200), text: s.utf8.replace(/\s+/g, ' ').trim() });
      });
    }
    chunks.sort((a, b) => a.start - b.start);
    return chunks.filter((c) => c.text && !/^\[.*\]$/.test(c.text)); // drop [Music], [Applause]
  }

  // Accepts YouTube json3 or XML (srv3 / srv1) subtitle bodies; returns json3-style events.
  function parseBody(body) {
    const text = String(body).trim();
    if (text.startsWith('{')) {
      try {
        return JSON.parse(text).events || [];
      } catch {
        return [];
      }
    }
    const doc = new DOMParser().parseFromString(text, 'text/xml');
    const events = [];
    for (const p of doc.querySelectorAll('p[t]')) {
      const start = Number(p.getAttribute('t')) || 0;
      const words = [...p.querySelectorAll('s')];
      const segs = words.length
        ? words.map((w) => ({ utf8: (w.textContent || '') + ' ', tOffsetMs: Number(w.getAttribute('t')) || 0 }))
        : [{ utf8: p.textContent || '' }];
      events.push({ tStartMs: start, dDurationMs: Number(p.getAttribute('d')) || 2000, segs });
    }
    for (const t of doc.querySelectorAll('text[start]')) {
      const tmp = document.createElement('textarea');
      tmp.innerHTML = t.textContent || ''; // srv1 double-escapes entities
      events.push({
        tStartMs: Number(t.getAttribute('start')) * 1000,
        dDurationMs: (Number(t.getAttribute('dur')) || 2) * 1000,
        segs: [{ utf8: tmp.value }],
      });
    }
    return events;
  }

  function buildSentences(events) {
    const chunks = buildChunks(events);
    const out = [];
    let cur = null;
    const flush = () => {
      if (cur && cur.text.trim()) out.push({ start: cur.start, end: cur.end, text: cur.text.trim(), tr: null });
      cur = null;
    };
    for (const c of chunks) {
      if (cur) {
        const gap = c.start - cur.end;
        const tooLong = c.end - cur.start > 8000 || cur.text.length > 160;
        const endsSentence = /[.!?؟。！？…]["')\]]?$/.test(cur.text) && cur.text.length > 15;
        if (gap > 1500 || tooLong || endsSentence) flush();
      }
      if (!cur) cur = { start: c.start, end: c.end, text: c.text };
      else {
        cur.text += ' ' + c.text;
        cur.end = Math.max(cur.end, c.end);
      }
    }
    flush();
    // Let each sentence stay on screen until the next begins (if the gap is short).
    for (let i = 0; i + 1 < out.length; i++) {
      if (out[i + 1].start - out[i].end < 1500) out[i].end = out[i + 1].start;
    }
    return out;
  }

  // ---------- translation ----------
  let jobId = 0;

  async function translateAll(myJob) {
    const BATCH_CHARS = 3500;
    const BATCH_LINES = 40;
    // Batches in time order, starting from where the viewer currently is.
    const batches = [];
    let cur = [];
    let chars = 0;
    sentences.forEach((s, i) => {
      if (cur.length && (cur.length >= BATCH_LINES || chars + s.text.length > BATCH_CHARS)) {
        batches.push(cur);
        cur = [];
        chars = 0;
      }
      cur.push(i);
      chars += s.text.length + 1;
    });
    if (cur.length) batches.push(cur);

    const t = (video()?.currentTime || 0) * 1000;
    let first = batches.findIndex((b) => sentences[b[b.length - 1]].end >= t);
    if (first < 0) first = 0;
    const order = [...batches.slice(first), ...batches.slice(0, first)];

    let done = 0;
    for (const batch of order) {
      if (myJob !== jobId) return;
      const texts = batch.map((i) => sentences[i].text);
      for (let attempt = 1; ; attempt++) {
        try {
          const res = await chrome.runtime.sendMessage({ type: 'translateBatch', texts, to: settings.target, engine: settings.engine });
          if (myJob !== jobId) return;
          if (!res || !res.ok) throw new Error(res ? res.error : 'no response');
          batch.forEach((idx, k) => (sentences[idx].tr = res.texts[k] || ''));
          break;
        } catch (e) {
          console.warn('[YouTube Live Translator] translation failed:', e.message);
          if (attempt >= 3) {
            setStatus('سرویس ترجمه در دسترس نیست (' + e.message + '). اگر از VPN استفاده می‌کنید، آن را روشن کنید یا سرور را عوض کنید، سپس صفحه را رفرش کنید.');
            return;
          }
          setStatus('خطا در ترجمه؛ تلاش دوباره…');
          await new Promise((r) => setTimeout(r, 3000 * attempt));
          if (myJob !== jobId) return;
        }
      }
      done += batch.length;
      setStatus(done < sentences.length ? `در حال ترجمه… ${Math.round((done / sentences.length) * 100)}%` : '');
      lastShown = -2;
    }
  }

  function loadCaptions(msg) {
    if (msg.videoId && msg.videoId !== currentVideoId()) return;
    if (msg.tlang) return; // YouTube's own auto-translated track; we translate the original ourselves
    const built = buildSentences(parseBody(msg.body));
    if (!built.length) {
      console.log('[YouTube Live Translator] subtitle file had no usable lines (via ' + msg.via + ')');
      return;
    }
    clearTimeout(retryTimer);
    console.log(`[YouTube Live Translator] ${built.length} sentences (${msg.lang}, via ${msg.via})`);
    // Same track downloaded again (e.g. seeking): keep existing translations.
    if (videoId === msg.videoId && captionLang === msg.lang && sentences.length === built.length) return;
    videoId = msg.videoId;
    captionLang = msg.lang;
    sentences = built;
    lastShown = -2;
    const myJob = ++jobId;
    if (sameLang(captionLang, settings.target)) {
      sentences.forEach((s) => (s.tr = s.text));
      setStatus('');
      return;
    }
    setStatus('در حال ترجمه…');
    translateAll(myJob);
  }

  // ---------- overlay ----------
  const overlay = document.createElement('div');
  overlay.className = 'ytx-overlay';
  overlay.innerHTML = '<div class="ytx-box"><div class="ytx-tr" dir="auto"></div><div class="ytx-orig" dir="auto"></div></div><div class="ytx-status"></div>';
  const trEl = overlay.querySelector('.ytx-tr');
  const origEl = overlay.querySelector('.ytx-orig');
  const boxEl = overlay.querySelector('.ytx-box');
  const statusEl = overlay.querySelector('.ytx-status');

  function setStatus(text) {
    status = text;
    statusEl.textContent = text;
    statusEl.style.display = text ? 'block' : 'none';
  }

  function attachOverlay() {
    const player = document.getElementById('movie_player');
    if (player && overlay.parentElement !== player) player.appendChild(overlay);
  }

  function findSentence(ms) {
    let lo = 0;
    let hi = sentences.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = sentences[mid];
      if (ms < s.start) hi = mid - 1;
      else if (ms >= s.end) lo = mid + 1;
      else return mid;
    }
    return -1;
  }

  function applyStyle() {
    const player = document.getElementById('movie_player');
    const h = player ? player.clientHeight : 400;
    overlay.style.fontSize = Math.max(14, Math.min(40, h * 0.045)) * (settings.fontSize / 100) + 'px';
    document.documentElement.classList.toggle('ytx-hide-native', settings.enabled && settings.hideOriginal && sentences.length > 0);
  }

  function tick() {
    requestAnimationFrame(tick);
    const v = video();
    const onVideo = settings.enabled && !!currentVideoId();
    const active = onVideo && currentVideoId() === videoId && v;
    overlay.style.display = onVideo && (active || status) ? 'block' : 'none';
    if (onVideo) attachOverlay();
    if (!active) {
      boxEl.style.visibility = 'hidden';
      lastShown = -2;
      return;
    }
    const idx = findSentence(v.currentTime * 1000);
    if (idx === lastShown) return;
    lastShown = idx;
    const s = sentences[idx];
    if (!s) {
      boxEl.style.visibility = 'hidden';
      return;
    }
    trEl.textContent = s.tr || '…';
    origEl.textContent = settings.showOriginal ? s.text : '';
    origEl.style.display = settings.showOriginal ? 'block' : 'none';
    boxEl.style.visibility = 'visible';
    applyStyle();
    if (s.tr && !v.paused) speak(s, v);
  }

  // ---------- voice ----------
  let speakingFor = -1;
  let savedVolume = null;

  function pickVoice() {
    const voices = speechSynthesis.getVoices();
    return voices.find((x) => sameLang(x.lang, settings.target) && /natural|online|google/i.test(x.name)) ||
      voices.find((x) => sameLang(x.lang, settings.target)) || null;
  }

  function restoreVolume(v) {
    if (savedVolume !== null && v) v.volume = savedVolume;
    savedVolume = null;
  }

  function speak(s, v) {
    if (!settings.voice || speakingFor === s.start) return;
    const voice = pickVoice();
    if (!voice) return;
    speakingFor = s.start;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(s.tr);
    u.voice = voice;
    u.lang = voice.lang;
    // Speed up long sentences so speech keeps pace with the video.
    const seconds = Math.max(1, (s.end - s.start) / 1000);
    const needed = s.tr.length / 14 / seconds; // ~14 chars per second at rate 1
    u.rate = Math.min(2, Math.max(settings.voiceRate, needed));
    if (savedVolume === null) {
      savedVolume = v.volume;
      v.volume = Math.min(v.volume, 0.25);
    }
    u.onend = u.onerror = () => {
      if (speakingFor === s.start) restoreVolume(v);
    };
    speechSynthesis.speak(u);
  }

  // ---------- wiring ----------
  const LANG_FA = (code) => {
    try {
      return new Intl.DisplayNames(['fa'], { type: 'language' }).of(code);
    } catch {
      return code;
    }
  };

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== 'ytx-page' || !settings.enabled) return;
    const m = e.data;
    if (m.videoId && m.videoId !== currentVideoId()) return;
    if (m.type === 'captions') loadCaptions(m);
    else if (m.type === 'noCaptions') {
      clearTimeout(retryTimer);
      setStatus('این ویدیو زیرنویس (حتی خودکار) ندارد؛ ترجمه ممکن نیست.');
      setTimeout(() => status.startsWith('این ویدیو') && setStatus(''), 8000);
    } else if (m.type === 'status' && m.message === 'track' && !sentences.length) {
      setStatus(`زیرنویس ${LANG_FA(m.lang)}${m.auto ? ' (خودکار)' : ''} پیدا شد؛ در حال دریافت…`);
    }
  });

  let retryTimer = null;
  let attempts = 0;
  function requestCaptions() {
    clearTimeout(retryTimer);
    const id = currentVideoId();
    if (!settings.enabled || !id || (videoId === id && sentences.length)) return;
    attempts++;
    if (!status || status.startsWith('در حال دریافت')) setStatus('در حال دریافت زیرنویس…');
    window.postMessage({ source: 'ytx-ext', cmd: 'loadCaptions', videoId: id }, '*');
    retryTimer = setTimeout(() => {
      if (videoId === currentVideoId() && sentences.length) return;
      if (attempts < 4) requestCaptions();
      else setStatus('زیرنویس دریافت نشد. صفحه را رفرش کنید یا دکمهٔ CC (زیرنویس) پلیر را یک بار بزنید.');
    }, 4000);
  }

  function reset() {
    jobId++;
    attempts = 0;
    clearTimeout(retryTimer);
    retryTimer = null;
    videoId = null;
    sentences = [];
    captionLang = '';
    lastShown = -2;
    speechSynthesis.cancel();
    restoreVolume(video());
    setStatus('');
    applyStyle();
  }

  document.addEventListener('yt-navigate-finish', () => {
    reset();
    setTimeout(requestCaptions, 1500);
  });
  document.addEventListener('play', (e) => e.target === video() && !sentences.length && !retryTimer && requestCaptions(), true);
  document.addEventListener('pause', () => {
    speechSynthesis.cancel();
    restoreVolume(video());
  }, true);
  document.addEventListener('seeked', () => {
    speechSynthesis.cancel();
    speakingFor = -1;
  }, true);
  window.addEventListener('resize', applyStyle);
  document.addEventListener('fullscreenchange', () => setTimeout(applyStyle, 200));

  // Alt+Y: quick on/off
  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.code === 'KeyY') {
      e.preventDefault();
      chrome.storage.sync.set({ enabled: !settings.enabled });
    }
  }, true);

  chrome.storage.sync.get(DEFAULTS, (s) => {
    settings = { ...DEFAULTS, ...s };
    setTimeout(requestCaptions, 1500);
    requestAnimationFrame(tick);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    const before = { ...settings };
    for (const [k, v] of Object.entries(changes)) settings[k] = v.newValue;
    lastShown = -2;
    if (!settings.voice) {
      speechSynthesis.cancel();
      restoreVolume(video());
    }
    if (!settings.enabled) {
      reset();
      return;
    }
    if (!before.enabled || before.target !== settings.target || before.engine !== settings.engine) {
      reset();
      requestCaptions();
    }
    applyStyle();
  });
})();
