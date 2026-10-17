/*
 * DeenScreen media piece parser (v3.1)
 *
 * Streaming players send audio as an "init segment" (codec setup, sent once)
 * followed by "media segments" (the actual sound, a few seconds each).
 * To place recognized words on the video's timeline we need each media
 * segment's start time, which is written inside it:
 *   WebM (YouTube's usual Opus audio): Cluster > Timecode, scaled by TimecodeScale
 *   MP4  (AAC audio):                  moof > traf > tfdt, divided by mdhd timescale
 *
 * Pure functions, no browser APIs, so they can be unit-tested anywhere.
 */

const WEBM_EBML = [0x1a, 0x45, 0xdf, 0xa3];
const WEBM_CLUSTER = [0x1f, 0x43, 0xb6, 0x75];

const isWebm = (mime) => /webm/i.test(mime);

function startsWith(b, sig, at = 0) {
  if (b.length < at + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (b[at + i] !== sig[i]) return false;
  return true;
}

function indexOfSig(b, sig, from = 0) {
  outer: for (let i = from; i <= b.length - sig.length; i++) {
    for (let k = 0; k < sig.length; k++) if (b[i + k] !== sig[k]) continue outer;
    return i;
  }
  return -1;
}

// ---------- WebM (EBML) ----------

function readVint(b, pos) {
  const first = b[pos];
  if (first === undefined || first === 0) return null;
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 8 || pos + len > b.length) return null;
  let value = first & (0xff >> len);
  let allOnes = value === (0xff >> len);
  for (let i = 1; i < len; i++) {
    value = value * 256 + b[pos + i];
    if (b[pos + i] !== 0xff) allOnes = false;
  }
  return { value, len, unknown: allOnes };
}

function readUint(b, pos, size) {
  let v = 0;
  for (let i = 0; i < size; i++) v = v * 256 + b[pos + i];
  return v;
}

function webmTimecodeScale(init) {
  const at = indexOfSig(init, [0x2a, 0xd7, 0xb1]);
  if (at < 0) return 1000000; // default: 1 ms
  const size = readVint(init, at + 3);
  if (!size || size.value > 8) return 1000000;
  return readUint(init, at + 3 + size.len, size.value) || 1000000;
}

function webmClusterTime(media, scale) {
  const at = indexOfSig(media, WEBM_CLUSTER);
  if (at < 0) return null;
  const size = readVint(media, at + 4);
  if (!size) return null;
  let pos = at + 4 + size.len;
  for (let guard = 0; guard < 16 && pos < media.length; guard++) {
    const idLen = readVint(media, pos);
    if (!idLen) return null;
    const id = readUint(media, pos, idLen.len);
    const sz = readVint(media, pos + idLen.len);
    if (!sz) return null;
    const dataAt = pos + idLen.len + sz.len;
    if (id === 0xe7) return (readUint(media, dataAt, sz.value) * scale) / 1e9;
    if (sz.unknown) return null;
    pos = dataAt + sz.value;
  }
  return null;
}

// ---------- MP4 (ISO BMFF) ----------

function* boxes(b, start = 0, end = b.length) {
  let pos = start;
  while (pos + 8 <= end) {
    let size = readUint(b, pos, 4);
    const type = String.fromCharCode(b[pos + 4], b[pos + 5], b[pos + 6], b[pos + 7]);
    let header = 8;
    if (size === 1) { size = readUint(b, pos + 8, 8); header = 16; }
    else if (size === 0) size = end - pos;
    if (size < header || pos + size > end) { yield { type, start: pos, header, end }; return; }
    yield { type, start: pos, header, end: pos + size };
    pos += size;
  }
}

function findBox(b, path, start = 0, end = b.length) {
  for (const box of boxes(b, start, end)) {
    if (box.type !== path[0]) continue;
    if (path.length === 1) return box;
    const found = findBox(b, path.slice(1), box.start + box.header, box.end);
    if (found) return found;
  }
  return null;
}

function mp4Timescale(init) {
  // moov > trak > mdia > mdhd (first audio track; streaming inits have one track)
  const moov = findBox(init, ["moov"]);
  if (!moov) return null;
  for (const trak of boxes(init, moov.start + moov.header, moov.end)) {
    if (trak.type !== "trak") continue;
    const mdhd = findBox(init, ["mdia", "mdhd"], trak.start + trak.header, trak.end);
    if (!mdhd) continue;
    const c = mdhd.start + mdhd.header;
    const version = init[c];
    return readUint(init, c + (version === 1 ? 20 : 12), 4) || null;
  }
  return null;
}

function mp4FragmentTime(media, timescale) {
  if (!timescale) return null;
  const tfdt = findBox(media, ["moof", "traf", "tfdt"]);
  if (!tfdt) return null;
  const c = tfdt.start + tfdt.header;
  const version = media[c];
  const t = version === 1 ? readUint(media, c + 4, 8) : readUint(media, c + 4, 4);
  return t / timescale;
}

// ---------- Public ----------

/** Split an appended piece into { init, media } (either may be null). */
export function splitPiece(bytes, mime) {
  if (isWebm(mime)) {
    if (!startsWith(bytes, WEBM_EBML)) return { init: null, media: bytes };
    const at = indexOfSig(bytes, WEBM_CLUSTER);
    if (at < 0) return { init: bytes, media: null };
    return { init: bytes.subarray(0, at), media: bytes.subarray(at) };
  }
  // MP4: init = everything through the moov box
  const moov = findBox(bytes, ["moov"]);
  if (!moov) return { init: null, media: bytes };
  const rest = bytes.subarray(moov.end);
  return { init: bytes.subarray(0, moov.end), media: rest.length >= 8 ? rest : null };
}

/** Facts from an init segment needed to read media timestamps. */
export function initInfo(init, mime) {
  return isWebm(mime) ? { scale: webmTimecodeScale(init) } : { timescale: mp4Timescale(init) };
}

/** Start time (seconds, before timestampOffset) of a media segment, or null. */
export function mediaStartTime(media, mime, info) {
  return isWebm(mime) ? webmClusterTime(media, info.scale) : mp4FragmentTime(media, info.timescale);
}
