"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.previewGuideVideo = previewGuideVideo;
exports.renderGuideVideo = renderGuideVideo;
const crypto_1 = require("crypto");
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const electron_1 = require("electron");
const customize_1 = require("./customize");
const GuideSessionStore_1 = require("./GuideSessionStore");
const GuideStore_1 = require("./GuideStore");
const RedactionService_1 = require("./RedactionService");
const ScreenshotStore_1 = require("./ScreenshotStore");
const TtsService_1 = require("./TtsService");
const VideoRenderService_1 = require("./VideoRenderService");
const videoTemplate_1 = require("./videoTemplate");
const LicenseService_1 = require("../services/LicenseService");
/** Where narration WAVs live for the duration of one render. Removed on the way out. */
function scratchDir(guideId) {
    const base = electron_1.app.isReady() ? electron_1.app.getPath('userData') : os_1.default.tmpdir();
    return path_1.default.join(base, 'showcasetool', '.narration', `${guideId}-${(0, crypto_1.randomUUID)()}`);
}
/**
 * One clip per step. Failures are per clip: a voice that chokes on one step's prose costs
 * that step's narration and nothing else. Clips come back tagged with their step index —
 * where each lands on the timeline is decided by `paceScenes`, after every clip's real
 * length is known.
 */
async function synthesizeNarration(guide, narration, dir) {
    const probe = await TtsService_1.ttsService.probe();
    if (!probe.available)
        return [];
    await fs_1.default.promises.mkdir(dir, { recursive: true });
    const out = [];
    for (let i = 0; i < guide.steps.length; i += 1) {
        const step = guide.steps[i];
        const script = [step.title, step.body, narration.script === 'body-why' ? step.why : '']
            .filter((part) => !!part && part.trim())
            .join('. ')
            .trim();
        if (!script)
            continue;
        const file = path_1.default.join(dir, `narration-${String(i).padStart(5, '0')}.wav`);
        try {
            await TtsService_1.ttsService.synthesize({ text: script, voice: narration.voice || undefined, rate: narration.wpm, outFile: file });
            out.push({ file, stepIndex: i });
        }
        catch {
            // A single unspeakable step is not worth losing the rest of the track over.
        }
    }
    return out;
}
/** Breathing room after a clip ends, so a scene never cuts on the last syllable. */
const NARRATION_TAIL_MS = 700;
/** A runaway cap: a step whose prose reads for a minute should not stall the whole video. */
const MAX_SCENE_MS = 30_000;
/**
 * The length of a WAV by its own header — data bytes over byte rate, walking the RIFF chunk
 * list rather than assuming the 44-byte layout. Null means "could not tell", and the caller
 * falls back to the configured pacing rather than guessing.
 */
function wavDurationMs(file) {
    try {
        const buf = fs_1.default.readFileSync(file);
        if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE')
            return null;
        let offset = 12;
        let byteRate = 0;
        while (offset + 8 <= buf.length) {
            const id = buf.toString('ascii', offset, offset + 4);
            const size = buf.readUInt32LE(offset + 4);
            if (id === 'fmt ' && offset + 20 <= buf.length)
                byteRate = buf.readUInt32LE(offset + 16);
            else if (id === 'data' && byteRate > 0)
                return (size / byteRate) * 1000;
            offset += 8 + size + (size % 2);
        }
        return null;
    }
    catch {
        return null;
    }
}
/**
 * Narration-paced scenes. `secondsPerStep` is a floor, not the law: a step whose clip reads
 * longer holds its scene until the voice finishes (§2.5) — otherwise a long body is cut off
 * mid-sentence and a short one leaves dead air. Only the narrated render gets this; the
 * animated HTML and APNG have no audio, so their pacing stays exactly as configured.
 */
function paceScenes(guide, settings, clips) {
    const stepMs = Math.round(settings.secondsPerStep * 1000);
    const sceneDurations = guide.steps.map(() => stepMs);
    for (const clip of clips) {
        const clipMs = wavDurationMs(clip.file);
        if (clipMs)
            sceneDurations[clip.stepIndex] = Math.min(MAX_SCENE_MS, Math.max(stepMs, Math.round(clipMs) + NARRATION_TAIL_MS));
    }
    const offset = settings.titleCard ? customize_1.TITLE_CARD_MS : 0;
    const starts = [];
    let at = offset;
    for (const duration of sceneDurations) {
        starts.push(at);
        at += duration;
    }
    return {
        sceneDurations,
        narration: clips.map((clip) => ({ file: clip.file, startMs: starts[clip.stepIndex] })),
        durationMs: at + (settings.outroCard ? customize_1.OUTRO_CARD_MS : 0),
    };
}
async function cleanupNarration(narration) {
    const dir = path_1.default.dirname(narration[0].file);
    await fs_1.default.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
}
/**
 * The animated document in a throwaway window — the same timeline the MP4 samples, at zero
 * cost: no encode, no save dialog, no file the Maker has to manage. It exists so checking the
 * camera does not mean committing to a multi-minute render.
 *
 * Behind the same acknowledgement gate as the real export, because a preview window shows
 * exactly the pixels an export would — "it was only a preview" must never be a way around
 * the review (§7.2).
 */
