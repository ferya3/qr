// Runs in the page (MAIN world) at document_start. Gets the video's subtitles in two ways:
//  1. captures the subtitle file the YouTube player itself downloads (/api/timedtext), and
//  2. on request, downloads the subtitle track directly (and, if that is refused, switches
//     the player's subtitles on so that (1) happens).
(() => {
  if (window.__ytxInjected) return;
  window.__ytxInjected = true;
  const LOG = (...a) => console.log('[YouTube Live Translator]', ...a);

  const isTimedText = (url) => typeof url === 'string' && url.includes('/api/timedtext');
  const post = (msg) => window.postMessage({ source: 'ytx-page', ...msg }, '*');

  function publish(url, body, via) {
    if (!body || !String(body).trim()) return false;
    const u = new URL(url, location.href);
    post({
      type: 'captions',
      via,
      videoId: u.searchParams.get('v'),
      lang: u.searchParams.get('lang') || '',
      tlang: u.searchParams.get('tlang') || '',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    return true;
  }

  // ---- 1. capture the player's own requests ----
  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const res = await origFetch.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : input && input.url;
      if (isTimedText(url)) res.clone().text().then((t) => publish(url, t, 'player-fetch'));
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
          const body = this.responseType === 'json' ? JSON.stringify(this.response) : this.responseText;
          publish(this.__ytxUrl, body, 'player-xhr');
        } catch {}
      });
    }
    return origSend.apply(this, arguments);
  };

  // ---- 2. load subtitles on request ----
  function playerResponse(videoId) {
    const player = document.getElementById('movie_player');
    const candidates = [player?.getPlayerResponse?.(), window.ytInitialPlayerResponse];
    return candidates.find((pr) => pr && pr.videoDetails && (!videoId || pr.videoDetails.videoId === videoId)) || null;
  }

  function pickTrack(tracks, original) {
    const manual = tracks.filter((t) => t.kind !== 'asr');
    const asr = tracks.filter((t) => t.kind === 'asr');
    // The auto-generated track is in the spoken language; prefer human subtitles in that language.
    const spoken = asr[0]?.languageCode || original;
    return (
      manual.find((t) => spoken && t.languageCode.split('-')[0] === spoken.split('-')[0]) ||
      asr[0] ||
      manual[0] ||
      tracks[0]
    );
  }

  async function loadCaptions(videoId) {
    const pr = playerResponse(videoId);
    if (!pr) {
      post({ type: 'status', videoId, message: 'player-not-ready' });
      return;
    }
    const tracks = pr.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    LOG('caption tracks:', tracks.map((t) => `${t.languageCode}${t.kind === 'asr' ? ' (auto)' : ''}`).join(', ') || 'none');
    if (!tracks.length) {
      post({ type: 'noCaptions', videoId });
      return;
    }
    const track = pickTrack(tracks, pr.videoDetails?.defaultAudioLanguage);
    post({ type: 'status', videoId, message: 'track', lang: track.languageCode, auto: track.kind === 'asr' });

    // Direct download (works when YouTube doesn't require a player token).
    try {
      const url = new URL(track.baseUrl, location.href);
      url.searchParams.set('fmt', 'json3');
      const text = await (await origFetch(url.toString(), { credentials: 'include' })).text();
      if (publish(url.toString(), text, 'direct')) {
        LOG('subtitles downloaded directly');
        return;
      }
      LOG('direct subtitle download returned nothing; switching player subtitles on');
    } catch (err) {
      LOG('direct subtitle download failed:', err);
    }

    // Fallback: turn on subtitles in the player; its request is captured above.
    const player = document.getElementById('movie_player');
    try {
      player.loadModule?.('captions');
      player.setOption?.('captions', 'track', { languageCode: track.languageCode, ...(track.kind ? { kind: track.kind } : {}) });
      if (!player.isSubtitlesOn?.()) player.toggleSubtitlesOn?.();
      if (!player.isSubtitlesOn?.()) document.querySelector('.ytp-subtitles-button[aria-pressed="false"]')?.click();
    } catch (err) {
      LOG('could not enable player subtitles:', err);
    }
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== 'ytx-ext') return;
    if (e.data.cmd === 'loadCaptions') loadCaptions(e.data.videoId);
  });
})();
