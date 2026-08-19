"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PROBE_HTML = exports.NARRATION_BITRATE = exports.NARRATION_SAMPLE_RATE = void 0;
exports.audioCodecCandidates = audioCodecCandidates;
exports.evenDimensions = evenDimensions;
exports.codecCandidates = codecCandidates;
exports.targetBitrate = targetBitrate;
exports.muxerSource = muxerSource;
exports.buildEncoderHtml = buildEncoderHtml;
const fs_1 = __importDefault(require("fs"));
/**
 * AAC-LC. One entry today, but kept as a list so a platform without it can be handled the same
 * way an unsupported H.264 level is — by trying the next one rather than failing the render.
 */
function audioCodecCandidates() {
    return ['mp4a.40.2'];
}
/**
 * Speech at 22.05 kHz mono. 64 kbit/s is generous for that and keeps the audio track a rounding
 * error next to the video — a 3-minute narration adds well under 1.5 MB.
 */
exports.NARRATION_SAMPLE_RATE = 22050;
exports.NARRATION_BITRATE = 64_000;
/**
 * H.264 cannot encode an odd dimension. The FFmpeg path forced this with a
 * `scale=trunc(iw/2)*2` filter; losing it silently would surface as a configure() failure at
 * the end of a long render rather than at the start.
 */
function evenDimensions(width, height) {
    return { width: Math.max(2, width - (width % 2)), height: Math.max(2, height - (height % 2)) };
}
/**
 * Codec strings in `avc1.PPCCLL` form — profile, constraint flags, level, each two hex digits.
 * High (0x64) first because that is what the FFmpeg path asked for (`-profile:v high`), then
 * Main and Baseline as fallbacks for a platform that lacks the better ones.
 *
 * The level has to cover the frame size or `isConfigSupported` refuses it, so the list starts
 * at the smallest level that fits and widens from there.
 */
function codecCandidates(width, height) {
    const pixels = width * height;
    // Start at the smallest level that can carry the frame and only ever widen *upward*. A lower
    // level is not a fallback — it is a config the encoder refuses, which is why 1080p must never
    // be offered level 3.1 (verified against a real encoder: it reports unsupported).
    const levels = pixels > 3840 * 2160
        ? ['34'] // 5.2
        : pixels > 2560 * 1440
            ? ['33', '34'] // 5.1 carries 4K30
            : pixels > 1920 * 1080
                ? ['32', '33', '34']
                : ['28', '32', '33', '34']; // 4.0 covers 1080p, which every preset is at or below
    const out = [];
    for (const profile of ['6400', '4d00', '4200']) {
        for (const level of levels)
            out.push(`avc1.${profile}${level}`);
    }
    return out;
}
/**
 * WebCodecs has no CRF, so the quality-targeted `-crf 20` becomes a resolution-aware bitrate.
 * 0.12 bits per pixel is generous for screen content — sharp text, large flat areas, very
 * little motion — and the clamps keep a tiny preset from looking soft and a 4K one from
 * producing a file nobody wants to email.
 */
function targetBitrate(width, height, fps) {
    const raw = width * height * fps * 0.12;
    return Math.round(Math.max(2_000_000, Math.min(40_000_000, raw)));
}
/**
 * The muxer ships an IIFE build that defines a `Mp4Muxer` global, so it inlines as a script.
 *
 * This reads the package's own source rather than importing it, because the code has to run
 * inside the encoder page rather than in main. In a packaged app that read comes out of
 * `app.asar` — which Electron's patched `fs` handles — so the failure mode to watch for is a
 * packaging config that drops the dependency, not a path problem. Hence the explicit message:
 * the raw ENOENT names a path inside an archive and explains nothing.
 */
function muxerSource() {
    try {
        return fs_1.default.readFileSync(require.resolve('mp4-muxer'), 'utf8');
    }
    catch (err) {
        throw new Error(`The MP4 muxer could not be loaded, so MP4 export is unavailable — export the animated HTML instead. (${err.message})`);
    }
}
/**
 * An empty page for the capability probe — and it has to be a real file on disk.
 *
 * **`about:blank` cannot be used here, and the failure is silent.** A window loaded with
 * `about:blank` and no opener gets an opaque origin, which is not a secure context, and
 * `VideoEncoder` is simply not defined on a non-secure context. The probe then reports "no
 * H.264 encoder" on a machine whose encoder works perfectly — which is exactly what happened
 * the first time this was written. `file://` is a trustworthy origin, so loading any real file
 * fixes it. Verified: `about:blank` → `isSecureContext: false`, no `VideoEncoder`; `file://` →
 * `isSecureContext: true`, 1080p High profile supported.
 */
