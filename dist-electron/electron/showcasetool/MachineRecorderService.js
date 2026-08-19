"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.machineRecorder = exports.MachineRecorderService = exports.CAPTURE_ACCELERATOR = void 0;
const crypto_1 = require("crypto");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const electron_1 = require("electron");
const channels_1 = require("../ipc/channels");
const devServer_1 = require("../devServer");
const appWindow_1 = require("./appWindow");
const GuideSessionStore_1 = require("./GuideSessionStore");
const machineCapture_1 = require("./machineCapture");
const machinePolicy_1 = require("./machinePolicy");
const machineRecovery_1 = require("./machineRecovery");
const ChromiumRecorder_1 = require("./ChromiumRecorder");
const MachineHelper_1 = require("./MachineHelper");
/**
 * The machine recorder (docs/machine-record-plan.md §6).
 *
 * Captures one desktop window on an explicit user action and appends the result to the same
 * session store the extension writes to. It observes no input of any kind — there is no
 * keyboard hook and no mouse hook, which is what keeps this outside the native-hook territory
 * the PRD ruled out in §5 and §14.4. A step happens because the Maker pressed the hotkey or
 * the HUD button, and for no other reason.
 *
 * Unlike the extension's service worker, this is the main process: it is not killed between
 * events, so holding the in-flight recording in a field is correct here. The
 * `chrome.storage.session` rule exists because MV3 workers die mid-recording; this one does not.
 */
exports.CAPTURE_ACCELERATOR = 'CommandOrControl+Shift+2';
/** Chrome's captureVisibleTab has a hard rate limit; desktopCapturer does not, but a Maker
 * leaning on the hotkey should not start ten overlapping full-resolution enumerations of
 * every open window. One chain, one minimum gap, extra presses coalesce. */
