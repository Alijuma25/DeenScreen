/*
 * DeenScreen speech engine (v3)
 *
 * On-device speech recognition with Whisper (OpenAI's open speech model),
 * run in the browser by transformers.js + ONNX Runtime (WebAssembly).
 *
 * Model: Xenova/whisper-tiny.en, 8-bit quantized (about 40 MB download).
 *  - Downloaded once from Hugging Face on first use, then cached by Chrome.
 *  - Audio is processed locally. No audio ever leaves the computer.
 *  - Gives a timestamp for every word, which is what lets us mute single words.
 *
 * Interface used by offscreen.js:
 *   const transcribe = await loadEngine(onProgress)
 *   const words = await transcribe(float32Audio16kHz)  // [{ text, start, end }]
 */
import { pipeline, env } from "../lib/transformers.min.js";

export const MODEL_ID = "Xenova/whisper-tiny.en";

// Extensions may not load code from the internet, so the ONNX Runtime
// WebAssembly files ship inside the extension (lib/ folder).
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("lib/");
env.allowLocalModels = false; // weights come from the Hugging Face Hub (data, not code)
env.useBrowserCache = true;   // keep the model after the first download

let loading = null;

export function loadEngine(onProgress) {
  if (!loading) {
    loading = pipeline("automatic-speech-recognition", MODEL_ID, {
      device: "wasm",
      dtype: "q8",
      progress_callback: onProgress,
    }).catch((e) => {
      loading = null; // allow a retry later
      throw e;
    });
  }
  return loading.then((asr) => async (audio) => {
    const out = await asr(audio, { return_timestamps: "word" });
    return (out.chunks || []).map((c) => {
      const [start, end] = c.timestamp;
      return { text: c.text, start, end: end == null ? start + 0.5 : end };
    });
  });
}
