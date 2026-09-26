/*
 * Telegram Video Downloader
 * Runs in the page (MAIN world) of web.telegram.org so that fetch() goes through
 * Telegram Web's own service worker, which streams media the logged-in user can view.
 * Works in both Web K (/k) and Web A (/a).
 */
(() => {
  if (window.__tgvdLoaded) return;
  window.__tgvdLoaded = true;

  const MIN_VIDEO_SIZE = 80; // ignore stickers / tiny previews (px)
  const MAX_RETRIES = 5;
  const active = new Map(); // url -> AbortController

  const ICON =
    '<svg viewBox="0 0 24 24"><path d="M12 3a1 1 0 0 1 1 1v9.59l3.3-3.3a1 1 0 1 1 1.4 1.42l-5 5a1 1 0 0 1-1.4 0l-5-5a1 1 0 1 1 1.4-1.42l3.3 3.3V4a1 1 0 0 1 1-1zM5 19a1 1 0 0 1 1-1h12a1 1 0 1 1 0 2H6a1 1 0 0 1-1-1z"/></svg>';

  // ---------- UI ----------
  const btn = document.createElement('button');
  btn.id = 'tgvd-btn';
  btn.type = 'button';
  btn.innerHTML = ICON + '<span>دانلود</span>';
  document.documentElement.appendChild(btn);

  const panel = document.createElement('div');
  panel.id = 'tgvd-panel';
  document.documentElement.appendChild(panel);

  let currentVideo = null;
  let hideTimer = null;

  function videoSrc(video) {
    return video.currentSrc || video.src || video.querySelector('source')?.src || '';
  }

  function findVideoAt(x, y) {
    for (const el of document.elementsFromPoint(x, y)) {
      if (el.tagName !== 'VIDEO') continue;
      const r = el.getBoundingClientRect();
      if (r.width < MIN_VIDEO_SIZE || r.height < MIN_VIDEO_SIZE) continue;
      if (!videoSrc(el)) continue;
      return el;
    }
    return null;
  }

  function showButtonFor(video) {
    clearTimeout(hideTimer);
    currentVideo = video;
    const r = video.getBoundingClientRect();
    btn.style.display = 'flex';
    const top = Math.max(8, r.top + 10);
    const left = Math.min(window.innerWidth - btn.offsetWidth - 8, r.right - btn.offsetWidth - 10);
    btn.style.top = top + 'px';
    btn.style.left = Math.max(8, left) + 'px';
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      btn.style.display = 'none';
      currentVideo = null;
    }, 400);
  }

  let pending = false;
  document.addEventListener(
    'mousemove',
    (e) => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        const v = findVideoAt(e.clientX, e.clientY);
        if (v) showButtonFor(v);
        else if (e.target !== btn && !btn.contains(e.target)) scheduleHide();
      });
    },
    { passive: true }
  );
  document.addEventListener('mouseleave', scheduleHide);
  window.addEventListener('scroll', scheduleHide, true);

  btn.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  btn.addEventListener(
    'click',
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (currentVideo) downloadVideo(currentVideo);
    },
    true
  );
  // Keep Telegram from treating the click as "close media viewer" etc.
  for (const type of ['mousedown', 'mouseup', 'pointerdown', 'pointerup']) {
    btn.addEventListener(type, (e) => e.stopPropagation(), true);
  }

  // ---------- helpers ----------
  const EXT = {
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
    'video/x-matroska': 'mkv',
    'image/gif': 'gif',
  };

  // Web K stream URLs look like .../stream/<encoded JSON with fileName, size, mimeType>
  function parseStreamInfo(url) {
    const m = url.match(/\/stream\/(.+)$/);
    if (!m) return {};
    try {
      return JSON.parse(decodeURIComponent(m[1]));
    } catch {
      return {};
    }
  }

  function sanitize(name) {
    return name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim().slice(0, 150);
  }

  function buildFileName(info, mime) {
    const ext = EXT[(mime || '').split(';')[0]] || 'mp4';
    if (info.fileName) {
      const n = sanitize(info.fileName);
      return /\.[a-z0-9]{2,4}$/i.test(n) ? n : `${n}.${ext}`;
    }
    const d = new Date();
    const pad = (x) => String(x).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    return `telegram_video_${stamp}.${ext}`;
  }

  function fmtSize(b) {
    if (!b && b !== 0) return '?';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (b >= 1024 && i < u.length - 1) {
      b /= 1024;
      i++;
    }
    return `${b.toFixed(i ? 1 : 0)} ${u[i]}`;
  }

  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  function createProgressItem(name, onCancel) {
    const item = document.createElement('div');
    item.className = 'tgvd-item';
    item.innerHTML =
      '<div class="tgvd-row"><span class="tgvd-name"></span><button class="tgvd-x" title="لغو / بستن">✕</button></div>' +
      '<div class="tgvd-bar"><i></i></div><div class="tgvd-status">در حال شروع…</div>';
    item.querySelector('.tgvd-name').textContent = name;
    const bar = item.querySelector('.tgvd-bar > i');
    const status = item.querySelector('.tgvd-status');
    let finished = false;
    item.querySelector('.tgvd-x').addEventListener('click', () => {
      if (!finished) onCancel();
      item.remove();
    });
    panel.appendChild(item);
    return {
      progress(done, total) {
        const pct = total ? Math.min(100, (done / total) * 100) : 0;
        bar.style.width = (total ? pct : 30) + '%';
        status.textContent = total
          ? `${pct.toFixed(1)}%  —  ${fmtSize(done)} / ${fmtSize(total)}`
          : `${fmtSize(done)}`;
      },
      done(size) {
        finished = true;
        item.classList.add('done');
        bar.style.width = '100%';
        status.textContent = `✓ ذخیره شد (${fmtSize(size)})`;
        setTimeout(() => item.remove(), 6000);
      },
      fail(msg) {
        finished = true;
        item.classList.add('error');
        bar.style.width = '100%';
        status.textContent = '✕ ' + msg;
      },
    };
  }

  async function fetchWithRetry(url, opts) {
    let lastErr;
    for (let i = 0; i < MAX_RETRIES; i++) {
      try {
        const res = await fetch(url, opts);
        if (res.ok || res.status === 206) return res;
        lastErr = new Error('HTTP ' + res.status);
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        lastErr = err;
      }
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
    throw lastErr;
  }

  async function readBody(res, onChunk) {
    if (!res.body) {
      const b = await res.blob();
      onChunk(b.size);
      return [b];
    }
    const reader = res.body.getReader();
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      onChunk(value.byteLength);
    }
    return chunks;
  }

  // Download a media URL piece by piece using HTTP Range requests.
  async function downloadRanges(url, signal, expectedSize, onProgress) {
    const parts = [];
    let offset = 0;
    let total = expectedSize || null;
    let mime = '';

    while (total === null || offset < total) {
      const res = await fetchWithRetry(url, {
        headers: { Range: `bytes=${offset}-` },
        signal,
        credentials: 'include',
      });
      mime = mime || res.headers.get('Content-Type') || '';

      if (res.status === 200) {
        // Server ignored Range and sent the whole file.
        total = Number(res.headers.get('Content-Length')) || total;
        parts.length = 0;
        offset = 0;
        const chunks = await readBody(res, (n) => onProgress((offset += n), total));
        parts.push(...chunks);
        total = offset;
        break;
      }

      const cr = res.headers.get('Content-Range'); // bytes start-end/total
      const m = cr && cr.match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/);
      if (m) {
        if (Number(m[1]) !== offset) throw new Error('پاسخ نامعتبر از سرور (Range)');
        if (m[3] !== '*') total = Number(m[3]);
      }
      const before = offset;
      const chunks = await readBody(res, (n) => onProgress((offset += n), total));
      parts.push(...chunks);
      if (offset === before) break; // no more data
      if (!m && total === null) break; // unknown size and no range info: assume complete
    }
    return { blob: new Blob(parts, { type: mime.split(';')[0] || 'video/mp4' }), mime };
  }

  async function downloadVideo(video) {
    const url = videoSrc(video);
    if (!url) return;
    if (active.has(url)) return;

    const info = parseStreamInfo(url);
    const ctrl = new AbortController();
    active.set(url, ctrl);

    const name = buildFileName(info, info.mimeType);
    const ui = createProgressItem(name, () => ctrl.abort());

    try {
      let result;
      if (url.startsWith('blob:') || url.startsWith('data:')) {
        const res = await fetch(url, { signal: ctrl.signal });
        let got = 0;
        const total = Number(res.headers.get('Content-Length')) || null;
        const chunks = await readBody(res, (n) => ui.progress((got += n), total));
        const mime = res.headers.get('Content-Type') || 'video/mp4';
        result = { blob: new Blob(chunks, { type: mime }), mime };
      } else {
        result = await downloadRanges(url, ctrl.signal, info.size, ui.progress);
      }
      if (!result.blob.size) throw new Error('فایل خالی دریافت شد');
      saveBlob(result.blob, info.fileName ? name : buildFileName(info, result.mime));
      ui.done(result.blob.size);
    } catch (err) {
      ui.fail(err.name === 'AbortError' ? 'لغو شد' : err.message || String(err));
      console.error('[Telegram Video Downloader]', err);
    } finally {
      active.delete(url);
    }
  }

  // Keyboard shortcut: Alt+D downloads the largest playing/visible video (e.g. in the media viewer).
  document.addEventListener('keydown', (e) => {
    if (!e.altKey || e.code !== 'KeyD') return;
    const vids = [...document.querySelectorAll('video')].filter((v) => {
      const r = v.getBoundingClientRect();
      return videoSrc(v) && r.width >= MIN_VIDEO_SIZE && r.height >= MIN_VIDEO_SIZE && r.bottom > 0 && r.top < innerHeight;
    });
    if (!vids.length) return;
    vids.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return rb.width * rb.height - ra.width * ra.height;
    });
    e.preventDefault();
    downloadVideo(vids[0]);
  });
})();
