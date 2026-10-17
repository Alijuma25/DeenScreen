/*
 * DeenScreen popup (v1)
 * Talks to the content script in the active tab to learn about the video,
 * and reads/writes filters + settings in chrome.storage.local.
 */

// Automatic-filter categories. Only "profanity" does something so far
// (v2: YouTube subtitles, v3: AI muting of spoken words in video files).
// Everything else is saved only, NOT functional yet.
const CATEGORIES = [
  { id: "nudity", label: "Nudity" },
  { id: "sexual", label: "Sexual content" },
  { id: "music", label: "Music" },
  { id: "profanity", label: "Profanity", active: "Active (AI audio + subtitles)" },
  { id: "lgbtq", label: "LGBTQ+ romantic or thematic content" },
  { id: "violence", label: "Violence" },
];

const $ = (id) => document.getElementById(id);

const ui = {
  tabId: null,
  status: null,      // last status from content script
  videoKey: null,
  action: "skip",
  pollTimer: null,
};

// ---------- Time helpers ----------

function fmt(sec) {
  if (sec == null || !isFinite(sec)) return "--:--";
  const whole = Math.floor(sec);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = String(whole % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

// Accepts "90", "1:30", "1:02:03", "1:30.5". Returns seconds or NaN.
function parseTime(text) {
  const str = String(text).trim();
  if (!str) return NaN;
  if (!/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(str)) return NaN;
  const parts = str.split(":").map(Number);
  if (parts.slice(1).some((p) => p >= 60)) return NaN;
  return parts.reduce((total, p) => total * 60 + p, 0);
}

// ---------- Talking to the page ----------

function sendToTab(msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(ui.tabId, msg, { frameId: 0 }, (res) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(res || null);
    });
  });
}

async function getStatus() {
  let res = await sendToTab({ type: "DS_GET_STATUS" });
  if (!res) {
    // Tab was probably open before DeenScreen was installed. Inject now.
    try {
      await chrome.scripting.executeScript({ target: { tabId: ui.tabId }, files: ["src/profanity.js", "src/content.js"] });
      res = await sendToTab({ type: "DS_GET_STATUS" });
    } catch (e) {
      res = null; // chrome:// pages, the Web Store, etc. cannot be scripted
    }
  }
  return res;
}

// ---------- Status card ----------

function renderStatus(s) {
  const dot = $("statusDot");
  const text = $("statusText");
  const pill = $("platformPill");
  dot.className = "dot";

  if (!s) {
    text.textContent = "DeenScreen can't run on this page";
    pill.hidden = true;
    $("videoTitle").textContent = "Open a YouTube video or a page with a video.";
    $("videoTime").textContent = "";
    $("speechLine").hidden = true;
    setFormEnabled(false);
    return;
  }

  if (!s.detected) {
    text.textContent = "No video detected";
    pill.hidden = true;
    $("videoTitle").textContent = "Start playing a video, then reopen this popup.";
    $("videoTime").textContent = "";
    $("speechLine").hidden = true;
    setFormEnabled(false);
    return;
  }

  dot.classList.add(s.isAd ? "warn" : "on");
  text.textContent = s.isAd ? "Ad playing (filters paused)" : "Video detected";
  pill.hidden = false;
  pill.textContent = s.platform;
  $("videoTitle").textContent = s.title || "";
  const state = s.muting ? "  🔇 muting" : s.paused ? "  ⏸ paused" : "  ▶ playing";
  $("videoTime").textContent = `${fmt(s.currentTime)} / ${fmt(s.duration)}${state}`;
  setFormEnabled(!!s.videoKey);
  renderSpeech(s.speech);
}

