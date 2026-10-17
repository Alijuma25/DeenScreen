/*
 * DeenScreen content script (v1)
 *
 * Runs on every page. Its jobs:
 *   1. Find the main <video> on the page (YouTube or any normal HTML5 video).
 *   2. Load the saved filters for that video from chrome.storage.
 *   3. While the video plays, SKIP or MUTE the sections the user marked.
 *   4. Answer status requests from the popup.
 *   5. (v2) On YouTube, replace swear words in captions with **** when the
 *      Profanity setting is on. Word list lives in src/profanity.js.
 *
 * Storage layout (chrome.storage.local):
 *   enabled            -> true / false (master switch)
 *   categories         -> { nudity: bool, ... } (future use, not read here)
 *   "filters:<key>"    -> [{ id, start, end, action: "skip" | "mute" }]
 */
(() => {
  // If an older copy of this script is still alive in this tab, do nothing.
  // (After the extension is reloaded, the old copy is dead and we can run again.)
  if (window.__deenScreen && window.__deenScreen.alive()) return;
  window.__deenScreen = { alive: () => !!(chrome.runtime && chrome.runtime.id) };

  const TICK_MS = 200;        // how often we check playback time
  const SCAN_EVERY = 5;       // rescan the page for videos every 5 ticks (1s)
  const SKIP_EPSILON = 0.05;  // land slightly past the end so we never loop

  const state = {
    enabled: true,
    profanity: false,    // "Profanity" category switch (v2: YouTube subtitles)
    video: null,
    videoKey: null,
    filters: [],
    muteActive: false,   // are WE currently muting the video?
    mutedVideo: null,    // which video element we muted
    mutedBefore: false,  // was it already muted before we touched it?
    tickCount: 0,
  };

  // ---------- Helpers ----------

  const isYouTube = () => /(^|\.)youtube(-nocookie)?\.com$/.test(location.hostname);

  function fmt(sec) {
    if (!isFinite(sec)) return "--:--";
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = String(sec % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
  }

  // A stable ID for "this video" so filters can be saved and reused later.
  function getVideoKey() {
    if (isYouTube()) {
      const url = new URL(location.href);
      let id = url.searchParams.get("v");
      if (!id) {
        const m = url.pathname.match(/^\/(shorts|embed|live)\/([\w-]{6,})/);
        if (m) id = m[2];
      }
      return id ? "youtube:" + id : null;
    }
    return "page:" + location.hostname + location.pathname;
  }

  function getTitle() {
    if (isYouTube()) return document.title.replace(/ - YouTube$/, "").replace(/^\(\d+\)\s*/, "");
    return document.title || location.hostname;
  }

  // YouTube ads play in the same <video> element. Never filter during ads.
  function isYouTubeAd() {
    return isYouTube() && !!document.querySelector("#movie_player.ad-showing");
  }

  // Pick the most likely "main" video on the page.
  function findVideo() {
    if (isYouTube()) {
      const main = document.querySelector("#movie_player video.html5-main-video");
      if (main && main.isConnected) return main;
    }
    let best = null;
    let bestScore = -1;
    for (const v of document.querySelectorAll("video")) {
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (area < 2 && v.paused) continue; // hidden and not playing
      const score = area + (v.paused ? 0 : 1e9); // playing videos win
      if (score > bestScore) {
        best = v;
        bestScore = score;
      }
    }
    return best;
  }

  // ---------- Small on-page notice ----------

  let toastEl = null;
  let toastTimer = null;
  function toast(text) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.style.cssText = [
        "position:fixed", "top:16px", "right:16px", "z-index:2147483647",
        "background:#0f1512", "color:#e7f5ec", "border:1px solid #22c55e",
        "border-radius:10px", "padding:8px 12px", "font:600 13px/1.3 system-ui,sans-serif",
        "box-shadow:0 6px 20px rgba(0,0,0,.4)", "pointer-events:none",
        "transition:opacity .25s", "opacity:0",
      ].join(";");
    }
    // In fullscreen only the fullscreen element is visible, so attach there.
    const host = document.fullscreenElement || document.body || document.documentElement;
    if (toastEl.parentNode !== host) host.appendChild(toastEl);
    toastEl.textContent = "DeenScreen: " + text;
    toastEl.style.opacity = "1";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.style.opacity = "0"), 1800);
  }

  // ---------- Muting ----------

  function startMute(v, label = "muting this section") {
    if (!state.muteActive) {
      state.mutedBefore = v.muted;
      state.mutedVideo = v;
      state.muteActive = true;
      toast(label);
    }
    if (!v.muted) v.muted = true; // keep it muted even if the site tries to unmute
  }

  function releaseMute() {
    if (!state.muteActive) return;
    if (state.mutedVideo) state.mutedVideo.muted = state.mutedBefore;
    state.muteActive = false;
    state.mutedVideo = null;
  }

  // ---------- Core check ----------

  function check() {
    const v = state.video;
    const hasAuto = speechActive();
    if (!v || !state.enabled || (state.filters.length === 0 && !hasAuto) || isYouTubeAd()) {
      releaseMute();
      return;
    }
    if (state.mutedVideo && state.mutedVideo !== v) releaseMute();

    const t = v.currentTime;
    let inMute = false;
    let muteLabel = "muting this section";

    for (const f of state.filters) {
      if (t < f.start || t >= f.end) continue;
      if (f.action === "skip") {
        let target = f.end + SKIP_EPSILON;
        if (isFinite(v.duration)) target = Math.min(target, v.duration);
        v.currentTime = target;
        toast(`skipped ${fmt(f.start)} to ${fmt(f.end)}`);
        return; // next check runs from the new position
      }
      if (f.action === "mute") inMute = true;
    }

    // (v3) AI-detected spoken profanity, plus "not analyzed yet" safety mute.
    if (!inMute && hasAuto) {
      const reason = speechMuteReason(t);
      if (reason) {
        inMute = true;
        muteLabel = reason;
      }
    }

    if (inMute) startMute(v, muteLabel);
    else releaseMute();
  }

  // ---------- Video + filter tracking ----------

  function attachVideo(v) {
    if (state.video === v) return;
    if (state.video) {
      state.video.removeEventListener("timeupdate", check);
      state.video.removeEventListener("seeked", check);
      state.video.removeEventListener("play", onPlay);
      state.video.removeEventListener("loadedmetadata", syncSpeech);
      state.video.removeEventListener("seeking", onSeekingForSpeech);
    }
    releaseMute();
    state.video = v;
    if (v) {
      v.addEventListener("timeupdate", check);
      v.addEventListener("seeked", check);
      v.addEventListener("play", onPlay);
      v.addEventListener("loadedmetadata", syncSpeech);
      v.addEventListener("seeking", onSeekingForSpeech);
    }
  }

  // (v3) Start the AI filter the moment playback starts, not on the next
  // 1s scan, so not even a second of unchecked audio slips through.
  function onPlay() {
    syncSpeech();
    check();
  }

  function loadFilters(key) {
    if (!key) {
      state.filters = [];
      return;
    }
    chrome.storage.local.get("filters:" + key, (res) => {
      if (key !== state.videoKey) return; // user navigated away meanwhile
      state.filters = sanitize(res["filters:" + key]);
      check();
    });
  }

  function sanitize(list) {
    if (!Array.isArray(list)) return [];
    return list.filter(
      (f) => f && isFinite(f.start) && isFinite(f.end) && f.end > f.start &&
        (f.action === "skip" || f.action === "mute")
    );
  }

  function scan() {
    syncSubtitleFilter();
    attachVideo(findVideo());
    const key = state.video ? getVideoKey() : null;
    if (key !== state.videoKey) {
      releaseMute();
      state.videoKey = key;
      state.filters = [];
      loadFilters(key);
    }
    syncSpeech();
  }

  // ---------- YouTube subtitle profanity filter (v2) ----------
  //
  // YouTube draws captions as <span class="ytp-caption-segment"> elements
  // inside ".ytp-caption-window-container" in the player. We watch ONLY that
  // container, and only rewrite the text inside caption segments, so no other
  // text on the page is ever touched. MutationObserver callbacks run before
  // the browser paints, so the original word does not flash on screen.

  const subs = {
    observer: null,
    containers: new Set(),     // caption containers we are watching
    originals: new WeakMap(),  // text node -> { original, censored }
    touched: new Set(),        // text nodes we changed (so we can undo)
  };

  const subtitleFilterOn = () =>
    state.enabled && state.profanity && isYouTube() && !!globalThis.DeenScreenProfanity;

  function censorTextNode(node) {
    const text = node.nodeValue;
    const rec = subs.originals.get(node);
    if (rec && rec.censored === text) return; // already censored by us
    const res = globalThis.DeenScreenProfanity.censor(text);
    if (res.count === 0) return;
    subs.originals.set(node, { original: text, censored: res.text });
    subs.touched.add(node);
    node.nodeValue = res.text;
  }

  function filterCaptions() {
    for (const c of subs.containers) {
      if (!c.isConnected) {
        subs.containers.delete(c);
        continue;
      }
      for (const seg of c.querySelectorAll(".ytp-caption-segment")) {
        for (const n of seg.childNodes) if (n.nodeType === Node.TEXT_NODE) censorTextNode(n);
      }
    }
    // Forget caption text that has already left the screen.
    if (subs.touched.size > 40) {
      for (const n of subs.touched) if (!n.isConnected) subs.touched.delete(n);
    }
  }

  function stopSubtitleFilter() {
    if (subs.observer) subs.observer.disconnect();
    subs.observer = null;
    subs.containers.clear();
    // Put back the original words on any caption still on screen.
    for (const n of subs.touched) {
      const rec = subs.originals.get(n);
      if (rec && n.isConnected && n.nodeValue === rec.censored) n.nodeValue = rec.original;
    }
    subs.touched.clear();
  }

  // Called on every scan (1s) and whenever settings change. Cheap when idle.
  function syncSubtitleFilter() {
    if (!subtitleFilterOn()) {
      if (subs.observer) stopSubtitleFilter();
      return;
    }
    if (!subs.observer) subs.observer = new MutationObserver(filterCaptions);
    // No subtitles on this video? Then there is simply nothing to find here.
    const found = document.querySelectorAll(".html5-video-player .ytp-caption-window-container");
    let added = false;
    for (const c of found) {
      if (subs.containers.has(c)) continue;
      subs.containers.add(c);
      subs.observer.observe(c, { childList: true, subtree: true, characterData: true });
      added = true;
    }
    if (added) filterCaptions();
  }

  // ---------- (v3) Spoken profanity: on-device speech recognition ----------
  //
  // A hidden extension page ("offscreen") runs a Whisper speech model on the
  // video's audio and sends back the timestamps of swear words, which get
  // muted here. Audio reaches it in one of two ways:
  //   file:   a normal video file (http/https/file URL). The AI page downloads it.
  //   stream: players like YouTube that stream in pieces (MSE, blob: URLs).
  //           src/mse-tap.js copies each audio piece the player buffers AHEAD
  //           of playback, and we forward those pieces. Nothing extra is downloaded.
  // Anything the AI hasn't checked yet stays muted, so unchecked audio is never heard.
  // Nothing leaves your computer except the one-time model download.

  const SPEECH = {
    PAD_BEFORE: 0.25,          // mute a bit before the word (timestamps are approximate)
    PAD_AFTER: 0.25,           // ...and a bit after
    MUTE_UNTIL_ANALYZED: true, // stay silent where the AI hasn't listened yet
    LOOKAHEAD: 0.6,            // a spot counts as "analyzed" only if the next 0.6s is too
    MAX_MINUTES: 30,           // file mode limit (whole audio track is decoded in memory)
    CACHE_VERSION: 2,
    PIECE_BUFFER_BYTES: 16 * 1024 * 1024, // streamed audio kept while no AI job is running
  };
  const RUNNING = ["starting", "loading-model", "decoding", "analyzing"];

  const auto = newAutoState();
  function newAutoState() {
    return { jobId: null, url: null, mode: null, videoKey: null, cacheKey: null, status: "off",
             message: "", progress: null, analyzed: [], segments: [], wordCount: 0, duration: 0,
             lastSeekSent: -999, startedAt: 0 };
  }

  // --- Streamed audio pieces from src/mse-tap.js (page world) ---
  const mseUrls = new Set();     // blob: URLs that belong to a MediaSource
  const pieceBuffer = [];        // recent pieces: { url, sb, mime, offset, bytes }
  let pieceBytes = 0;

  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || typeof e.data.__deenscreen !== "string") return;
    const d = e.data;
    if (d.__deenscreen === "mse-url" && typeof d.url === "string") {
      mseUrls.add(d.url);
    } else if (d.__deenscreen === "mse-audio" && d.url && d.bytes instanceof ArrayBuffer) {
      mseUrls.add(d.url);
      onPiece({ url: d.url, sb: d.sb, mime: String(d.mime), offset: +d.offset || 0, bytes: d.bytes });
    }
  });

  function onPiece(piece) {
    if (auto.mode === "stream" && auto.url === piece.url && auto.jobId && RUNNING.includes(auto.status)) {
      forwardPiece(piece);
      return;
    }
    // No job for this audio yet (still loading, an ad, filter off): keep the most recent pieces.
    pieceBuffer.push(piece);
    pieceBytes += piece.bytes.byteLength;
    while (pieceBytes > SPEECH.PIECE_BUFFER_BYTES) {
      // drop the oldest sound piece, but never a codec setup piece (tiny, needed to decode the rest)
      const i = pieceBuffer.findIndex((p) => !isSetupPiece(p));
      if (i < 0) break;
      pieceBytes -= pieceBuffer.splice(i, 1)[0].bytes.byteLength;
    }
  }

  function isSetupPiece(p) {
    const b = new Uint8Array(p.bytes, 0, Math.min(8, p.bytes.byteLength));
    return (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) || // WebM header
      String.fromCharCode(b[4], b[5], b[6], b[7]) === "ftyp";                   // MP4 header
  }

  function toBase64(buf) {
    const bytes = new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  function forwardPiece(p) {
    sendSpeech({ type: "DS_SPEECH_CHUNK", jobId: auto.jobId, sb: p.sb, mime: p.mime,
                 offset: p.offset, data: toBase64(p.bytes) });
  }

  function flushPieces(url) {
    const keep = [];
    for (const p of pieceBuffer) (p.url === url ? forwardPiece(p) : keep.push(p));
    pieceBuffer.length = 0;
    pieceBuffer.push(...keep);
    pieceBytes = keep.reduce((n, p) => n + p.bytes.byteLength, 0);
  }

  // --- State helpers ---
  const speechWanted = () => state.enabled && state.profanity && !!state.video;
  const speechActive = () =>
    speechWanted() && (auto.segments.length > 0 || RUNNING.includes(auto.status));

  function isCovered(t) {
    const need = Math.min(t + SPEECH.LOOKAHEAD, auto.duration || t);
    return auto.analyzed.some(([s, e]) => s <= t + 0.001 && e >= need - 0.001);
  }

  // Why should we be muted at time t right now? (null = we shouldn't)
  function speechMuteReason(t) {
    for (const seg of auto.segments) {
      if (t >= seg.start && t < seg.end) return "muted a swear word";
    }
    if (SPEECH.MUTE_UNTIL_ANALYZED && RUNNING.includes(auto.status) && !isCovered(t)) {
      return "analyzing audio, sound returns in a moment";
    }
    return null;
  }

  // Returns { mode } if we can analyze this video, or { why } if not.
  function speechSupport(v, url) {
    if (v.duration === Infinity) return { why: "Live streams aren't supported yet." };
    if (/^blob:/i.test(url)) {
      if (mseUrls.has(url)) return { mode: "stream" };
      return { why: "This video was loaded in a way DeenScreen can't read ahead. If it's a file on your computer, open it directly in Chrome.", retry: true };
    }
    if (!/^(https?|file):/i.test(url)) return { why: "Unsupported video source." };
    if (isFinite(v.duration) && v.duration > SPEECH.MAX_MINUTES * 60) {
      return { why: `Video files longer than ${SPEECH.MAX_MINUTES} minutes aren't supported yet.` };
    }
    return { mode: "file" };
  }

  function sendSpeech(msg) {
    try {
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch (e) { /* extension reloaded */ }
  }

  function stopSpeech() {
    if (auto.jobId && RUNNING.includes(auto.status)) {
      sendSpeech({ type: "DS_SPEECH_STOP", jobId: auto.jobId });
    }
    Object.assign(auto, newAutoState());
  }

  function addSegments(words) {
    for (const w of words) {
      auto.segments.push({ start: Math.max(0, w.start - SPEECH.PAD_BEFORE), end: w.end + SPEECH.PAD_AFTER });
      auto.wordCount++;
    }
    auto.segments = mergeSegments(auto.segments);
  }

  function mergeSegments(list) {
    const sorted = [...list].sort((a, b) => a.start - b.start);
    const merged = [];
    for (const s of sorted) {
      const last = merged[merged.length - 1];
      if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
      else merged.push({ ...s });
    }
    return merged;
  }

  function syncSpeech() {
    if (!speechWanted()) {
      if (auto.status !== "off") stopSpeech();
      return;
    }
    const v = state.video;
    const url = v.currentSrc || v.src || "";
    if (!url) return; // video has no source yet
    // During a YouTube ad, leave the AI alone (ad audio is never analyzed as the video's).
    if (isYouTubeAd()) return;
    // Safety net: the AI page never answered at all. Don't stay muted forever.
    if (auto.status === "starting" && auto.startedAt && Date.now() - auto.startedAt > 20000) {
      auto.status = "error";
      auto.message = "The AI audio filter didn't start. Try reloading the page.";
      toast(auto.message);
      check();
      return;
    }
    const sameVideo = auto.url === url && auto.videoKey === state.videoKey;
    if (sameVideo && !(auto.status === "unsupported" && auto.retry && mseUrls.has(url))) {
      // Keep the AI aimed at where the viewer is.
      if (RUNNING.includes(auto.status) && auto.jobId) sendSeek(v.currentTime);
      return;
    }
    stopSpeech();
    const sup = speechSupport(v, url);
    if (sup.why) {
      Object.assign(auto, { url, videoKey: state.videoKey, status: "unsupported", message: sup.why, retry: !!sup.retry });
      return;
    }
    if (!isFinite(v.duration) || v.duration <= 0) return; // wait for metadata
    startSpeech(url, v, sup.mode);
  }

  function startSpeech(url, v, mode) {
    // Saved results: per file URL, or per video page for streams (their blob: URLs change every visit).
    const cacheKey = "speech:" + (mode === "stream" ? state.videoKey : url);
    Object.assign(auto, { url, mode, videoKey: state.videoKey, cacheKey, status: "starting",
                          message: "Starting...", duration: v.duration });
    chrome.storage.local.get(cacheKey, (res) => {
      if (auto.url !== url || auto.status !== "starting") return;
      const c = res[cacheKey];
      if (c && c.v === SPEECH.CACHE_VERSION) {
        auto.analyzed = c.analyzed || [];
        auto.segments = c.segments || [];
        auto.wordCount = c.wordCount || 0;
        if (c.done) {
          Object.assign(auto, { status: "done", message: "Using saved analysis" });
          check();
          return;
        }
      }
      auto.jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      auto.startedAt = Date.now();
      sendSpeech({ type: "DS_SPEECH_START", jobId: auto.jobId, mode, url, duration: v.duration,
                   from: v.currentTime, skip: auto.analyzed });
      if (mode === "stream") flushPieces(url); // audio the player buffered before the job existed
      check(); // start the "not analyzed yet" safety mute right away
    });
  }

  function saveProgress(done) {
    if (!auto.cacheKey) return;
    chrome.storage.local.set({
      [auto.cacheKey]: { v: SPEECH.CACHE_VERSION, done: !!done, analyzed: auto.analyzed,
                         segments: auto.segments, wordCount: auto.wordCount },
    });
  }

  function sendSeek(t) {
    if (Math.abs(t - auto.lastSeekSent) < 2) return;
    auto.lastSeekSent = t;
    sendSpeech({ type: "DS_SPEECH_SEEK", jobId: auto.jobId, from: t });
  }

  function onSeekingForSpeech() {
    const v = state.video;
    if (v && RUNNING.includes(auto.status) && auto.jobId && !isCovered(v.currentTime)) sendSeek(v.currentTime);
  }

  function onSpeechUpdate(msg) {
    if (!msg.jobId || msg.jobId !== auto.jobId) return;
    if (msg.status) auto.status = msg.status;
    if (msg.message != null) auto.message = msg.message;
    if (msg.progress != null) auto.progress = msg.progress;
    if (msg.analyzed) auto.analyzed = msg.analyzed;
    if (msg.words && msg.words.length) addSegments(msg.words);
    if (msg.analyzed || msg.status === "done") saveProgress(msg.status === "done");
    if (msg.status === "error") toast(auto.message || "speech analysis failed");
    check();
  }

  function speechStatus() {
    const covered = auto.analyzed.reduce((sum, [s, e]) => sum + (e - s), 0);
    return { status: auto.status, message: auto.message, progress: auto.progress, mode: auto.mode,
             covered, duration: auto.duration, muted: auto.wordCount };
  }

  window.addEventListener("pagehide", stopSpeech);

  // Catch any video starting or getting ready, page-wide and immediately
  // (media events don't bubble, but they can be caught in the capture phase).
  // Important for autoplaying videos: the AI filter's safety mute is applied
  // before the first second of audio, instead of on the next 1s scan.
  function onAnyMediaEvent(e) {
    if (!(e.target instanceof HTMLVideoElement)) return;
    scan();
    check();
  }
  document.addEventListener("loadedmetadata", onAnyMediaEvent, true);
  document.addEventListener("play", onAnyMediaEvent, true);

  // ---------- Wiring ----------

  chrome.storage.local.get({ enabled: true, categories: {} }, (res) => {
    state.enabled = res.enabled !== false;
    state.profanity = !!(res.categories && res.categories.profanity);
    scan();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.enabled) {
      state.enabled = changes.enabled.newValue !== false;
      if (!state.enabled) releaseMute();
    }
    if (changes.categories) {
      const cats = changes.categories.newValue || {};
      state.profanity = !!cats.profanity;
    }
    if (changes.enabled || changes.categories) {
      syncSubtitleFilter();
      syncSpeech();
    }
    const fk = "filters:" + state.videoKey;
    if (state.videoKey && changes[fk]) state.filters = sanitize(changes[fk].newValue);
    check();
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "DS_SPEECH_UPDATE") return onSpeechUpdate(msg);
    if (!msg || msg.type !== "DS_GET_STATUS") return;
    scan();
    const v = state.video;
    sendResponse({
      ok: true,
      detected: !!v,
      platform: isYouTube() ? "YouTube" : "HTML5 video",
      videoKey: state.videoKey,
      title: v ? getTitle() : null,
      currentTime: v ? v.currentTime : null,
      duration: v && isFinite(v.duration) ? v.duration : null,
      paused: v ? v.paused : null,
      isAd: isYouTubeAd(),
      muting: state.muteActive,
      speech: speechStatus(),
    });
  });

  // YouTube is a single-page app: the URL changes without a page reload.
  window.addEventListener("yt-navigate-finish", scan);

  const timer = setInterval(() => {
    // Extension was reloaded or removed: stop cleanly.
    if (!window.__deenScreen.alive()) {
      clearInterval(timer);
      releaseMute();
      stopSubtitleFilter();
      return;
    }
    state.tickCount++;
    if (state.tickCount % SCAN_EVERY === 0) scan();
    if (state.video && !state.video.paused) check();
  }, TICK_MS);

  // (v3) Words are short, so while AI muting is active we check every 40ms
  // instead of every 200ms. Costs almost nothing; idle otherwise.
  const fastTimer = setInterval(() => {
    if (!window.__deenScreen.alive()) return clearInterval(fastTimer);
    if (state.video && !state.video.paused && speechActive()) check();
  }, 40);
})();
