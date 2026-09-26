const box = document.getElementById('status');

function row(label, value, cls) {
  const d = document.createElement('div');
  d.className = 'row';
  const a = document.createElement('span');
  a.textContent = label;
  const b = document.createElement('span');
  b.textContent = value;
  b.className = cls;
  d.append(a, b);
  return d;
}

chrome.runtime.sendMessage({ type: 'ping' }, (res) => {
  box.textContent = '';
  if (!res || !res.ok) {
    box.append(row('برنامهٔ کمکی', 'نصب نیست', 'bad'));
    const n = document.createElement('div');
    n.className = 'note';
    n.textContent = (res && res.error) || 'ابتدا install را از پوشهٔ host اجرا کنید.';
    box.append(n);
    return;
  }
  box.append(row('برنامهٔ کمکی', 'متصل ✓', 'ok'));
  box.append(row('yt-dlp', res.ytdlp || 'نصب نیست', res.ytdlp ? 'ok' : 'bad'));
  box.append(row('ffmpeg', res.ffmpeg ? 'نصب است ✓' : 'نصب نیست', res.ffmpeg ? 'ok' : 'warn'));
  box.append(row('deno', res.deno ? 'نصب است ✓' : 'نصب نیست', res.deno ? 'ok' : 'warn'));
  if (!res.ffmpeg || !res.deno) {
    const n = document.createElement('div');
    n.className = 'note';
    n.textContent =
      (!res.ffmpeg ? 'بدون ffmpeg فقط کیفیت‌های پایین (حدود 360p) و بدون تبدیل به MP3 ممکن است. ' : '') +
      (!res.deno ? 'بدون deno ممکن است yt-dlp همهٔ کیفیت‌ها را پیدا نکند. ' : '') +
      'راهنمای نصب در README آمده است.';
    box.append(n);
  }
  if (res.folder) {
    const n = document.createElement('div');
    n.className = 'note';
    n.style.direction = 'ltr';
    n.textContent = res.folder;
    box.append(n);
  }
});
