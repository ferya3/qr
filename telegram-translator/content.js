// Telegram Web translator: shows a translation under each incoming message and can
// translate the message you are typing (Alt+T or the small button above the input).
(() => {
  const DEFAULTS = { enabled: true, target: 'fa', reply: 'ru', engine: 'google' };
  let settings = { ...DEFAULTS };

  // Message text containers for Web K (/k) and Web A (/a), and the parts inside them that aren't message text.
  const SOURCES = [
    { sel: '.bubble .message', skip: '.time, .time-inner, .reactions, .reply, .name, .document-container, .audio, .contact, .poll, .web, .tgtr-tr' },
    { sel: '.Message .text-content', skip: '.MessageMeta, .Reactions, .reply-markup, .tgtr-tr' },
  ];
  const META = ':scope > .time, :scope > .MessageMeta';
  const INPUTS = '.input-message-input[contenteditable="true"], #editable-message-text, [contenteditable="true"].form-control';

  const state = new WeakMap(); // container -> text currently translated / in flight

  // ---------- text extraction ----------
  function extractText(container, skip) {
    const clone = container.cloneNode(true);
    clone.querySelectorAll(skip).forEach((n) => n.remove());
    clone.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
    clone.querySelectorAll('img[alt]').forEach((img) => img.replaceWith(img.alt));
    return clone.textContent.replace(/[ \t]+\n/g, '\n').trim();
  }

  function worthTranslating(text) {
    if (text.length < 2) return false;
    const stripped = text.replace(/https?:\/\/\S+|@\w+|#\w+/g, '');
    return /\p{L}{2,}/u.test(stripped);
  }

  // ---------- translation queue ----------
  const queue = [];
  let running = 0;
  const MAX_PARALLEL = 3;

  function requestTranslation(text, to) {
    return new Promise((resolve, reject) => {
      queue.push({ text, to, resolve, reject });
      pump();
    });
  }

  function pump() {
    while (running < MAX_PARALLEL && queue.length) {
      const job = queue.shift();
      running++;
      chrome.runtime
        .sendMessage({ type: 'translate', text: job.text, to: job.to, engine: settings.engine })
        .then((res) => (res && res.ok ? job.resolve(res) : job.reject(new Error(res ? res.error : 'no response'))))
        .catch(job.reject)
        .finally(() => {
          running--;
          pump();
        });
    }
  }

  const sameLang = (a, b) => !!a && !!b && a.split('-')[0].toLowerCase() === b.split('-')[0].toLowerCase();

  // ---------- incoming messages ----------
  function render(container, text, result) {
    container.querySelectorAll(':scope > .tgtr-tr').forEach((n) => n.remove());
    if (!result || sameLang(result.src, settings.target) || result.text.trim() === text) return;
    const div = document.createElement('div');
    div.className = 'tgtr-tr';
    div.dir = 'auto';
    div.textContent = result.text;
    const meta = container.querySelector(META);
    container.insertBefore(div, meta);
  }

  const inflight = new WeakSet();

  // Idempotent: cheap when the translation is already up to date.
  async function processContainer(container, skip) {
    if (!settings.enabled || !container.isConnected) return;
    const text = extractText(container, skip);
    if (!worthTranslating(text)) return;
    if (state.get(container) === text) {
      if (inflight.has(container)) return;
      if (container.querySelector(':scope > .tgtr-tr') || container.dataset.tgtrNone === text) return;
    }
    state.set(container, text);
    inflight.add(container);
    try {
      const result = await requestTranslation(text, settings.target);
      if (state.get(container) !== text || !settings.enabled) return;
      render(container, text, result);
      if (container.querySelector(':scope > .tgtr-tr')) delete container.dataset.tgtrNone;
      else container.dataset.tgtrNone = text; // same language as target: nothing to show
    } catch (e) {
      state.delete(container);
      console.warn('[Telegram Translator]', e);
    } finally {
      inflight.delete(container);
    }
  }

  const skipFor = new WeakMap();
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) processContainer(e.target, skipFor.get(e.target));
      }
    },
    { rootMargin: '300px 0px' }
  );

  const observed = new WeakSet();
  function scan() {
    for (const { sel, skip } of SOURCES) {
      for (const el of document.querySelectorAll(sel)) {
        if (el.closest('.tgtr-tr')) continue;
        if (!observed.has(el)) {
          observed.add(el);
          skipFor.set(el, skip);
          io.observe(el);
        } else if (settings.enabled) {
          // Handles edited messages and Telegram re-renders that drop our translation (served from cache).
          const r = el.getBoundingClientRect();
          if (r.bottom > -300 && r.top < innerHeight + 300) processContainer(el, skip);
        }
      }
    }
  }

  let scanTimer = null;
  const mo = new MutationObserver((mutations) => {
    // Ignore our own insertions.
    if (mutations.every((m) => [...m.addedNodes, ...m.removedNodes].every((n) => n.classList?.contains('tgtr-tr')))) return;
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 250);
  });

  function clearAll() {
    document.querySelectorAll('.tgtr-tr').forEach((n) => n.remove());
    document.querySelectorAll('[data-tgtr-none]').forEach((n) => delete n.dataset.tgtrNone);
  }

  // ---------- outgoing message (compose box) ----------
  const composeBtn = document.createElement('button');
  composeBtn.type = 'button';
  composeBtn.className = 'tgtr-compose';
  document.documentElement.appendChild(composeBtn);
  let composeInput = null;

  function langName(code) {
    try {
      return new Intl.DisplayNames(['fa'], { type: 'language' }).of(code);
    } catch {
      return code;
    }
  }

  function findInput() {
    const active = document.activeElement;
    if (active && active.matches && active.matches(INPUTS)) return active;
    return [...document.querySelectorAll(INPUTS)].find((el) => el.offsetParent !== null) || null;
  }

  function updateComposeButton() {
    const input = findInput();
    const text = input ? input.innerText.trim() : '';
    if (!input || !text || document.activeElement !== input) {
      composeBtn.style.display = 'none';
      return;
    }
    composeInput = input;
    composeBtn.textContent = `ترجمه به ${langName(settings.reply)} (Alt+T)`;
    const r = input.getBoundingClientRect();
    composeBtn.style.display = 'block';
    composeBtn.style.top = Math.max(8, r.top - composeBtn.offsetHeight - 10) + 'px';
    composeBtn.style.left = Math.max(8, Math.min(innerWidth - composeBtn.offsetWidth - 8, r.right - composeBtn.offsetWidth)) + 'px';
  }

  async function translateCompose() {
    const input = composeInput || findInput();
    if (!input) return;
    const text = input.innerText.trim();
    if (!text) return;
    const label = composeBtn.textContent;
    composeBtn.textContent = 'در حال ترجمه…';
    composeBtn.disabled = true;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'translate', text, to: settings.reply, engine: settings.engine });
      if (!res || !res.ok) throw new Error(res ? res.error : 'no response');
      input.focus();
      const sel = getSelection();
      const range = document.createRange();
      range.selectNodeContents(input);
      sel.removeAllRanges();
      sel.addRange(range);
      // insertText keeps Telegram's editor state (and undo with Ctrl+Z) in sync.
      if (!document.execCommand('insertText', false, res.text)) {
        input.textContent = res.text;
        input.dispatchEvent(new InputEvent('input', { bubbles: true }));
      }
    } catch (e) {
      composeBtn.textContent = 'خطا در ترجمه';
      console.warn('[Telegram Translator]', e);
      setTimeout(updateComposeButton, 1500);
      return;
    } finally {
      composeBtn.disabled = false;
    }
    composeBtn.textContent = label;
    updateComposeButton();
  }

  composeBtn.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the input
  composeBtn.addEventListener('click', translateCompose);
  document.addEventListener('input', () => setTimeout(updateComposeButton, 0), true);
  document.addEventListener('focusin', () => setTimeout(updateComposeButton, 0), true);
  document.addEventListener('focusout', () => setTimeout(updateComposeButton, 100), true);
  window.addEventListener('resize', updateComposeButton);

  document.addEventListener(
    'keydown',
    (e) => {
      if (!e.altKey || e.code !== 'KeyT') return;
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) {
        chrome.storage.sync.set({ enabled: !settings.enabled });
      } else {
        translateCompose();
      }
    },
    true
  );

  // ---------- settings ----------
  chrome.storage.sync.get(DEFAULTS, (s) => {
    settings = { ...DEFAULTS, ...s };
    mo.observe(document.body, { childList: true, subtree: true });
    scan();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    const before = { ...settings };
    for (const [k, v] of Object.entries(changes)) settings[k] = v.newValue;
    if (!settings.enabled) {
      clearAll();
      return;
    }
    if (!before.enabled || before.target !== settings.target || before.engine !== settings.engine) {
      clearAll();
      for (const { sel } of SOURCES) document.querySelectorAll(sel).forEach((el) => state.delete(el));
      scan();
    }
    updateComposeButton();
  });
})();
