"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.chromiumRecorder = exports.ChromiumRecorder = void 0;
exports.registerChromiumRecorder = registerChromiumRecorder;
const child_process_1 = require("child_process");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const util_1 = require("util");
const electron_1 = require("electron");
const channels_1 = require("../ipc/channels");
const devServer_1 = require("../devServer");
const machineCapture_1 = require("./machineCapture");
const wavAudio_1 = require("./wavAudio");
/**
 * Studio video on Windows and Linux (and on a Mac that has no Swift helper).
 *
 * ScreenCaptureKit is Darwin-only. Here a hidden renderer window records through
 * `desktopCapturer` + `MediaRecorder` to WebM, a sidecar WAV carries speech for compose
 * and loudness, and the cursor is polled with `screen.getCursorScreenPoint`. Clicks are
 * not hooked — PRD §5 refused input hooks — so steps come from the HUD mark, the same
 * override the helper already has.
 *
 * Pause still closes a segment. The pixels the Maker paused to avoid are never written.
 */
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
let ipcWired = false;
function registerChromiumRecorder() {
    if (ipcWired)
        return;
    ipcWired = true;
    electron_1.ipcMain.on(channels_1.CHANNELS.capture.event, (_event, payload) => {
        void exports.chromiumRecorder.handleEvent(payload);
    });
}
class ChromiumRecorder {
    win = null;
    handlers = null;
    mediaDir = '';
    stepDir = '';
    fps = 30;
    target = null;
    frame = { x: 0, y: 0, width: 1, height: 1 };
    sourceId = '';
    crop = null;
    width = 0;
    height = 0;
    systemAudio = false;
    microphone = false;
    webcam = false;
    microphoneId = '';
    startedAtMs = 0;
    pausedMs = 0;
    pausedAt = 0;
    paused = false;
    segments = [];
    cameraSegments = [];
    screenIndex = -1;
    cameraIndex = -1;
    screenStream = null;
    cameraStream = null;
    screenOpenedAt = 0;
    cameraOpenedAt = 0;
    pcm = [];
    pcmSampleRate = 48000;
    cursorTimer = null;
    boundsTimer = null;
    pendingStart = null;
    pendingStop = null;
    seq = 0;
    lastCursor = null;
    get running() {
        return this.win !== null && !this.win.isDestroyed();
    }
    async start(options, handlers) {
        if (this.running)
            throw new Error('A Chromium recorder is already running.');
        this.reset();
        this.handlers = handlers;
        this.mediaDir = options.mediaDir;
        this.stepDir = options.stepDir;
        this.fps = options.fps === 60 ? 60 : 30;
        this.target = options.target;
        this.systemAudio = options.systemAudio;
        this.microphone = options.microphone;
        this.microphoneId = options.microphoneId;
        this.webcam = options.webcam === true;
        const resolved = await resolveSource(options.target);
        this.sourceId = resolved.sourceId;
        this.frame = resolved.frame;
        this.crop = resolved.crop;
        this.width = resolved.width;
        this.height = resolved.height;
        fs_1.default.mkdirSync(this.mediaDir, { recursive: true });
        fs_1.default.mkdirSync(this.stepDir, { recursive: true });
        const win = new electron_1.BrowserWindow({
            width: 8,
            height: 8,
            show: false,
            frame: false,
            skipTaskbar: true,
            fullscreenable: false,
            title: '1ShowcaseTool capture',
            webPreferences: {
                preload: path_1.default.join(__dirname, '../preload.js'),
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
            },
        });
        win.setContentProtection(true);
        this.win = win;
        const started = new Promise((resolve, reject) => {
            this.pendingStart = { resolve, reject };
            setTimeout(() => {
                if (this.pendingStart) {
                    this.pendingStart = null;
                    reject(new Error('The capture window did not start recording.'));
                }
            }, 20_000);
        });
        const devUrl = (0, devServer_1.devServerUrl)('capture');
        if (devUrl) {
            await win.loadURL(devUrl).catch(() => win.loadFile(this.rendererFile(), { hash: 'capture' }));
        }
        else {
            await win.loadFile(this.rendererFile(), { hash: 'capture' });
        }
        win.webContents.once('did-finish-load', () => {
            this.send({
                cmd: 'start',
                sourceId: this.sourceId,
                fps: this.fps,
                systemAudio: this.systemAudio,
                microphone: this.microphone,
                microphoneId: this.microphoneId,
                webcam: this.webcam,
                crop: this.crop,
            });
        });
        win.on('closed', () => {
            this.win = null;
            if (this.pendingStart) {
                this.pendingStart.reject(new Error('The capture window closed before recording started.'));
                this.pendingStart = null;
            }
        });
        try {
            return await started;
        }
        catch (err) {
            this.kill();
            throw err;
        }
    }
    async pause() {
        if (!this.running || this.paused)
            return;
        this.paused = true;
        this.pausedAt = Date.now();
        this.stopCursor();
        this.send({ cmd: 'pause' });
    }
    async resume() {
        if (!this.running || !this.paused)
            return;
        this.pausedMs += Date.now() - this.pausedAt;
        this.paused = false;
        this.pausedAt = 0;
        this.send({ cmd: 'resume' });
        this.startCursor();
    }
    mark() {
        if (!this.running || this.paused)
            return;
        this.seq += 1;
        this.send({ cmd: 'mark', seq: this.seq });
    }
    async stop() {
        if (!this.running) {
            return { steps: this.seq, durationMs: this.elapsedMs(), segments: this.segments, cameraSegments: this.cameraSegments };
        }
        const done = new Promise((resolve) => {
            this.pendingStop = { resolve };
            setTimeout(() => {
                if (this.pendingStop) {
                    this.pendingStop = null;
                    resolve(this.finishStop());
                }
            }, 12_000);
        });
        this.send({ cmd: 'stop' });
        return done;
    }
    kill() {
        this.stopCursor();
        this.closeStreams();
        const win = this.win;
        this.win = null;
        if (win && !win.isDestroyed())
            win.destroy();
        this.pendingStart?.reject(new Error('The recorder was stopped.'));
        this.pendingStart = null;
        if (this.pendingStop) {
            this.pendingStop.resolve(this.finishStop());
            this.pendingStop = null;
        }
        this.handlers = null;
    }
    handleEvent(event) {
        if (event.ev === 'ready') {
            this.width = event.width || this.width;
            this.height = event.height || this.height;
            this.systemAudio = event.systemAudio;
            this.microphone = event.microphone;
            this.startedAtMs = Date.now();
            this.startCursor();
            this.startBoundsWatch();
            this.pendingStart?.resolve({
                t0: this.startedAtMs,
                recordingVideo: true,
                width: this.width,
                height: this.height,
                scale: 1,
                frame: this.frame,
                systemAudio: this.systemAudio,
                microphone: this.microphone,
                windowTitle: '',
            });
            this.pendingStart = null;
            return;
        }
        if (event.ev === 'chunk') {
            const bytes = Buffer.from(new Uint8Array(event.bytes));
            if (event.kind === 'camera') {
                this.ensureCameraStream();
                this.cameraStream?.write(bytes);
            }
            else {
                this.ensureScreenStream();
                this.screenStream?.write(bytes);
            }
            return;
        }
        if (event.ev === 'pcm') {
            if (this.paused)
                return;
            const bytes = Buffer.from(new Uint8Array(event.bytes));
            this.pcm.push(bytes);
            if (event.sampleRate && event.sampleRate > 0)
                this.pcmSampleRate = event.sampleRate;
            return;
        }
        if (event.ev === 'segment-closed') {
            if (event.kind === 'camera')
                this.closeCameraSegment(event.durationMs);
            else
                this.closeScreenSegment(event.durationMs);
            return;
        }
        if (event.ev === 'frame') {
            void this.writeStep(event);
            return;
        }
        if (event.ev === 'error') {
            this.handlers?.onError?.(event.message, event.fatal === true);
            if (event.fatal) {
                this.pendingStart?.reject(new Error(event.message));
                this.pendingStart = null;
            }
            return;
        }
        if (event.ev === 'stopped') {
            if (this.pendingStop) {
                this.pendingStop.resolve(this.finishStop(event.durationMs));
                this.pendingStop = null;
            }
            else {
                this.finishStop(event.durationMs);
            }
        }
    }
    finishStop(reportedMs) {
        this.stopCursor();
        this.closeScreenSegment();
        this.closeCameraSegment();
        this.writeSpeechWav();
        const win = this.win;
        this.win = null;
        if (win && !win.isDestroyed())
            win.destroy();
        const durationMs = Math.round(reportedMs && reportedMs > 0 ? reportedMs : this.elapsedMs());
        const result = {
            steps: this.seq,
            durationMs,
            segments: this.segments,
            cameraSegments: this.cameraSegments,
        };
        this.handlers = null;
        return result;
    }
    writeSpeechWav() {
        if (!this.pcm.length)
            return;
        const pcm = Buffer.concat(this.pcm);
        const samples = new Float32Array(pcm.length / 2);
        for (let i = 0; i < samples.length; i += 1)
            samples[i] = pcm.readInt16LE(i * 2) / 0x8000;
        const wav = (0, wavAudio_1.writeWav)(samples, this.pcmSampleRate, 1);
        fs_1.default.writeFileSync(path_1.default.join(this.mediaDir, 'speech.wav'), wav);
        this.pcm = [];
    }
    ensureScreenStream() {
        if (this.screenStream)
            return;
        this.screenIndex += 1;
        const file = `segment-${String(this.screenIndex).padStart(3, '0')}.webm`;
        this.screenStream = fs_1.default.createWriteStream(path_1.default.join(this.mediaDir, file));
        this.screenOpenedAt = Date.now();
        const startMs = this.elapsedMs();
        this.segments.push({ file, startMs, durationMs: 0 });
    }
    ensureCameraStream() {
        if (this.cameraStream)
            return;
        this.cameraIndex += 1;
        const file = `camera-${String(this.cameraIndex).padStart(3, '0')}.webm`;
        this.cameraStream = fs_1.default.createWriteStream(path_1.default.join(this.mediaDir, file));
        this.cameraOpenedAt = Date.now();
        this.cameraSegments.push({ file, startMs: this.elapsedMs(), durationMs: 0 });
    }
    closeScreenSegment(durationMs) {
        if (!this.screenStream)
            return;
        this.screenStream.end();
        this.screenStream = null;
        const last = this.segments[this.segments.length - 1];
        if (last) {
            last.durationMs = Math.max(1, Math.round(durationMs ?? Date.now() - this.screenOpenedAt));
        }
    }
    closeCameraSegment(durationMs) {
        if (!this.cameraStream)
            return;
        this.cameraStream.end();
        this.cameraStream = null;
        const last = this.cameraSegments[this.cameraSegments.length - 1];
        if (last) {
            last.durationMs = Math.max(1, Math.round(durationMs ?? Date.now() - this.cameraOpenedAt));
        }
    }
    closeStreams() {
        this.closeScreenSegment();
        this.closeCameraSegment();
    }
    async writeStep(event) {
        const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(event.png);
        if (!match)
            return;
        const name = `step-${String(event.seq).padStart(3, '0')}.png`;
        await fs_1.default.promises.writeFile(path_1.default.join(this.stepDir, name), Buffer.from(match[1], 'base64'));
        const cursor = this.lastCursor;
        const x = cursor ? cursor[1] : 0.5;
        const y = cursor ? cursor[2] : 0.5;
        this.handlers?.onStep?.({
            seq: event.seq,
            tMs: this.elapsedMs(),
            png: name,
            rect: {
                x: Math.max(0, Math.min(0.92, x - 0.04)),
                y: Math.max(0, Math.min(0.92, y - 0.04)),
                width: 0.08,
                height: 0.08,
            },
            windowTitle: '',
        });
    }
    startCursor() {
        this.stopCursor();
        const interval = Math.max(16, Math.round(1000 / this.fps));
        this.cursorTimer = setInterval(() => {
            if (this.paused)
                return;
            const point = electron_1.screen.getCursorScreenPoint();
            const x = (point.x - this.frame.x) / Math.max(1, this.frame.width);
            const y = (point.y - this.frame.y) / Math.max(1, this.frame.height);
            const sample = [
                this.elapsedMs(),
                Math.max(0, Math.min(1, x)),
                Math.max(0, Math.min(1, y)),
                0,
            ];
            this.lastCursor = sample;
            this.handlers?.onCursor?.([sample]);
        }, interval);
    }
    startBoundsWatch() {
        if (this.boundsTimer)
            clearInterval(this.boundsTimer);
        if (this.target?.kind !== 'window')
            return;
        const windowId = this.target.windowId;
        const tick = () => {
            void windowFrame(windowId).then((next) => {
                if (next)
                    this.frame = next;
            });
        };
        tick();
        this.boundsTimer = setInterval(tick, 2000);
    }
    stopCursor() {
        if (this.cursorTimer)
            clearInterval(this.cursorTimer);
        this.cursorTimer = null;
        if (this.boundsTimer)
            clearInterval(this.boundsTimer);
        this.boundsTimer = null;
    }
    elapsedMs() {
        if (!this.startedAtMs)
            return 0;
        const paused = this.paused ? this.pausedMs + (Date.now() - this.pausedAt) : this.pausedMs;
        return Math.max(0, Date.now() - this.startedAtMs - paused);
    }
    send(command) {
        if (this.win && !this.win.isDestroyed())
            this.win.webContents.send(channels_1.CHANNELS.capture.command, command);
    }
    rendererFile() {
        return path_1.default.join(__dirname, '../../../dist-renderer/index.html');
    }
    reset() {
        this.handlers = null;
        this.segments = [];
        this.cameraSegments = [];
        this.screenIndex = -1;
        this.cameraIndex = -1;
        this.pcm = [];
        this.seq = 0;
        this.paused = false;
        this.pausedMs = 0;
        this.pausedAt = 0;
        this.startedAtMs = 0;
        this.lastCursor = null;
    }
}
exports.ChromiumRecorder = ChromiumRecorder;
exports.chromiumRecorder = new ChromiumRecorder();
async function resolveSource(target) {
    const shells = await (0, machineCapture_1.listCaptureSources)();
    if (target.kind === 'window') {
        const shell = shells.find((item) => item.kind === 'window' && item.nativeId === target.windowId);
        if (!shell)
            throw new Error('That window is no longer available to record.');
        const frame = (await windowFrame(target.windowId)) ?? { x: 0, y: 0, width: 1280, height: 800 };
        return { sourceId: shell.sourceId, frame, crop: null, width: frame.width, height: frame.height };
    }
    const display = electron_1.screen.getAllDisplays().find((item) => item.id === target.displayId) ?? electron_1.screen.getPrimaryDisplay();
    const scale = display.scaleFactor || 1;
    const shell = shells.find((item) => item.kind === 'display' &&
        (item.displayId === String(display.id) || item.nativeId === display.id || item.nativeId === target.displayId)) ?? shells.find((item) => item.kind === 'display');
    if (!shell)
        throw new Error('That display is no longer available to record.');
    const frame = {
        x: display.bounds.x,
        y: display.bounds.y,
        width: display.bounds.width,
        height: display.bounds.height,
    };
    if (target.kind === 'region') {
        const crop = {
            x: Math.max(0, Math.round((target.rect.x - display.bounds.x) * scale)),
            y: Math.max(0, Math.round((target.rect.y - display.bounds.y) * scale)),
            width: Math.max(16, Math.round(target.rect.width * scale)),
            height: Math.max(16, Math.round(target.rect.height * scale)),
        };
        return {
            sourceId: shell.sourceId,
            frame: { x: target.rect.x, y: target.rect.y, width: target.rect.width, height: target.rect.height },
            crop,
            width: crop.width,
            height: crop.height,
        };
    }
    return {
        sourceId: shell.sourceId,
        frame,
        crop: null,
        width: Math.round(display.size.width * scale),
        height: Math.round(display.size.height * scale),
    };
}
async function windowFrame(windowId) {
    if (process.platform === 'win32')
        return windowsWindowRect(windowId);
    return null;
}
async function windowsWindowRect(hwnd) {
    if (!Number.isFinite(hwnd) || hwnd <= 0)
        return null;
    try {
        const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  public struct R { public int L; public int T; public int Right; public int B; }
}
"@
$r = New-Object W+R
if (-not [W]::GetWindowRect([IntPtr]${Math.round(hwnd)}, [ref]$r)) { exit 1 }
Write-Output "$($r.L) $($r.T) $($r.Right) $($r.B)"
`;
        const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script], { timeout: 2500 });
        const parts = stdout.trim().split(/\s+/).map(Number);
        if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n)))
            return null;
        const [left, top, right, bottom] = parts;
        const physical = { x: left, y: top, width: right - left, height: bottom - top };
        if (physical.width < 16 || physical.height < 16)
            return null;
        const display = electron_1.screen.getDisplayMatching(physical);
        const scale = display.scaleFactor || 1;
        return {
            x: physical.x / scale,
            y: physical.y / scale,
            width: physical.width / scale,
            height: physical.height / scale,
        };
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=ChromiumRecorder.js.map