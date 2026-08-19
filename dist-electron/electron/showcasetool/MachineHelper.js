"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.machineHelper = exports.MachineHelper = void 0;
exports.helperPath = helperPath;
exports.helperAvailable = helperAvailable;
exports.readHelperRecord = readHelperRecord;
exports.clearHelperRecord = clearHelperRecord;
exports.killOrphanHelper = killOrphanHelper;
const child_process_1 = require("child_process");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const electron_1 = require("electron");
const LIST_TIMEOUT_MS = 8000;
/** A long take's audio takes real time to decode and re-encode; a 4K hour would exceed this. */
const COMPOSE_TIMEOUT_MS = 15 * 60 * 1000;
/**
 * Where the compiled helper lives. Packaged it is an `extraResources` entry rather than an asar
 * member, because an executable inside an archive cannot be exec'd.
 */
function helperPath() {
    const candidates = electron_1.app.isPackaged
        ? [path_1.default.join(process.resourcesPath, 'helpers', 'gt-recorder')]
        : [path_1.default.join(__dirname, '..', '..', 'helpers', 'gt-recorder')];
    for (const candidate of candidates) {
        if (fs_1.default.existsSync(candidate))
            return candidate;
    }
    return null;
}
/** Whether native recording can be offered at all. Never throws — the UI asks this to decide. */
function helperAvailable() {
    return process.platform === 'darwin' && helperPath() !== null;
}
function helperRecordFile() {
    return path_1.default.join(electron_1.app.getPath('userData'), 'showcasetool', '.machine', 'helper.json');
}
function readHelperRecord() {
    try {
        const parsed = JSON.parse(fs_1.default.readFileSync(helperRecordFile(), 'utf8'));
        if (typeof parsed?.pid !== 'number' || parsed.pid <= 1)
            return null;
        return { pid: parsed.pid, mediaDir: String(parsed.mediaDir ?? ''), startedAt: String(parsed.startedAt ?? '') };
    }
    catch {
        return null;
    }
}
function writeHelperRecord(record) {
    try {
        fs_1.default.mkdirSync(path_1.default.dirname(helperRecordFile()), { recursive: true });
        fs_1.default.writeFileSync(helperRecordFile(), JSON.stringify(record));
    }
    catch {
        // Losing the record costs a manual force-stop later; it must never cost the recording.
    }
}
function clearHelperRecord(pid) {
    const record = readHelperRecord();
    if (!record)
        return;
    if (pid !== undefined && record.pid !== pid)
        return;
    try {
        fs_1.default.rmSync(helperRecordFile(), { force: true });
    }
    catch {
        /* the next launch will find a dead pid and clear it then */
    }
}
/**
 * Is this pid still one of our helpers?
 *
 * A pid is reused, and the recorded one belongs to a process that died in a crash — signalling
 * it on the strength of the number alone would eventually kill whatever inherited it. `ps` is
 * read-only, costs nothing, and is the only way to ask macOS what a pid is running from without
 * a native module. A name we cannot read is treated as "not ours": leaving a stranger alone is
 * always the right side to fail on.
 */
async function isOurHelper(pid) {
    const binary = helperPath();
    if (!binary)
        return false;
    const comm = await new Promise((resolve) => {
        // Asynchronous because this runs on the main process's thread at launch, and a blocked main
        // process is a window that has not painted yet.
        (0, child_process_1.execFile)('/bin/ps', ['-p', String(pid), '-o', 'comm='], { timeout: 4000 }, (err, stdout) => resolve(err ? '' : String(stdout).trim()));
    });
    if (!comm)
        return false;
    return comm === binary || path_1.default.basename(comm) === path_1.default.basename(binary);
}
const ORPHAN_TERM_WAIT_MS = 6000;
/**
 * End a helper a previous run left behind, and wait for it to actually be gone.
 *
 * SIGTERM first, and the helper handles it by finalising the movie — a `.mov` killed before its
 * `moov` atom is written cannot be opened by anything, so the tidy-up would otherwise destroy
 * the take it is tidying up after. SIGKILL only once the polite ask has run out of time, since
 * an orphan still holding the screen is worse than a lost segment.
 *
 * Waiting matters as much as killing: the caller reads those segment files immediately
 * afterwards to rebuild the manifest, and a writer still finalising has not written the header
 * that read depends on.
 */
