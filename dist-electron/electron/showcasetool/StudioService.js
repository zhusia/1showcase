"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.studioService = exports.StudioService = void 0;
exports.sweepRenderStash = sweepRenderStash;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const crypto_1 = require("crypto");
const electron_1 = require("electron");
const db_1 = require("../db");
const GuideSessionStore_1 = require("./GuideSessionStore");
const MachineHelper_1 = require("./MachineHelper");
const captionsParse_1 = require("./captionsParse");
const wavAudio_1 = require("./wavAudio");
const machinePolicy_1 = require("./machinePolicy");
const mediaProtocol_1 = require("./mediaProtocol");
const studio_1 = require("./studio");
const LicenseService_1 = require("../services/LicenseService");
const entitlements_1 = require("./entitlements");
function recordingDir(sessionId) {
    // The id arrives over IPC and lands in an rm -rf; one traversal segment would delete
    // anything. Same shape the gtmedia:// handler enforces.
    if (!/^[a-z0-9-]{8,64}$/i.test(sessionId))
        throw new Error('invalid session id');
    return path_1.default.join(electron_1.app.getPath('userData'), 'showcasetool', '.machine', sessionId);
}
function stashDir() {
    return path_1.default.join(electron_1.app.getPath('temp'), 'oneshowcasetool-render');
}
/**
 * Startup sweep for the export scratch directory. A stash whose export never finished — a
 * refusal, a crash, a quit mid-compose — is a full-length, mask-burned video of the Maker's
 * screen sitting in temp with nothing pointing at it. Anything older than a day cannot belong
 * to a live export.
 */