exports.PROBE_HTML = '<!doctype html><html><head><meta charset="utf-8"><title>probe</title></head><body></body></html>';
/**
 * The encoder page. It exposes three entry points to the main process:
 *   `__gtPick()`    → the first supported codec string, or null
 *   `__gtEncode()`  → encodes every frame and returns the byte length
 *   `__gtChunk()`   → base64 slice of the result, so a large MP4 crosses in bounded pieces
 *   `__gtProgress`  → polled while `__gtEncode` is in flight
 */
function buildEncoderHtml(config) {
    return `<!doctype html>
<html><head><meta charset="utf-8"><title>encode</title></head><body>
<script>${muxerSource()}</script>
<script>
const CONFIG = ${JSON.stringify(config)};
window.__gtProgress = 0;
window.__gtOut = null;

window.__gtPick = async function () {
  for (const codec of CONFIG.codecs) {
    try {
      const probe = await VideoEncoder.isConfigSupported({
        codec: codec, width: CONFIG.width, height: CONFIG.height,
        bitrate: CONFIG.bitrate, framerate: CONFIG.fps,
      });
      if (probe && probe.supported) return codec;
    } catch (err) { /* an unparseable codec string throws rather than returning false */ }
  }
  return null;
};

/**
 * Narration WAVs arrive here in base64 slices rather than being fetched. A file:// page may
 * load a file:// image but may not fetch() one, and that restriction covers audio too — so the
 * main process pushes the bytes across the same executeJavaScript bridge that carries the
 * finished MP4 back out.
 */
window.__gtAudioBufs = [];
window.__gtAudioPush = function (index, base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  if (!window.__gtAudioBufs[index]) window.__gtAudioBufs[index] = [];
  window.__gtAudioBufs[index].push(bytes);
  return true;
};

window.__gtPickAudio = async function () {
  if (!CONFIG.audio) return null;
  for (const codec of CONFIG.audio.codecs) {
    try {
      const probe = await AudioEncoder.isConfigSupported({
        codec: codec, sampleRate: CONFIG.audio.sampleRate, numberOfChannels: 1,
        bitrate: CONFIG.audio.bitrate,
      });
      if (probe && probe.supported) return codec;
    } catch (err) { /* same contract as the video probe: unparseable strings throw */ }
  }
  return null;
};

/**
 * Mixes every narration clip onto one silent bed of the video's exact length, so a clip that
 * runs past its step simply overlaps the next scene rather than desynchronising everything
 * after it. OfflineAudioContext does the resampling, which is the part worth not hand-rolling:
 * the platform voices do not all speak at the sample rate we asked for.
 */
async function buildNarrationBuffer(totalMs) {
  const rate = CONFIG.audio.sampleRate;
  const frames = Math.max(1, Math.ceil((totalMs / 1000) * rate));
  const ctx = new OfflineAudioContext(1, frames, rate);

  for (let i = 0; i < CONFIG.audio.clips.length; i++) {
    const parts = window.__gtAudioBufs[i];
    if (!parts || !parts.length) continue;

    let size = 0;
    for (const p of parts) size += p.length;
    const joined = new Uint8Array(size);
    let at = 0;
    for (const p of parts) { joined.set(p, at); at += p.length; }

    let decoded = null;
    try {
      decoded = await ctx.decodeAudioData(joined.buffer);
    } catch (err) {
      continue; // one unreadable clip must not lose the whole narration track
    }

    const source = ctx.createBufferSource();
    source.buffer = decoded;
    source.connect(ctx.destination);
    source.start(CONFIG.audio.clips[i].startMs / 1000);
  }

  return await ctx.startRendering();
}

window.__gtEncode = async function (codec, audioCodec) {
  const useAudio = !!(CONFIG.audio && audioCodec);
  const muxer = new Mp4Muxer.Muxer({
    target: new Mp4Muxer.ArrayBufferTarget(),
    video: { codec: 'avc', width: CONFIG.width, height: CONFIG.height },
    audio: useAudio
      ? { codec: 'aac', numberOfChannels: 1, sampleRate: CONFIG.audio.sampleRate }
      : undefined,
    // The moov atom goes at the front, so the file streams rather than needing a full
    // download before the first frame. This is what '-movflags +faststart' bought.
    fastStart: 'in-memory',
  });

  let failure = null;
  const encoder = new VideoEncoder({
    output: function (chunk, meta) { muxer.addVideoChunk(chunk, meta); },
    error: function (err) { failure = err; },
  });
  encoder.configure({
    codec: codec, width: CONFIG.width, height: CONFIG.height,
    bitrate: CONFIG.bitrate, framerate: CONFIG.fps,
    avc: { format: 'avc' },      // AVCC, which is what an MP4 sample entry expects
    latencyMode: 'quality',      // offline render; there is nothing to be low-latency for
  });

  // Every frame is drawn through a canvas of the exact encode size. It costs one blit and it
  // removes two whole classes of failure at once: an odd dimension H.264 cannot take, and a
  // captured PNG whose size drifted from the requested one.
  const canvas = new OffscreenCanvas(CONFIG.width, CONFIG.height);
  const ctx = canvas.getContext('2d', { alpha: false });
  const usPerFrame = 1000000 / CONFIG.fps;

  for (let i = 0; i < CONFIG.frameCount; i++) {
    if (failure) throw failure;

    const img = new Image();
    img.src = 'frame-' + String(i).padStart(5, '0') + '.png';
    await img.decode();
    ctx.drawImage(img, 0, 0, CONFIG.width, CONFIG.height);

    const frame = new VideoFrame(canvas, {
      timestamp: Math.round(i * usPerFrame),
      duration: Math.round(usPerFrame),
    });
    encoder.encode(frame, { keyFrame: i % CONFIG.keyEvery === 0 });
    frame.close();

    // An unbounded queue holds full uncompressed frames in memory; at 4K that is ~33 MB each.
    while (encoder.encodeQueueSize > 8) await new Promise(function (r) { setTimeout(r, 4); });
    window.__gtProgress = (i + 1) / CONFIG.frameCount;
  }

  await encoder.flush();
  if (failure) throw failure;

  /**
   * Audio last, after every video chunk is in. mp4-muxer interleaves by timestamp regardless of
   * the order it is fed, and encoding the narration first would hold a decoded PCM bed in
   * memory for the whole video pass.
   */
  if (useAudio) {
    const totalMs = (CONFIG.frameCount / CONFIG.fps) * 1000;
    const bed = await buildNarrationBuffer(totalMs);
    const pcm = bed.getChannelData(0);
    const rate = CONFIG.audio.sampleRate;

    let audioFailure = null;
    const audioEncoder = new AudioEncoder({
      output: function (chunk, meta) { muxer.addAudioChunk(chunk, meta); },
      error: function (err) { audioFailure = err; },
    });
    audioEncoder.configure({
      codec: audioCodec, sampleRate: rate, numberOfChannels: 1, bitrate: CONFIG.audio.bitrate,
    });

    // AAC wants ~1024-sample frames; feeding a whole multi-minute buffer at once allocates a
    // copy of the entire track and stalls the queue. One second at a time is plenty.
    const CHUNK_FRAMES = rate;
    for (let offset = 0; offset < pcm.length; offset += CHUNK_FRAMES) {
      if (audioFailure) throw audioFailure;
      const slice = pcm.subarray(offset, Math.min(offset + CHUNK_FRAMES, pcm.length));
      const data = new AudioData({
        format: 'f32-planar',
        sampleRate: rate,
        numberOfFrames: slice.length,
        numberOfChannels: 1,
        timestamp: Math.round((offset / rate) * 1000000),
        data: new Float32Array(slice),
      });
      audioEncoder.encode(data);
      data.close();
      while (audioEncoder.encodeQueueSize > 8) await new Promise(function (r) { setTimeout(r, 4); });
    }
    await audioEncoder.flush();
    if (audioFailure) throw audioFailure;
  }

  muxer.finalize();
  window.__gtOut = new Uint8Array(muxer.target.buffer);
  return window.__gtOut.length;
};

window.__gtChunk = function (offset, length) {
  const view = window.__gtOut.subarray(offset, offset + length);
  let binary = '';
  // String.fromCharCode.apply blows the argument limit on a large array, so walk it.
  for (let i = 0; i < view.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, view.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};
</script></body></html>`;
}
//# sourceMappingURL=videoEncoder.js.map