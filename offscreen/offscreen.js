/*
 * DeenScreen offscreen page (v3.1): finds spoken profanity in video audio.
 *
 * Two ways audio arrives, both placed on the video's own timeline:
 *   "file":   a normal video file. Downloaded and decoded in one go.
 *   "stream": streaming players like YouTube. The page's player already
 *             downloads audio AHEAD of playback; the content script sends us a
 *             copy of each piece as it is buffered (see src/mse-tap.js).
 *
 * Then, repeatedly: pick the earliest stretch of received-but-unchecked audio
 * at or after where the viewer is, run speech recognition on up to 30s of it
 * (with 2.5s of audio before it as context so words aren't cut), and send back
 * which time range is now checked plus the timestamps of any swear words.
 */
import { loadEngine } from "./speech-engine.js";
import { splitPiece, initInfo, mediaStartTime } from "./media-parse.js";

const SAMPLE_RATE = 16000;
const WINDOW = 30;       // seconds of audio per recognition run (Whisper's window)
const EDGE = 2.5;        // context kept on each side so words at the edges aren't cut
const MIN_STEP = 1;      // don't run the model for less than 1s of new audio
const NOT_URGENT_MIN = 8;// far from the viewer: wait until 8s of new audio is buffered
const WAITING_WINDOW = 10; // the viewer is sitting in silence: check a short piece first
const MAX_BYTES = 600 * 1024 * 1024; // refuse giant files in this prototype
const IDLE_CLOSE_MS = 3 * 60 * 1000; // free memory when unused for 3 minutes

// One job per tab. Jobs share the single speech model and take turns using it.
const jobs = new Map(); // jobId -> job
let idleTimer = null;
let engineBusy = Promise.resolve();

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.target !== "offscreen") return;
  const j = jobs.get(msg.jobId);
  if (msg.type === "DS_SPEECH_START") startJob(msg);
  else if (msg.type === "DS_SPEECH_SEEK" && j) { j.cursorTime = msg.from || 0; wake(j); }
  else if (msg.type === "DS_SPEECH_CHUNK" && j) addPiece(j, msg);
  else if (msg.type === "DS_SPEECH_STOP" && j) cancel(j);
  else if (msg.type === "DS_SPEECH_STOP_TAB") {
    for (const other of jobs.values()) if (other.tabId === msg.tabId) cancel(other);
  }
});

function cancel(j) {
  j.cancelled = true;
  jobs.delete(j.id);
  if (jobs.size === 0) scheduleIdleClose();
}

function scheduleIdleClose() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (jobs.size === 0) window.close(); }, IDLE_CLOSE_MS);
}

function send(j, payload) {
  if (j.cancelled) return;
  chrome.runtime
    .sendMessage({ type: "DS_SPEECH_UPDATE", target: "background", tabId: j.tabId, jobId: j.id, ...payload })
    .catch(() => {});
}

// Only one recognition at a time (the model can't run two at once).
function exclusive(fn) {
  const p = engineBusy.then(fn, fn);
  engineBusy = p.catch(() => {});
  return p;
}

// ---------- Audio ----------

function xhrBytes(url) {
  // fetch() can't read file:// URLs, XHR can (needs "Allow access to file URLs").
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("GET", url);
    x.responseType = "arraybuffer";
    x.onload = () => (x.response ? resolve(x.response) : reject(new Error("empty file")));
    x.onerror = () => reject(new Error("Couldn't read the local file. Turn on \"Allow access to file URLs\" for DeenScreen."));
    x.send();
  });
}

async function fetchBytes(url) {
  if (url.startsWith("file:")) return xhrBytes(url);
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`Couldn't download the video (HTTP ${res.status}).`);
  const len = Number(res.headers.get("content-length") || 0);
  if (len > MAX_BYTES) throw new Error("This video file is too big for the prototype (over 600 MB).");
  return res.arrayBuffer();
}

async function decodeAudio(bytes) {
  // Decoding into a 16 kHz context makes Chrome resample for us.
  const ctx = new OfflineAudioContext(1, 1, SAMPLE_RATE);
  let buf;
  try {
    buf = await ctx.decodeAudioData(bytes);
  } catch (e) {
    throw new Error("Chrome couldn't decode this video's audio track.");
  }
  if (buf.numberOfChannels === 1) return buf.getChannelData(0);
  const out = new Float32Array(buf.length);
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < out.length; i++) out[i] += data[i];
  }
  for (let i = 0; i < out.length; i++) out[i] /= buf.numberOfChannels;
  return out;
}

function isSilent(samples) {
  for (let i = 0; i < samples.length; i += 4) if (Math.abs(samples[i]) > 0.01) return false;
  return true;
}

