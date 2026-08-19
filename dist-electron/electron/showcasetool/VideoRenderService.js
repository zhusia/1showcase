"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.videoRenderService = exports.VideoRenderService = void 0;
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const crypto_1 = require("crypto");
const electron_1 = require("electron");
const apngEncoder_1 = require("./apngEncoder");
const videoEncoder_1 = require("./videoEncoder");
const NO_CODEC_HINT = 'This build of Chromium reports no H.264 encoder, so MP4 export is unavailable. Export the animated HTML instead — it plays in any browser and needs nothing installed.';
/** Capture is the slow half; the split keeps the bar honest rather than jumping to 100% twice. */
const CAPTURE_SHARE = 0.7;
class VideoRenderService {
    cachedProbe = null;
    scavenged = false;
    /**
     * Non-throwing availability check, so the customise panel can say what is and is not there.
     *
     * Unlike the FFmpeg probe this replaces, the answer cannot come from the main process —
     * `VideoEncoder` only exists in a renderer, and only in a *secure* one (see `PROBE_HTML`,
     * which is why this loads a real file rather than `about:blank`). It costs one hidden window,
     * so the result is cached for the life of the process and re-taken only on an explicit rescan.
     */
    async probe(rescan = false) {
        if (rescan)
            this.cachedProbe = null;
        if (this.cachedProbe)
            return this.cachedProbe;
        let win = null;
        let dir = null;
        try {
            win = new electron_1.BrowserWindow({
                show: false,
                webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
            });
            dir = this.tempRoot();
            const probeFile = path_1.default.join(dir, 'probe.html');
            await fs_1.default.promises.writeFile(probeFile, videoEncoder_1.PROBE_HTML, 'utf8');
            await win.loadFile(probeFile);
            // 1080p stands in for the whole preset range — every preset is at or below it, and a
            // platform that can encode 1080p H.264 can encode the smaller ones.
            const codecs = (0, videoEncoder_1.codecCandidates)(1920, 1080);
            const codec = (await win.webContents.executeJavaScript(`(async () => {
           if (typeof VideoEncoder === 'undefined') return null;
           for (const codec of ${JSON.stringify(codecs)}) {
             try {
               const probe = await VideoEncoder.isConfigSupported({ codec, width: 1920, height: 1080, bitrate: 6000000, framerate: 30 });
               if (probe && probe.supported) return codec;
             } catch (err) { /* an unparseable codec string throws rather than returning false */ }
           }
           return null;
         })()`));
            this.cachedProbe = codec
                ? { available: true, codec, hint: null }
                : { available: false, codec: null, hint: NO_CODEC_HINT };
            return this.cachedProbe;
        }
        catch (err) {
            // Not cached: a failure here is as likely to be a transient window problem as a real
            // absence, and caching it would make the panel lie until the app restarts.
            return { available: false, codec: null, hint: err.message };
        }
        finally {
            if (win && !win.isDestroyed())
                win.destroy();
            if (dir)
                await fs_1.default.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
        }
    }
    tempRoot() {
        const base = electron_1.app.isReady() ? electron_1.app.getPath('userData') : os_1.default.tmpdir();
        const parent = path_1.default.join(base, 'showcasetool', '.video');
        fs_1.default.mkdirSync(parent, { recursive: true });
        if (!this.scavenged) {
            this.scavenged = true;
            void this.scavenge(parent);
        }
        const root = path_1.default.join(parent, (0, crypto_1.randomUUID)());
        fs_1.default.mkdirSync(root, { recursive: true });
        return root;
    }
    /** A render that was killed mid-flight leaves frames behind; clear yesterday's on the way in. */
    async scavenge(parent) {
        const entries = await fs_1.default.promises.readdir(parent, { withFileTypes: true }).catch(() => []);
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        await Promise.all(entries.map(async (entry) => {
            if (!entry.isDirectory())
                return;
            const target = path_1.default.join(parent, entry.name);
            const stat = await fs_1.default.promises.stat(target).catch(() => null);
            if (stat && stat.mtimeMs < cutoff)
                await fs_1.default.promises.rm(target, { recursive: true, force: true }).catch(() => undefined);
        }));
    }
    async renderHtmlToMp4(html, options) {
        return this.capture(html, options, (dir, frames) => this.encode(dir, frames, options));
    }
    /**
     * The same captured frames, assembled into an animated PNG instead of encoded (§2.4).
     *
     * Sampled down to APNG_TARGET_FPS first: a 60-second walkthrough at 30fps is 1800 full-size
     * PNGs, and concatenating those produces a file nobody can paste anywhere. A walkthrough of
     * still screenshots survives the sampling — there is no real motion to lose beyond the
     * transitions.
     */
    async renderHtmlToApng(html, options) {
        return this.capture(html, options, async (dir, frames) => {
            options.onProgress?.('Assembling the animation…', CAPTURE_SHARE);
            const names = Array.from({ length: frames.frameCount }, (_, i) => `frame-${String(i).padStart(5, '0')}.png`);
            const kept = (0, apngEncoder_1.pickFrames)(names, frames.fps, apngEncoder_1.APNG_TARGET_FPS);
            const buffers = [];
            for (const name of kept) {
                throwIfAborted(options.signal);
                buffers.push(await fs_1.default.promises.readFile(path_1.default.join(dir, name)));
            }
            const out = (0, apngEncoder_1.buildApng)(buffers, { delayMs: (0, apngEncoder_1.frameDelayMs)(frames.fps, apngEncoder_1.APNG_TARGET_FPS) });
            options.onProgress?.(`Animated ${kept.length} frames`, 1);
            return out;
        });
    }
    /**
     * Render the document offscreen and write one PNG per frame, then hand the directory to
     * whatever turns them into a file. Shared by the MP4 and APNG paths so the capture loop —
     * the part with the seek timing, the fit/annotate pass and the abort handling — exists once.
     */
    async capture(html, options, consume) {
        const { width, height } = options;
        const fps = Math.max(12, Math.min(60, options.fps));
        const durationMs = Math.max(1000, options.durationMs);
        const frameCount = Math.max(1, Math.round((durationMs / 1000) * fps));
        const dir = this.tempRoot();
        const win = new electron_1.BrowserWindow({
            width,
            height,
            useContentSize: true,
            show: false,
            frame: false,
            webPreferences: {
                // The document is ours, but it carries model-authored prose and screenshot bytes —
                // it gets no Node, no preload, and no way out of its own window.
                sandbox: true,
                contextIsolation: true,
                nodeIntegration: false,
                backgroundThrottling: false,
            },
        });
        const abortWindow = () => {
            if (!win.isDestroyed())
                win.destroy();
        };
        options.signal?.addEventListener('abort', abortWindow, { once: true });
        try {
            throwIfAborted(options.signal);
            const htmlFile = path_1.default.join(dir, 'scene.html');
            await fs_1.default.promises.writeFile(htmlFile, html, 'utf8');
            await win.loadFile(htmlFile);
            // Fonts and the inlined screenshots must have real dimensions before the first capture,
            // or frame 0 is a blank stage and the annotation overlay measures against nothing.
            await win.webContents
                .executeJavaScript(`Promise.all([
             document.fonts && document.fonts.ready ? document.fonts.ready : true,
             ...Array.from(document.images).map(function(img){
               return img.complete ? true : new Promise(function(r){ img.addEventListener('load', r); img.addEventListener('error', r); });
             })
           ]).then(function(){
             if (window.__gtFitShots) window.__gtFitShots();
             if (window.__gtDrawAnnotations) window.__gtDrawAnnotations();
             return true;
           })`)
                .catch(() => undefined);
            for (let i = 0; i < frameCount; i += 1) {
                throwIfAborted(options.signal);
                const t = frameCount === 1 ? 0 : (i / (frameCount - 1)) * durationMs;
                await win.webContents.executeJavaScript(`window.__gtSeek && window.__gtSeek(${t.toFixed(2)}); true`).catch(() => undefined);
                // One beat so the compositor flushes the seeked frame before it is read back.
                await delay(16);
                let image = await win.webContents.capturePage();
                const size = image.getSize();
                if (size.width !== width || size.height !== height)
                    image = image.resize({ width, height, quality: 'best' });
                await fs_1.default.promises.writeFile(path_1.default.join(dir, `frame-${String(i).padStart(5, '0')}.png`), image.toPNG());
                if (i % 10 === 0 || i === frameCount - 1) {
                    options.onProgress?.(`Capturing frame ${i + 1} of ${frameCount}`, ((i + 1) / frameCount) * CAPTURE_SHARE);
                }
            }
            // The scene window is deliberately left alive until the `finally` below. Destroying it
            // here would leave the process with zero windows for as long as it takes to open the
            // encoder's, which is enough to fire 'window-all-closed' and quit mid-render.
            return await consume(dir, { frameCount, fps, width, height });
        }
        finally {
            options.signal?.removeEventListener('abort', abortWindow);
            if (!win.isDestroyed())
                win.destroy();
            await fs_1.default.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
        }
    }
    /**
     * Encode the captured frames into an MP4, in a window of its own.
     *
     * The result comes back as base64 in bounded slices rather than one string, because a long
     * render is tens of megabytes and `executeJavaScript` has to materialise whatever it returns
     * on both sides at once.
     */
    async encode(dir, frames, options) {
        const { width, height } = (0, videoEncoder_1.evenDimensions)(frames.width, frames.height);
        /**
         * Narration clips are read here rather than inside the page: a file:// document may load a
         * file:// image but may not fetch() one, and the same restriction covers audio. The bytes
         * go across the executeJavaScript bridge instead, in the same bounded slices the finished
         * MP4 comes back in.
         */
        const clipBytes = [];
        for (const clip of options.narration ?? []) {
            const bytes = await fs_1.default.promises.readFile(clip.file).catch(() => null);
            if (bytes && bytes.length)
                clipBytes.push(bytes);
        }
        const audioTrack = clipBytes.length
            ? {
                clips: (options.narration ?? []).slice(0, clipBytes.length).map((clip, i) => ({
                    startMs: clip.startMs,
                    byteLength: clipBytes[i].length,
                })),
                sampleRate: videoEncoder_1.NARRATION_SAMPLE_RATE,
                bitrate: videoEncoder_1.NARRATION_BITRATE,
                codecs: (0, videoEncoder_1.audioCodecCandidates)(),
            }
            : undefined;
        const config = {
            frameCount: frames.frameCount,
            fps: frames.fps,
            width,
            height,
            codecs: (0, videoEncoder_1.codecCandidates)(width, height),
            bitrate: (0, videoEncoder_1.targetBitrate)(width, height, frames.fps),
            // A keyframe every two seconds, so scrubbing the result is not a decode from frame zero.
            keyEvery: Math.max(1, Math.round(frames.fps * 2)),
            audio: audioTrack,
        };
        const encodeFile = path_1.default.join(dir, 'encode.html');
        await fs_1.default.promises.writeFile(encodeFile, (0, videoEncoder_1.buildEncoderHtml)(config), 'utf8');
        const win = new electron_1.BrowserWindow({
            show: false,
            width,
            height,
            webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
        });
        const abortWindow = () => {
            if (!win.isDestroyed())
                win.destroy();
        };
        options.signal?.addEventListener('abort', abortWindow, { once: true });
        let ticker = null;
        try {
            throwIfAborted(options.signal);
            await win.loadFile(encodeFile);
            const codec = (await win.webContents.executeJavaScript('window.__gtPick()'));
            if (!codec)
                throw new Error(NO_CODEC_HINT);
            /**
             * Narration degrades rather than failing the render. A platform without an AAC encoder
             * still gets its video — losing the voice track is a disappointment, losing the whole
             * export because of it would be a bug.
             */
            let audioCodec = null;
            if (audioTrack) {
                audioCodec = (await win.webContents.executeJavaScript('window.__gtPickAudio()'));
                if (audioCodec) {
                    options.onProgress?.('Adding narration…', CAPTURE_SHARE);
                    const AUDIO_CHUNK = 512 * 1024;
                    for (let i = 0; i < clipBytes.length; i += 1) {
                        for (let offset = 0; offset < clipBytes[i].length; offset += AUDIO_CHUNK) {
                            throwIfAborted(options.signal);
                            const slice = clipBytes[i].subarray(offset, offset + AUDIO_CHUNK).toString('base64');
                            await win.webContents.executeJavaScript(`window.__gtAudioPush(${i}, ${JSON.stringify(slice)})`);
                        }
                    }
                }
            }
            // The encode is one long promise, so progress is polled alongside it. The page is
            // single-threaded but awaits on every frame, which is what leaves room for this to run.
            ticker = setInterval(() => {
                if (win.isDestroyed())
                    return;
                win.webContents
                    .executeJavaScript('window.__gtProgress')
                    .then((fraction) => {
                    const done = Math.round((fraction || 0) * config.frameCount);
                    options.onProgress?.(`Encoding frame ${done} of ${config.frameCount}`, CAPTURE_SHARE + (fraction || 0) * (1 - CAPTURE_SHARE));
                })
                    .catch(() => undefined);
            }, 250);
            const total = (await win.webContents.executeJavaScript(`window.__gtEncode(${JSON.stringify(codec)}, ${JSON.stringify(audioCodec)})`));
            throwIfAborted(options.signal);
            if (!total || total <= 0)
                throw new Error('The encoder produced an empty file.');
            if (ticker)
                clearInterval(ticker);
            ticker = null;
            options.onProgress?.('Writing MP4…', 1);
            const CHUNK = 2 * 1024 * 1024;
            const parts = [];
            for (let offset = 0; offset < total; offset += CHUNK) {
                throwIfAborted(options.signal);
                const base64 = (await win.webContents.executeJavaScript(`window.__gtChunk(${offset}, ${CHUNK})`));
                parts.push(Buffer.from(base64, 'base64'));
            }
            const out = Buffer.concat(parts);
            if (out.length !== total)
                throw new Error(`Encoded MP4 was truncated (${out.length} of ${total} bytes).`);
            return out;
        }
        catch (err) {
            // A destroyed window rejects whatever was in flight; report the cancel, not the symptom.
            throwIfAborted(options.signal);
            throw err;
        }
        finally {
            if (ticker)
                clearInterval(ticker);
            options.signal?.removeEventListener('abort', abortWindow);
            if (!win.isDestroyed())
                win.destroy();
        }
    }
}
exports.VideoRenderService = VideoRenderService;
function throwIfAborted(signal) {
    if (signal?.aborted)
        throw new Error('Video render canceled.');
}
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
exports.videoRenderService = new VideoRenderService();
//# sourceMappingURL=VideoRenderService.js.map