// (v3) One line about the AI spoken-profanity filter for this video.
function renderSpeech(sp) {
  const el = $("speechLine");
  el.className = "speech-line";
  if (!sp || sp.status === "off") {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const muted = sp.muted === 1 ? "1 swear word muted" : `${sp.muted || 0} swear words muted`;
  let text;
  switch (sp.status) {
    case "unsupported":
      text = "🎙️ AI audio filter not available here. " + sp.message;
      el.classList.add("dim");
      break;
    case "error":
      text = "⚠️ AI audio filter: " + sp.message;
      el.classList.add("bad");
      break;
    case "analyzing":
      text = `🎙️ AI listened to ${fmt(sp.covered)} of ${fmt(sp.duration)} · ${muted}`;
      break;
    case "done":
      text = `🎙️ Whole video checked by AI · ${muted}`;
      el.classList.add("good");
      break;
    default:
      text = "🎙️ " + (sp.message || "Starting AI audio filter...") + " (muted until ready)";
  }
  el.textContent = text;
}

function setFormEnabled(on) {
  for (const id of ["startInput", "endInput", "startNow", "endNow", "addBtn"]) $(id).disabled = !on;
}

async function refreshStatus() {
  const s = await getStatus();
  ui.status = s;
  renderStatus(s);
  const key = s && s.detected ? s.videoKey : null;
  if (key !== ui.videoKey) {
    ui.videoKey = key;
    renderFilters();
  }
}

// ---------- Filters ----------

const filterStorageKey = () => "filters:" + ui.videoKey;

function loadFilters() {
  return new Promise((resolve) => {
    if (!ui.videoKey) return resolve([]);
    chrome.storage.local.get(filterStorageKey(), (res) => resolve(res[filterStorageKey()] || []));
  });
}

function saveFilters(list) {
  return chrome.storage.local.set({ [filterStorageKey()]: list });
}

async function renderFilters() {
  const list = await loadFilters();
  const ul = $("filterList");
  ul.innerHTML = "";
  $("filterCount").textContent = list.length;
  $("emptyState").hidden = list.length > 0;
  $("emptyState").textContent = ui.videoKey ? "No filters yet for this video." : "No video selected.";

  for (const f of list) {
    const li = document.createElement("li");
    li.className = "filter-item";

    const range = document.createElement("span");
    range.className = "filter-range";
    range.textContent = `${fmt(f.start)} → ${fmt(f.end)}`;

    const tag = document.createElement("span");
    tag.className = "tag " + f.action;
    tag.textContent = f.action.toUpperCase();

    const del = document.createElement("button");
    del.className = "del";
    del.title = "Delete this filter";
    del.textContent = "×";
    del.addEventListener("click", async () => {
      const current = await loadFilters();
      await saveFilters(current.filter((x) => x.id !== f.id));
      renderFilters();
    });

    li.append(range, tag, del);
    ul.appendChild(li);
  }
}

async function addFilter() {
  const err = $("formError");
  err.textContent = "";
  if (!ui.videoKey) return (err.textContent = "No video detected on this tab.");

  const start = parseTime($("startInput").value);
  const end = parseTime($("endInput").value);
  if (isNaN(start)) return (err.textContent = "Start time isn't valid. Try 1:30 or 90.");
  if (isNaN(end)) return (err.textContent = "End time isn't valid. Try 2:05 or 125.");
  if (end <= start) return (err.textContent = "End time must be after the start time.");
  const dur = ui.status && ui.status.duration;
  if (dur && start >= dur) return (err.textContent = `Start is past the end of the video (${fmt(dur)}).`);

  const list = await loadFilters();
  list.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), start, end, action: ui.action });
  list.sort((a, b) => a.start - b.start);
  await saveFilters(list);

  $("startInput").value = "";
  $("endInput").value = "";
  renderFilters();
}

async function fillNow(inputId) {
  const s = await getStatus();
  if (s && s.detected && s.currentTime != null) $(inputId).value = fmt(s.currentTime);
}

// ---------- Settings (future categories) ----------

function renderCategories(saved) {
  const ul = $("catList");
  ul.innerHTML = "";
  for (const c of CATEGORIES) {
    const li = document.createElement("li");
    li.className = "cat";
    li.innerHTML = `
      <span class="cat-name"></span>
      <span class="soon">Not yet functional</span>
      <label class="switch"><input type="checkbox" /><span class="slider"></span></label>`;
    li.querySelector(".cat-name").textContent = c.label;
    if (c.active) {
      const badge = li.querySelector(".soon");
      badge.textContent = c.active;
      badge.classList.add("active");
    }
    const box = li.querySelector("input");
    box.checked = !!saved[c.id];
    box.addEventListener("change", () => {
      chrome.storage.local.get({ categories: {} }, (res) => {
        const cats = res.categories || {};
        cats[c.id] = box.checked;
        chrome.storage.local.set({ categories: cats });
      });
    });
    ul.appendChild(li);
  }
}

// ---------- Master switch ----------

function applyEnabled(on) {
  $("masterSwitch").checked = on;
  document.body.classList.toggle("off", !on);
  $("pausedOverlay").hidden = on;
  $("masterLabel").textContent = on ? "Protection on" : "Protection off";
}

// ---------- Init ----------

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  ui.tabId = tab ? tab.id : null;

  const stored = await chrome.storage.local.get({ enabled: true, categories: {} });
  applyEnabled(stored.enabled !== false);
  renderCategories(stored.categories || {});

  $("masterSwitch").addEventListener("change", (e) => {
    chrome.storage.local.set({ enabled: e.target.checked });
    applyEnabled(e.target.checked);
  });

  document.querySelectorAll(".tab").forEach((btn) =>
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === btn));
      $("panel-filters").hidden = btn.dataset.tab !== "filters";
      $("panel-settings").hidden = btn.dataset.tab !== "settings";
    })
  );

  document.querySelectorAll(".seg").forEach((btn) =>
    btn.addEventListener("click", () => {
      ui.action = btn.dataset.action;
      document.querySelectorAll(".seg").forEach((b) => b.classList.toggle("active", b === btn));
    })
  );

  $("addBtn").addEventListener("click", addFilter);
  $("startNow").addEventListener("click", () => fillNow("startInput"));
  $("endNow").addEventListener("click", () => fillNow("endInput"));
  for (const id of ["startInput", "endInput"]) {
    $(id).addEventListener("keydown", (e) => e.key === "Enter" && addFilter());
  }

  if (ui.tabId == null) return renderStatus(null);
  await refreshStatus();
  await renderFilters();
  ui.pollTimer = setInterval(refreshStatus, 1000); // live time display
}

init();
