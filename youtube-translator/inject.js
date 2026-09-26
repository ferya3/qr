// Runs in the page (MAIN world) at document_start. Captures the subtitle data the YouTube
// player downloads (/api/timedtext) and can switch subtitles on so that download happens.
(() => {
  if (window.__ytxInjected) return;
  window.__ytxInjected = true;

  const isTimedText = (url) => typeof url === 'string' && url.includes('/api/timedtext');

  function publish(url, body) {
    try {
      const u = new URL(url, location.href);
      const data = typeof body === 'string' ? JSON.parse(body) : body;
      if (!data || !Array.isArray(data.events)) return;
      window.postMessage(
        {
          source: 'ytx-page',
          type: 'captions',
          videoId: u.searchParams.get('v'),
          lang: u.searchParams.get('lang') || '',
          tlang: u.searchParams.get('tlang') || '',
          kind: u.searchParams.get('kind') || '',
          events: data.events,
        },
        '*'
      );
    } catch {
      /* not json3 */
    }
  }

  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const res = await origFetch.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : input && input.url;
      if (isTimedText(url)) res.clone().text().then((t) => publish(url, t));
    } catch {}
    return res;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__ytxUrl = String(url);
    return origOpen.apply(this, arguments);
  };
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    if (isTimedText(this.__ytxUrl)) {
      this.addEventListener('load', () => {
        try {
          const body = this.responseType === 'json' ? this.response : this.responseText;
          publish(this.__ytxUrl, body);
        } catch {}
      });
    }
    return origSend.apply(this, arguments);
  };

  // Commands from the extension's content script.
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== 'ytx-ext') return;
    const player = document.getElementById('movie_player');
    if (!player) return;
    if (e.data.cmd === 'enableCaptions') {
      try {
        const pr = player.getPlayerResponse && player.getPlayerResponse();
        const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
        if (!tracks.length) {
          window.postMessage({ source: 'ytx-page', type: 'noCaptions', videoId: pr?.videoDetails?.videoId }, '*');
          return;
        }
        // Prefer human-made subtitles over auto-generated (kind "asr").
        const track = tracks.find((t) => t.kind !== 'asr') || tracks[0];
        player.loadModule && player.loadModule('captions');
        player.setOption && player.setOption('captions', 'track', { languageCode: track.languageCode, kind: track.kind });
        if (player.toggleSubtitlesOn) player.toggleSubtitlesOn();
      } catch (err) {
        console.warn('[YouTube Live Translator]', err);
      }
    }
  });
})();
