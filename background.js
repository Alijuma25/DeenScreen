/*
 * DeenScreen background service worker (v3)
 *
 * Only job: route spoken-profanity messages.
 *   content script (tab)  ->  background  ->  offscreen page (runs the AI)
 *   offscreen page        ->  background  ->  the right tab
 * The offscreen page is created on demand. It is a hidden extension page,
 * needed because service workers can't decode audio.
 */

const OFFSCREEN_PATH = "offscreen/offscreen.html";
let creating = null;

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        reasons: ["WORKERS"],
        justification: "Runs on-device speech recognition to find spoken profanity in videos.",
      })
      .finally(() => (creating = null));
  }
  await creating;
}

const toOffscreen = (msg) => chrome.runtime.sendMessage({ ...msg, target: "offscreen" }).catch(() => {});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.target === "offscreen") return;

  // Results from the offscreen page: pass them to the tab that asked.
  if (msg.type === "DS_SPEECH_UPDATE" && msg.target === "background") {
    chrome.tabs.sendMessage(msg.tabId, msg, { frameId: 0 }).catch(() => {});
    return;
  }

  // Requests from a content script. Forwarded strictly in order per tab, so
  // streamed audio pieces never arrive before their job's START message.
  if (!sender.tab) return;
  const tabId = sender.tab.id;
  if (msg.type === "DS_SPEECH_START") {
    queue(tabId, () => ensureOffscreen().then(() => toOffscreen({ ...msg, tabId })));
  } else if (["DS_SPEECH_CHUNK", "DS_SPEECH_SEEK", "DS_SPEECH_STOP"].includes(msg.type)) {
    queue(tabId, () => hasOffscreen().then((yes) => yes && toOffscreen({ ...msg, tabId })));
  }
});

const tabQueues = new Map(); // tabId -> promise chain
function queue(tabId, task) {
  const next = (tabQueues.get(tabId) || Promise.resolve()).then(task).catch(() => {});
  tabQueues.set(tabId, next);
}

// Tab closed: stop analyzing for it.
chrome.tabs.onRemoved.addListener((tabId) => {
  tabQueues.delete(tabId);
  hasOffscreen().then((yes) => yes && toOffscreen({ type: "DS_SPEECH_STOP_TAB", tabId }));
});