// ---------- Time ranges ----------

const GAP_OK = 0.08; // pieces closer than this count as touching

function addRange(list, [a, b]) {
  const all = [...list, [a, b]].sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const r of all) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + GAP_OK) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

function rangeAt(list, t) {
  return list.find(([a, b]) => a <= t + 0.001 && t < b) || null;
}

function subtract(list, minus) {
  let out = list.map((r) => [...r]);
  for (const [ma, mb] of minus) {
    const next = [];
    for (const [a, b] of out) {
      if (mb <= a || ma >= b) { next.push([a, b]); continue; }
      if (ma > a) next.push([a, ma]);
      if (mb < b) next.push([mb, b]);
    }
    out = next;
  }
  return out.filter(([a, b]) => b - a > 0.05);
}

const insideRange = (list, a, b, margin = 0) =>
  list.some(([x, y]) => x <= a + 0.001 && b <= y - margin + 0.001);
const covered = (j) => j.analyzed.reduce((s, [a, b]) => s + (b - a), 0);

// ---------- Received audio ----------

function b64ToBytes(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function storeAudio(j, start, pcm) {
  const end = start + pcm.length / SAMPLE_RATE;
  if (insideRange(j.analyzed, start, end)) return; // already checked (players re-send after seeks)
  j.chunks.push({ start, end, pcm });
  j.chunks.sort((x, y) => x.start - y.start);
  j.received = addRange(j.received, [start, end]);
  wake(j);
}

// Streaming: one audio piece copied from the page's player.
function addPiece(j, msg) {
  j.ingest = j.ingest.then(() => ingestPiece(j, msg)).catch((e) => console.warn("DeenScreen piece:", e));
}

async function ingestPiece(j, msg) {
  if (j.cancelled) return;
  const { init, media } = splitPiece(b64ToBytes(msg.data), msg.mime);
  if (init) j.inits.set(msg.sb, { bytes: init.slice(), info: initInfo(init, msg.mime) });
  if (!media) return;
  const setup = j.inits.get(msg.sb);
  if (!setup) return; // can't decode without the codec setup piece
  const t0 = mediaStartTime(media, msg.mime, setup.info);
  if (t0 == null) return;
  let pcm;
  try {
    pcm = await decodeAudio(concat(setup.bytes, media).buffer);
  } catch (e) {
    j.decodeFails++;
    if (j.decodeFails >= 3 && j.decodeOk === 0) {
      send(j, { status: "error", message: "This video's audio can't be read (it may be DRM protected)." });
      cancel(j);
    }
    return;
  }
  j.decodeOk++;
  storeAudio(j, t0 + (msg.offset || 0), pcm);
}

// Join the received audio for [ws, we) into one buffer for the model.
function assemble(j, ws, we) {
  const out = new Float32Array(Math.max(1, Math.round((we - ws) * SAMPLE_RATE)));
  for (const c of j.chunks) {
    if (c.end <= ws || c.start >= we) continue;
    const from = Math.max(0, Math.round((ws - c.start) * SAMPLE_RATE));
    const to = Math.min(c.pcm.length, Math.round((we - c.start) * SAMPLE_RATE));
    const at = Math.round((c.start + from / SAMPLE_RATE - ws) * SAMPLE_RATE);
    if (to > from) out.set(c.pcm.subarray(from, to).subarray(0, out.length - at), Math.max(0, at));
  }
  return out;
}

// Drop audio that's checked and no longer needed as context (keeps memory low).
function freeChunks(j) {
  j.chunks = j.chunks.filter((c) => !insideRange(j.analyzed, c.start, c.end, 2 * EDGE));
}

// ---------- Choosing what to analyze next ----------

function pickWindow(j) {
  const todo = subtract(j.received, j.analyzed);
  const cur = j.cursorTime;
  const ordered = [...todo.filter((r) => r[1] > cur), ...todo.filter((r) => r[1] <= cur)];
  for (const [a, b] of ordered) {
    const p = a < cur && cur < b ? Math.max(a, cur - 0.5) : a;
    const rec = rangeAt(j.received, p);
    if (!rec) continue;
    const ws = Math.max(rec[0], p - EDGE);
    // If the viewer is waiting right at this spot, a short window gets sound back sooner.
    const waiting = p <= cur + 1;
    const we = Math.min(ws + (waiting ? WAITING_WINDOW + EDGE : WINDOW), rec[1]);
    const atEnd = we >= j.duration - 0.05 || (j.final && we >= rec[1] - 0.001);
    const commitEnd = Math.min(atEnd ? we : we - EDGE, b);
    const step = commitEnd - p;
    const fullContext = atEnd || we - EDGE >= b - 0.001;
    if (step <= 0.05 || (step < MIN_STEP && !fullContext)) continue; // need more audio first
    const urgent = p < cur + NOT_URGENT_MIN;
    if (!urgent && !atEnd && !fullContext && step < NOT_URGENT_MIN) continue; // batch it up
    return { ws, we, p, commitEnd };
  }
  return null;
}

function wake(j) {
  if (j.wakeUp) { j.wakeUp(); j.wakeUp = null; }
}

function sleepUntilWoken(j, ms) {
  return new Promise((resolve) => {
    j.wakeUp = resolve;
    setTimeout(resolve, ms);
  });
}

const fullyChecked = (j) =>
  isFinite(j.duration) && j.analyzed.length === 1 && j.analyzed[0][0] <= 0.1 && j.analyzed[0][1] >= j.duration - 0.1;

// ---------- Job ----------

async function startJob(msg) {
  // A tab only watches one video at a time: replace that tab's old job.
  for (const other of jobs.values()) if (other.tabId === msg.tabId) cancel(other);
  clearTimeout(idleTimer);
  const j = { id: msg.jobId, tabId: msg.tabId, url: msg.url, mode: msg.mode || "file",
              duration: msg.duration || Infinity, cursorTime: msg.from || 0, cancelled: false,
              final: false, chunks: [], received: [], analyzed: [], inits: new Map(),
              ingest: Promise.resolve(), decodeOk: 0, decodeFails: 0, wakeUp: null };
  for (const r of msg.skip || []) j.analyzed = addRange(j.analyzed, r); // checked in an earlier session
  jobs.set(j.id, j);
  let stage = "model";
  try {
    // 1. Model (streaming pieces are already being collected meanwhile)
    send(j, { status: "loading-model", message: "Loading speech model..." });
    const files = {};
    let lastSent = 0;
    const transcribe = await loadEngine((p) => {
      if (p.status !== "progress" || !p.total) return;
      files[p.file] = [p.loaded, p.total];
      const now = Date.now();
      if (now - lastSent < 500) return;
      lastSent = now;
      const all = Object.values(files);
      const pct = Math.round((100 * all.reduce((a, f) => a + f[0], 0)) / all.reduce((a, f) => a + f[1], 0));
      send(j, { status: "loading-model", message: `Downloading speech model (first time only): ${pct}%` });
    });
    if (j.cancelled) return;

    // 2. Audio
    stage = "audio";
    if (j.mode === "file") {
      send(j, { status: "decoding", message: "Reading the video's audio..." });
      const audio = await decodeAudio(await fetchBytes(j.url));
      if (j.cancelled) return;
      j.duration = audio.length / SAMPLE_RATE;
      j.final = true;
      storeAudio(j, 0, audio);
    }
    send(j, { status: "analyzing", analyzed: j.analyzed, progress: covered(j) / j.duration,
              message: j.mode === "stream" ? "Listening to the player's buffered audio..." : "Listening for profanity..." });

    // 3. Recognition: earliest unchecked audio at/after the viewer first
    while (!j.cancelled) {
      const w = pickWindow(j);
      if (!w) {
        if (fullyChecked(j)) break;
        await sleepUntilWoken(j, 1000); // wait for more buffered audio or a seek
        continue;
      }
      const audio = assemble(j, w.ws, w.we);
      const words = isSilent(audio) ? [] : await exclusive(() => transcribe(audio));
      if (j.cancelled) return;
      const found = words
        .map((x) => ({ text: x.text, start: x.start + w.ws, end: x.end + w.ws }))
        .filter((x) => x.start >= w.p - 0.001 && x.start < w.commitEnd)
        .filter((x) => globalThis.DeenScreenProfanity.isProfaneWord(x.text));
      j.analyzed = addRange(j.analyzed, [w.p, w.commitEnd]);
      freeChunks(j);
      send(j, { status: "analyzing", analyzed: j.analyzed, words: found, progress: covered(j) / j.duration });
    }
    if (j.cancelled) return;
    send(j, { status: "done", message: "Whole video analyzed", analyzed: j.analyzed, progress: 1 });
  } catch (e) {
    const text = String((e && e.message) || e);
    const message = stage === "model"
      ? "Couldn't load the speech model. The first use needs internet to download it. (" + text + ")"
      : text;
    send(j, { status: "error", message });
    console.error("DeenScreen speech analysis failed:", e);
  } finally {
    // Finished or failed: forget the job (this also frees its audio).
    if (jobs.get(j.id) === j) cancel(j);
  }
}