const CAPTURE_MIN_INTERVAL_MS = 250;
/** How long unburned footage may sit on disk before it is deleted. See sweepRawMedia. */
const RAW_MEDIA_TTL_MS = 7 * 24 * 60 * 60 * 1000;
class MachineRecorderService {
    active = null;
    hud = null;
    chain = Promise.resolve();
    lastCaptureAt = 0;
    swept = false;
    /** The frame rate the current take was started at, carried into its manifest. */
    fps = 30;
    status() {
        const state = this.active;
        return {
            recording: state
                ? {
                    sessionId: state.sessionId,
                    sourceName: state.sourceName,
                    stepCount: state.seq,
                    startedAt: state.startedAt,
                    hotkeyError: state.hotkeyError,
                    mode: state.mode,
                    targetKind: state.targetKind,
                    paused: state.paused,
                    elapsedMs: this.elapsedMs(state),
                    systemAudio: state.systemAudio,
                    microphone: state.microphone,
                }
                : null,
            permission: (0, machineCapture_1.screenPermission)(),
            accelerator: exports.CAPTURE_ACCELERATOR,
            nativeAvailable: (0, MachineHelper_1.helperAvailable)(),
            studioAvailable: true,
        };
    }
    /**
     * Recorded milliseconds, not wall clock. A HUD that keeps counting through a pause tells the
     * Maker their take is longer than the movie they will actually get.
     */
    elapsedMs(state) {
        const paused = state.paused ? state.pausedMs + (Date.now() - state.pausedAt) : state.pausedMs;
        return Math.max(0, Date.now() - state.startedAtMs - paused);
    }
    async listWindows() {
        return (0, machineCapture_1.listWindows)();
    }
    // ---------------------------------------------------------------- lifecycle
    async start(options) {
        if (this.active)
            throw new Error('A machine recording is already running. Stop it before starting another.');
        /**
         * The extension writes sessions over the relay and knows nothing about this recorder, so
         * the app's own store is the shared truth about whether something is already recording.
         * The mirror of this check lives in registerRelayRoutes' /session/start.
         */
        await this.clearStaleRecordings();
        if (GuideSessionStore_1.guideSessionStore.hasActiveRecording())
            throw new Error(this.busyReason('recording a desktop window'));
        const permission = (0, machineCapture_1.screenPermission)();
        if (!permission.usable)
            throw new Error(permission.hint ?? 'Screen recording is not permitted for 1ShowcaseTool.');
        const sourceName = options.sourceName?.trim() || 'Untitled window';
        const blocked = (0, machinePolicy_1.blockedWindowReason)(sourceName);
        if (blocked)
            throw new Error(blocked);
        // Prove the window is actually capturable before opening a session for it, so a refusal
        // does not leave an empty recording in the library.
        const probe = await (0, machineCapture_1.captureWindow)(options.sourceId);
        if (!probe.ok)
            throw new Error(probe.error);
        const title = options.title?.trim() || sourceName;
        const sessionId = GuideSessionStore_1.guideSessionStore.create(title, { source: 'machine', targetWindow: sourceName });
        this.active = {
            sessionId,
            sourceId: options.sourceId,
            sourceName,
            seq: 0,
            startedAt: new Date().toISOString(),
            pendingNote: '',
            hotkeyError: null,
            mode: 'shots',
            mediaDir: '',
            cursor: [],
            targetKind: 'window',
            width: 0,
            height: 0,
            systemAudio: false,
            microphone: false,
            paused: false,
            pausedAt: 0,
            pausedMs: 0,
            startedAtMs: Date.now(),
            stepMarks: [],
            keystrokes: [],
            engine: 'helper',
        };
        this.registerHotkey();
        this.openHud();
        // The window we already captured is the entry point — the same shape the browser recorder
        // uses when it records the page it started on.
        await this.appendCapture(probe, 'navigate', '');
        this.notify();
        return { sessionId, hotkeyError: this.active.hotkeyError };
    }
    // ---------------------------------------------------------------- video mode (P1)
    /**
     * What this machine's recorder can do, so the UI offers only what will work. Never throws:
     * a build without the helper answers "nothing", which is the correct thing to show.
     */
    async capabilities() {
        if ((0, MachineHelper_1.helperAvailable)()) {
            try {
                return await MachineHelper_1.machineHelper.probe();
            }
            catch {
                /* fall through to the Chromium feature set */
            }
        }
        return {
            macos: '',
            features: {
                video: true,
                microphone: true,
                systemAudio: process.platform !== 'darwin',
                region: true,
                pause: true,
                webcam: true,
            },
            micPermission: 'not-determined',
            accessibility: 'unknown',
        };
    }
    /** Raise the microphone prompt from the settings panel rather than mid-take. */
    async requestMicrophone() {
        if ((0, MachineHelper_1.helperAvailable)())
            return MachineHelper_1.machineHelper.requestMicrophone();
        if (process.platform === 'darwin') {
            try {
                const status = electron_1.systemPreferences.getMediaAccessStatus('microphone');
                if (status === 'not-determined') {
                    const ok = await electron_1.systemPreferences.askForMediaAccess('microphone');
                    return ok ? 'granted' : 'denied';
                }
                return status;
            }
            catch {
                return 'unknown';
            }
        }
        // Chromium will prompt on first getUserMedia. The picker just needs to light up.
        return 'granted';
    }
    /** Raise the Accessibility prompt for keyboard-shortcut capture, from the settings panel. */
    async requestAccessibility() {
        if (!(0, MachineHelper_1.helperAvailable)())
            return 'unknown';
        return MachineHelper_1.machineHelper.requestAccessibility();
    }
    /**
     * Everything the Maker can point at.
     *
     * Two enumerations joined on a numeric id, because each knows something the other does not:
     * ScreenCaptureKit knows the owning *application* of a window (so the blocklist can match an
     * app rather than only a mutable title), and `desktopCapturer` produces thumbnails cheaply in
     * one batched call. Electron's source ids embed the same `CGWindowID`/`CGDirectDisplayID` the
     * helper speaks, which is what lets the two lists join at all.
     */
    async listStudioSources() {
        if ((0, MachineHelper_1.helperAvailable)()) {
            try {
                return await this.listNativeStudioSources();
            }
            catch {
                /* helper enumeration failed — the Chromium list is still enough to start a take */
            }
        }
        return this.listChromiumStudioSources();
    }
    async listNativeStudioSources() {
        const [native, shells] = await Promise.all([
            MachineHelper_1.machineHelper.listSources(),
            (0, machineCapture_1.listCaptureSources)().catch(() => []),
        ]);
        const thumbnails = new Map();
        for (const shell of shells)
            thumbnails.set(`${shell.kind}:${shell.nativeId}`, shell);
        const displays = native.displays.map((display) => {
            const shell = thumbnails.get(`display:${display.id}`);
            return {
                id: display.id,
                name: shell?.name || `Display ${display.id}`,
                width: display.width,
                height: display.height,
                x: display.x,
                y: display.y,
                scale: display.scale,
                thumbnail: shell?.thumbnail ?? '',
            };
        });
        const windows = native.windows.map((win) => ({
            id: win.id,
            title: win.title,
            app: win.app,
            width: win.width,
            height: win.height,
            thumbnail: thumbnails.get(`window:${win.id}`)?.thumbnail ?? '',
            // Both are checked: a window titled innocuously inside a password manager is still a
            // password manager, and that is precisely the case the title-only check misses. Only the
            // *title* may trigger the empty-name refusal — a missing owning app is common for system
            // chrome and must not look like an untitled target.
            blockedReason: (0, machinePolicy_1.blockedWindowReason)(win.title) ?? ((win.app ?? '').trim() ? (0, machinePolicy_1.blockedWindowReason)(win.app) : null),
        }));
        return { displays, windows, microphones: native.microphones };
    }
    async listChromiumStudioSources() {
        const shells = await (0, machineCapture_1.listCaptureSources)().catch(() => []);
        const displays = electron_1.screen.getAllDisplays().map((display, index) => {
            const shell = shells.find((item) => item.kind === 'display' &&
                (item.displayId === String(display.id) || item.nativeId === display.id)) ?? shells.filter((item) => item.kind === 'display')[index];
            const scale = display.scaleFactor || 1;
            return {
                id: display.id,
                name: shell?.name || (index === 0 ? 'Primary display' : `Display ${index + 1}`),
                width: Math.round(display.size.width * scale),
                height: Math.round(display.size.height * scale),
                x: display.bounds.x,
                y: display.bounds.y,
                scale,
                thumbnail: shell?.thumbnail ?? '',
            };
        });
        const windows = shells
            .filter((item) => item.kind === 'window')
            .map((item) => ({
            id: item.nativeId,
            title: item.name,
            app: '',
            width: 0,
            height: 0,
            thumbnail: item.thumbnail,
            blockedReason: (0, machinePolicy_1.blockedWindowReason)(item.name),
        }));
        return { displays, windows, microphones: [] };
    }
    /** Kept for the older still-capture picker, which lists windows and nothing else. */
    async listNativeWindows() {
        const sources = await this.listStudioSources();
        return sources.windows.map((win) => ({
            id: String(win.id),
            name: win.title,
            thumbnail: win.thumbnail,
            blockedReason: win.blockedReason,
        }));
    }
    /**
     * Record continuously and let clicks produce the steps.
     *
     * The movie is written by ScreenCaptureKit straight to `mediaDir`; it is **not exportable**
     * until P2's mask burn exists, which is why `media_state` is stored as 'raw'. The steps, by
     * contrast, are ordinary machine steps and go through the existing review gate unchanged —
     * that is the whole point of the phase.
     */
    /**
     * Delete raw footage nobody came back to review (real-recorder-plan §5.4).
     *
     * The movie is unredacted by construction — masks and the destructive burn are P2, so today
     * nothing ever reaches 'burned' and *every* recording is eventually swept. That is the
     * intended P1 behaviour, not an oversight: better to lose footage than to keep an unreviewed
     * copy of someone's screen indefinitely. The steps themselves are unaffected; they are
     * ordinary redacted screenshots in the session store.
     */
    /**
     * Run the sweep at app start as well. Its only other caller is startStudio, so a Maker who
     * recorded once and never recorded again kept unredacted footage indefinitely — the exact
     * outcome the sweep exists to prevent.
     */
    sweepOnBoot() {
        this.sweepRawMedia();
    }
    sweepRawMedia() {
        if (this.swept)
            return;
        this.swept = true;
        const parent = path_1.default.join(electron_1.app.getPath('userData'), 'showcasetool', '.machine');
        void (async () => {
            const entries = await fs_1.default.promises.readdir(parent, { withFileTypes: true }).catch(() => []);
            const cutoff = Date.now() - RAW_MEDIA_TTL_MS;
            for (const entry of entries) {
                if (!entry.isDirectory())
                    continue;
                const target = path_1.default.join(parent, entry.name);
                const stat = await fs_1.default.promises.stat(target).catch(() => null);
                if (stat && stat.mtimeMs < cutoff) {
                    await fs_1.default.promises.rm(target, { recursive: true, force: true }).catch(() => undefined);
                    GuideSessionStore_1.guideSessionStore.setMedia(entry.name, '', 'swept');
                }
            }
        })();
    }
    // ---------------------------------------------------------------- stale takes
    /**
     * Close out takes a crash left open, and end any capture process it left running.
     *
     * A session's `status` is a claim made by the process that opened it. This one holds its live
     * take in a field, so anything the store still calls 'recording' at boot ended when the app
     * did — and because both recorders refuse to start over an open session, that row would block
     * every recording from here on with nothing on screen to explain why. The reasoning, and why
     * browser rows are left for the Maker to clear by hand, is in `machineRecovery.ts`.
     *
     * Fire and forget: it reads a few movie headers, the window has already been created, and a
     * boot must not wait on it. The renderer is told afterwards because the library it has just
     * fetched still has the old rows in it.
     */
    reconcileOnBoot() {
        void (0, machineRecovery_1.reconcileStaleRecordings)()
            .then((recovered) => {
            for (const one of recovered)
                console.log(`[machine] recovered a crashed recording — ${one.note}`);
            if (recovered.length)
                this.notify();
        })
            .catch((err) => console.error(`[machine] stale recording sweep failed: ${err.message}`));
    }
    /**
     * The same sweep, awaited, on the path where it decides whether a recording may start. Runs
     * only when nothing is live in this process, which the callers have already established.
     */
    async clearStaleRecordings() {
        if (!GuideSessionStore_1.guideSessionStore.hasActiveRecording())
            return;
        await (0, machineRecovery_1.reconcileStaleRecordings)().catch((err) => {
            console.error(`[machine] stale recording sweep failed: ${err.message}`);
            return [];
        });
    }
    /**
     * Why a start was refused, naming the recording that is in the way.
     *
     * Only a browser session can still be blocking by the time this is reached — the sweep above
     * has closed every machine one — and it may be genuinely live in Chrome, so the message offers
     * both readings rather than asserting the one that would be wrong half the time.
     */
    busyReason(action) {
        const open = GuideSessionStore_1.guideSessionStore.openRecordings();
        const names = open.map((row) => `“${row.title}”`).join(', ');
        if (!open.length)
            return `A recording is already running — stop it before ${action}.`;
        return `${names} ${open.length === 1 ? 'is' : 'are'} still marked as recording — stop it in the extension before ${action}, or force-stop it from the library if that recording is over.`;
    }
    /**
     * The manual way out: close a recording this app is not actually making.
     *
     * The live take goes through the ordinary stop, so the helper finalises its movie and writes
     * its own manifest with the cursor track intact — force-stopping it must not be a worse ending
     * than pressing Stop. Anything else is reconciled against what is on disk.
     */
    async forceStop(sessionId) {
        if (this.active?.sessionId === sessionId)
            await this.stop();
        const result = await (0, machineRecovery_1.recoverRecording)(sessionId);
        this.notify();
        return result;
    }
    /**
     * Start a studio recording: a continuous take of a display, a window, or a region.
     *
     * The footage is written straight to disk by ScreenCaptureKit and is **raw** — masks are only
     * descriptions until the export burns them in, so `media_state` is 'raw' and there is no path
     * from here to a file on the Maker's desktop. That is the guarantee that replaced window-only
     * scoping; see `machinePolicy.ts`.
     */
    async startStudio(options) {
        if (this.active)
            throw new Error('A machine recording is already running. Stop it before starting another.');
        await this.clearStaleRecordings();
        if (GuideSessionStore_1.guideSessionStore.hasActiveRecording())
            throw new Error(this.busyReason('recording your screen'));
        this.sweepRawMedia();
        const engine = (0, MachineHelper_1.helperAvailable)() ? 'helper' : 'chromium';
        const permission = (0, machineCapture_1.screenPermission)();
        if (!permission.usable)
            throw new Error(permission.hint ?? 'Screen recording is not permitted for 1ShowcaseTool.');
        const target = options.target;
        const sourceName = (0, machinePolicy_1.describeTarget)(target.kind, options.targetName);
        await this.assertTargetAllowed(target, options.targetName);
        const title = options.title?.trim() || sourceName;
        const sessionId = GuideSessionStore_1.guideSessionStore.create(title, { source: 'machine', targetWindow: sourceName, captureMode: 'video' });
        const mediaDir = path_1.default.join(electron_1.app.getPath('userData'), 'showcasetool', '.machine', sessionId);
        fs_1.default.mkdirSync(path_1.default.join(mediaDir, 'steps'), { recursive: true });
        const fps = options.fps === 60 ? 60 : 30;
        this.active = {
            sessionId,
            sourceId: target.kind === 'window' ? String(target.windowId) : String(target.displayId),
            sourceName,
            seq: 0,
            startedAt: new Date().toISOString(),
            pendingNote: '',
            hotkeyError: null,
            mode: 'video',
            mediaDir,
            cursor: [],
            targetKind: target.kind,
            width: 0,
            height: 0,
            systemAudio: options.systemAudio,
            microphone: options.microphone,
            paused: false,
            pausedAt: 0,
            pausedMs: 0,
            startedAtMs: Date.now(),
            stepMarks: [],
            keystrokes: [],
            engine,
        };
        this.fps = fps;
        const onStarted = {
            onStep: (step) => void this.appendHelperStep(step).catch(() => undefined),
            onCursor: (samples) => {
                if (this.active)
                    this.active.cursor.push(...samples);
            },
            onKey: (sample) => {
                if (this.active && this.active.keystrokes.length < 2000)
                    this.active.keystrokes.push(sample);
            },
            onError: (message, fatal) => {
                if (fatal)
                    void this.stop();
                else
                    console.warn(`[machine] ${message}`);
            },
        };
        try {
            const started = engine === 'helper'
                ? await MachineHelper_1.machineHelper.start({
                    target,
                    mediaDir,
                    stepDir: path_1.default.join(mediaDir, 'steps'),
                    fps,
                    systemAudio: options.systemAudio,
                    microphone: options.microphone,
                    microphoneId: options.microphoneId ?? '',
                    keyboardShortcuts: options.keyboardShortcuts === true,
                    webcam: options.webcam === true,
                }, onStarted)
                : await ChromiumRecorder_1.chromiumRecorder.start({
                    target,
                    mediaDir,
                    stepDir: path_1.default.join(mediaDir, 'steps'),
                    fps,
                    systemAudio: options.systemAudio,
                    microphone: options.microphone,
                    microphoneId: options.microphoneId ?? '',
                    webcam: options.webcam === true,
                }, onStarted);
            this.active.width = started.width;
            this.active.height = started.height;
            // The helper is the authority on what it actually got: a mic the Maker asked for but has
            // not granted comes back false, and the HUD must not claim to be recording narration.
            this.active.systemAudio = started.systemAudio;
            this.active.microphone = started.microphone;
            this.active.startedAtMs = Date.now();
        }
        catch (err) {
            /**
             * Nothing was recorded, so delete the session outright rather than stopping it.
             *
             * A stopped session with no steps and no footage is indistinguishable in the library from
             * a real recording that went wrong, and it can never become one — every downstream screen
             * would offer actions that immediately refuse. A failed start should leave no trace.
             */
            this.active = null;
            fs_1.default.rmSync(mediaDir, { recursive: true, force: true });
            GuideSessionStore_1.guideSessionStore.delete(sessionId);
            throw err;
        }
        GuideSessionStore_1.guideSessionStore.setMedia(sessionId, path_1.default.join('.machine', sessionId), 'raw');
        this.registerHotkey();
        this.openHud();
        this.notify();
        return { sessionId, hotkeyError: this.active.hotkeyError };
    }
    /**
     * Refuse a target that is showing, or sitting in front of, something that exists to display
     * secrets. A window capture is scoped by the framework, so only the target itself is checked;
     * a display or region has everything on that screen in frame, so everything on it is.
     */
    async assertTargetAllowed(target, targetName) {
        if (target.kind === 'window') {
            const blocked = (0, machinePolicy_1.blockedWindowReason)(targetName?.trim() || '');
            if (blocked)
                throw new Error(blocked);
            return;
        }
        const native = (0, MachineHelper_1.helperAvailable)() ? await MachineHelper_1.machineHelper.listSources().catch(() => null) : null;
        if (native) {
            const display = native.displays.find((item) => item.id === target.displayId);
            const bounds = target.kind === 'region'
                ? target.rect
                : display
                    ? { x: display.x, y: display.y, width: display.width, height: display.height }
                    : null;
            const visible = native.windows.filter((win) => {
                if (!bounds)
                    return true;
                return win.width > 0 && win.height > 0;
            });
            const reason = (0, machinePolicy_1.blockedOnDisplayReason)(visible.map((win) => ({ title: win.title, app: win.app })));
            if (reason)
                throw new Error(reason);
            return;
        }
        const shells = await (0, machineCapture_1.listCaptureSources)().catch(() => []);
        const reason = (0, machinePolicy_1.blockedOnDisplayReason)(shells.filter((item) => item.kind === 'window').map((item) => ({ title: item.name, app: '' })));
        if (reason)
            throw new Error(reason);
    }
    /**
     * Pause closes the current segment, so the footage the Maker paused to avoid is never written
     * to disk. Trimming one long file afterwards would have left those pixels there.
     */
    async pause() {
        const state = this.active;
        if (!state || state.mode !== 'video')
            throw new Error('No studio recording is running.');
        if (state.paused)
            return { paused: true };
        if (state.engine === 'chromium')
            await ChromiumRecorder_1.chromiumRecorder.pause();
        else
            await MachineHelper_1.machineHelper.pause();
        state.paused = true;
        state.pausedAt = Date.now();
        this.notify('status');
        return { paused: true };
    }
    async resume() {
        const state = this.active;
        if (!state || state.mode !== 'video')
            throw new Error('No studio recording is running.');
        if (!state.paused)
            return { paused: false };
        if (state.engine === 'chromium')
            await ChromiumRecorder_1.chromiumRecorder.resume();
        else
            await MachineHelper_1.machineHelper.resume();
        state.pausedMs += Date.now() - state.pausedAt;
        state.paused = false;
        state.pausedAt = 0;
        this.notify('status');
        return { paused: false };
    }
    /**
     * One click, one step — the same `CapturedStep` shape the hotkey recorder produces, so every
     * downstream service (review gate, generator, exporters, video template) is untouched.
     *
     * The one thing this has that the hotkey path never did is a real `targetRect`, taken from
     * where the pointer actually was. Machine guides stop falling back to a corner badge.
     */
    async appendHelperStep(step) {
        const state = this.active;
        if (!state)
            return;
        const file = path_1.default.join(state.mediaDir, 'steps', step.png);
        let screenshot;
        let captureError;
        try {
            screenshot = `data:image/png;base64,${await fs_1.default.promises.readFile(file, 'base64')}`;
        }
        catch (err) {
            captureError = `The frame for this step could not be read: ${err.message}`;
        }
        const windowTitle = step.windowTitle || state.sourceName;
        state.seq = Math.max(state.seq, step.seq);
        // Where this step sits on the recorded timeline, so the editor can mark it on the scrubber
        // and the Maker can jump between actions instead of hunting for them.
        state.stepMarks.push({ seq: step.seq, tMs: Math.round(step.tMs) });
        GuideSessionStore_1.guideSessionStore.appendStep(state.sessionId, {
            id: (0, crypto_1.randomUUID)(),
            seq: step.seq,
            kind: 'click',
            url: (0, machinePolicy_1.appUriFor)(windowTitle),
            urlPattern: (0, machinePolicy_1.appUriFor)(windowTitle),
            pageTitle: windowTitle,
            selectors: [],
            a11y: {},
            valueMasked: false,
            viewport: { width: 0, height: 0, dpr: 1 },
            screenshot,
            captureError,
            targetRect: step.rect,
            windowTitle,
            note: state.pendingNote,
            warnings: [],
            capturedAt: new Date().toISOString(),
        });
        state.pendingNote = '';
        this.pushToHud();
        this.notify('status');
    }
    /** True while stop() is draining the helper, so a second Stop cannot re-enter it. */
    stopping = false;
    /** Set on the way out, so the take stopped by a quit never pulls a window to the front. */
    quitting = false;
    async stop() {
        const state = this.active;
        if (this.stopping)
            return { sessionId: state?.sessionId ?? null, stepCount: state?.seq ?? 0 };
        this.stopping = true;
        electron_1.globalShortcut.unregister(exports.CAPTURE_ACCELERATOR);
        this.closeHud();
        try {
            if (state?.mode === 'video') {
                // Stopping the helper drains any screenshot a click scheduled just before Stop, so the
                // last thing the Maker did is still in the guide. `this.active` stays set through the
                // drain on purpose: appendHelperStep drops a step for a session it cannot find, and the
                // drained step is the one that finished the flow.
                const result = await (state.engine === 'chromium' ? ChromiumRecorder_1.chromiumRecorder.stop() : MachineHelper_1.machineHelper.stop()).catch(() => ({
                    steps: state.seq,
                    durationMs: this.elapsedMs(state),
                    segments: [],
                    cameraSegments: [],
                }));
                state.seq = Math.max(state.seq, result.steps);
                /**
                 * One manifest beside the footage, rather than rows in SQLite (§6). A ten-minute take is
                 * around 36 000 cursor samples — a blob to read whole or not at all — and keeping it in
                 * the recording directory means deleting the directory deletes the recording, with no
                 * orphaned rows behind it.
                 */
                const manifest = {
                    version: 1,
                    sessionId: state.sessionId,
                    createdAt: state.startedAt,
                    targetKind: state.targetKind,
                    targetName: state.sourceName,
                    width: state.width,
                    height: state.height,
                    fps: this.fps,
                    durationMs: Math.round(result.durationMs || this.elapsedMs(state)),
                    systemAudio: state.systemAudio,
                    microphone: state.microphone,
                    segments: result.segments ?? [],
                    cameraSegments: result.cameraSegments ?? [],
                    cursor: state.cursor,
                    stepMarks: state.stepMarks,
                    keystrokes: state.keystrokes,
                    engine: state.engine,
                };
                await fs_1.default.promises
                    .writeFile(path_1.default.join(state.mediaDir, 'recording.json'), JSON.stringify(manifest))
                    .catch(() => undefined);
            }
        }
        finally {
            this.active = null;
            this.stopping = false;
        }
        if (!state)
            return { sessionId: null, stepCount: 0 };
        GuideSessionStore_1.guideSessionStore.stop(state.sessionId);
        this.notify();
        this.surface();
        return { sessionId: state.sessionId, stepCount: state.seq };
    }
    /**
     * The quit path. Waits for a real stop() — the helper has to finalise its movie or the take
     * has no moov atom and is lost — but not forever: past the deadline the child is killed so
     * a hung helper cannot leave a headless process recording the screen after the app is gone.
     */
    async shutdown(deadlineMs = 8000) {
        this.quitting = true;
        if (this.active) {
            await Promise.race([
                this.stop().catch(() => undefined),
                new Promise((resolve) => setTimeout(resolve, deadlineMs)),
            ]);
        }
        // A timed-out stop leaves the session open; close the record so it never shows as a
        // recording that will not end.
        if (this.active) {
            GuideSessionStore_1.guideSessionStore.stop(this.active.sessionId);
            this.active = null;
        }
        MachineHelper_1.machineHelper.kill();
        ChromiumRecorder_1.chromiumRecorder.kill();
        electron_1.globalShortcut.unregister(exports.CAPTURE_ACCELERATOR);
        this.closeHud();
    }
    /** Called from before-quit. A session left at 'recording' never appears finished. */
    dispose() {
        this.quitting = true;
        if (this.active) {
            if (this.active.mode === 'video') {
                if (this.active.engine === 'chromium')
                    ChromiumRecorder_1.chromiumRecorder.kill();
                else
                    void MachineHelper_1.machineHelper.stop().catch(() => undefined);
            }
            GuideSessionStore_1.guideSessionStore.stop(this.active.sessionId);
            this.active = null;
        }
        electron_1.globalShortcut.unregister(exports.CAPTURE_ACCELERATOR);
        this.closeHud();
    }
    setNote(note) {
        if (this.active)
            this.active.pendingNote = typeof note === 'string' ? note.slice(0, 400) : '';
    }
    async requestCamera() {
        if (process.platform === 'darwin') {
            try {
                // The app owns the TCC grant even when the spawned native helper records the track.
                // Asking from Electron is what gives macOS the app bundle, usage description and active
                // window it needs to show the real 1ShowcaseTool camera consent prompt. A bare helper
                // executable has no Info.plist of its own and can fall straight to `denied` without UI.
                const status = electron_1.systemPreferences.getMediaAccessStatus('camera');
                if (status === 'not-determined') {
                    const ok = await electron_1.systemPreferences.askForMediaAccess('camera');
                    return ok ? 'granted' : 'denied';
                }
                return status;
            }
            catch {
                return 'unknown';
            }
        }
        // Chromium owns camera permission on the non-macOS fallback and prompts on getUserMedia.
        return 'granted';
    }
    // ---------------------------------------------------------------- capture
    async captureStep(note) {
        if (!this.active)
            throw new Error('No machine recording is running.');
        const state = this.active;
        const text = (typeof note === 'string' ? note : state.pendingNote).trim();
        /**
         * In video mode the helper owns the shutter, so the hotkey becomes an override rather than
         * the only way to get a step. It stays because click detection is a heuristic and the Maker
         * has to be able to beat it.
         */
        if (state.mode === 'video') {
            state.pendingNote = text;
            if (state.engine === 'chromium')
                ChromiumRecorder_1.chromiumRecorder.mark();
            else
                MachineHelper_1.machineHelper.mark();
            return { stepId: null, seq: state.seq, captureError: null };
        }
        return this.queue(async () => {
            // Re-read, and match by id: a stop-then-start inside the queue's wait window would
            // otherwise write this capture into the *new* session with the old window's frame.
            const current = this.active;
            if (!current || current.sessionId !== state.sessionId) {
                throw new Error('The recording stopped while that capture was waiting.');
            }
            const captured = await (0, machineCapture_1.captureWindow)(current.sourceId);
            const result = await this.appendCapture(captured, 'click', text);
            current.pendingNote = '';
            this.notify('status');
            return result;
        });
    }
    /**
     * Persist one capture. A failure is recorded *on the step* rather than thrown away — the
     * extension learned this the expensive way, and a guide missing pictures has to explain
     * itself instead of looking deliberate.
     */
    async appendCapture(captured, kind, note) {
        if (!this.active)
            throw new Error('No machine recording is running.');
        const state = this.active;
        const seq = state.seq + 1;
        state.seq = seq;
        const windowTitle = captured.ok ? captured.name : state.sourceName;
        const step = {
            id: (0, crypto_1.randomUUID)(),
            seq,
            kind,
            // A desktop window has no URL. See machinePolicy.appUriFor for why this shape.
            url: (0, machinePolicy_1.appUriFor)(windowTitle),
            urlPattern: (0, machinePolicy_1.appUriFor)(windowTitle),
            pageTitle: windowTitle,
            // No DOM, so no selectors and no accessibility anchor. This emptiness is also what makes
            // the guide inert if it ever reaches the overlay (§8, guard 3).
            selectors: [],
            a11y: {},
            valueMasked: false,
            viewport: captured.ok
                ? { width: captured.width, height: captured.height, dpr: 1 }
                : { width: 0, height: 0, dpr: 1 },
            screenshot: captured.ok ? captured.dataUri : undefined,
            captureError: captured.ok ? undefined : captured.error,
            windowTitle,
            note,
            warnings: [],
            capturedAt: new Date().toISOString(),
        };
        const stepId = GuideSessionStore_1.guideSessionStore.appendStep(state.sessionId, step);
        this.pushToHud();
        return { stepId, seq, captureError: captured.ok ? null : captured.error };
    }
    queue(task) {
        const run = this.chain.then(async () => {
            const wait = CAPTURE_MIN_INTERVAL_MS - (Date.now() - this.lastCaptureAt);
            if (wait > 0)
                await new Promise((resolve) => setTimeout(resolve, wait));
            try {
                return await task();
            }
            finally {
                this.lastCaptureAt = Date.now();
            }
        });
        // Keep the chain alive after a rejection, or every later capture inherits it.
        this.chain = run.then(() => undefined, () => undefined);
        return run;
    }
    // ---------------------------------------------------------------- hotkey + HUD
    registerHotkey() {
        if (!this.active)
            return;
        try {
            const registered = electron_1.globalShortcut.register(exports.CAPTURE_ACCELERATOR, () => {
                void this.captureStep().catch((err) => {
                    // The Maker pressed the hotkey and got nothing — the HUD's foot has to say why, or
                    // they keep recording a guide that is quietly missing steps.
                    if (this.active) {
                        this.active.hotkeyError = err.message;
                        this.pushToHud();
                    }
                });
            });
            this.active.hotkeyError = registered ? null : `${exports.CAPTURE_ACCELERATOR} is already taken by another app — use the Capture button instead.`;
        }
        catch (err) {
            this.active.hotkeyError = `${err.message} — use the Capture button instead.`;
        }
    }
    /**
     * The HUD is how the Maker captures and stops without switching back to the app window,
     * which matters because switching windows is itself a change to what is on screen.
     *
     * `setContentProtection(true)` is the load-bearing line: without it, a tutorial recorded of
     * any window that overlaps the HUD has the recording HUD in the frame.
     */
    openHud() {
        if (this.hud && !this.hud.isDestroyed())
            return;
        const hud = new electron_1.BrowserWindow({
            /**
             * One row and a line of text under it. It was three stacked rows, and this window sits on
             * top of the thing being recorded — every pixel of it is a pixel of the Maker's work it is
             * covering, so it is sized to the bar rather than to what fits comfortably.
             *
             * Transparent, because the bar has rounded corners: an opaque frameless window paints its
             * own colour into the corners the radius cuts away. The window is kept only a few pixels
             * bigger than the pill for the same reason it is small at all — transparent pixels still
             * take the click, so a generous invisible margin is a hole punched in whatever is beneath.
             */
            width: 440,
            height: 82,
            resizable: false,
            frame: false,
            transparent: true,
            backgroundColor: '#00000000',
            // The pill draws its own; the platform's would be a rectangle around the transparent frame.
            hasShadow: false,
            alwaysOnTop: true,
            skipTaskbar: true,
            fullscreenable: false,
            minimizable: false,
            maximizable: false,
            title: '1ShowcaseTool recording',
            webPreferences: {
                preload: path_1.default.join(__dirname, '../preload.js'),
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
            },
        });
        hud.setAlwaysOnTop(true, 'screen-saver');
        hud.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        hud.setContentProtection(true);
        /**
         * The HUD is the same renderer bundle behind a hash route rather than a second Vite entry
         * point — one bundle, one build config, and `main.tsx` picks the root component.
         */
        // The dev port is whichever one Vite could get, resolved once at startup — never assumed here.
        const devUrl = (0, devServer_1.devServerUrl)('hud');
        if (devUrl) {
            void hud.loadURL(devUrl).catch(() => void hud.loadFile(this.rendererFile(), { hash: 'hud' }));
        }
        else {
            void hud.loadFile(this.rendererFile(), { hash: 'hud' });
        }
        hud.on('closed', () => {
            this.hud = null;
            // Closing the HUD is the same intent as pressing Stop; leaving the session open would
            // strand it at 'recording' with no visible way to end it.
            if (this.active)
                void this.stop();
        });
        this.hud = hud;
    }
    closeHud() {
        const hud = this.hud;
        this.hud = null;
        if (hud && !hud.isDestroyed())
            hud.destroy();
    }
    rendererFile() {
        // __dirname is dist-electron/electron/showcasetool once compiled.
        return path_1.default.join(__dirname, '../../../dist-renderer/index.html');
    }
    // ---------------------------------------------------------------- events
    /**
     * Bring the app forward when a take ends, so the screen it routes the take to is one the Maker
     * is actually looking at. Stop is pressed on the floating bar, and while recording that bar is
     * usually the only part of this app on screen.
     *
     * Skipped on the way out: `shutdown` stops an in-flight take as the app quits.
     */
    surface() {
        if (this.quitting)
            return;
        (0, appWindow_1.surfaceAppWindow)();
    }
    pushToHud() {
        if (this.hud && !this.hud.isDestroyed()) {
            this.hud.webContents.send(channels_1.CHANNELS.events.machineChanged, this.status());
        }
    }
    /**
     * Both the app window and the HUD render from this, so they cannot disagree.
     *
     * `sessionsChanged` only when the library's contents actually changed — start and stop.
     * A pause, a resume or one appended step is machine state, and broadcasting it as a library
     * change made the renderer reload the entire session and guide list once per captured click.
     */
    notify(scope = 'library') {
        const status = this.status();
        for (const window of electron_1.BrowserWindow.getAllWindows()) {
            if (window.isDestroyed())
                continue;
            window.webContents.send(channels_1.CHANNELS.events.machineChanged, status);
        }
        if (scope !== 'library')
            return;
        for (const window of electron_1.BrowserWindow.getAllWindows()) {
            if (!window.isDestroyed())
                window.webContents.send(channels_1.CHANNELS.events.sessionsChanged);
        }
    }
}
exports.MachineRecorderService = MachineRecorderService;
exports.machineRecorder = new MachineRecorderService();
//# sourceMappingURL=MachineRecorderService.js.map