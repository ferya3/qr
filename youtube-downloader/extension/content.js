// Adds a "Download" button to YouTube watch / shorts pages and shows download progress.
(() => {
  const QUALITIES = [
    { id: 'best', label: 'بهترین کیفیت' },
    { id: '2160', label: '4K (2160p)' },
    { id: '1440', label: '1440p' },
    { id: '1080', label: '1080p' },
    { id: '720', label: '720p' },
    { id: '480', label: '480p' },
    { id: '360', label: '360p' },
    { id: 'mp3', label: 'فقط صدا (MP3)' },
  ];

  const ICON =
    '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M12 3a1 1 0 0 1 1 1v9.59l3.3-3.3a1 1 0 1 1 1.4 1.42l-5 5a1 1 0 0 1-1.4 0l-5-5a1 1 0 1 1 1.4-1.42l3.3 3.3V4a1 1 0 0 1 1-1zM5 19a1 1 0 0 1 1-1h12a1 1 0 1 1 0 2H6a1 1 0 0 1-1-1z"/></svg>';

  // ---------- current video ----------
  function currentVideo() {
    const u = new URL(location.href);
    if (u.pathname === '/watch' && u.searchParams.get('v')) {
      return `https://www.youtube.com/watch?v=${u.searchParams.get('v')}`;
    }
    const m = u.pathname.match(/^\/(shorts|live)\/([\w-]{6,})/);
    if (m) return `https://www.youtube.com/${m[1]}/${m[2]}`;
    return null;
  }

  function currentTitle() {
    return document.title.replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube$/, '').trim() || 'YouTube video';
  }

  // ---------- button ----------
  const btn = document.createElement('button');
  btn.className = 'ytdl-btn';
  btn.type = 'button';
  btn.innerHTML = ICON + '<span>دانلود</span>';

  const menu = document.createElement('div');
  menu.className = 'ytdl-menu';
  for (const q of QUALITIES) {
    const item = document.createElement('button');
    item.type = 'button';
    item.textContent = q.label;
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      closeMenu();
      startDownload(q);
    });
    menu.appendChild(item);
  }
  document.documentElement.appendChild(menu);

  function openMenu() {
    const r = btn.getBoundingClientRect();
    menu.classList.add('open');
    const mh = menu.offsetHeight;
    const mw = menu.offsetWidth;
    const top = r.bottom + 6 + mh > innerHeight ? r.top - mh - 6 : r.bottom + 6;
    menu.style.top = Math.max(8, top) + 'px';
    menu.style.left = Math.min(innerWidth - mw - 8, Math.max(8, r.left)) + 'px';
  }
  function closeMenu() {
    menu.classList.remove('open');
  }
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.classList.contains('open') ? closeMenu() : openMenu();
  });
  document.addEventListener('click', closeMenu);
  window.addEventListener('scroll', closeMenu, { passive: true });
  window.addEventListener('resize', closeMenu);

  // Place the button next to Like/Share on watch pages; otherwise float it.
  function placeButton() {
    if (!currentVideo()) {
      btn.remove();
      closeMenu();
      return;
    }
    const isWatch = location.pathname === '/watch';
    const anchor = isWatch
      ? document.querySelector('ytd-watch-metadata #top-level-buttons-computed') ||
        document.querySelector('ytd-watch-metadata #actions-inner') ||
        document.querySelector('#menu-container #top-level-buttons-computed')
      : null;

    if (anchor) {
      btn.classList.remove('floating');
      if (btn.parentElement !== anchor.parentElement || btn.nextElementSibling !== anchor) {
        anchor.parentElement.insertBefore(btn, anchor);
      }
    } else {
      btn.classList.add('floating');
      if (btn.parentElement !== document.body) document.body.appendChild(btn);
    }
  }
  setInterval(placeButton, 1000);
  document.addEventListener('yt-navigate-finish', () => setTimeout(placeButton, 300));
  placeButton();

  // ---------- progress panel ----------
  const panel = document.createElement('div');
  panel.className = 'ytdl-panel';
  document.documentElement.appendChild(panel);
  const items = new Map();

  function fmtSize(b) {
    if (!b) return '';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (b >= 1024 && i < u.length - 1) {
      b /= 1024;
      i++;
    }
    return `${b.toFixed(i ? 1 : 0)} ${u[i]}`;
  }

  function createItem(id, title, qLabel) {
    const el = document.createElement('div');
    el.className = 'ytdl-item';
    el.innerHTML =
      '<div class="ytdl-row"><span class="ytdl-title"></span><button class="ytdl-x" title="لغو / بستن">✕</button></div>' +
      '<div class="ytdl-q"></div><div class="ytdl-bar"><i></i></div><div class="ytdl-status">در حال آماده‌سازی…</div>';
    el.querySelector('.ytdl-title').textContent = title;
    el.querySelector('.ytdl-q').textContent = qLabel;
    const state = { el, finished: false };
    el.querySelector('.ytdl-x').addEventListener('click', () => {
      if (!state.finished) chrome.runtime.sendMessage({ type: 'cancel', id });
      el.remove();
      items.delete(id);
    });
    panel.appendChild(el);
    items.set(id, state);
    return state;
  }

  function startDownload(q) {
    const url = currentVideo();
    if (!url) return;
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const title = currentTitle();
    createItem(id, title, q.label);
    chrome.runtime.sendMessage({ type: 'download', id, url, quality: q.id, title });
  }

  chrome.runtime.onMessage.addListener((m) => {
    const state = items.get(m.id);
    if (!state) return;
    const bar = state.el.querySelector('.ytdl-bar > i');
    const status = state.el.querySelector('.ytdl-status');

    if (m.type === 'progress') {
      const pct = m.total ? (m.downloaded / m.total) * 100 : 0;
      bar.style.width = pct.toFixed(1) + '%';
      const parts = [m.stage || '', m.total ? pct.toFixed(1) + '%' : '', m.total ? `${fmtSize(m.downloaded)} / ${fmtSize(m.total)}` : fmtSize(m.downloaded)];
      if (m.speed) parts.push(fmtSize(m.speed) + '/s');
      if (m.eta != null) parts.push(`${Math.round(m.eta)}s`);
      status.textContent = parts.filter(Boolean).join('  •  ');
    } else if (m.type === 'status') {
      status.textContent = m.message;
    } else if (m.type === 'done') {
      state.finished = true;
      state.el.classList.add('done');
      bar.style.width = '100%';
      status.textContent = '✓ ذخیره شد: ' + (m.file || '');
      status.title = m.file || '';
      if (m.file) {
        status.classList.add('link');
        status.onclick = () => chrome.runtime.sendMessage({ type: 'open-folder', path: m.file });
      }
    } else if (m.type === 'error') {
      state.finished = true;
      state.el.classList.add('error');
      bar.style.width = '100%';
      status.textContent = '✕ ' + m.message;
    }
  });
})();
