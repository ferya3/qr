/* ==========================================================================
   ابزار QR کد — ساخت و اسکن
   وابسته به: vendor/qr-code-styling.min.js و vendor/html5-qrcode.min.js
   ========================================================================== */

(function () {
  'use strict';

  var $ = function (sel, ctx) { return (ctx || document).querySelector(sel); };
  var $$ = function (sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); };

  document.addEventListener('DOMContentLoaded', init);

  // ---------- وضعیت کلی ----------
  var state = {
    type: 'link',      // نوع محتوای فعال
    frame: 'none',     // قاب فعال
    logoDataUrl: null, // لوگوی آپلودشده (dataURL)
    lastData: ''       // آخرین محتوای ساخته‌شده (برای کپی)
  };

  var qr = null;           // نمونهٔ QRCodeStyling
  var rebuildTimer = null;
  var camScanner = null;   // Html5Qrcode دوربین
  var fileScanner = null;  // Html5Qrcode فایل
  var camRunning = false;

  function init() {
    if (typeof QRCodeStyling === 'undefined') return;

    bindTabs();
    bindTypeChips();
    bindOptionInputs();
    bindLogo();
    bindFrame();
    bindDownloads();
    bindScanner();
    bindMediaUpload('audio');
    bindMediaUpload('video');
    bindAdminPanel();

    rebuild();
  }

  // ==========================================================================
  // تب‌های اصلی (ساخت / اسکن)
  // ==========================================================================
  function bindTabs() {
    $$('.qr-tabs:not(.qr-tabs-small) .qr-tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        $$('.qr-tabs:not(.qr-tabs-small) .qr-tab').forEach(function (t) { t.classList.remove('active'); });
        tab.classList.add('active');
        $$('.qr-panel').forEach(function (p) { p.classList.remove('active'); });
        $('#' + tab.dataset.panel).classList.add('active');
        if (tab.dataset.panel !== 'qr-scan-panel') {
          stopCamera();
          // توقف پخش صدا/ویدیوی نتیجهٔ اسکن هنگام ترک پنل
          $$('#result-media audio, #result-media video').forEach(function (m) { m.pause(); });
        }
      });
    });
  }

  // ==========================================================================
  // ساخت QR — نوع محتوا
  // ==========================================================================
  function bindTypeChips() {
    $$('.qr-type-chips .qr-chip[data-type]').forEach(function (chip) {
      chip.addEventListener('click', function () {
        $$('.qr-type-chips .qr-chip[data-type]').forEach(function (c) { c.classList.remove('active'); });
        chip.classList.add('active');
        state.type = chip.dataset.type;
        $$('.qr-fields').forEach(function (f) {
          f.classList.toggle('active', f.dataset.fields === state.type);
        });
        scheduleRebuild();
      });
    });

    // بازسازی زنده با هر تغییر در فرم‌ها
    $$('.qr-fields input, .qr-fields textarea, .qr-fields select').forEach(function (el) {
      el.addEventListener('input', scheduleRebuild);
      el.addEventListener('change', scheduleRebuild);
    });
  }

  // ---------- escape های استاندارد ----------
  function escWifi(v) {
    return String(v).replace(/([\\;,:"])/g, '\\$1');
  }

  function escVcard(v) {
    return String(v).replace(/\\/g, '\\\\').replace(/([;,])/g, '\\$1').replace(/\n/g, '\\n');
  }

  function normalizeUrl(v) {
    v = v.trim();
    if (!v) return '';
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(v)) v = 'https://' + v;
    return v;
  }

  // لینک صدا/ویدیو را در صفحهٔ پلیر سایت می‌پیچد تا با هر اسکنری
  // (دوربین گوشی و…) مستقیم پخش شود، نه اینکه فقط لینک فایل باز شود
  function playerWrap(kind, url) {
    var base = location.href.split(/[?#]/)[0].replace(/[^/]*$/, '') + 'play.html';
    return base + '#t=' + kind + '&u=' + encodeURIComponent(url);
  }

  // انکدر بایتی qr-code-styling فقط Latin-1 است؛ متن غیر ASCII (فارسی و …)
  // باید قبل از ساخت QR به بایت‌های UTF-8 تبدیل شود تا اسکنرها درست بخوانند.
  function toQrBytes(str) {
    if (!/[^\x00-\x7F]/.test(str)) return str;
    var bytes = new TextEncoder().encode(str);
    var out = '';
    for (var i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
    return out;
  }

  // ---------- ساخت محتوای QR بر اساس نوع ----------
  function buildData() {
    var val = function (id) { return ($('#' + id).value || '').trim(); };

    switch (state.type) {
      case 'link': {
        return normalizeUrl(val('link-url')) || 'https://example.com';
      }

      case 'text': {
        return val('text-content') || 'سلام دنیا!';
      }

      case 'audio': {
        var au = normalizeUrl(val('audio-url')) || 'https://example.com/sound.mp3';
        return $('#audio-wrap').checked ? playerWrap('audio', au) : au;
      }

      case 'video': {
        var vu = normalizeUrl(val('video-url')) || 'https://example.com/video.mp4';
        return $('#video-wrap').checked ? playerWrap('video', vu) : vu;
      }

      case 'email': {
        var to = val('email-to') || 'info@example.com';
        var params = [];
        if (val('email-subject')) params.push('subject=' + encodeURIComponent(val('email-subject')));
        if (val('email-body')) params.push('body=' + encodeURIComponent(val('email-body')));
        return 'mailto:' + to + (params.length ? '?' + params.join('&') : '');
      }

      case 'tel': {
        return 'tel:' + (val('tel-number').replace(/[\s-]/g, '') || '+989121234567');
      }

      case 'sms': {
        var num = val('sms-number').replace(/[\s-]/g, '') || '+989121234567';
        return 'SMSTO:' + num + ':' + val('sms-message');
      }

      case 'wifi': {
        var enc = $('#wifi-enc').value;
        var s = 'WIFI:T:' + enc + ';S:' + escWifi(val('wifi-ssid') || 'MyWiFi') + ';';
        if (enc !== 'nopass') s += 'P:' + escWifi(val('wifi-pass')) + ';';
        if ($('#wifi-hidden').checked) s += 'H:true;';
        return s + ';';
      }

      case 'vcard': {
        var first = val('vc-first');
        var last = val('vc-last');
        var lines = [
          'BEGIN:VCARD',
          'VERSION:3.0',
          'N:' + escVcard(last) + ';' + escVcard(first) + ';;;',
          'FN:' + escVcard((first + ' ' + last).trim() || 'نام و نام خانوادگی')
        ];
        if (val('vc-org')) lines.push('ORG:' + escVcard(val('vc-org')));
        if (val('vc-title')) lines.push('TITLE:' + escVcard(val('vc-title')));
        if (val('vc-mobile')) lines.push('TEL;TYPE=CELL:' + val('vc-mobile').replace(/[\s-]/g, ''));
        if (val('vc-phone')) lines.push('TEL;TYPE=WORK,VOICE:' + val('vc-phone').replace(/[\s-]/g, ''));
        if (val('vc-email')) lines.push('EMAIL:' + val('vc-email'));
        if (val('vc-web')) lines.push('URL:' + normalizeUrl(val('vc-web')));
        if (val('vc-address')) lines.push('ADR;TYPE=WORK:;;' + escVcard(val('vc-address')) + ';;;;');
        lines.push('END:VCARD');
        return lines.join('\n');
      }
    }
    return '';
  }

  // ==========================================================================
  // ساخت QR — گزینه‌های شخصی‌سازی
  // ==========================================================================
  function bindOptionInputs() {
    var ids = [
      'opt-dot-color', 'opt-dot-color2', 'opt-bg-color', 'opt-gradient', 'opt-bg-transparent',
      'opt-dot-type', 'opt-corner-type', 'opt-size', 'opt-margin', 'opt-ecl',
      'opt-logo-size', 'opt-logo-hide-dots'
    ];
    ids.forEach(function (id) {
      var el = $('#' + id);
      el.addEventListener('input', scheduleRebuild);
      el.addEventListener('change', scheduleRebuild);
    });

    // نمایش/مخفی‌کردن رنگ دوم گرادیان
    $('#opt-gradient').addEventListener('change', function () {
      $('.gradient-only').hidden = !this.checked;
    });

    // نمایش مقدار اسلایدرها
    $('#opt-size').addEventListener('input', function () { $('#opt-size-val').textContent = this.value; });
    $('#opt-margin').addEventListener('input', function () { $('#opt-margin-val').textContent = this.value; });
    $('#opt-logo-size').addEventListener('input', function () { $('#opt-logo-size-val').textContent = this.value; });
  }

  function bindLogo() {
    $('#opt-logo').addEventListener('change', function () {
      var file = this.files && this.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function (e) {
        state.logoDataUrl = e.target.result;
        $('#opt-logo-name').textContent = file.name;
        $('#opt-logo-remove').hidden = false;
        // با وجود لوگو، سطح تصحیح خطای بالا لازم است
        if ($('#opt-ecl').value !== 'H') {
          $('#opt-ecl').value = 'H';
          toast('سطح تصحیح خطا برای لوگو روی «بالا» تنظیم شد');
        }
        scheduleRebuild();
      };
      reader.readAsDataURL(file);
    });

    $('#opt-logo-remove').addEventListener('click', function () {
      state.logoDataUrl = null;
      $('#opt-logo').value = '';
      $('#opt-logo-name').textContent = 'لوگویی انتخاب نشده';
      this.hidden = true;
      scheduleRebuild();
    });
  }

  function bindFrame() {
    $$('.qr-frame-chips .qr-chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        $$('.qr-frame-chips .qr-chip').forEach(function (c) { c.classList.remove('active'); });
        chip.classList.add('active');
        state.frame = chip.dataset.frame;
        $('.frame-only').hidden = state.frame === 'none';
        $('.frame-label-only').hidden = state.frame !== 'label';
        applyFramePreview();
      });
    });

    $('#opt-frame-color').addEventListener('input', applyFramePreview);
    $('#opt-frame-text').addEventListener('input', applyFramePreview);
  }

  function applyFramePreview() {
    var frame = $('#qr-frame');
    frame.className = 'qr-frame frame-' + state.frame;
    frame.style.setProperty('--qr-frame-color', $('#opt-frame-color').value);
    var label = $('#qr-frame-label');
    label.hidden = state.frame !== 'label';
    label.textContent = $('#opt-frame-text').value || 'اسکن کنید';
  }

  // ---------- ساخت مجدد QR ----------
  function scheduleRebuild() {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(rebuild, 180);
  }

  function buildOptions() {
    var size = parseInt($('#opt-size').value, 10) || 400;
    var dotColor = $('#opt-dot-color').value;
    var dotsOptions = { type: $('#opt-dot-type').value };

    if ($('#opt-gradient').checked) {
      dotsOptions.gradient = {
        type: 'linear',
        rotation: Math.PI / 4,
        colorStops: [
          { offset: 0, color: dotColor },
          { offset: 1, color: $('#opt-dot-color2').value }
        ]
      };
    } else {
      dotsOptions.color = dotColor;
    }

    var opts = {
      width: size,
      height: size,
      type: 'canvas',
      data: toQrBytes(state.lastData),
      margin: parseInt($('#opt-margin').value, 10) || 0,
      qrOptions: { errorCorrectionLevel: $('#opt-ecl').value },
      dotsOptions: dotsOptions,
      backgroundOptions: {
        color: $('#opt-bg-transparent').checked ? 'rgba(0,0,0,0)' : $('#opt-bg-color').value
      },
      cornersSquareOptions: { type: $('#opt-corner-type').value, color: dotColor },
      cornersDotOptions: { type: $('#opt-corner-type').value === 'square' ? 'square' : 'dot', color: dotColor }
    };

    if (state.logoDataUrl) {
      opts.image = state.logoDataUrl;
      opts.imageOptions = {
        crossOrigin: 'anonymous',
        margin: 6,
        imageSize: (parseInt($('#opt-logo-size').value, 10) || 35) / 100,
        hideBackgroundDots: $('#opt-logo-hide-dots').checked
      };
    }

    return opts;
  }

  function rebuild() {
    state.lastData = buildData();

    var holder = $('#qr-canvas-holder');
    holder.innerHTML = '';
    qr = new QRCodeStyling(buildOptions());
    qr.append(holder);
    applyFramePreview();
  }

  // ==========================================================================
  // دانلود خروجی
  // ==========================================================================
  function bindDownloads() {
    $('#btn-dl-png').addEventListener('click', function () {
      if (!qr) return;
      if (state.frame === 'none') {
        qr.download({ name: 'qr-code', extension: 'png' });
      } else {
        downloadFramedPng();
      }
    });

    $('#btn-dl-svg').addEventListener('click', function () {
      if (!qr) return;
      qr.download({ name: 'qr-code', extension: 'svg' });
    });

    $('#btn-copy-data').addEventListener('click', function () {
      copyText(state.lastData, 'محتوای QR کپی شد');
    });
  }

  // ترسیم قاب روی خروجی PNG با canvas
  function downloadFramedPng() {
    qr.getRawData('png').then(function (blob) {
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);

        var size = img.width;
        var innerPad = Math.round(size * 0.04);  // فاصلهٔ سفید دور QR
        var framePad = Math.round(size * 0.05);  // ضخامت قاب رنگی
        var labelH = state.frame === 'label' ? Math.round(size * 0.17) : 0;
        var frameColor = $('#opt-frame-color').value;
        var labelText = $('#opt-frame-text').value || 'اسکن کنید';

        var w = size + (innerPad + framePad) * 2;
        var h = w + labelH;
        var canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext('2d');

        // بدنهٔ قاب
        roundRect(ctx, 0, 0, w, h, Math.round(size * 0.06));
        ctx.fillStyle = frameColor;
        ctx.fill();

        // کادر سفید داخلی
        roundRect(ctx, framePad, framePad, size + innerPad * 2, size + innerPad * 2, Math.round(size * 0.035));
        ctx.fillStyle = '#ffffff';
        ctx.fill();

        // خود QR
        ctx.drawImage(img, framePad + innerPad, framePad + innerPad, size, size);

        // متن قاب
        if (labelH) {
          ctx.fillStyle = '#ffffff';
          ctx.font = '700 ' + Math.round(labelH * 0.42) + 'px Vazirmatn, Tahoma, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(labelText, w / 2, size + innerPad * 2 + framePad + labelH / 2 - Math.round(framePad / 3));
        }

        canvas.toBlob(function (out) {
          var a = document.createElement('a');
          a.href = URL.createObjectURL(out);
          a.download = 'qr-code.png';
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
        }, 'image/png');
      };
      img.src = url;
    });
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(x, y, w, h, r);
      return;
    }
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // ==========================================================================
  // آپلود فایل صوتی/ویدیویی از دستگاه — لینک هاست‌شده در QR قرار می‌گیرد
  // ==========================================================================
  var UPLOAD_MAX_BYTES = 100 * 1024 * 1024; // ۱۰۰ مگابایت
  var ADMIN_CFG_KEY = 'qr-upload-custom';

  // سرویس‌های عمومی — به ترتیب امتحان می‌شوند
  var defaultUploadProviders = [
    {
      name: 'pixeldrain.com',
      note: 'ماندگار',
      upload: function (file, onProgress) {
        return xhrUpload('PUT', 'https://pixeldrain.com/api/file/' + encodeURIComponent(file.name), file, onProgress)
          .then(function (resp) {
            var j = JSON.parse(resp);
            if (!j.id) throw new Error('bad response');
            return 'https://pixeldrain.com/api/file/' + j.id;
          });
      }
    },
    {
      name: 'tmpfiles.org',
      note: 'موقت — حدود ۱ ساعت',
      upload: function (file, onProgress) {
        var fd = new FormData();
        fd.append('file', file);
        return xhrUpload('POST', 'https://tmpfiles.org/api/v1/upload', fd, onProgress)
          .then(function (resp) {
            var j = JSON.parse(resp);
            var url = j && j.data && j.data.url;
            if (!url) throw new Error('bad response');
            // تبدیل لینک صفحه به لینک مستقیم دانلود
            return url.replace('tmpfiles.org/', 'tmpfiles.org/dl/');
          });
      }
    }
  ];

  // تنظیمات هاست اختصاصی مدیر: اولویت با ذخیرهٔ مرورگر، بعد فایل upload-config.js
  function getCustomUploadConfig() {
    try {
      var saved = localStorage.getItem(ADMIN_CFG_KEY);
      if (saved) return JSON.parse(saved);
    } catch (e) { /* localStorage در دسترس نیست */ }
    var fileCfg = window.QR_UPLOAD_CONFIG && window.QR_UPLOAD_CONFIG.custom;
    return fileCfg || null;
  }

  function makeCustomProvider(cfg) {
    return {
      name: cfg.name || 'هاست اختصاصی',
      note: 'هاست اختصاصی',
      upload: function (file, onProgress) {
        var endpoint = String(cfg.endpoint).replace('{filename}', encodeURIComponent(file.name));
        var method = (cfg.method || 'POST').toUpperCase();
        var body;
        if (method === 'PUT') {
          body = file;
        } else {
          body = new FormData();
          body.append(cfg.fieldName || 'file', file);
        }
        return xhrUpload(method, endpoint, body, onProgress, cfg.headers).then(function (resp) {
          var link;
          var p = (cfg.responseUrlPath || 'text').trim();
          if (p === 'text') {
            link = resp.trim();
          } else {
            var j = JSON.parse(resp);
            link = p.split('.').reduce(function (o, k) { return o == null ? o : o[k]; }, j);
          }
          if (!link || typeof link !== 'string') throw new Error('no url in response');
          return (cfg.urlPrefix || '') + link;
        });
      }
    };
  }

  // زنجیرهٔ نهایی سرویس‌ها: اول هاست مدیر (اگر فعال)، بعد سرویس‌های عمومی
  function getUploadProviders() {
    var list = [];
    var cfg = getCustomUploadConfig();
    if (cfg && cfg.enabled && cfg.endpoint) {
      list.push(makeCustomProvider(cfg));
      if (cfg.useDefaultFallbacks === false) return list;
    }
    return list.concat(defaultUploadProviders);
  }

  function xhrUpload(method, url, body, onProgress, headers) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open(method, url);
      xhr.timeout = 300000;
      if (headers) {
        Object.keys(headers).forEach(function (k) {
          try { xhr.setRequestHeader(k, headers[k]); } catch (e) { /* هدر نامعتبر */ }
        });
      }
      if (xhr.upload && onProgress) {
        xhr.upload.onprogress = function (e) {
          if (e.lengthComputable) onProgress(e.loaded / e.total);
        };
      }
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.responseText);
        else reject(new Error('HTTP ' + xhr.status));
      };
      xhr.onerror = function () { reject(new Error('network')); };
      xhr.ontimeout = function () { reject(new Error('timeout')); };
      xhr.send(body);
    });
  }

  function humanSize(bytes) {
    if (bytes < 1024) return bytes + ' بایت';
    if (bytes < 1048576) return (bytes / 1024).toFixed(0) + ' کیلوبایت';
    return (bytes / 1048576).toFixed(1) + ' مگابایت';
  }

  function bindMediaUpload(kind) {
    var input = $('#' + kind + '-file-input');
    var drop = $('#' + kind + '-drop');
    var info = $('#' + kind + '-file-info');
    var preview = $('#' + kind + '-file-preview');
    var btn = $('#' + kind + '-upload-btn');
    var progress = $('#' + kind + '-progress');
    var fill = $('#' + kind + '-progress-fill');
    var status = $('#' + kind + '-upload-status');
    var picked = null;

    // سوییچ «لینک اینترنتی / آپلود از دستگاه»
    $$('.qr-src-chips .qr-chip', $('[data-fields="' + kind + '"]')).forEach(function (chip) {
      chip.addEventListener('click', function () {
        var wrap = $('[data-fields="' + kind + '"]');
        $$('.qr-src-chips .qr-chip', wrap).forEach(function (c) { c.classList.remove('active'); });
        chip.classList.add('active');
        $$('.qr-src-pane', wrap).forEach(function (p) {
          p.classList.toggle('active', p.id === chip.dataset.src);
        });
      });
    });

    function setStatus(msg, cls) {
      status.hidden = false;
      status.textContent = msg;
      status.className = 'qr-upload-status' + (cls ? ' ' + cls : '');
    }

    function pick(file) {
      if (!file) return;
      // بعضی سیستم‌ها MIME نمی‌دهند — پسوند فایل هم بررسی می‌شود
      var okType = kind === 'audio' ? /^audio\// : /^video\//;
      var okExt = kind === 'audio' ? /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus)$/i : /\.(mp4|webm|ogv|m4v|mov)$/i;
      if (!okType.test(file.type) && !okExt.test(file.name)) {
        toast(kind === 'audio' ? 'لطفاً یک فایل صوتی انتخاب کنید' : 'لطفاً یک فایل ویدیویی انتخاب کنید');
        return;
      }
      if (file.size > UPLOAD_MAX_BYTES) {
        toast('حجم فایل بیشتر از ۱۰۰ مگابایت است');
        return;
      }
      picked = file;
      $('#' + kind + '-file-name').textContent = file.name;
      $('#' + kind + '-file-size').textContent = '(' + humanSize(file.size) + ')';
      preview.src = URL.createObjectURL(file);
      info.hidden = false;
      status.hidden = true;
      progress.hidden = true;
      btn.disabled = false;
    }

    input.addEventListener('change', function () { pick(this.files && this.files[0]); });

    ['dragover', 'dragleave', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) {
        e.preventDefault();
        drop.classList.toggle('dragover', ev === 'dragover');
        if (ev === 'drop' && e.dataTransfer.files && e.dataTransfer.files[0]) {
          pick(e.dataTransfer.files[0]);
        }
      });
    });

    btn.addEventListener('click', function () {
      if (!picked) return;
      btn.disabled = true;
      progress.hidden = false;
      fill.style.width = '0%';

      var providers = getUploadProviders();
      var tryProvider = function (i) {
        if (i >= providers.length) {
          progress.hidden = true;
          btn.disabled = false;
          setStatus('آپلود ناموفق بود — اتصال اینترنت را بررسی کنید یا لینک مستقیم فایل را دستی وارد کنید.', 'is-error');
          return;
        }
        var p = providers[i];
        setStatus('در حال آپلود به ' + p.name + '…');
        p.upload(picked, function (ratio) {
          fill.style.width = Math.round(ratio * 100) + '%';
        }).then(function (url) {
          // هینت نوع مدیا برای اسکنر — فرگمنت برای سرور بی‌اثر است
          url += '#media=' + kind;
          $('#' + kind + '-url').value = url;
          fill.style.width = '100%';
          btn.disabled = false;
          setStatus('آپلود شد (' + p.name + ' — ' + p.note + '): ' + url, 'is-ok');
          scheduleRebuild();
          toast('فایل آپلود شد و QR ساخته شد');
        }).catch(function () {
          fill.style.width = '0%';
          tryProvider(i + 1);
        });
      };
      tryProvider(0);
    });
  }

  // ==========================================================================
  // پنل مدیر — تنظیم هاست آپلود اختصاصی
  // ==========================================================================
  function bindAdminPanel() {
    var overlay = $('#admin-overlay');
    var status = $('#adm-status');

    function setAdmStatus(msg, cls) {
      status.hidden = false;
      status.textContent = msg;
      status.className = 'qr-upload-status' + (cls ? ' ' + cls : '');
    }

    function fillForm(cfg) {
      cfg = cfg || {};
      $('#adm-enabled').checked = !!cfg.enabled;
      $('#adm-name').value = cfg.name || '';
      $('#adm-endpoint').value = cfg.endpoint || '';
      $('#adm-method').value = (cfg.method || 'POST').toUpperCase() === 'PUT' ? 'PUT' : 'POST';
      $('#adm-field').value = cfg.fieldName || 'file';
      $('#adm-urlpath').value = cfg.responseUrlPath || 'data.url';
      $('#adm-prefix').value = cfg.urlPrefix || '';
      $('#adm-headers').value = cfg.headers && Object.keys(cfg.headers).length ? JSON.stringify(cfg.headers) : '';
      $('#adm-fallback').checked = cfg.useDefaultFallbacks !== false;
    }

    // خواندن فرم؛ درصورت JSON نامعتبر هدرها، خطا پرتاب می‌شود
    function readForm() {
      var headers = {};
      var raw = $('#adm-headers').value.trim();
      if (raw) headers = JSON.parse(raw);
      return {
        enabled: $('#adm-enabled').checked,
        name: $('#adm-name').value.trim() || 'هاست من',
        endpoint: $('#adm-endpoint').value.trim(),
        method: $('#adm-method').value,
        fieldName: $('#adm-field').value.trim() || 'file',
        headers: headers,
        responseUrlPath: $('#adm-urlpath').value.trim() || 'text',
        urlPrefix: $('#adm-prefix').value.trim(),
        useDefaultFallbacks: $('#adm-fallback').checked
      };
    }

    function readFormSafe() {
      try {
        var cfg = readForm();
        if (cfg.enabled && !cfg.endpoint) {
          setAdmStatus('آدرس API آپلود را وارد کنید.', 'is-error');
          return null;
        }
        return cfg;
      } catch (e) {
        setAdmStatus('هدرها JSON معتبر نیست — نمونه: {"Authorization":"Bearer XXX"}', 'is-error');
        return null;
      }
    }

    // فایل صوتی ریز برای تست آپلود (WAV نیم‌ثانیه‌ای)
    function makeTestFile() {
      var rate = 8000, n = 4000;
      var buf = new ArrayBuffer(44 + n * 2);
      var v = new DataView(buf);
      var wstr = function (o, s) { for (var i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
      wstr(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); wstr(8, 'WAVE'); wstr(12, 'fmt ');
      v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
      wstr(36, 'data'); v.setUint32(40, n * 2, true);
      for (var i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(Math.sin(i / 5) * 8000), true);
      return new File([buf], 'qr-upload-test.wav', { type: 'audio/wav' });
    }

    function open() {
      fillForm(getCustomUploadConfig());
      status.hidden = true;
      $('#adm-snippet-box').hidden = true;
      overlay.hidden = false;
    }

    function close() { overlay.hidden = true; }

    $$('.qr-admin-open').forEach(function (b) { b.addEventListener('click', open); });
    $('#adm-close').addEventListener('click', close);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });

    $('#adm-save').addEventListener('click', function () {
      var cfg = readFormSafe();
      if (!cfg) return;
      try {
        localStorage.setItem(ADMIN_CFG_KEY, JSON.stringify(cfg));
      } catch (e) {
        setAdmStatus('ذخیره در مرورگر ممکن نشد.', 'is-error');
        return;
      }
      setAdmStatus(cfg.enabled
        ? 'ذخیره شد — آپلودهای این مرورگر از «' + cfg.name + '» انجام می‌شود. برای همهٔ بازدیدکنندگان، «کد پیکربندی» را در js/upload-config.js بگذارید.'
        : 'ذخیره شد — هاست اختصاصی غیرفعال است و سرویس‌های عمومی استفاده می‌شوند.', 'is-ok');
      toast('تنظیمات ذخیره شد');
    });

    $('#adm-test').addEventListener('click', function () {
      var cfg = readFormSafe();
      if (!cfg) return;
      if (!cfg.endpoint) {
        setAdmStatus('آدرس API آپلود را وارد کنید.', 'is-error');
        return;
      }
      setAdmStatus('در حال تست آپلود یک فایل صوتی کوچک…');
      makeCustomProvider(cfg).upload(makeTestFile(), function () {}).then(function (url) {
        setAdmStatus('تست موفق ✓ لینک دریافتی: ' + url, 'is-ok');
      }).catch(function (e) {
        setAdmStatus('تست ناموفق: ' + (e && e.message ? e.message : 'خطای نامشخص') +
          ' — آدرس، متد، CORS سرور و هدرها را بررسی کنید.', 'is-error');
      });
    });

    $('#adm-snippet').addEventListener('click', function () {
      var cfg = readFormSafe();
      if (!cfg) return;
      var code = 'window.QR_UPLOAD_CONFIG = {\n  custom: ' +
        JSON.stringify(cfg, null, 2).replace(/\n/g, '\n  ') + '\n};\n';
      $('#adm-snippet-pre').textContent = code;
      $('#adm-snippet-box').hidden = false;
      setAdmStatus('این کد را جایگزین محتوای js/upload-config.js کنید تا برای همهٔ بازدیدکنندگان اعمال شود.');
    });

    $('#adm-snippet-copy').addEventListener('click', function () {
      copyText($('#adm-snippet-pre').textContent, 'کد پیکربندی کپی شد');
    });

    $('#adm-clear').addEventListener('click', function () {
      try { localStorage.removeItem(ADMIN_CFG_KEY); } catch (e) { /* نادیده */ }
      fillForm(window.QR_UPLOAD_CONFIG && window.QR_UPLOAD_CONFIG.custom);
      $('#adm-snippet-box').hidden = true;
      setAdmStatus('تنظیمات مرورگر حذف شد — تنظیمات فایل پیکربندی (درصورت وجود) اعمال می‌شود.', 'is-ok');
    });
  }

  // ==========================================================================
  // اسکنر
  // ==========================================================================
  function bindScanner() {
    if (typeof Html5Qrcode === 'undefined') return;

    // تب‌های حالت اسکن (دوربین / فایل)
    $$('[data-scanmode]').forEach(function (tab) {
      tab.addEventListener('click', function () {
        $$('[data-scanmode]').forEach(function (t) { t.classList.remove('active'); });
        tab.classList.add('active');
        $$('.qr-scan-mode').forEach(function (m) {
          m.classList.toggle('active', m.dataset.mode === tab.dataset.scanmode);
        });
        if (tab.dataset.scanmode !== 'camera') stopCamera();
      });
    });

    // دوربین
    $('#btn-cam-start').addEventListener('click', startCamera);
    $('#btn-cam-stop').addEventListener('click', stopCamera);

    // فایل
    var input = $('#scan-file-input');
    input.addEventListener('change', function () {
      if (this.files && this.files[0]) scanImageFile(this.files[0]);
    });

    var zone = $('.qr-dropzone');
    ['dragover', 'dragleave', 'drop'].forEach(function (ev) {
      zone.addEventListener(ev, function (e) {
        e.preventDefault();
        zone.classList.toggle('dragover', ev === 'dragover');
        if (ev === 'drop' && e.dataTransfer.files && e.dataTransfer.files[0]) {
          scanImageFile(e.dataTransfer.files[0]);
        }
      });
    });
  }

  function startCamera() {
    if (camRunning) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('مرورگر شما از دوربین پشتیبانی نمی‌کند (HTTPS لازم است)');
      return;
    }
    camScanner = camScanner || new Html5Qrcode('qr-reader');
    camScanner.start(
      { facingMode: 'environment' },
      {
        fps: 10,
        qrbox: function (vw, vh) {
          var s = Math.round(Math.min(vw, vh) * 0.7);
          return { width: s, height: s };
        }
      },
      function (decodedText) {
        stopCamera();
        showResult(decodedText);
      },
      function () { /* فریم بدون کد — نادیده */ }
    ).then(function () {
      camRunning = true;
      $('#btn-cam-start').hidden = true;
      $('#btn-cam-stop').hidden = false;
      $('#cam-hint').hidden = true;
    }).catch(function (err) {
      toast('دسترسی به دوربین ممکن نشد');
      console.error(err);
    });
  }

  function stopCamera() {
    if (!camScanner || !camRunning) return;
    camRunning = false;
    camScanner.stop().catch(function () {});
    $('#btn-cam-start').hidden = false;
    $('#btn-cam-stop').hidden = true;
  }

  function scanImageFile(file) {
    if (!/^image\//.test(file.type)) {
      toast('لطفاً یک فایل تصویری انتخاب کنید');
      return;
    }
    // دیکدر اصلی: jsQR (خواندن بایت‌ها و UTF-8 دقیق) — درصورت شکست: zxing
    decodeWithJsQr(file).then(function (text) {
      if (text !== null) {
        showResult(text);
        return;
      }
      fileScanner = fileScanner || new Html5Qrcode('qr-file-region');
      fileScanner.scanFile(file, false)
        .then(showResult)
        .catch(function () { toast('QR کدی در این تصویر پیدا نشد'); });
    });
  }

  function decodeWithJsQr(file) {
    return new Promise(function (resolve) {
      if (typeof jsQR === 'undefined') return resolve(null);
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        try {
          // تصاویر خیلی بزرگ را کوچک می‌کنیم؛ پس‌زمینهٔ شفاف باید سفید شود
          var max = 1200;
          var scale = Math.min(1, max / Math.max(img.width, img.height));
          var w = Math.max(1, Math.round(img.width * scale));
          var h = Math.max(1, Math.round(img.height * scale));
          var canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          var ctx = canvas.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          var pixels = ctx.getImageData(0, 0, w, h);
          var code = jsQR(pixels.data, w, h);
          if (!code) return resolve(null);
          var text;
          try {
            text = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(code.binaryData));
          } catch (e) {
            text = code.data; // بایت‌ها UTF-8 نبودند — متن خود کتابخانه
          }
          resolve(text);
        } catch (e) {
          resolve(null);
        }
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        resolve(null);
      };
      img.src = url;
    });
  }

  // ==========================================================================
  // تحلیل و نمایش نتیجهٔ اسکن
  // ==========================================================================
  function parseScan(text) {
    var t = text.trim();

    if (/^https?:\/\//i.test(t) || /^www\./i.test(t)) {
      var href = /^www\./i.test(t) ? 'https://' + t : t;

      // اگر لینک صوتی/ویدیویی باشد، پلیر داخلی نمایش داده می‌شود
      var media = mediaFromUrl(href);
      if (media) {
        return {
          type: media.kind === 'audio' ? 'audio' : 'video',
          label: media.kind === 'audio' ? 'صدا' : 'ویدیو',
          media: media,
          rows: [{ k: 'آدرس', v: t, href: href }],
          actions: [{ text: 'باز کردن لینک', icon: 'fa-up-right-from-square', href: href }, copyAction(t)]
        };
      }

      return { type: 'link', label: 'لینک', rows: [{ k: 'آدرس', v: t, href: href }],
        actions: [{ text: 'باز کردن لینک', icon: 'fa-up-right-from-square', href: href }, copyAction(t)] };
    }

    if (/^mailto:/i.test(t)) {
      var m = t.slice(7);
      var qi = m.indexOf('?');
      var addr = qi === -1 ? m : m.slice(0, qi);
      var sp = new URLSearchParams(qi === -1 ? '' : m.slice(qi + 1));
      var rows = [{ k: 'گیرنده', v: addr }];
      if (sp.get('subject')) rows.push({ k: 'موضوع', v: sp.get('subject') });
      if (sp.get('body')) rows.push({ k: 'متن', v: sp.get('body') });
      return { type: 'email', label: 'ایمیل', rows: rows,
        actions: [{ text: 'ارسال ایمیل', icon: 'fa-envelope', href: t }, copyAction(addr, 'کپی آدرس')] };
    }

    if (/^tel:/i.test(t)) {
      var num = t.slice(4);
      return { type: 'tel', label: 'تماس', rows: [{ k: 'شماره', v: num }],
        actions: [{ text: 'تماس', icon: 'fa-phone', href: t }, copyAction(num, 'کپی شماره')] };
    }

    if (/^smsto:/i.test(t) || /^sms:/i.test(t)) {
      var body = t.replace(/^smsto:/i, '').replace(/^sms:/i, '');
      var parts = body.split(':');
      var phone = parts.shift() || '';
      var msg = parts.join(':');
      var rows2 = [{ k: 'شماره', v: phone }];
      if (msg) rows2.push({ k: 'متن پیامک', v: msg });
      return { type: 'sms', label: 'پیامک', rows: rows2,
        actions: [{ text: 'ارسال پیامک', icon: 'fa-comment-sms', href: 'sms:' + phone + (msg ? '?body=' + encodeURIComponent(msg) : '') }, copyAction(phone, 'کپی شماره')] };
    }

    if (/^WIFI:/i.test(t)) {
      var wifi = parseWifi(t);
      var rows3 = [{ k: 'نام شبکه', v: wifi.S || '—' }, { k: 'رمزنگاری', v: wifi.T || '—' }];
      var actions = [];
      if (wifi.P) {
        rows3.push({ k: 'رمز عبور', v: wifi.P });
        actions.push(copyAction(wifi.P, 'کپی رمز'));
      }
      if (wifi.H) rows3.push({ k: 'شبکه مخفی', v: 'بله' });
      actions.push(copyAction(t, 'کپی همه'));
      return { type: 'wifi', label: 'وای‌فای', rows: rows3, actions: actions };
    }

    if (/^BEGIN:VCARD/i.test(t)) {
      var vc = parseVcard(t);
      return { type: 'vcard', label: 'کارت ویزیت', rows: vc,
        actions: [{ text: 'ذخیره مخاطب (vcf)', icon: 'fa-address-card', vcf: t }, copyAction(t)] };
    }

    if (/^MECARD:/i.test(t)) {
      var me = parseMecard(t);
      return { type: 'vcard', label: 'کارت ویزیت (MeCard)', rows: me, actions: [copyAction(t)] };
    }

    return { type: 'text', label: 'متن', rows: [{ k: 'محتوا', v: t }], actions: [copyAction(t)] };
  }

  function copyAction(value, text) {
    return { text: text || 'کپی', icon: 'fa-copy', copy: value };
  }

  // تشخیص لینک‌های صوتی/ویدیویی برای پخش داخلی
  // - فایل مستقیم: بر اساس پسوند مسیر
  // - ویدیو: لینک‌های یوتیوب و آپارات هم به‌صورت embed پشتیبانی می‌شوند
  function mediaFromUrl(href) {
    var u;
    try { u = new URL(href); } catch (e) { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

    // لینک صفحهٔ پلیر خود سایت (play.html#t=…&u=…) → پخش داخلی همان مدیا
    if (/\/play\.html$/.test(u.pathname)) {
      var pm = (u.hash || '').match(/^#t=(audio|video)&u=(.+)$/);
      if (pm) {
        var inner = decodeURIComponent(pm[2]).replace(/#media=(audio|video)$/, '');
        if (/^https?:\/\//i.test(inner)) {
          // لینک داخلی ممکن است خودش یوتیوب/آپارات باشد → embed
          return mediaFromUrl(inner) || { kind: pm[1], src: inner };
        }
      }
    }

    // هینت صریح نوع مدیا که ژنراتور هنگام آپلود فایل اضافه می‌کند
    var hint = (u.hash || '').match(/^#media=(audio|video)$/);
    if (hint) {
      return { kind: hint[1], src: href.replace(/#.*$/, '') };
    }

    var path = u.pathname.toLowerCase();
    if (/\.(mp3|wav|ogg|oga|m4a|aac|flac|opus)$/.test(path)) {
      return { kind: 'audio', src: href };
    }
    if (/\.(mp4|webm|ogv|m4v|mov)$/.test(path)) {
      return { kind: 'video', src: href };
    }

    var host = u.hostname.replace(/^www\.|^m\./, '');
    if (host === 'youtube.com' || host === 'youtube-nocookie.com' || host === 'youtu.be') {
      var id = null;
      if (host === 'youtu.be') {
        id = u.pathname.split('/')[1] || null;
      } else if (u.pathname === '/watch') {
        id = u.searchParams.get('v');
      } else {
        var ym = u.pathname.match(/^\/(embed|shorts|live)\/([A-Za-z0-9_-]{6,})/);
        if (ym) id = ym[2];
      }
      if (id && /^[A-Za-z0-9_-]{6,}$/.test(id)) {
        return { kind: 'embed', src: 'https://www.youtube.com/embed/' + id + '?autoplay=1' };
      }
    }
    if (host === 'aparat.com') {
      var am = u.pathname.match(/^\/v\/([A-Za-z0-9]+)/);
      if (am) {
        return { kind: 'embed', src: 'https://www.aparat.com/video/video/embed/videohash/' + am[1] + '/vt/frame' };
      }
    }
    // فایل‌های pixeldrain پسوند ندارند — پلیر ویدیو صدا را هم پخش می‌کند
    if (host === 'pixeldrain.com' && /^\/api\/file\/[A-Za-z0-9]+$/.test(u.pathname)) {
      return { kind: 'video', src: href };
    }
    return null;
  }

  function unescapeWifi(v) {
    return v.replace(/\\([\\;,:"])/g, '$1');
  }

  function parseWifi(t) {
    var out = {};
    var body = t.slice(5);
    // جداکردن فیلدها با درنظرگرفتن «;» های escape شده
    var re = /([A-Z]+):((?:\\.|[^\\;])*);/gi;
    var m;
    while ((m = re.exec(body)) !== null) {
      out[m[1].toUpperCase()] = unescapeWifi(m[2]);
    }
    if (out.H) out.H = /^true$/i.test(out.H);
    return out;
  }

  function unescapeVcard(v) {
    return v.replace(/\\n/gi, '\n').replace(/\\([\\;,])/g, '$1');
  }

  function parseVcard(t) {
    var rows = [];
    var map = {
      FN: 'نام کامل', ORG: 'شرکت', TITLE: 'سِمَت', EMAIL: 'ایمیل', URL: 'وب‌سایت', NOTE: 'یادداشت'
    };
    // خطوط ادامه‌دار (folded) را باز می‌کنیم
    var lines = t.replace(/\r/g, '').replace(/\n[ \t]/g, '').split('\n');
    lines.forEach(function (line) {
      var ci = line.indexOf(':');
      if (ci === -1) return;
      var keyPart = line.slice(0, ci).toUpperCase();
      var value = unescapeVcard(line.slice(ci + 1)).trim();
      if (!value) return;
      var key = keyPart.split(';')[0];

      if (key === 'TEL') {
        var kind = /CELL/i.test(keyPart) ? 'موبایل' : 'تلفن';
        rows.push({ k: kind, v: value });
      } else if (key === 'ADR') {
        rows.push({ k: 'آدرس', v: value.split(';').filter(Boolean).join('، ') });
      } else if (map[key]) {
        rows.push({ k: map[key], v: value });
      }
    });
    return rows.length ? rows : [{ k: 'محتوا', v: t }];
  }

  function parseMecard(t) {
    var rows = [];
    var map = { N: 'نام', TEL: 'تلفن', EMAIL: 'ایمیل', ORG: 'شرکت', URL: 'وب‌سایت', ADR: 'آدرس', NOTE: 'یادداشت' };
    var re = /([A-Z]+):((?:\\.|[^\\;])*);/gi;
    var m;
    while ((m = re.exec(t.slice(7))) !== null) {
      var key = m[1].toUpperCase();
      if (map[key]) rows.push({ k: map[key], v: unescapeWifi(m[2]) });
    }
    return rows.length ? rows : [{ k: 'محتوا', v: t }];
  }

  function showResult(text) {
    var parsed = parseScan(text);

    $('#qr-result-card').hidden = false;
    $('#result-type-badge').textContent = parsed.label;
    $('#result-raw').textContent = text;

    // پلیر صوتی/ویدیویی — پخش مستقیم داخل کارت نتیجه
    var mediaBox = $('#result-media');
    mediaBox.innerHTML = '';
    mediaBox.hidden = !parsed.media;
    if (parsed.media) {
      var player;
      if (parsed.media.kind === 'audio') {
        player = document.createElement('audio');
        player.controls = true;
        player.src = parsed.media.src;
      } else if (parsed.media.kind === 'video') {
        player = document.createElement('video');
        player.controls = true;
        player.playsInline = true;
        player.src = parsed.media.src;
      } else {
        player = document.createElement('iframe');
        player.src = parsed.media.src;
        player.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
        player.allowFullscreen = true;
      }
      mediaBox.appendChild(player);
      // تلاش برای پخش خودکار — اگر مرورگر اجازه ندهد، دکمهٔ پخش در دسترس است
      if (player.play) {
        var playing = player.play();
        if (playing && playing.catch) playing.catch(function () {});
      }
    }

    // ردیف‌های اطلاعات — ساخت با DOM (بدون innerHTML برای دادهٔ کاربر)
    var rowsBox = $('#result-rows');
    rowsBox.innerHTML = '';
    parsed.rows.forEach(function (row) {
      var div = document.createElement('div');
      div.className = 'qr-result-row';
      var k = document.createElement('span');
      k.className = 'k';
      k.textContent = row.k;
      var v = document.createElement('span');
      v.className = 'v';
      if (row.href) {
        var a = document.createElement('a');
        a.href = row.href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = row.v;
        v.appendChild(a);
      } else {
        v.textContent = row.v;
      }
      div.appendChild(k);
      div.appendChild(v);
      rowsBox.appendChild(div);
    });

    // دکمه‌های عملیات
    var actionsBox = $('#result-actions');
    actionsBox.innerHTML = '';
    parsed.actions.forEach(function (action, i) {
      var el;
      if (action.href) {
        el = document.createElement('a');
        el.href = action.href;
        if (/^https?:/i.test(action.href)) {
          el.target = '_blank';
          el.rel = 'noopener noreferrer';
        }
      } else {
        el = document.createElement('button');
        el.type = 'button';
      }
      el.className = 'qr-btn ' + (i === 0 ? 'qr-btn-primary' : 'qr-btn-outline');
      var icon = document.createElement('i');
      icon.className = 'fas ' + action.icon;
      el.appendChild(icon);
      el.appendChild(document.createTextNode(' ' + action.text));

      if (action.copy) {
        el.addEventListener('click', function () { copyText(action.copy, 'کپی شد'); });
      }
      if (action.vcf) {
        el.addEventListener('click', function () {
          var blob = new Blob([action.vcf], { type: 'text/vcard;charset=utf-8' });
          var a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'contact.vcf';
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
        });
      }
      actionsBox.appendChild(el);
    });

    $('#qr-result-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    toast('کد با موفقیت اسکن شد');
  }

  // ==========================================================================
  // ابزارهای کمکی
  // ==========================================================================
  function copyText(text, msg) {
    var done = function () { toast(msg || 'کپی شد'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () { fallbackCopy(text); done(); });
    } else {
      fallbackCopy(text);
      done();
    }
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* نادیده */ }
    ta.remove();
  }

  var toastTimer = null;
  function toast(msg) {
    var el = $('#qr-toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 2600);
  }
})();
