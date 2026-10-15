# DeenScreen v1

Skip or mute the parts of a video that you choose. Works on YouTube and on regular HTML5 video players.

## What works right now

- ON/OFF master switch (turning it off instantly stops all skipping/muting and restores sound)
- Video detection on YouTube and normal HTML5 `<video>` players
- Manual filters: pick a start time, end time, and SKIP or MUTE
- Sound comes back automatically when a muted section ends (and stays muted if you had it muted before)
- Filters are saved per video and work again next time you open that video
- YouTube ads are ignored (filters pause while an ad plays)
- A small on-page notice shows when a section is skipped or muted

## What does NOT work yet (on purpose)

- The category switches in Settings (nudity, sexual content, music, profanity, LGBTQ+ content, violence) only save your choices. There is no automatic detection yet.
- No Netflix, Disney+, or Prime Video support.
- Videos inside iframes (embedded players on other sites) are not handled yet. Only the main page's video is.

## Install in Chrome

1. Unzip `DeenScreen-v1.zip` somewhere you will keep it (Chrome loads it from that folder).
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose the `deenscreen` folder (the one containing `manifest.json`).
5. Pin DeenScreen from the puzzle icon in the toolbar.

## Test it on YouTube

1. Open any YouTube video and let it play.
2. Click the DeenScreen icon. You should see **Video detected** with a **YouTube** tag and a live timer.
3. Add a SKIP filter, for example start `0:10`, end `0:20`. Go back to 0:05 and watch it jump to 0:20.
4. Add a MUTE filter, for example `0:30` to `0:40`. The sound cuts at 0:30 and comes back at 0:40.
5. Tip: the **Now** buttons grab the video's current time so you don't have to type it.
6. Close the tab, open the same video again: your filters still work.
7. Flip the master switch off: nothing gets skipped or muted.

## Test it on a normal HTML5 video

Open `test/test-page.html` and pick any video file from your computer. The page shows the current time and whether the video is muted, so you can see DeenScreen working.

To use it from your hard drive, go to `chrome://extensions`, click **Details** on DeenScreen, and turn on **Allow access to file URLs**.

## Notes

- If a tab was already open before you installed DeenScreen, the popup connects to it automatically. If it still says "No video detected", refresh the page.
- After editing the code, click the reload icon on DeenScreen in `chrome://extensions` and refresh the video tab.

## Project layout

```
deenscreen/
  manifest.json      Extension config (Manifest V3)
  src/content.js     Runs on pages: finds the video, applies skip/mute filters
  popup/             The popup UI (HTML, CSS, JS)
  icons/             Extension icons
  test/test-page.html  Local HTML5 video test page
```

## How data is stored

Everything is in `chrome.storage.local` on your computer. Nothing is sent anywhere.

- `enabled`: master switch
- `categories`: future category preferences
- `filters:youtube:<videoId>` or `filters:page:<site><path>`: list of `{ start, end, action }`
