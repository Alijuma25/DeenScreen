/*
 * DeenScreen content script (v1)
 *
 * Runs on every page. Its jobs:
 *   1. Find the main <video> on the page (YouTube or any normal HTML5 video).
 *   2. Load the saved filters for that video from chrome.storage.
 *   3. While the video plays, SKIP or MUTE the sections the user marked.
 *   4. Answer status requests from the popup.
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

  function startMute(v) {
    if (!state.muteActive) {
      state.mutedBefore = v.muted;
      state.mutedVideo = v;
      state.muteActive = true;
      toast("muting this section");
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
    if (!v || !state.enabled || state.filters.length === 0 || isYouTubeAd()) {
      releaseMute();
      return;
    }
    if (state.mutedVideo && state.mutedVideo !== v) releaseMute();

    const t = v.currentTime;
    let inMute = false;

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

    if (inMute) startMute(v);
    else releaseMute();
  }

  // ---------- Video + filter tracking ----------

  function attachVideo(v) {
    if (state.video === v) return;
    if (state.video) {
      state.video.removeEventListener("timeupdate", check);
      state.video.removeEventListener("seeked", check);
      state.video.removeEventListener("play", check);
    }
    releaseMute();
    state.video = v;
    if (v) {
      v.addEventListener("timeupdate", check);
      v.addEventListener("seeked", check);
      v.addEventListener("play", check);
    }
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
    attachVideo(findVideo());
    const key = state.video ? getVideoKey() : null;
    if (key !== state.videoKey) {
      releaseMute();
      state.videoKey = key;
      state.filters = [];
      loadFilters(key);
    }
  }

  // ---------- Wiring ----------

  chrome.storage.local.get({ enabled: true }, (res) => {
    state.enabled = res.enabled !== false;
    scan();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.enabled) {
      state.enabled = changes.enabled.newValue !== false;
      if (!state.enabled) releaseMute();
    }
    const fk = "filters:" + state.videoKey;
    if (state.videoKey && changes[fk]) state.filters = sanitize(changes[fk].newValue);
    check();
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
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
    });
  });

  // YouTube is a single-page app: the URL changes without a page reload.
  window.addEventListener("yt-navigate-finish", scan);

  const timer = setInterval(() => {
    // Extension was reloaded or removed: stop cleanly.
    if (!window.__deenScreen.alive()) {
      clearInterval(timer);
      releaseMute();
      return;
    }
    state.tickCount++;
    if (state.tickCount % SCAN_EVERY === 0) scan();
    if (state.video && !state.video.paused) check();
  }, TICK_MS);
})();