async function previewGuideVideo(guideId, overrides) {
    const loaded = GuideStore_1.guideStore.getOrError(guideId);
    if (!loaded.ok)
        throw new Error(loaded.error);
    const guide = loaded.guide;
    const sessionId = GuideStore_1.guideStore.sessionIdOf(guideId);
    if (sessionId)
        RedactionService_1.redactionService.assertAcknowledged(sessionId);
    const parsed = customize_1.VideoSettingsSchema.safeParse(overrides ?? guide.video ?? {});
    if (!parsed.success)
        throw new Error(`invalid video settings: ${parsed.error.issues[0]?.message ?? 'unknown error'}`);
    const settings = parsed.data;
    /**
     * Resolved at render time, not stamped on the guide — the same rule the file exporters follow.
     * A render started after a purchase comes out clean; one started after a licence lapses does not.
     */
    const videoOptions = { watermark: LicenseService_1.licenseService.watermark() };
    const images = new Map();
    for (const step of guide.steps) {
        if (!step.screenshot)
            continue;
        const dataUri = ScreenshotStore_1.screenshotStore.readDataUri(step.screenshot);
        if (dataUri)
            images.set(step.id, dataUri);
    }
    /**
     * A real file loaded with loadFile, not a data: URL — the preview should exercise exactly
     * what an exported .html will do in a browser, shell and all. It lives in the OS temp dir
     * and is removed when the window closes; a crash leaves it to the OS scavenger.
     */
    const file = path_1.default.join(electron_1.app.getPath('temp'), `showcasetool-preview-${(0, crypto_1.randomUUID)()}.html`);
    await fs_1.default.promises.writeFile(file, (0, videoTemplate_1.toAnimatedHtml)(guide, images, settings, videoOptions), 'utf8');
    const { width, height } = (0, customize_1.videoDimensions)(settings);
    const area = electron_1.screen.getPrimaryDisplay().workAreaSize;
    const scale = Math.min(1, (area.width * 0.8) / width, (area.height * 0.8) / height);
    const window = new electron_1.BrowserWindow({
        width: Math.round(width * scale),
        height: Math.round(height * scale),
        useContentSize: true,
        autoHideMenuBar: true,
        title: `Motion preview — ${guide.title}`,
        // The document is app-authored markup around model-authored prose; it gets no more
        // privilege than the exported file would have in a browser.
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    window.on('closed', () => {
        void fs_1.default.promises.rm(file, { force: true }).catch(() => undefined);
    });
    await window.loadFile(file);
    return true;
}
async function renderGuideVideo(guideId, overrides, onProgress, signal) {
    const loaded = GuideStore_1.guideStore.getOrError(guideId);
    if (!loaded.ok)
        throw new Error(loaded.error);
    const guide = loaded.guide;
    // The gate. A guide generated before an edit re-opened its session must not keep exporting.
    const sessionId = GuideStore_1.guideStore.sessionIdOf(guideId);
    if (sessionId)
        RedactionService_1.redactionService.assertAcknowledged(sessionId);
    const parsed = customize_1.VideoSettingsSchema.safeParse(overrides ?? guide.video ?? {});
    if (!parsed.success)
        throw new Error(`invalid video settings: ${parsed.error.issues[0]?.message ?? 'unknown error'}`);
    const settings = parsed.data;
    /**
     * Resolved at render time, not stamped on the guide — the same rule the file exporters follow.
     * A render started after a purchase comes out clean; one started after a licence lapses does not.
     */
    const videoOptions = { watermark: LicenseService_1.licenseService.watermark() };
    /**
     * Narration settings stay on the session rather than the guide: a voice track is a render
     * option, not a property of the artifact, and re-rendering with a different voice should not
     * count as changing the guide.
     */
    const narrationSettings = sessionId
        ? GuideSessionStore_1.guideSessionStore.customize(sessionId).narration
        : null;
    const { width, height } = (0, customize_1.videoDimensions)(settings);
    // The configured estimate. A narrated MP4 re-derives both once the clip lengths are known.
    let durationMs = (0, customize_1.videoDurationMs)(settings, guide.steps.length);
    let frames = Math.max(1, Math.round((durationMs / 1000) * settings.fps));
    // Ask where it goes before spending a minute on frames nobody asked to keep.
    const window = electron_1.BrowserWindow.getFocusedWindow() ?? electron_1.BrowserWindow.getAllWindows()[0];
    const FORMAT_DIALOG = {
        mp4: { ext: 'mp4', title: 'Export video walkthrough', filter: { name: 'MP4 video', extensions: ['mp4'] } },
        html: { ext: 'html', title: 'Export animated walkthrough', filter: { name: 'Self-contained HTML', extensions: ['html'] } },
        // .png rather than .apng: Slack, GitHub and every wiki accept the former, and an animated
        // PNG is a valid PNG — pasteability is the whole point of the format.
        apng: { ext: 'png', title: 'Export animated image', filter: { name: 'Animated PNG', extensions: ['png'] } },
    };
    const spec = FORMAT_DIALOG[settings.format];
    const picked = await electron_1.dialog.showSaveDialog(window, {
        title: spec.title,
        defaultPath: `${guide.id || 'guide'}.${spec.ext}`,
        filters: [spec.filter],
    });
    if (picked.canceled || !picked.filePath)
        return { path: null, format: settings.format, durationMs, width, height, frames };
    onProgress({ message: 'Collecting screenshots…', fraction: 0 });
    const images = new Map();
    for (const step of guide.steps) {
        if (!step.screenshot)
            continue;
        const dataUri = ScreenshotStore_1.screenshotStore.readDataUri(step.screenshot);
        if (dataUri)
            images.set(step.id, dataUri);
    }
    if (settings.format === 'html') {
        onProgress({ message: 'Writing the animated file…', fraction: 0.6 });
        fs_1.default.writeFileSync(picked.filePath, (0, videoTemplate_1.toAnimatedHtml)(guide, images, settings, videoOptions), 'utf8');
    }
    else if (settings.format === 'apng') {
        // Same capture loop as MP4, assembled instead of encoded. No narration: an image is silent.
        onProgress({ message: `Rendering ${frames} frames…`, fraction: 0 });
        const apng = await VideoRenderService_1.videoRenderService.renderHtmlToApng((0, videoTemplate_1.buildVideoHtml)(guide, images, settings, undefined, videoOptions), {
            width,
            height,
            fps: settings.fps,
            durationMs,
            onProgress: (message, fraction) => onProgress({ message, fraction }),
            signal,
        });
        fs_1.default.writeFileSync(picked.filePath, apng);
    }
    else {
        /**
         * Narration is synthesised before the frames, so a machine with no speech engine finds out
         * in a second rather than after a minute of rendering. A failure here never fails the
         * export — the video is still worth having without a voice track. Once the clips exist,
         * `paceScenes` stretches each scene to its own clip, and the duration and frame count are
         * re-derived from the paced timeline.
         */
        let narration;
        let sceneDurations;
        if (narrationSettings?.enabled) {
            onProgress({ message: 'Narrating with this machine’s voice…', fraction: 0 });
            const clips = await synthesizeNarration(guide, narrationSettings, scratchDir(guideId));
            if (clips.length) {
                const paced = paceScenes(guide, settings, clips);
                narration = paced.narration;
                sceneDurations = paced.sceneDurations;
                durationMs = paced.durationMs;
                frames = Math.max(1, Math.round((durationMs / 1000) * settings.fps));
            }
        }
        try {
            onProgress({ message: `Rendering ${frames} frames…`, fraction: 0 });
            const mp4 = await VideoRenderService_1.videoRenderService.renderHtmlToMp4((0, videoTemplate_1.buildVideoHtml)(guide, images, settings, sceneDurations, videoOptions), {
                width,
                height,
                fps: settings.fps,
                durationMs,
                narration,
                // Frame capture is the long pole; leave the last slice of the bar for the encode.
                onProgress: (message, fraction) => onProgress({ message, fraction: fraction * 0.9 }),
                signal,
            });
            fs_1.default.writeFileSync(picked.filePath, mp4);
        }
        finally {
            // On failure and cancel too — synthesised narration is a WAV per step, and a render
            // that never finished used to leave the whole set on disk with no scavenger behind it.
            if (narration?.length)
                await cleanupNarration(narration);
        }
    }
    // Remember what was chosen so the next render is one click.
    GuideStore_1.guideStore.setVideoPreset(guideId, settings);
    onProgress({ message: 'Done.', fraction: 1 });
    void electron_1.shell.showItemInFolder(picked.filePath);
    return { path: picked.filePath, format: settings.format, durationMs, width, height, frames };
}
//# sourceMappingURL=videoExport.js.map