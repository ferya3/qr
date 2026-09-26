// Bridges the YouTube page (content.js) and the local yt-dlp host (native messaging).
const HOST = 'com.ytdl.downloader';
const ports = new Map(); // download id -> native port

function notInstalledMessage(err) {
  const msg = (err && err.message) || String(err || '');
  if (/not found|forbidden|exited/i.test(msg)) {
    return 'برنامهٔ کمکی (host) نصب نیست یا درست نصب نشده. فایل install را از پوشهٔ host اجرا کنید و کروم را ری‌استارت کنید.';
  }
  return msg;
}

function sendToTab(tabId, msg) {
  chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

function startDownload(tabId, { id, url, quality, title }) {
  let port;
  try {
    port = chrome.runtime.connectNative(HOST);
  } catch (e) {
    sendToTab(tabId, { type: 'error', id, message: notInstalledMessage(e) });
    return;
  }
  ports.set(id, port);
  let finished = false;

  port.onMessage.addListener((m) => {
    if (m.type === 'done' || m.type === 'error') finished = true;
    sendToTab(tabId, { ...m, id });
  });
  port.onDisconnect.addListener(() => {
    ports.delete(id);
    if (!finished) {
      const err = chrome.runtime.lastError;
      sendToTab(tabId, {
        type: 'error',
        id,
        message: err ? notInstalledMessage(err) : 'ارتباط با برنامهٔ دانلود قطع شد',
      });
    }
  });
  port.postMessage({ action: 'download', url, quality, title });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'download' && sender.tab) {
    startDownload(sender.tab.id, msg);
    return;
  }
  if (msg.type === 'cancel') {
    const port = ports.get(msg.id);
    if (port) {
      port.postMessage({ action: 'cancel' });
      setTimeout(() => port.disconnect(), 300);
      ports.delete(msg.id);
    }
    return;
  }
  if (msg.type === 'ping') {
    chrome.runtime.sendNativeMessage(HOST, { action: 'ping' }, (res) => {
      const err = chrome.runtime.lastError;
      sendResponse(err ? { ok: false, error: notInstalledMessage(err) } : { ok: true, ...res });
    });
    return true; // async response
  }
  if (msg.type === 'open-folder') {
    chrome.runtime.sendNativeMessage(HOST, { action: 'open-folder', path: msg.path }, () => void chrome.runtime.lastError);
  }
});