function sweepRenderStash() {
    void (async () => {
        const entries = await fs_1.default.promises.readdir(stashDir()).catch(() => []);
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        for (const name of entries) {
            const file = path_1.default.join(stashDir(), name);
            const stat = await fs_1.default.promises.stat(file).catch(() => null);
            if (stat && stat.mtimeMs < cutoff)
                await fs_1.default.promises.rm(file, { force: true }).catch(() => undefined);
        }
    })();
}
class StudioService {
    /**
     * The stash and dialog results this process actually produced. `finishExport` will only copy
     * from a path `stashRender` returned and only write to a path the save dialog chose — the
     * renderer names both over IPC, and taking them verbatim made a renderer bug (or compromise)
     * able to copy from and delete any file on the machine.
     */
    stashed = new Set();
    allowedOut = new Map();
    /**
     * Everything the editor needs to open a take.
     *
     * The manifest is read from disk rather than the database on purpose (see
     * `MachineRecorderService.RecordingManifest`): the cursor track alone is tens of thousands of
     * samples, and it is a blob to read whole or not at all.
     */
    get(sessionId) {
        const session = GuideSessionStore_1.guideSessionStore.get(sessionId);
        if (!session)
            throw new Error('That recording is not in the library.');
        const { project, issues, musicSalvaged } = GuideSessionStore_1.guideSessionStore.studioWithIssues(sessionId);
        const media = GuideSessionStore_1.guideSessionStore.media(sessionId);
        const mediaState = media?.state ?? '';
        const manifest = this.manifest(sessionId);
        /**
         * Capture the evidence the first time it is seen, because it is about to stop existing: the
         * editor autosaves a complete project within half a second of opening, and that write rebuilds
         * `sessions.studio` from the entries that *did* parse. After it, nothing anywhere remembers
         * that a mask was ever there.
         */
        const stored = GuideSessionStore_1.guideSessionStore.studioQuarantine(sessionId);
        const quarantine = mergeIssues(stored, issues);
        if (quarantine.length !== stored.length)
            GuideSessionStore_1.guideSessionStore.setStudioQuarantine(sessionId, quarantine);
        const unreadableMasks = quarantine.filter((one) => one.kind === 'mask').length;
        return {
            sessionId,
            title: session.title,
            project,
            manifest,
            mediaState,
            exportRefusal: (0, studio_1.studioExportRefusal)(project, mediaState, unreadableMasks),
            watermark: LicenseService_1.licenseService.watermark(),
            stepCount: session.stepCount,
            quarantine: { count: quarantine.length, unreadableMasks, notes: quarantine.map(describeIssue) },
            musicNote: musicSalvaged
                ? 'A stored score could not be read, so those pieces fell back to the mood tables. Nothing else about the take changed.'
                : null,
            speechUrl: manifest?.speechUrl,
        };
    }
    /**
     * The recorded clock, for the half of the app that does not open the editor.
     *
     * One capture becomes two products — footage the studio edits, and step screenshots the guide
     * is made from — and `stepMarks` is the *only* thing that says which moment of the first a step
     * of the second came from. The review screen needs that to offer "show this in the video", and
     * it must not read the manifest itself: the file lives beside the footage under `userData`, and
     * the renderer has no filesystem.
     *
     * Null when there is nothing to cross to — a still-frame recording, a browser recording, or a
     * take whose footage was swept. `manifest()` already drops segments whose files are gone, so a
     * swept take answers null here rather than offering a jump into a video that no longer exists.
     */
    footage(sessionId) {
        const manifest = this.manifest(sessionId);
        if (!manifest || !manifest.segments.length)
            return null;
        return {
            durationMs: manifest.durationMs,
            marks: (manifest.stepMarks ?? []).map((mark) => ({ seq: mark.seq, tMs: mark.tMs })),
        };
    }
    /**
     * Turn the frame the Maker is looking at in the editor into a guide step.
     *
     * The pixels arrive composited from the renderer, for the same reason an export's do: `drawFrame`
     * is the only definition of what a take looks like and it needs a canvas, which main does not
     * have. What that means for safety is the important half — the frame handed over has already had
     * every active mask filled at capture resolution, so this writes a burned frame, never raw
     * footage. It is the studio export's contract applied to one still, and it is why this is allowed
     * to exist next to "never add a path that copies the captured .mov out of `.machine/`".
     *
     * Adding a step is an edit to the session's content, so it **clears the redaction
     * acknowledgement** — the new frame has been through the studio's mask pass but not through the
     * guide's, and those are separate gates over separate artifacts.
     */
    captureStep(options) {
        const session = GuideSessionStore_1.guideSessionStore.get(options.sessionId);
        if (!session)
            throw new Error('That recording is not in the library.');
        if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(options.dataUri)) {
            throw new Error('That frame is not a PNG this app produced.');
        }
        const manifest = this.manifest(options.sessionId);
        if (!manifest)
            throw new Error('There is no footage for this recording.');
        const sourceMs = Math.max(0, Math.round(Number.isFinite(options.sourceMs) ? options.sourceMs : 0));
        const seq = (GuideSessionStore_1.guideSessionStore.steps(options.sessionId).reduce((max, step) => Math.max(max, step.seq), 0) || 0) + 1;
        const windowTitle = manifest.targetName || session.targetWindow || session.title;
        const stepId = GuideSessionStore_1.guideSessionStore.appendStep(options.sessionId, {
            id: (0, crypto_1.randomUUID)(),
            seq,
            kind: 'click',
            // A desktop step has no URL, so it gets the synthetic one every machine step gets — see
            // machinePolicy.ts. Nothing downstream has to learn about a third kind of step.
            url: (0, machinePolicy_1.appUriFor)(windowTitle),
            urlPattern: (0, machinePolicy_1.appUriFor)(windowTitle),
            pageTitle: windowTitle,
            selectors: [],
            a11y: {},
            valueMasked: false,
            viewport: { width: 0, height: 0, dpr: 1 },
            screenshot: options.dataUri,
            targetRect: options.targetRect,
            windowTitle,
            note: (options.note ?? '').slice(0, 400),
            warnings: [],
            capturedAt: new Date().toISOString(),
        });
        /**
         * The mark goes in the manifest beside the recorder's own, because that file is the single
         * definition of where a step sits on the recorded clock. Putting it on the step row instead
         * would be a second answer to one question, and the timeline reads this one.
         */
        this.appendStepMark(options.sessionId, seq, sourceMs);
        GuideSessionStore_1.guideSessionStore.invalidateAcknowledgement(options.sessionId);
        return { stepId, seq, stepCount: session.stepCount + 1 };
    }
    /**
     * Add one `{ seq, tMs }` to the take's manifest, in place.
     *
     * Read-modify-write of the raw file rather than of `manifest()`'s return: that accessor drops
     * segments whose files are missing and adds `segmentUrls`, and writing either back would edit
     * the recording's own record of itself. A manifest that cannot be read is left alone — the step
     * is still a step, it simply has no pin on the ruler.
     */
    appendStepMark(sessionId, seq, tMs) {
        const file = path_1.default.join(recordingDir(sessionId), 'recording.json');
        try {
            const parsed = JSON.parse(fs_1.default.readFileSync(file, 'utf8'));
            const marks = (parsed.stepMarks ?? []).filter((mark) => mark.seq !== seq);
            marks.push({ seq, tMs });
            marks.sort((a, b) => a.tMs - b.tMs);
            fs_1.default.writeFileSync(file, JSON.stringify({ ...parsed, stepMarks: marks }));
        }
        catch {
            /* an unreadable manifest costs a pin on the ruler, never the step */
        }
    }
    /**
     * The one way out: the Maker says they have been through the take again and re-masked whatever
     * needed it, so the unreadable records can go.
     *
     * It clears the quarantine **and** resets the review flag, together. Discarding the evidence is
     * a statement about the take's redaction, so the take has to go back through the gate — and the
     * ordinary `review()` action deliberately cannot do this, because a timestamp is not an answer to
     * "a mask could not be read".
     */
    discardQuarantine(sessionId) {
        const session = GuideSessionStore_1.guideSessionStore.get(sessionId);
        if (!session)
            throw new Error('That recording is not in the library.');
        GuideSessionStore_1.guideSessionStore.setStudioQuarantine(sessionId, []);
        const project = GuideSessionStore_1.guideSessionStore.studio(sessionId);
        return GuideSessionStore_1.guideSessionStore.setStudio(sessionId, { ...project, reviewedAt: '' });
    }
    manifest(sessionId) {
        const file = path_1.default.join(recordingDir(sessionId), 'recording.json');
        if (!fs_1.default.existsSync(file))
            return null;
        let parsed;
        try {
            parsed = JSON.parse(fs_1.default.readFileSync(file, 'utf8'));
        }
        catch {
            return null;
        }
        // Only segments that actually exist are offered. A take whose files were swept must not
        // give the editor a playlist of 404s to puzzle over.
        const segments = (parsed.segments ?? []).filter((segment) => fs_1.default.existsSync(path_1.default.join(recordingDir(sessionId), segment.file)));
        const cameraSegments = (parsed.cameraSegments ?? []).filter((segment) => fs_1.default.existsSync(path_1.default.join(recordingDir(sessionId), segment.file)));
        const speechFile = path_1.default.join(recordingDir(sessionId), 'speech.wav');
        return {
            ...parsed,
            segments,
            cameraSegments,
            segmentUrls: segments.map((segment) => `${mediaProtocol_1.MEDIA_SCHEME}://${sessionId}/${segment.file}`),
            cameraUrls: cameraSegments.map((segment) => `${mediaProtocol_1.MEDIA_SCHEME}://${sessionId}/${segment.file}`),
            speechUrl: fs_1.default.existsSync(speechFile) ? `${mediaProtocol_1.MEDIA_SCHEME}://${sessionId}/speech.wav` : undefined,
        };
    }
    /**
     * Save the project. Every edit, not an explicit Save — an editor that can lose an hour of
     * mask work to a crash is worse than no editor.
     *
     * Changing anything clears the review flag. The Maker acknowledged *a* take; moving the trim
     * or deleting a mask makes it a different one, and the export gate has to be re-earned. This
     * mirrors `invalidateAcknowledgement` on the guide side and exists for the same reason.
     */
    save(sessionId, project) {
        // Strict: an invalid save is a bug to report, never something to replace with defaults.
        const incoming = (0, studio_1.parseStudioStrict)(project);
        const previous = GuideSessionStore_1.guideSessionStore.studio(sessionId);
        const captions = (0, entitlements_1.applyCaptionLicence)(incoming.captions, LicenseService_1.licenseService.isPro());
        const next = {
            ...incoming,
            captions,
            reviewedAt: (0, studio_1.studioEditAffectsOutput)(previous, incoming) ? '' : previous.reviewedAt,
        };
        return GuideSessionStore_1.guideSessionStore.setStudio(sessionId, next);
    }
    /**
     * The Maker says they have watched the take and masked what needed masking.
     *
     * Recorded in main rather than trusted from the renderer, for the same reason the machine
     * session's stricter acknowledge gate is enforced here: a renderer bug must not be able to
     * skip the only pass this footage gets.
     */
    review(sessionId) {
        const project = GuideSessionStore_1.guideSessionStore.studio(sessionId);
        const media = GuideSessionStore_1.guideSessionStore.media(sessionId);
        if (!media?.state)
            throw new Error('There is no footage attached to this recording.');
        if (media.state === 'swept') {
            throw new Error('This recording’s footage was deleted after sitting unreviewed for seven days.');
        }
        return GuideSessionStore_1.guideSessionStore.setStudio(sessionId, { ...project, reviewedAt: new Date().toISOString() });
    }
    /**
     * Where an export may be written, and the last gate before it is.
     *
     * `studioExportRefusal` is checked here as well as in the renderer, because the renderer's
     * copy is a courtesy that stops a disabled button and this one is the rule.
     */
    async chooseExportPath(sessionId, suggested) {
        const take = this.get(sessionId);
        if (take.exportRefusal)
            throw new Error(take.exportRefusal);
        const window = electron_1.BrowserWindow.getFocusedWindow() ?? electron_1.BrowserWindow.getAllWindows()[0];
        const safeName = (suggested || take.title || 'recording').replace(/[^\w. -]+/g, '_').slice(0, 80);
        const result = await electron_1.dialog.showSaveDialog(window ?? undefined, {
            title: 'Export recording',
            defaultPath: path_1.default.join(electron_1.app.getPath('downloads'), `${safeName}.mp4`),
            filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
        });
        if (result.canceled || !result.filePath)
            return null;
        this.allowedOut.set(sessionId, result.filePath);
        return result.filePath;
    }
    /**
     * Take the encoded bytes off the renderer's hands and put them somewhere with a name.
     *
     * The renderer produced the MP4 in memory and cannot write a file; main can, but has no
     * encoder. So the bytes cross once, into a scratch file the compose stage then reads. It goes
     * to a temp directory rather than the Maker's chosen path because it is not the finished
     * article yet — the audio is still to come, and half a file at the destination would look
     * like a successful export.
     */
    async stashRender(bytes) {
        if (!bytes?.byteLength)
            throw new Error('The renderer produced an empty video.');
        const dir = stashDir();
        await fs_1.default.promises.mkdir(dir, { recursive: true });
        const file = path_1.default.join(dir, `render-${Date.now()}.mp4`);
        await fs_1.default.promises.writeFile(file, bytes);
        this.stashed.add(file);
        return file;
    }
    /**
     * The score's WAV, written next to the video stash. Bounded: a score is a few megabytes of
     * PCM, never a captured movie. Same allow-list as `stashRender` so `finishExport` will only
     * mux a file this process just wrote.
     */
    async stashScore(bytes) {
        if (!bytes?.byteLength)
            throw new Error('The renderer produced an empty score.');
        if (bytes.byteLength > 80 * 1024 * 1024)
            throw new Error('That score is larger than an export is allowed to carry.');
        if (bytes.byteLength < 44 || bytes[0] !== 0x52 || bytes[1] !== 0x49 || bytes[2] !== 0x46 || bytes[3] !== 0x46) {
            throw new Error('The score is not a WAV this app produced.');
        }
        const dir = stashDir();
        await fs_1.default.promises.mkdir(dir, { recursive: true });
        const file = path_1.default.join(dir, `score-${Date.now()}.wav`);
        await fs_1.default.promises.writeFile(file, bytes);
        this.stashed.add(file);
        return file;
    }
    /**
     * Mux the take's audio onto a rendered, mask-burned picture, and mark the footage burned.
     *
     * The renderer has already produced a video-only file in which the mask rectangles are opaque
     * pixels rather than metadata — that is the destruction. This adds the recording's own audio,
     * trimmed and time-scaled the same way the picture was, using AVFoundation rather than a
     * bundled FFmpeg (see Composer.swift).
     */
    async finishExport(options) {
        // Both paths must be ones this process handed out — see the field comment above.
        if (!this.stashed.has(options.renderedPath))
            throw new Error('That rendered file is not a pending export.');
        if (options.musicPath && !this.stashed.has(options.musicPath)) {
            throw new Error('That score file is not a pending export.');
        }
        if (this.allowedOut.get(options.sessionId) !== options.outPath) {
            throw new Error('The destination does not match the one chosen in the save dialog.');
        }
        try {
            // Inside the try: a refusal must still remove the stashed render in the finally below,
            // or every refused export leaves a mask-burned video of the screen sitting in temp.
            const take = this.get(options.sessionId);
            if (take.exportRefusal)
                throw new Error(take.exportRefusal);
            if (!fs_1.default.existsSync(options.renderedPath))
                throw new Error('The rendered video is missing.');
            const project = take.project;
            const manifest = take.manifest;
            const recorded = manifest?.durationMs ?? 0;
            const physical = manifest?.segments ?? [];
            const editedClips = project.clips
                .map((clip) => ({
                ...clip,
                sourceStartMs: Math.max(0, Math.min(recorded, clip.sourceStartMs)),
                sourceEndMs: Math.max(0, Math.min(recorded, clip.sourceEndMs)),
            }))
                .filter((clip) => clip.sourceEndMs - clip.sourceStartMs >= 1);
            const clips = editedClips.length
                ? editedClips
                : physical.map((segment, index) => ({
                    id: `source-${index}-${Math.round(segment.startMs)}`,
                    sourceStartMs: segment.startMs,
                    sourceEndMs: Math.min(recorded, segment.startMs + segment.durationMs),
                    rate: 1,
                }));
            /**
             * The audio is assembled on the **unscaled** concatenation of the clips, and the per-clip
             * rates are applied to the assembled ranges afterwards (Composer.swift).
             *
             * Two clocks, and conflating them is the bug worth naming. The Maker trims on the *edit*
             * timeline, where a clip slowed to half occupies twice its recorded length; the audio slices
             * are addressed by recorded length, because that is what is in the files. So the trim window
             * is converted into assembly space here, and every segment carries the rate the composer
             * should stretch it by. Doing the stretch in the renderer is not an option — there is no
             * demuxer for the captured `.mov` in a browser context, which is why this stage exists.
             */
            const laid = clips.map((clip) => {
                const clipStart = Math.max(0, Math.min(recorded, clip.sourceStartMs));
                const clipEnd = Math.max(clipStart, Math.min(recorded, clip.sourceEndMs));
                const rate = Number.isFinite(clip.rate) && clip.rate > 0 ? Math.max(0.25, Math.min(4, clip.rate)) : 1;
                return { clipStart, clipEnd, rate, sourceLen: clipEnd - clipStart };
            });
            const segments = [];
            let assemblyAt = 0;
            let editAt = 0;
            const spans = laid.map((clip) => {
                const span = { ...clip, assemblyStart: assemblyAt, editStart: editAt, editLen: clip.sourceLen / clip.rate };
                assemblyAt += clip.sourceLen;
                editAt += span.editLen;
                return span;
            });
            for (const span of spans) {
                for (const source of physical) {
                    const from = Math.max(span.clipStart, source.startMs);
                    const to = Math.min(span.clipEnd, source.startMs + source.durationMs);
                    if (to - from < 1)
                        continue;
                    segments.push({
                        file: path_1.default.join(recordingDir(options.sessionId), source.file),
                        startMs: span.assemblyStart + (from - span.clipStart),
                        durationMs: to - from,
                        sourceOffsetMs: from - source.startMs,
                        rate: span.rate,
                    });
                }
            }
            /** An edit-timeline instant, on the clock the audio slices are addressed by. */
            const toAssembly = (editMs) => {
                if (!spans.length)
                    return 0;
                const wanted = Math.max(0, editMs);
                for (const span of spans) {
                    if (wanted < span.editStart + span.editLen)
                        return span.assemblyStart + (wanted - span.editStart) * span.rate;
                }
                return assemblyAt;
            };
            const hasAudio = (manifest?.systemAudio || manifest?.microphone) === true && project.audio?.muted !== true;
            const musicPath = options.musicPath && fs_1.default.existsSync(options.musicPath) ? options.musicPath : undefined;
            if (options.audioMuxed) {
                await fs_1.default.promises.copyFile(options.renderedPath, options.outPath);
                this.markBurned(options.sessionId);
                writeExportSidecars(options.outPath, project, take.title);
                return { out: options.outPath, audio: hasAudio || Boolean(musicPath) };
            }
            if ((!hasAudio || !segments.length) && !musicPath) {
                // A silent take needs no mux, and spawning the helper to copy a file would only add a
                // way for the export to fail. A take with a score still has to go through compose.
                await fs_1.default.promises.copyFile(options.renderedPath, options.outPath);
                this.markBurned(options.sessionId);
                writeExportSidecars(options.outPath, project, take.title);
                return { out: options.outPath, audio: false };
            }
            if (!(0, MachineHelper_1.helperAvailable)()) {
                await fs_1.default.promises.copyFile(options.renderedPath, options.outPath);
                this.markBurned(options.sessionId);
                writeExportSidecars(options.outPath, project, take.title);
                return { out: options.outPath, audio: false };
            }
            const result = await MachineHelper_1.machineHelper.compose({
                video: options.renderedPath,
                out: options.outPath,
                segments: hasAudio ? segments : [],
                trimStartMs: toAssembly(project.trimStartMs),
                trimEndMs: toAssembly(project.trimEndMs === null ? editAt : Math.min(project.trimEndMs, editAt)),
                speed: project.export.speed,
                music: musicPath,
                musicVolume: Math.max(0, Math.min(1, (project.music?.volume ?? 70) / 100)),
                duckRamps: project.music?.duckUnderSpeech === false ? [] : options.duckRamps ?? [],
                speechGain: speechGainOf(project) * Math.max(0.25, Math.min(2, (project.audio?.voiceGain ?? 100) / 100)),
                noiseGate: project.audio?.noiseGate === true || project.audio?.cleanupVoice === true,
            });
            this.markBurned(options.sessionId);
            writeExportSidecars(options.outPath, project, take.title);
            return result;
        }
        finally {
            // The scratch render is a mask-burned copy of the take. Leaving it in the temp directory
            // would quietly accumulate full-length videos of the Maker's screen, which is exactly the
            // thing the seven-day sweep exists to prevent for the raw capture.
            this.stashed.delete(options.renderedPath);
            await fs_1.default.promises.rm(options.renderedPath, { force: true }).catch(() => undefined);
            if (options.musicPath) {
                this.stashed.delete(options.musicPath);
                await fs_1.default.promises.rm(options.musicPath, { force: true }).catch(() => undefined);
            }
        }
    }
    /**
     * RMS of the assembled speech track, on the output clock, as gain-sized numbers.
     *
     * Used to build the duck envelope. The helper never returns samples — only bucket
     * magnitudes — so nothing harvested can hide in this reply.
     */
    async speechEnvelope(sessionId) {
        const take = this.get(sessionId);
        const manifest = take.manifest;
        if (!manifest || !(manifest.systemAudio || manifest.microphone))
            return { buckets: [], bucketMs: 50 };
        const assembled = this.assembleAudio(sessionId, take.project, manifest);
        if (!assembled.segments.length)
            return { buckets: [], bucketMs: 50 };
        const wavPath = path_1.default.join(recordingDir(sessionId), 'speech.wav');
        if (fs_1.default.existsSync(wavPath)) {
            const parsed = (0, wavAudio_1.parseWav)(fs_1.default.readFileSync(wavPath));
            if (parsed) {
                return (0, wavAudio_1.rmsBuckets)((0, wavAudio_1.toMono)(parsed), parsed.sampleRate, 50);
            }
        }
        try {
            return await MachineHelper_1.machineHelper.analyzeAudio({
                segments: assembled.segments,
                trimStartMs: assembled.trimStartMs,
                trimEndMs: assembled.trimEndMs,
                speed: take.project.export.speed,
            });
        }
        catch {
            return { buckets: [], bucketMs: 50 };
        }
    }
    assembleAudio(sessionId, project, manifest) {
        const recorded = manifest.durationMs ?? 0;
        const physical = manifest.segments ?? [];
        const editedClips = project.clips
            .map((clip) => ({
            ...clip,
            sourceStartMs: Math.max(0, Math.min(recorded, clip.sourceStartMs)),
            sourceEndMs: Math.max(0, Math.min(recorded, clip.sourceEndMs)),
        }))
            .filter((clip) => clip.sourceEndMs - clip.sourceStartMs >= 1);
        const clips = editedClips.length
            ? editedClips
            : physical.map((segment, index) => ({
                id: `source-${index}-${Math.round(segment.startMs)}`,
                sourceStartMs: segment.startMs,
                sourceEndMs: Math.min(recorded, segment.startMs + segment.durationMs),
                rate: 1,
            }));
        const laid = clips.map((clip) => {
            const clipStart = Math.max(0, Math.min(recorded, clip.sourceStartMs));
            const clipEnd = Math.max(clipStart, Math.min(recorded, clip.sourceEndMs));
            const rate = Number.isFinite(clip.rate) && clip.rate > 0 ? Math.max(0.25, Math.min(4, clip.rate)) : 1;
            return { clipStart, clipEnd, rate, sourceLen: clipEnd - clipStart };
        });
        const segments = [];
        let assemblyAt = 0;
        let editAt = 0;
        const spans = laid.map((clip) => {
            const span = { ...clip, assemblyStart: assemblyAt, editStart: editAt, editLen: clip.sourceLen / clip.rate };
            assemblyAt += clip.sourceLen;
            editAt += span.editLen;
            return span;
        });
        for (const span of spans) {
            for (const source of physical) {
                const from = Math.max(span.clipStart, source.startMs);
                const to = Math.min(span.clipEnd, source.startMs + source.durationMs);
                if (to - from < 1)
                    continue;
                segments.push({
                    file: path_1.default.join(recordingDir(sessionId), source.file),
                    startMs: span.assemblyStart + (from - span.clipStart),
                    durationMs: to - from,
                    sourceOffsetMs: from - source.startMs,
                    rate: span.rate,
                });
            }
        }
        const toAssembly = (editMs) => {
            if (!spans.length)
                return 0;
            const wanted = Math.max(0, editMs);
            for (const span of spans) {
                if (wanted < span.editStart + span.editLen)
                    return span.assemblyStart + (wanted - span.editStart) * span.rate;
            }
            return assemblyAt;
        };
        return {
            segments,
            trimStartMs: toAssembly(project.trimStartMs),
            trimEndMs: toAssembly(project.trimEndMs === null ? editAt : Math.min(project.trimEndMs, editAt)),
        };
    }
    /**
     * Show a finished export in the file manager.
     *
     * Only a path this process itself chose in the save dialog, for the same reason `finishExport`
     * checks: the renderer names the path, and a renderer bug that could hand an arbitrary one to
     * `showItemInFolder` turns a convenience into a way to open any directory on the machine.
     */
    revealExport(sessionId, outPath) {
        if (this.allowedOut.get(sessionId) !== outPath)
            throw new Error('That is not a file this recording exported.');
        if (!fs_1.default.existsSync(outPath))
            return { revealed: false };
        electron_1.shell.showItemInFolder(outPath);
        return { revealed: true };
    }
    /**
     * The footage has now produced an export in which the masks are pixels.
     *
     * The raw capture is *not* deleted here. A Maker who masked the wrong thing has to be able to
     * go back and re-export, and the seven-day sweep already bounds how long unreviewed footage
     * sits on disk. What 'burned' records is that a burn has happened — which is what the state
     * is for, since the raw file itself never had an export path.
     */
    markBurned(sessionId) {
        const media = GuideSessionStore_1.guideSessionStore.media(sessionId);
        if (media?.path)
            GuideSessionStore_1.guideSessionStore.setMedia(sessionId, media.path, 'burned');
    }
    /** Delete a take's footage on request, leaving the steps and the guide behind. */
    async discardMedia(sessionId) {
        const dir = recordingDir(sessionId);
        if (!fs_1.default.existsSync(dir))
            return { removed: false };
        await fs_1.default.promises.rm(dir, { recursive: true, force: true });
        GuideSessionStore_1.guideSessionStore.setMedia(sessionId, '', 'swept');
        return { removed: true };
    }
    async transcribe(sessionId) {
        const take = this.get(sessionId);
        const manifest = take.manifest;
        if (!manifest || !(manifest.systemAudio || manifest.microphone)) {
            throw new Error('This take has no recorded speech to transcribe.');
        }
        if (!(0, MachineHelper_1.helperAvailable)()) {
            throw new Error('On-device transcription is not available on this system. Import an SRT or VTT file, or type the captions.');
        }
        const assembled = this.assembleAudio(sessionId, take.project, manifest);
        if (!assembled.segments.length)
            throw new Error('This take has no recorded speech to transcribe.');
        return MachineHelper_1.machineHelper.transcribe({
            segments: assembled.segments,
            trimStartMs: assembled.trimStartMs,
            trimEndMs: assembled.trimEndMs,
            speed: take.project.export.speed,
        });
    }
    async importCaptions(sessionId) {
        const take = this.get(sessionId);
        const window = electron_1.BrowserWindow.getFocusedWindow() ?? electron_1.BrowserWindow.getAllWindows()[0];
        const picked = await electron_1.dialog.showOpenDialog(window ?? undefined, {
            title: 'Import captions',
            filters: [{ name: 'Captions', extensions: ['srt', 'vtt'] }],
            properties: ['openFile'],
        });
        if (picked.canceled || !picked.filePaths[0])
            return null;
        const text = fs_1.default.readFileSync(picked.filePaths[0], 'utf8');
        const words = (0, captionsParse_1.parseCaptionFile)(text, picked.filePaths[0]);
        if (!words.length)
            throw new Error('That file did not contain any captions.');
        void take;
        return { words };
    }
    async analyzeLoudness(sessionId) {
        const envelope = await this.speechEnvelope(sessionId);
        if (!envelope.buckets.length)
            return { measuredLufs: null };
        const mean = envelope.buckets.reduce((sum, one) => sum + one * one, 0) / envelope.buckets.length;
        const rms = Math.sqrt(Math.max(1e-12, mean));
        const measuredLufs = 20 * Math.log10(rms) - 0.691;
        const project = { ...this.get(sessionId).project, audio: { ...this.get(sessionId).project.audio, measuredLufs } };
        this.save(sessionId, project);
        return { measuredLufs };
    }
    async exportCaptions(sessionId, format) {
        const take = this.get(sessionId);
        const words = take.project.captions?.words ?? [];
        if (!words.length)
            throw new Error('This take has no transcript yet.');
        const body = format === 'vtt' ? toVtt(words) : toSrt(words);
        const window = electron_1.BrowserWindow.getFocusedWindow() ?? electron_1.BrowserWindow.getAllWindows()[0];
        const picked = await electron_1.dialog.showSaveDialog(window ?? undefined, {
            title: format === 'vtt' ? 'Export WebVTT' : 'Export SubRip',
            defaultPath: `${take.title || 'captions'}.${format}`,
            filters: [{ name: format.toUpperCase(), extensions: [format] }],
        });
        if (picked.canceled || !picked.filePath)
            return null;
        fs_1.default.writeFileSync(picked.filePath, body, 'utf8');
        void electron_1.shell.showItemInFolder(picked.filePath);
        return picked.filePath;
    }
    copyExport(sessionId, outPath) {
        if (this.allowedOut.get(sessionId) !== outPath)
            throw new Error('That is not a file this recording exported.');
        if (!fs_1.default.existsSync(outPath))
            return { copied: false };
        if (process.platform === 'darwin') {
            electron_1.clipboard.writeBuffer('public.file-url', Buffer.from(`file://${outPath}`));
        }
        else if (process.platform === 'win32') {
            electron_1.clipboard.writeBuffer('CF_HDROP', dropFilesBuffer(outPath));
        }
        else {
            const uri = `file://${outPath.replace(/\\/g, '/')}\n`;
            electron_1.clipboard.writeBuffer('text/uri-list', Buffer.from(uri));
            try {
                electron_1.clipboard.writeBuffer('x-special/gnome-copied-files', Buffer.from(`copy\n${uri}`));
            }
            catch {
                /* not every desktop understands this format */
            }
            electron_1.clipboard.writeText(outPath);
        }
        return { copied: true };
    }
    saveSnapshot(sessionId, name) {
        const take = this.get(sessionId);
        const id = (0, crypto_1.randomUUID)();
        const createdAt = new Date().toISOString();
        const label = (name ?? '').trim().slice(0, 80) || `Snapshot ${createdAt.slice(0, 16).replace('T', ' ')}`;
        (0, db_1.getDb)()
            .prepare(`INSERT INTO studio_snapshots (id, session_id, name, project_json, created_at) VALUES (?, ?, ?, ?, ?)`)
            .run(id, sessionId, label, JSON.stringify(take.project), createdAt);
        return { id, name: label, createdAt };
    }
    listSnapshots(sessionId) {
        const rows = (0, db_1.getDb)()
            .prepare(`SELECT id, name, created_at AS createdAt FROM studio_snapshots WHERE session_id = ? ORDER BY created_at DESC LIMIT 40`)
            .all(sessionId);
        return rows;
    }
    restoreSnapshot(sessionId, id) {
        const row = (0, db_1.getDb)()
            .prepare(`SELECT project_json FROM studio_snapshots WHERE id = ? AND session_id = ?`)
            .get(id, sessionId);
        if (!row)
            throw new Error('That snapshot is not on this recording.');
        let raw;
        try {
            raw = JSON.parse(row.project_json);
        }
        catch {
            throw new Error('That snapshot could not be read.');
        }
        return this.save(sessionId, raw);
    }
    listExportPresets() {
        const rows = (0, db_1.getDb)()
            .prepare(`SELECT id, name, settings_json FROM export_presets ORDER BY name COLLATE NOCASE`)
            .all();
        return rows.map((row) => ({
            id: row.id,
            name: row.name,
            settings: parseExportPreset(row.settings_json),
        }));
    }
    saveExportPreset(name, settings) {
        const label = String(name ?? '').trim().slice(0, 60);
        if (!label)
            throw new Error('Give the preset a name.');
        const parsed = parseExportPreset(JSON.stringify(settings ?? {}));
        const id = (0, crypto_1.randomUUID)();
        (0, db_1.getDb)()
            .prepare(`INSERT INTO export_presets (id, name, settings_json) VALUES (?, ?, ?)`)
            .run(id, label, JSON.stringify(parsed));
        return { id, name: label, settings: parsed };
    }
    deleteExportPreset(id) {
        const result = (0, db_1.getDb)().prepare(`DELETE FROM export_presets WHERE id = ?`).run(id);
        return result.changes > 0;
    }
    saveThumbnail(sessionId, dataUri) {
        this.get(sessionId);
        const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUri ?? ''));
        if (!match)
            throw new Error('The thumbnail has to be a PNG.');
        const bytes = Buffer.from(match[1], 'base64');
        if (bytes.length < 32 || bytes.length > 8_000_000)
            throw new Error('That thumbnail is not a usable PNG.');
        const dest = path_1.default.join(recordingDir(sessionId), 'thumbnail.png');
        fs_1.default.writeFileSync(dest, bytes);
        const project = this.get(sessionId).project;
        this.save(sessionId, { ...project, export: { ...project.export, thumbnail: 'thumbnail.png' } });
        return 'thumbnail.png';
    }
    getPrefs() {
        return readStudioPrefs();
    }
    setPrefs(raw) {
        const current = readStudioPrefs();
        const next = raw && typeof raw === 'object' ? raw : {};
        const prefs = {
            teleprompter: typeof next.teleprompter === 'string' ? next.teleprompter.slice(0, 4000) : current.teleprompter,
            freshnessDays: typeof next.freshnessDays === 'number' && Number.isFinite(next.freshnessDays)
                ? Math.max(1, Math.min(90, Math.round(next.freshnessDays)))
                : current.freshnessDays,
            freshnessRemind: typeof next.freshnessRemind === 'boolean' ? next.freshnessRemind : current.freshnessRemind,
        };
        (0, db_1.getDb)()
            .prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
            .run('studio.prefs', JSON.stringify(prefs));
        return prefs;
    }
}
exports.StudioService = StudioService;
const DEFAULT_PREFS = { teleprompter: '', freshnessDays: 14, freshnessRemind: false };
function readStudioPrefs() {
    const row = (0, db_1.getDb)().prepare(`SELECT value FROM settings WHERE key = ?`).get('studio.prefs');
    if (!row)
        return { ...DEFAULT_PREFS };
    try {
        const parsed = JSON.parse(row.value);
        return {
            teleprompter: typeof parsed.teleprompter === 'string' ? parsed.teleprompter : '',
            freshnessDays: typeof parsed.freshnessDays === 'number' ? parsed.freshnessDays : 14,
            freshnessRemind: parsed.freshnessRemind === true,
        };
    }
    catch {
        return { ...DEFAULT_PREFS };
    }
}
function parseExportPreset(raw) {
    let parsed = {};
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        parsed = {};
    }
    const source = parsed && typeof parsed === 'object' ? parsed : {};
    const defaults = {
        resolution: '1080p',
        fps: 30,
        speed: 1,
        quality: 'balanced',
        aspect: 'capture',
        burnCaptions: true,
        captionSidecar: false,
        chapters: false,
        thumbnail: '',
    };
    const fps = source.fps === 24 || source.fps === 30 || source.fps === 60 ? source.fps : defaults.fps;
    const resolution = source.resolution === '720p' ||
        source.resolution === '1080p' ||
        source.resolution === '1440p' ||
        source.resolution === '4k' ||
        source.resolution === 'source'
        ? source.resolution
        : defaults.resolution;
    const quality = source.quality === 'studio' || source.quality === 'balanced' || source.quality === 'web' || source.quality === 'web-low'
        ? source.quality
        : defaults.quality;
    const aspect = source.aspect === 'capture' ||
        source.aspect === '16:9' ||
        source.aspect === '9:16' ||
        source.aspect === '1:1' ||
        source.aspect === '4:5'
        ? source.aspect
        : defaults.aspect;
    return {
        ...defaults,
        resolution,
        fps,
        quality,
        aspect,
        burnCaptions: source.burnCaptions !== false,
        captionSidecar: source.captionSidecar === true,
        chapters: source.chapters === true,
    };
}
function writeExportSidecars(outPath, project, title) {
    const dir = path_1.default.dirname(outPath);
    const stem = path_1.default.basename(outPath, path_1.default.extname(outPath));
    if (project.export.captionSidecar && project.captions?.words?.length) {
        fs_1.default.writeFileSync(path_1.default.join(dir, `${stem}.srt`), toSrt(project.captions.words), 'utf8');
        fs_1.default.writeFileSync(path_1.default.join(dir, `${stem}.vtt`), toVtt(project.captions.words), 'utf8');
    }
    if (project.export.chapters) {
        const marks = (project.captions?.cards ?? [])
            .filter((card) => card.kind === 'chapter')
            .map((card) => ({ tMs: card.atMs, title: card.text }));
        const clips = project.clips ?? [];
        const fallback = marks.length
            ? marks
            : clips.map((_clip, index) => ({ tMs: index === 0 ? 0 : 0, title: `Clip ${index + 1}` }));
        const lines = ['0:00 Opening'];
        const seen = new Set(['0']);
        for (const mark of fallback) {
            const at = Math.max(0, Math.round(mark.tMs));
            if (at < 1000)
                continue;
            const key = String(Math.floor(at / 1000));
            if (seen.has(key))
                continue;
            seen.add(key);
            const m = Math.floor(at / 60_000);
            const s = Math.floor((at % 60_000) / 1000);
            lines.push(`${m}:${String(s).padStart(2, '0')} ${(mark.title || 'Chapter').slice(0, 80)}`);
        }
        if (lines.length > 1)
            fs_1.default.writeFileSync(path_1.default.join(dir, `${stem}.chapters.txt`), lines.join('\n') + '\n', 'utf8');
        void title;
    }
}
function speechGainOf(project) {
    if (project.audio?.normalize === false)
        return 1;
    const measured = project.audio?.measuredLufs;
    if (typeof measured !== 'number' || !Number.isFinite(measured))
        return 1;
    const target = project.audio?.targetLufs ?? -16;
    const db = Math.max(-12, Math.min(12, target - measured));
    return Math.max(0.25, Math.min(4, 10 ** (db / 20)));
}
function pad2(n) {
    return String(n).padStart(2, '0');
}
function srtTime(ms) {
    const clamped = Math.max(0, Math.round(ms));
    const h = Math.floor(clamped / 3_600_000);
    const m = Math.floor((clamped % 3_600_000) / 60_000);
    const s = Math.floor((clamped % 60_000) / 1000);
    const milli = clamped % 1000;
    return `${pad2(h)}:${pad2(m)}:${pad2(s)},${String(milli).padStart(3, '0')}`;
}
function toSrt(words) {
    const cues = cueWords(words);
    return cues.map((cue, i) => `${i + 1}\n${srtTime(cue.from)} --> ${srtTime(cue.to)}\n${cue.text}\n`).join('\n');
}
function toVtt(words) {
    const cues = cueWords(words);
    return `WEBVTT\n\n${cues.map((cue) => `${srtTime(cue.from).replace(',', '.')} --> ${srtTime(cue.to).replace(',', '.')}\n${cue.text}\n`).join('\n')}`;
}
function cueWords(words) {
    const cues = [];
    let batch = [];
    const flush = () => {
        if (!batch.length)
            return;
        const last = batch[batch.length - 1];
        cues.push({ from: batch[0].tMs, to: last.tMs + Math.max(40, last.dMs), text: batch.map((w) => w.word).join(' ') });
        batch = [];
    };
    for (const word of words) {
        if (batch.length >= 8 || (batch.length && word.tMs - batch[0].tMs > 2400))
            flush();
        batch.push(word);
    }
    flush();
    return cues;
}
function dropFilesBuffer(filePath) {
    const list = Buffer.from(`${filePath}\0\0`, 'ucs2');
    const headerSize = 20;
    const buf = Buffer.alloc(headerSize + list.length);
    buf.writeUInt32LE(headerSize, 0);
    buf.writeInt32LE(0, 4);
    buf.writeInt32LE(0, 8);
    buf.writeUInt32LE(0, 12);
    buf.writeUInt32LE(1, 16);
    list.copy(buf, headerSize);
    return buf;
}
exports.studioService = new StudioService();
/**
 * Union by the raw entry, so re-opening a take does not duplicate its own casualty list and a
 * second unreadable mask appearing later is still recorded.
 */
function mergeIssues(stored, found) {
    const seen = new Set(stored.map((one) => JSON.stringify(one.raw)));
    const out = [...stored];
    for (const one of found) {
        const key = JSON.stringify(one.raw);
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(one);
    }
    return out.slice(0, 200);
}
/** A sentence for the banner. The Maker's own label, never anything read out of the footage. */
function describeIssue(issue) {
    const what = issue.kind === 'mask' ? 'A mask' : 'A clip';
    const named = issue.label ? `${what} you labelled “${issue.label}”` : `${what} with no label`;
    return `${named} — ${issue.reason}`;
}
//# sourceMappingURL=StudioService.js.map