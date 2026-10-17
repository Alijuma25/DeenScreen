/*
 * DeenScreen MSE audio tap (v3.1) - runs in the PAGE's own JavaScript world.
 *
 * Why: YouTube (and many sites) stream video in pieces using Media Source
 * Extensions (MSE). The site's player downloads audio well AHEAD of playback
 * and hands each piece to Chrome with SourceBuffer.appendBuffer(). We wrap
 * that one function and pass a copy of each AUDIO piece to DeenScreen, so the
 * AI can listen before you hear it. Nothing is downloaded by DeenScreen, and
 * the player keeps working exactly as before.
 *
 * Messages posted to the DeenScreen content script (same tab, via postMessage):
 *   { __deenscreen: "mse-url",   url }                     a MediaSource got a blob: URL
 *   { __deenscreen: "mse-audio", url, sb, mime, offset, bytes }  one audio piece
 */
(() => {
  if (window.__deenScreenTap) return;
  window.__deenScreenTap = true;

  const MS = window.MediaSource;
  if (!MS || !window.SourceBuffer) return;

  const msUrl = new WeakMap();  // MediaSource -> its blob: URL
  const sbInfo = new WeakMap(); // SourceBuffer -> { ms, mime, id }
  let nextId = 1;

  const post = (msg, transfer) => {
    try { window.postMessage(msg, "*", transfer || []); } catch (e) { /* ignore */ }
  };

  const origCreateObjectURL = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    const url = origCreateObjectURL.apply(this, arguments);
    try {
      if (obj instanceof MS) {
        msUrl.set(obj, url);
        post({ __deenscreen: "mse-url", url });
      }
    } catch (e) { /* ignore */ }
    return url;
  };

  const origAddSourceBuffer = MS.prototype.addSourceBuffer;
  MS.prototype.addSourceBuffer = function (mime) {
    const sb = origAddSourceBuffer.apply(this, arguments);
    try { sbInfo.set(sb, { ms: this, mime: String(mime), id: nextId++ }); } catch (e) { /* ignore */ }
    return sb;
  };

  const origAppendBuffer = SourceBuffer.prototype.appendBuffer;
  SourceBuffer.prototype.appendBuffer = function (data) {
    try {
      const info = sbInfo.get(this);
      if (info && /^audio\//i.test(info.mime) && data) {
        const view = data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        const copy = view.slice(); // our own copy; the player's buffer is untouched
        post({ __deenscreen: "mse-audio", url: msUrl.get(info.ms) || null, sb: info.id,
               mime: info.mime, offset: this.timestampOffset, bytes: copy.buffer }, [copy.buffer]);
      }
    } catch (e) { /* never break the player */ }
    return origAppendBuffer.apply(this, arguments);
  };
})();
