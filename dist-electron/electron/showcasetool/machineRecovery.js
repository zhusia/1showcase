"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.recoverRecording = recoverRecording;
exports.reconcileStaleRecordings = reconcileStaleRecordings;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const GuideSessionStore_1 = require("./GuideSessionStore");
const MachineHelper_1 = require("./MachineHelper");
const mediaProtocol_1 = require("./mediaProtocol");
const movProbe_1 = require("./movProbe");
const webmProbe_1 = require("./webmProbe");
function recordingDir(sessionId) {
    // The id reaches this from the renderer. Same shape the gtmedia:// handler enforces, for the
    // same reason: one traversal segment would point the reads and the manifest write elsewhere.
    if (!/^[a-z0-9-]{8,64}$/i.test(sessionId))
        throw new Error('invalid session id');
    return path_1.default.join((0, mediaProtocol_1.mediaRoot)(), sessionId);
}
/**
 * Rebuild `recording.json` from the segment files.
 *
 * What survives: the segments, their real durations and the captured frame size, read out of
 * each movie's own header. What does not: the cursor track and the step marks, which lived in
 * main's memory and went with it. That costs the recovered take its drawn pointer, its click
 * zooms and the step pins on the ruler — the footage is intact, the direction is not, and the
 * note says so rather than leaving the Maker to notice.
 *
 * `startMs` is laid end to end. A take that was paused has real gaps between its segments, and
 * only the process that paused knew where they were; laying them flat keeps the picture
 * continuous and moves any recorded audio at most by the length of the pauses.
 */
function rebuildManifest(sessionId) {
    const dir = recordingDir(sessionId);
    const session = GuideSessionStore_1.guideSessionStore.get(sessionId);
    const files = fs_1.default
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /^segment-\d+\.(mov|webm)$/.test(entry.name))
        .map((entry) => entry.name)
        .sort();
    if (!files.length)
        return null;
    const segments = [];
    const unreadable = [];
    let at = 0;
    let width = 0;
    let height = 0;
    let fps = 0;
    let audio = false;
    for (const file of files) {
        const probe = file.endsWith('.webm') ? (0, webmProbe_1.probeWebm)(path_1.default.join(dir, file)) : (0, movProbe_1.probeMovie)(path_1.default.join(dir, file));
        // No `moov` atom means the writer was killed before it finalised: the bytes are there and
        // nothing can decode them. Naming it is the only useful thing left to do with it.
        if (!probe || probe.durationMs <= 0) {
            unreadable.push(file);
            continue;
        }
        segments.push({ file, startMs: at, durationMs: probe.durationMs });
        at += probe.durationMs;
        width = Math.max(width, probe.width);
        height = Math.max(height, probe.height);
        const probedFps = 'fps' in probe ? Number(probe.fps) : 0;
        if (probedFps > 0)
            fps = Math.max(fps, probedFps);
        if ('hasAudio' in probe)
            audio = audio || Boolean(probe.hasAudio);
        if (file.endsWith('.webm') && fs_1.default.existsSync(path_1.default.join(dir, 'speech.wav')))
            audio = true;
    }
    if (!segments.length)
        return { manifest: emptyManifest(sessionId), unreadable };
    const manifest = {
        version: 1,
        sessionId,
        createdAt: session?.startedAt ?? new Date().toISOString(),
        // The kind was the Maker's choice and lived only in the crashed process. 'display' is the
        // honest guess: it is what the studio recorder offers first, and the field only labels.
        targetKind: 'display',
        targetName: session?.targetWindow || session?.title || 'Recovered recording',
        width,
        height,
        fps: fps >= 45 ? 60 : 30,
        durationMs: Math.round(at),
        /**
         * Whether the Maker asked for audio is unknowable now; whether the movies *have* an audio
         * track is not, and it is the thing the export actually branches on. Reading it from the
         * files is what keeps a recovered take's narration in the exported MP4.
         */
        systemAudio: audio,
        microphone: false,
        segments,
        cursor: [],
        stepMarks: [],
    };
    return { manifest, unreadable };
}
function emptyManifest(sessionId) {
    const session = GuideSessionStore_1.guideSessionStore.get(sessionId);
    return {
        version: 1,
        sessionId,
        createdAt: session?.startedAt ?? new Date().toISOString(),
        targetKind: 'display',
        targetName: session?.targetWindow || session?.title || 'Recovered recording',
        width: 0,
        height: 0,
        fps: 30,
        durationMs: 0,
        systemAudio: false,
        microphone: false,
        segments: [],
        cursor: [],
        stepMarks: [],
    };
}
/**
 * Make one session's record agree with what is actually on this machine.
 *
 * Idempotent, and safe on a session that is already stopped: it is "reconcile", not "stop". The
 * live take is *not* this function's business — the caller stops that through the recorder, so
 * the helper finalises its movie and writes its own manifest with the cursor track intact.
 */
