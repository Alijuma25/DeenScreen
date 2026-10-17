# DeenScreen v3.1

Filters videos according to your own preferences.

- **v1:** skip or mute sections you choose (YouTube + regular HTML5 video)
- **v2:** swear words in YouTube subtitles become `****`
- **v3:** on-device AI listens to a video's audio and mutes spoken swear words automatically
- **v3.1 (new):** the AI audio filter now works on **YouTube** and other streaming sites, not just video files

## Install in Chrome

1. Unzip `DeenScreen-v3.1.zip` somewhere you will keep it (Chrome loads it from that folder).
   Upgrading? Replace the old folder with the new one, then click the reload icon on DeenScreen in `chrome://extensions`. Your saved filters stay.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `deenscreen` folder (the one containing `manifest.json`).
4. Click **Details** on DeenScreen and turn on **Allow access to file URLs** (needed for videos on your computer).
5. Pin DeenScreen from the puzzle icon in the toolbar.

## v3: AI spoken profanity muting

### How it works

**Getting the audio before you hear it**

- **YouTube and other streaming sites:** the site's own player downloads audio well ahead of playback (often 30+ seconds) and hands each piece to Chrome. A tiny script (`src/mse-tap.js`) copies each audio piece as the player buffers it. DeenScreen downloads nothing itself and never touches YouTube's video URLs.
- **Video files** (opened in Chrome or played directly by a page): the file is downloaded and its audio decoded.

**Finding swear words**

1. Audio goes to a hidden extension page and is placed on the video's own timeline (timestamps are read from the audio pieces themselves).
2. **Whisper tiny.en** (OpenAI's open speech model, run by transformers.js + ONNX Runtime WebAssembly) turns it into words, **with a timestamp for every word**. It works on up to 30 seconds at a time with 2.5s of overlap, always starting where you're watching. When you're waiting in silence, it does a short 10s piece first so sound comes back sooner.
3. Each word is checked against `src/profanity.js`. Swear words get muted from 0.25s before to 0.25s after. Only the word, not the sentence.
4. **Anything not checked yet stays muted**, so unchecked audio is never heard. Normally the AI stays far ahead (about 20+ seconds in tests). After you jump to an unbuffered spot, there's a short silence while the player buffers and the AI catches up.
5. Results are saved per video, so rewatching (or coming back after an ad) skips already-checked parts.

Everything runs on your computer. No audio is uploaded anywhere. The only network use is the one-time model download.

### Turn it on

Settings tab > **Profanity** ON. The master switch and the Profanity switch both turn it off instantly.

The popup's status card shows what the AI is doing, for example `AI listened to 2:30 of 10:00 · 3 swear words muted`.

### What it supports right now

| Works | Doesn't work yet |
|---|---|
| YouTube (regular videos) and other sites that stream with standard MSE | Netflix, Disney+, Prime and other DRM sites (not attempted) |
| Video files opened in Chrome, or played directly by a page | Live streams |
| Files up to 30 minutes; streams of any length | Players that stream from a background worker (rare) |

### Model and performance

- Model: `Xenova/whisper-tiny.en`, 8-bit, about **40 MB** download from Hugging Face on first use, then cached by Chrome.
- Engine files shipped inside the extension: about 22 MB (Chrome extensions aren't allowed to load code from the internet).
- Uses multiple CPU threads when available (up to 4).
- Memory: the model plus audio waiting to be checked. For streams, checked audio is thrown away right after (only ~16 MB of compressed audio is held while no check is running). For files, the whole decoded track (about 115 MB for 30 minutes). The hidden AI page closes itself after 3 minutes of no use.
- The AI has to process each 30s block faster than you watch it. How fast that is depends on your computer and has **not been measured yet** (see the test notes below).

### Known limitations (prototype)

- Whisper tiny is the smallest model: fast, but it will sometimes mishear or miss words, especially with background music or noise.
- Word timestamps can be off by a fraction of a second. That's why there's padding around each muted word.
- Video files are decoded fully into memory, hence the 30 minute limit for files (streams don't have this limit).
- If the AI is slower than playback on your computer, the filter stays safe by muting until it catches up, so you'd hear gaps.
- A video from a site that blocks downloads, or needs special sign-in tokens, may fail with a clear error.

## Test it (v3.1)

1. Turn on **Profanity** in Settings.
2. Open a YouTube video with swearing and press play. The first time, the model downloads (the popup shows the %), and the video stays muted until the AI has checked the start.
3. Open the popup: it should say `AI listened to ... of ...` and keep growing ahead of where you are.
4. Swear words should go silent for under a second while everything else plays.
5. Please tell me: how long the first silence lasts, whether the AI stays ahead, and which swear words were missed.

## v1 and v2 (unchanged)

- **Manual filters:** popup > Filters: start time, end time, SKIP or MUTE. Saved per video. The **Now** buttons grab the current time.
- **YouTube subtitles:** with Profanity on, turn on captions (CC). Swear words show as `****`. YouTube's own `[ __ ]` censoring is left as it is.
- `test/test-page.html` plays a local file with a picker for testing manual filters.

## Project layout

```
deenscreen/
  manifest.json            Extension config (Manifest V3)
  background.js            Routes messages between tabs and the AI page (v3)
  src/mse-tap.js           Copies audio pieces streaming players buffer ahead (v3.1)
  offscreen/offscreen.html Hidden page where the AI runs (v3)
  offscreen/offscreen.js   Collects audio on the video timeline, runs analysis windows (v3)
  offscreen/media-parse.js Reads timestamps from WebM/MP4 audio pieces (v3.1)
  offscreen/speech-engine.js  Loads Whisper and returns timestamped words (v3)
  lib/                     transformers.js + ONNX Runtime WebAssembly (Apache-2.0 / MIT)
  src/profanity.js         Swear word list + checks (v2, v3)
  src/content.js           Runs on pages: video detection, skip/mute, subtitles, AI muting
  popup/                   The popup UI
  icons/                   Extension icons
  test/test-page.html      Local video test page
```

## How data is stored

Everything is in `chrome.storage.local` on your computer.

- `enabled`: master switch
- `categories`: category switches (only `profanity` does something so far)
- `filters:<video>`: manual filters
- `speech:<video>`: saved AI results (checked time ranges + muted word times)