async function killOrphanHelper() {
    const record = readHelperRecord();
    if (!record)
        return null;
    if (!(await isOurHelper(record.pid))) {
        clearHelperRecord(record.pid);
        return null;
    }
    const alive = () => {
        try {
            process.kill(record.pid, 0);
            return true;
        }
        catch {
            return false;
        }
    };
    let hard = false;
    try {
        process.kill(record.pid, 'SIGTERM');
    }
    catch {
        clearHelperRecord(record.pid);
        return null;
    }
    const deadline = Date.now() + ORPHAN_TERM_WAIT_MS;
    while (Date.now() < deadline && alive()) {
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (alive()) {
        hard = true;
        try {
            process.kill(record.pid, 'SIGKILL');
        }
        catch {
            /* it exited between the check and the signal */
        }
        // A killed process is reaped by launchd, not by us, so poll rather than assume.
        for (let i = 0; i < 10 && alive(); i += 1)
            await new Promise((resolve) => setTimeout(resolve, 100));
    }
    clearHelperRecord(record.pid);
    return { pid: record.pid, mediaDir: record.mediaDir, killed: true, hard };
}
/** Translate the wire target into the flat keys the Swift side parses. */
function targetPayload(target) {
    if (target.kind === 'window')
        return { targetKind: 'window', windowID: target.windowId };
    if (target.kind === 'display')
        return { targetKind: 'display', displayID: target.displayId };
    return { targetKind: 'region', displayID: target.displayId, rect: target.rect };
}
class MachineHelper {
    child = null;
    buffer = '';
    handlers = {};
    waiters = new Map();
    capabilities = null;
    /** Serialises the short-lived helper calls; see `oneShot`. */
    queue = Promise.resolve();
    spawnHelper() {
        const binary = helperPath();
        if (!binary)
            throw new Error('The native recorder is not installed in this build.');
        const child = (0, child_process_1.spawn)(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (chunk) => this.consume(chunk));
        /**
         * Keep the last of stderr. A Swift crash — a trap, a missing framework, a signal — writes
         * there and then the process is gone, so without this the only symptom is "the helper
         * stopped unexpectedly", which says nothing anyone can act on.
         */
        let stderr = '';
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk) => {
            stderr = `${stderr}${chunk}`.slice(-2000);
        });
        /**
         * The child and each of its three streams are EventEmitters, and an unhandled `'error'` event
         * is *rethrown* by Node. In the main process that ends the whole app — and because it is a
         * clean `exit(1)` rather than a signal, macOS files no crash report, so the only evidence is
         * a stack on a terminal nobody was watching. An app that vanishes mid-take with nothing left
         * behind is the worst shape a bug can have.
         *
         * The helper dying is a normal event, not an exceptional one. It aborts on a window-server
         * assert, `oneShot` kills it by design, macOS's capture service wedges it, a compose on a long
         * take is reaped. None of that should be able to end a recording session, let alone one the
         * Maker has spent ten minutes on.
         *
         * Measured, so the next reader does not have to re-derive it: an unhandled `'error'` on the
         * **child** is reliably fatal — a missing binary (ENOENT) or one that lost its executable bit
         * (EACCES) kills the process on the spot. The **stream** listeners are belt-and-braces: an
         * EPIPE from writing into a dead helper did *not* reproduce a crash on macOS, so treat them as
         * cheap insurance against a path that has not been proven rather than a fix for one that has.
         */
        const collapse = (message) => {
            // Only the *current* child's death is news — same identity check as `exit` below.
            if (this.child !== child)
                return;
            this.child = null;
            console.error(`[machine] ${message}`);
            for (const [, waiter] of this.waiters)
                waiter.reject(new Error(message));
            this.waiters.clear();
            this.handlers.onError?.(message, true);
        };
        /**
         * `'error'` on the child itself means it never ran: ENOENT for a build with no helper, EACCES
         * for one that lost its executable bit. `'exit'` does *not* follow a failed spawn, so this is
         * the only chance to answer whoever is waiting — without it they wait out the full timeout.
         */
        child.on('error', (err) => collapse(`The recorder helper could not be started (${err.message}).`));
        /**
         * A stream error needs no report of its own: `exit` follows and carries the captured stderr,
         * which says something useful about *why*. These exist only so the event has a listener.
         */
        child.stdin?.on('error', () => undefined);
        child.stdout?.on('error', () => undefined);
        child.stderr?.on('error', () => undefined);
        child.on('exit', (code, signal) => {
            /**
             * Only the *current* child's death is news.
             *
             * `oneShot` kills its child and clears the field synchronously, then lets the next queued
             * call spawn a replacement — and the dead process's `exit` event arrives after that. The
             * waiter map is shared, so without this identity check the old child's exit rejects the
             * *new* call's waiter with "the recorder helper stopped unexpectedly", and the caller
             * concludes the machine cannot record. That is how the setup screen came to disable region
             * capture and audio on a machine that supports both.
             */
            if (this.child !== child)
                return;
            const detail = [
                signal ? `signal ${signal}` : code === null ? '' : `exit code ${code}`,
                stderr.trim().split('\n').slice(-3).join(' · '),
            ]
                .filter(Boolean)
                .join(' — ');
            const message = detail ? `The recorder helper stopped unexpectedly (${detail}).` : 'The recorder helper stopped unexpectedly.';
            if (detail)
                console.error(`[machine] ${message}`);
            // Anything still waiting will never be answered now.
            for (const [, waiter] of this.waiters)
                waiter.reject(new Error(message));
            this.waiters.clear();
            this.child = null;
            // A helper that ended by itself is nobody's orphan. Only its own record is dropped: a
            // `oneShot` child exiting must not erase the record of a recording that is still running.
            if (child.pid)
                clearHelperRecord(child.pid);
        });
        return child;
    }
    consume(chunk) {
        this.buffer += chunk;
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() ?? '';
        for (const line of lines) {
            if (!line.trim())
                continue;
            let event;
            try {
                event = JSON.parse(line);
            }
            catch {
                continue; // A malformed line is not worth killing a recording over.
            }
            this.dispatch(event);
        }
    }
    dispatch(event) {
        const name = String(event.ev ?? '');
        if (name === 'step')
            this.handlers.onStep?.(event);
        else if (name === 'cursor')
            this.handlers.onCursor?.(event.samples ?? []);
        else if (name === 'key') {
            // The helper only emits a chord (a key with ⌘/⌃/⌥ held), never bare text — see the tap in
            // the Swift helper. Keys are display tokens already; treat anything malformed as nothing.
            const keys = Array.isArray(event.keys) ? event.keys.filter((k) => typeof k === 'string') : [];
            if (keys.length)
                this.handlers.onKey?.({ tMs: Number(event.tMs) || 0, keys });
        }
        else if (name === 'error') {
            const message = String(event.message ?? 'The recorder helper failed.');
            const fatal = event.fatal === true;
            /**
             * A fatal error has to reject whoever is waiting, or `start` hangs until its timeout —
             * but never the `stopped` reply. Stopping must always succeed from the app's point of
             * view: whatever went wrong, the helper has already written what it wrote, and rejecting
             * here threw away the segment list of a recording that was perfectly fine.
             */
            if (fatal)
                this.settle(new Error(message), 'stopped');
            this.handlers.onError?.(message, fatal);
            return;
        }
        const waiter = this.waiters.get(name);
        if (waiter) {
            this.waiters.delete(name);
            waiter.resolve(event);
        }
    }
    settle(error, except) {
        for (const [name, waiter] of this.waiters) {
            if (name === except)
                continue;
            waiter.reject(error);
            this.waiters.delete(name);
        }
    }
    /**
     * One waiter per event name. Each waiter only ever removes *itself*: the timeout used to do a
     * bare delete-by-name, so two concurrent calls for the same event had the first call's timer
     * silently cancelling the second call's waiter — "did not answer in time" from a helper that
     * had answered. A waiter displaced by a newer call for the same event is rejected on the spot
     * rather than left dangling until its timer fires.
     */
    await(event, timeoutMs) {
        return new Promise((resolve, reject) => {
            const waiter = {
                resolve: ((value) => {
                    clearTimeout(timer);
                    resolve(value);
                }),
                reject: (err) => {
                    clearTimeout(timer);
                    reject(err);
                },
            };
            const timer = setTimeout(() => {
                if (this.waiters.get(event) === waiter)
                    this.waiters.delete(event);
                reject(new Error(`The recorder helper did not answer in time (${event}).`));
            }, timeoutMs);
            const displaced = this.waiters.get(event);
            if (displaced)
                displaced.reject(new Error(`superseded by a newer ${event} request`));
            this.waiters.set(event, waiter);
        });
    }
    /**
     * A command is a best-effort write. The `writable` check skips the obvious dead pipe, the
     * callback absorbs the race that the check cannot see — the helper can exit between the two —
     * and `stdin`'s `'error'` listener catches what is left. All three, because losing a `mark`
     * matters far less than taking the app down with it.
     */
    send(payload) {
        const stdin = this.child?.stdin;
        if (!stdin || stdin.destroyed || !stdin.writable)
            return;
        try {
            stdin.write(`${JSON.stringify(payload)}\n`, () => undefined);
        }
        catch {
            // The helper is gone; `exit` reports it with the stderr that explains why.
        }
    }
    /**
     * Run one command in a short-lived process: spawn, ask, answer, exit.
     *
     * **Serialised**, because there is one `child` field and one waiter map. The setup screen asks
     * for sources, capabilities and status in a single `Promise.all`, and without this queue the
     * second call would find `child` already set and throw — which the caller reports as "this
     * build cannot record", disabling the whole feature over a race. That failure is silent and
     * plausible, which is the worst combination.
     */
    oneShot(command, event, timeoutMs) {
        const run = this.queue.then(async () => {
            if (this.child)
                throw new Error('A recording is running; stop it first.');
            this.child = this.spawnHelper();
            try {
                const pending = this.await(event, timeoutMs);
                this.send(command);
                return await pending;
            }
            finally {
                this.send({ cmd: 'quit' });
                this.child?.kill();
                this.child = null;
            }
        });
        // Keep the queue alive after a rejection, or every later call inherits it.
        this.queue = run.then(() => undefined, () => undefined);
        return run;
    }
    /**
     * What this machine can do, cached for the process lifetime.
     *
     * `ping` deliberately touches no capture API, so this answers even when Screen Recording has
     * never been granted — which is exactly when the UI most needs to know what to offer.
     */
    async probe() {
        if (this.capabilities)
            return this.capabilities;
        if (!helperAvailable()) {
            return {
                macos: '',
                features: { video: false, microphone: false, systemAudio: false, region: false, pause: false, webcam: false },
                micPermission: 'unknown',
                accessibility: 'unknown',
            };
        }
        const result = await this.oneShot({ cmd: 'ping' }, 'pong', LIST_TIMEOUT_MS);
        this.capabilities = {
            macos: result.macos ?? '',
            features: {
                video: result.features?.video === true,
                microphone: result.features?.microphone === true,
                systemAudio: result.features?.systemAudio === true,
                region: result.features?.region === true,
                pause: result.features?.pause === true,
                webcam: result.features?.webcam === true,
            },
            micPermission: (result.micPermission ?? 'unknown'),
            accessibility: result.accessibility ?? 'unknown',
        };
        return this.capabilities;
    }
    /** Everything pointable, in one answer: displays, windows and audio inputs. */
    async listSources() {
        const result = await this.oneShot({ cmd: 'list-sources' }, 'sources', LIST_TIMEOUT_MS);
        return { displays: result.displays ?? [], windows: result.windows ?? [], microphones: result.microphones ?? [] };
    }
    /**
     * Raise the microphone prompt before a take rather than during one.
     *
     * The grant is the *app's*, not the helper's, precisely because the helper is a spawned child
     * — the same TCC attribution that keeps Screen Recording to one prompt.
     */
    async requestMicrophone() {
        const result = await this.oneShot({ cmd: 'request-microphone' }, 'mic-permission', 60_000);
        if (this.capabilities)
            this.capabilities.micPermission = result.status ?? 'unknown';
        return result.status ?? 'unknown';
    }
    /**
     * Raise the macOS Accessibility prompt for keyboard-shortcut capture, before a take.
     *
     * The grant is the *app's*, not the helper's, for the same spawn-attribution reason the mic and
     * Screen Recording grants are — the helper is a direct child. Prompting from settings rather than
     * mid-take means the Maker deals with the System Settings dialog while choosing options.
     */
    async requestAccessibility() {
        const result = await this.oneShot({ cmd: 'request-accessibility' }, 'accessibility', 60_000);
        const status = result.trusted ? 'granted' : 'denied';
        if (this.capabilities)
            this.capabilities.accessibility = status;
        return status;
    }
    async start(options, handlers) {
        if (this.child)
            throw new Error('A recording is already running.');
        this.handlers = handlers;
        this.child = this.spawnHelper();
        /**
         * Written before the handshake, not after it: the window this record exists for is the one
         * where the app dies unexpectedly, and a capture that has begun but not yet reported
         * `started` is as capable of outliving us as one that has.
         */
        if (this.child.pid)
            writeHelperRecord({ pid: this.child.pid, mediaDir: options.mediaDir, startedAt: new Date().toISOString() });
        const pending = this.await('started', LIST_TIMEOUT_MS);
        this.send({
            cmd: 'start',
            ...targetPayload(options.target),
            mediaDir: options.mediaDir,
            stepDir: options.stepDir,
            fps: options.fps,
            systemAudio: options.systemAudio,
            microphone: options.microphone,
            microphoneID: options.microphoneId,
            keyboardShortcuts: options.keyboardShortcuts,
            webcam: options.webcam === true,
        });
        try {
            return await pending;
        }
        catch (err) {
            clearHelperRecord(this.child?.pid);
            this.child?.kill();
            this.child = null;
            throw err;
        }
    }
    /**
     * Pause closes the current segment, so the footage the Maker paused to avoid is never
     * written. Trimming a single long file would have left those pixels on disk.
     */
    async pause() {
        if (!this.child)
            throw new Error('No recording is running.');
        const pending = this.await('paused', LIST_TIMEOUT_MS);
        this.send({ cmd: 'pause' });
        return pending;
    }
    async resume() {
        if (!this.child)
            throw new Error('No recording is running.');
        const pending = this.await('resumed', LIST_TIMEOUT_MS);
        this.send({ cmd: 'resume' });
        return pending;
    }
    /** The hotkey and the HUD button. Kept because click detection is a heuristic, not a promise. */
    mark() {
        this.send({ cmd: 'mark' });
    }
    async stop() {
        if (!this.child)
            return { steps: 0, durationMs: 0, segments: [] };
        const pending = this.await('stopped', 30_000);
        this.send({ cmd: 'stop' });
        let result = { steps: 0, durationMs: 0, segments: [] };
        try {
            result = await pending;
        }
        catch {
            // Stopping must always succeed from the app's point of view; a helper that died mid-stop
            // has already written whatever it wrote.
        }
        this.send({ cmd: 'quit' });
        clearHelperRecord(this.child?.pid);
        this.child?.kill();
        this.child = null;
        this.handlers = {};
        return { steps: result.steps ?? 0, durationMs: result.durationMs ?? 0, segments: result.segments ?? [] };
    }
    /**
     * Mux the recording's audio onto a rendered picture (see Composer.swift).
     *
     * A fresh short-lived process: by export time the recording one is long gone, and this is
     * pure file work that touches no capture API and needs no permission.
     */
    async compose(options) {
        return this.oneShot({ cmd: 'compose', ...options }, 'composed', COMPOSE_TIMEOUT_MS);
    }
    async transcribe(options) {
        const result = await this.oneShot({ cmd: 'transcribe', ...options }, 'transcript', COMPOSE_TIMEOUT_MS);
        return { words: Array.isArray(result.words) ? result.words : [] };
    }
    /**
     * RMS of the assembled speech track. Numbers only — the helper never ships samples back.
     */
    async analyzeAudio(options) {
        return this.oneShot({ cmd: 'rms', ...options }, 'rms', COMPOSE_TIMEOUT_MS);
    }
    get running() {
        return this.child !== null;
    }
    /**
     * The quit path's last word. No handshake — for the case where a graceful stop already ran
     * (a no-op then) or timed out (the child must not outlive the app that holds its TCC grant).
     */
    kill() {
        clearHelperRecord(this.child?.pid);
        this.child?.kill('SIGKILL');
        this.child = null;
        this.handlers = {};
    }
}
exports.MachineHelper = MachineHelper;
exports.machineHelper = new MachineHelper();
//# sourceMappingURL=MachineHelper.js.map