async function recoverRecording(sessionId) {
    const session = GuideSessionStore_1.guideSessionStore.get(sessionId);
    if (!session)
        throw new Error('That recording is not in the library.');
    const parts = [];
    let helperKilled = false;
    /**
     * Only an orphan is killed, and only this session's. `machineHelper.running` means the child
     * belongs to *this* process — a live capture, which force-stopping goes through the recorder
     * for — and a record naming another session's directory belongs to that session's recovery.
     */
    const record = (0, MachineHelper_1.readHelperRecord)();
    if (record && !MachineHelper_1.machineHelper.running && (!record.mediaDir || path_1.default.basename(record.mediaDir) === sessionId)) {
        const outcome = await (0, MachineHelper_1.killOrphanHelper)();
        if (outcome) {
            helperKilled = true;
            parts.push(outcome.hard ? 'a capture process left running was killed' : 'the capture process left running was stopped');
        }
    }
    let footageRecovered = false;
    let segments = 0;
    let durationMs = 0;
    if (session.captureMode === 'video') {
        const dir = recordingDir(sessionId);
        const file = path_1.default.join(dir, 'recording.json');
        const described = (() => {
            try {
                const parsed = JSON.parse(fs_1.default.readFileSync(file, 'utf8'));
                return Array.isArray(parsed.segments) ? parsed : null;
            }
            catch {
                return null;
            }
        })();
        if (described) {
            segments = described.segments.length;
            durationMs = described.durationMs;
        }
        else if (fs_1.default.existsSync(dir)) {
            const rebuilt = rebuildManifest(sessionId);
            if (rebuilt) {
                fs_1.default.writeFileSync(file, JSON.stringify(rebuilt.manifest));
                segments = rebuilt.manifest.segments.length;
                durationMs = rebuilt.manifest.durationMs;
                footageRecovered = segments > 0;
                /**
                 * The footage is only reachable once the row points at it. A crash between `start` and
                 * `setMedia` leaves the directory full and the row empty, and 'raw' is the only state it
                 * may be given: it has had no mask burn, so it still has no export path.
                 */
                if (footageRecovered)
                    GuideSessionStore_1.guideSessionStore.setMedia(sessionId, path_1.default.join('.machine', sessionId), 'raw');
                if (segments) {
                    parts.push(`${segments} clip${segments === 1 ? '' : 's'} of footage recovered — the pointer track and the step marks were lost with the crash`);
                }
                if (rebuilt.unreadable.length) {
                    parts.push(`${rebuilt.unreadable.length} clip${rebuilt.unreadable.length === 1 ? '' : 's'} never finished writing and cannot be played`);
                }
            }
        }
    }
    GuideSessionStore_1.guideSessionStore.stop(sessionId);
    const steps = session.stepCount;
    if (steps)
        parts.push(`${steps} captured step${steps === 1 ? '' : 's'} kept`);
    if (!parts.length)
        parts.push('nothing had been captured yet');
    return {
        sessionId,
        title: session.title,
        helperKilled,
        footageRecovered,
        segments,
        durationMs,
        note: `“${session.title}” was closed out: ${parts.join('; ')}.`,
    };
}
/**
 * The boot sweep. Every machine session still marked 'recording' when the app starts is stale by
 * construction — that recorder lives in this process, and this process has just begun.
 *
 * Browser sessions are deliberately left alone. The extension's recording state lives in the
 * service worker's session storage, which outlives an app restart, so a Maker whose app crashed
 * mid-flow can carry on recording in Chrome and still have their steps land. Those rows are
 * cleared by hand from the library instead, which is why the force-stop control is not
 * machine-only.
 */
async function reconcileStaleRecordings() {
    const open = GuideSessionStore_1.guideSessionStore.openRecordings().filter((row) => row.source === 'machine');
    const recovered = [];
    for (const row of open) {
        try {
            recovered.push(await recoverRecording(row.id));
        }
        catch (err) {
            // A recovery that throws must not leave the row open — that is the deadlock this exists
            // to break. Close it and say what could not be salvaged.
            console.error(`[machine] could not recover ${row.id}: ${err.message}`);
            GuideSessionStore_1.guideSessionStore.stop(row.id);
        }
    }
    /**
     * An orphan with no row of its own is still a camera pointed at the Maker's screen: a crash
     * between spawning the helper and inserting the session leaves exactly that, and so does one
     * whose row somebody has already closed by hand. Killed last, because the loop above kills
     * the one it can attribute and this is only ever the remainder.
     */
    if (!MachineHelper_1.machineHelper.running && (0, MachineHelper_1.readHelperRecord)()) {
        const outcome = await (0, MachineHelper_1.killOrphanHelper)().catch(() => null);
        if (outcome)
            console.log(`[machine] ended a capture process left running by a previous run (pid ${outcome.pid})`);
    }
    return recovered;
}
//# sourceMappingURL=machineRecovery.js.map