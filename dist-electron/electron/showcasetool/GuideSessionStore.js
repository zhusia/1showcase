"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.guideSessionStore = exports.GuideSessionStore = void 0;
const crypto_1 = require("crypto");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const electron_1 = require("electron");
const db_1 = require("../db");
const ScreenshotStore_1 = require("./ScreenshotStore");
const customize_1 = require("./customize");
const studio_1 = require("./studio");
const schema_1 = require("./schema");
const AnnotationProject_1 = require("./AnnotationProject");
/** A row written before the capture_mode column existed was the hotkey recorder. */
function toCaptureMode(raw) {
    return raw === 'video' ? 'video' : 'shots';
}
/** A row written before the source column existed came from the extension. */
function toSource(raw) {
    return raw === 'machine' ? 'machine' : 'browser';
}
function parseJson(raw, fallback) {
    try {
        return JSON.parse(raw);
    }
    catch {
        return fallback;
    }
}
/**
 * The target rect arrives over the relay, so it is untrusted input like everything else the
 * extension sends. Four finite numbers in range or nothing at all — a malformed one just
 * means the app falls back to placing the arrow itself.
 */
function sanitizeRect(rect) {
    if (!rect || typeof rect !== 'object')
        return null;
    const values = [rect.x, rect.y, rect.width, rect.height];
    if (values.some((v) => typeof v !== 'number' || !Number.isFinite(v)))
        return null;
    if (rect.width <= 0 || rect.height <= 0)
        return null;
    const clamp01 = (v) => Math.min(Math.max(v, 0), 1);
    return { x: clamp01(rect.x), y: clamp01(rect.y), width: clamp01(rect.width), height: clamp01(rect.height) };
}
/**
 * Keep only the two deliberately narrow keyboard-action shapes when reading older/corrupt rows.
 * The write path below compares the result with its input and refuses anything this drops.
 */
function sanitizeKeystrokes(raw) {
    if (!Array.isArray(raw))
        return [];
    const out = [];
    const ids = new Set();
    for (const item of raw.slice(0, 64)) {
        if (!item || typeof item !== 'object')
            continue;
        const record = item;
        const id = typeof record.id === 'string' ? record.id.trim() : '';
        if (!id || id.length > 120 || ids.has(id))
            continue;
        if (record.kind === 'shortcut' && Array.isArray(record.keys)) {
            const keys = record.keys.filter((key) => typeof key === 'string' && key.length > 0 && key.length <= 24 && !/[\u0000-\u001f\u007f]/.test(key));
            if (keys.length !== record.keys.length || keys.length < 1 || keys.length > 5)
                continue;
            if (Object.keys(record).some((key) => !['id', 'kind', 'keys'].includes(key)))
                continue;
            out.push({ id, kind: 'shortcut', keys });
            ids.add(id);
            continue;
        }
        if (record.kind === 'type' && typeof record.label === 'string') {
            const label = record.label.trim();
            if (!label || label.length > 80 || /[\u0000-\u001f\u007f]/.test(label))
                continue;
            if (Object.keys(record).some((key) => !['id', 'kind', 'label'].includes(key)))
                continue;
            out.push({ id, kind: 'type', label });
            ids.add(id);
        }
    }
    return out;
}
function toStoredStep(row) {
    return {
        id: row.id,
        sessionId: row.session_id,
        seq: row.seq,
        kind: row.kind,
        url: row.url,
        urlPattern: row.url_pattern,
        pageTitle: row.page_title,
        selectors: parseJson(row.selectors, []),
        a11y: parseJson(row.a11y, {}),
        value: row.value ?? undefined,
        valueMasked: row.value_masked === 1,
        placeholder: row.placeholder ?? undefined,
        viewport: parseJson(row.viewport, { width: 0, height: 0, dpr: 1 }),
        screenshot: row.screenshot ?? undefined,
        annotationProject: row.annotation_project ?? undefined,
        fullPage: row.full_page ?? undefined,
        targetRect: row.target_rect ? parseJson(row.target_rect, undefined) : undefined,
        captureError: row.capture_error ?? undefined,
        windowTitle: row.window_title || undefined,
        note: row.note || undefined,
        keystrokes: sanitizeKeystrokes(parseJson(row.keystrokes, [])),
        warnings: parseJson(row.warnings, []),
        dropped: row.dropped === 1,
        outputs: parseJson(row.outputs, []),
        chapter: row.chapter || undefined,
        branches: parseJson(row.branches, []),
        altSelectors: parseJson(row.alt_selectors, []),
        capturedAt: row.captured_at,
    };
}
class GuideSessionStore {
    create(title, options) {
        const id = (0, crypto_1.randomUUID)();
        (0, db_1.getDb)()
            .prepare(`INSERT INTO sessions (id, title, status, source, target_window, capture_mode, started_at)
         VALUES (?, ?, 'recording', ?, ?, ?, ?)`)
            .run(id, title, options?.source ?? 'browser', options?.targetWindow ?? '', options?.captureMode ?? 'shots', new Date().toISOString());
        return id;
    }
    /**
     * Record where a video session's footage landed and what state it is in.
     *
     * `media_state` is the thing that keeps unburned footage from leaving the app. 'raw' means the
     * capture is exactly as ScreenCaptureKit wrote it — masks are still only descriptions — so it
     * has no export path at all. Only the burn, which composites the fills into new frames, writes
     * 'burned'. `relativePath` names the recording *directory*, because a take that was paused is
     * several segment files plus a manifest, not one movie.
     */
    setMedia(sessionId, relativePath, state) {
        (0, db_1.getDb)().prepare(`UPDATE sessions SET media_path = ?, media_state = ? WHERE id = ?`).run(relativePath, state, sessionId);
    }
    media(sessionId) {
        const row = (0, db_1.getDb)()
            .prepare(`SELECT media_path, media_state, capture_mode FROM sessions WHERE id = ?`)
            .get(sessionId);
        if (!row)
            return null;
        return { path: row.media_path ?? '', state: row.media_state ?? '', captureMode: toCaptureMode(row.capture_mode) };
    }
    /**
     * The studio project — trim, camera, cursor, background, masks.
     *
     * Saved on every edit rather than on an explicit Save: an editor that can lose an hour of
     * mask work to a crash is worse than no editor. Normalising on the way in means a project
     * written by an older build reads back complete instead of throwing.
     */
    setStudio(sessionId, project) {
        const normalized = (0, studio_1.normalizeStudio)(project);
        (0, db_1.getDb)().prepare(`UPDATE sessions SET studio = ? WHERE id = ?`).run(JSON.stringify(normalized), sessionId);
        return normalized;
    }
    studio(sessionId) {
        const row = (0, db_1.getDb)().prepare(`SELECT studio FROM sessions WHERE id = ?`).get(sessionId);
        return (0, studio_1.normalizeStudio)(row ? parseJson(row.studio, {}) : {});
    }
    /**
     * Imported mockup ids still named by a stored project.
     *
     * Read the raw blob rather than `normalizeStudio`: if a future build writes a photo scene this
     * build cannot fully parse, normalising it to `flat` and then sweeping its photograph would turn
     * a recoverable project into permanent data loss. Null means at least one row could not be
     * audited, and the caller must skip the sweep entirely.
     */
    studioSceneAssetIds() {
        const rows = (0, db_1.getDb)().prepare(`SELECT studio FROM sessions`).all();
        const used = new Set();
        for (const row of rows) {
            let raw;
            try {
                raw = JSON.parse(row.studio);
            }
            catch {
                return null;
            }
            if (!raw || typeof raw !== 'object')
                continue;
            const project = raw;
            const scenes = [project.scene];
            if (project.clips !== undefined) {
                if (!Array.isArray(project.clips))
                    return null;
                for (const clip of project.clips) {
                    if (!clip || typeof clip !== 'object')
                        return null;
                    const look = clip.look;
                    if (look === undefined)
                        continue;
                    if (!look || typeof look !== 'object')
                        return null;
                    scenes.push(look.scene);
                }
            }
            for (const scene of scenes) {
                if (scene === undefined)
                    continue;
                if (!scene || typeof scene !== 'object')
                    return null;
                const record = scene;
                if (record.kind !== 'photo')
                    continue;
                if (typeof record.assetId !== 'string')
                    return null;
                // Bundled ids contain a colon and have no file under scenes/. Custom ids obey sceneFile's
                // alphabet; an unfamiliar future id makes the audit incomplete, so retain everything.
                if (record.assetId.startsWith('bundled:'))
                    continue;
                if (!/^[a-z0-9-]{8,80}$/i.test(record.assetId))
                    return null;
                used.add(record.assetId);
            }
        }
        return used;
    }
    /**
     * The same read, with whatever could not be read back.
     *
     * Separate from `studio()` because almost nothing needs the casualty list — only the editor's
     * open path does, and it needs it to refuse an export rather than to render anything.
     */
    studioWithIssues(sessionId) {
        const row = (0, db_1.getDb)().prepare(`SELECT studio FROM sessions WHERE id = ?`).get(sessionId);
        return (0, studio_1.inspectStudio)(row ? parseJson(row.studio, {}) : {});
    }
    /**
     * Mask entries that could not be parsed, held where the renderer cannot overwrite them.
     *
     * `setStudio` never touches this column, which is the point: the editor sends a complete project
     * every 400 ms, and a count or a list living inside that blob would be zeroed by the first
     * autosave after the problem was noticed.
     */
    studioQuarantine(sessionId) {
        const row = (0, db_1.getDb)().prepare(`SELECT studio_quarantine FROM sessions WHERE id = ?`).get(sessionId);
        const parsed = parseJson(row?.studio_quarantine ?? '[]', []);
        return Array.isArray(parsed) ? parsed : [];
    }
    setStudioQuarantine(sessionId, issues) {
        (0, db_1.getDb)()
            .prepare(`UPDATE sessions SET studio_quarantine = ? WHERE id = ?`)
            .run(JSON.stringify(issues.slice(0, 200)), sessionId);
    }
    /**
     * Which recorder produced this session. Read on the paths that must behave differently for
     * a machine recording — the acknowledge gate, the generator prompt, and the replay filter.
     */
    sourceOf(sessionId) {
        const row = (0, db_1.getDb)().prepare(`SELECT source FROM sessions WHERE id = ?`).get(sessionId);
        return row ? toSource(row.source) : null;
    }
    /** True while any recorder holds an open session. Both recorders refuse to start over one. */
    hasActiveRecording() {
        const row = (0, db_1.getDb)().prepare(`SELECT COUNT(*) AS n FROM sessions WHERE status = 'recording'`).get();
        return row.n > 0;
    }
    /**
     * Every session still marked 'recording', with enough about each to decide what it is.
     *
     * The status is a *claim*, not a fact: the machine recorder holds its live take in a field of
     * the main process, so after a crash the row survives and the recorder that owned it does not.
     * `hasActiveRecording` then blocks every later recording over a take that ended when the app
     * died. Whoever needs to break that deadlock has to know which recorder wrote the row — see
     * `machineRecovery.ts`.
     */
    openRecordings() {
        const rows = (0, db_1.getDb)()
            .prepare(`SELECT id, title, source, capture_mode, started_at FROM sessions WHERE status = 'recording' ORDER BY started_at`)
            .all();
        return rows.map((row) => ({
            id: row.id,
            title: row.title,
            source: toSource(row.source),
            captureMode: toCaptureMode(row.capture_mode),
            startedAt: row.started_at,
        }));
    }
    /**
     * Persist one Layer-1-redacted step. Screenshot data URIs are written to disk here
     * and replaced by relative paths, so the DB never holds image bytes.
     */
    appendStep(sessionId, step) {
        /**
         * The session must exist before anything touches disk. This id arrives from the relay —
         * the app's untrusted-input boundary — and the screenshot write used to run *first*, so a
         * bogus id put a PNG on disk before the insert failed on the foreign key.
         */
        const known = (0, db_1.getDb)().prepare(`SELECT 1 FROM sessions WHERE id = ?`).get(sessionId);
        if (!known)
            throw new Error('no such session');
        const screenshot = step.screenshot ? ScreenshotStore_1.screenshotStore.writeDataUri(sessionId, step.screenshot, 'step') : null;
        const fullPage = step.fullPage ? ScreenshotStore_1.screenshotStore.writeDataUri(sessionId, step.fullPage, 'page') : null;
        const seq = step.seq ??
            ((0, db_1.getDb)().prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM session_steps WHERE session_id = ?`).get(sessionId).m + 1);
        const id = step.id || (0, crypto_1.randomUUID)();
        (0, db_1.getDb)()
            .prepare(`INSERT INTO session_steps
           (id, session_id, seq, kind, url, url_pattern, page_title, selectors, a11y,
            value, value_masked, placeholder, viewport, screenshot, full_page, target_rect, capture_error,
            window_title, note, keystrokes, warnings, outputs, captured_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?)`)
            .run(id, sessionId, seq, step.kind, step.url, step.urlPattern, step.pageTitle, JSON.stringify(step.selectors ?? []), JSON.stringify(step.a11y ?? {}), step.value ?? null, step.valueMasked ? 1 : 0, step.placeholder ?? null, JSON.stringify(step.viewport ?? {}), screenshot, fullPage, sanitizeRect(step.targetRect) ? JSON.stringify(sanitizeRect(step.targetRect)) : null, step.captureError ?? null, step.windowTitle ?? '', step.note ?? '', JSON.stringify(sanitizeKeystrokes(step.keystrokes ?? [])), JSON.stringify(step.warnings ?? []), step.capturedAt || new Date().toISOString());
        return id;
    }
    stop(sessionId) {
        (0, db_1.getDb)()
            .prepare(`UPDATE sessions SET status = 'stopped', stopped_at = ? WHERE id = ? AND status = 'recording'`)
            .run(new Date().toISOString(), sessionId);
    }
    setStatus(sessionId, status) {
        (0, db_1.getDb)().prepare(`UPDATE sessions SET status = ? WHERE id = ?`).run(status, sessionId);
    }
    setPrompt(sessionId, prompt, audience) {
        (0, db_1.getDb)().prepare(`UPDATE sessions SET prompt = ?, audience = ? WHERE id = ?`).run(prompt, audience, sessionId);
    }
    /**
     * The Generation step's customisation choices. Config, not content — changing how the
     * guide will look does not re-open the redaction gate the way editing a step does.
     */
    setCustomize(sessionId, customize) {
        const normalized = (0, customize_1.normalizeCustomize)(customize);
        (0, db_1.getDb)().prepare(`UPDATE sessions SET customize = ? WHERE id = ?`).run(JSON.stringify(normalized), sessionId);
        return normalized;
    }
    customize(sessionId) {
        const row = (0, db_1.getDb)().prepare(`SELECT customize FROM sessions WHERE id = ?`).get(sessionId);
        return (0, customize_1.normalizeCustomize)(row ? parseJson(row.customize, {}) : {});
    }
    rename(sessionId, title) {
        (0, db_1.getDb)().prepare(`UPDATE sessions SET title = ? WHERE id = ?`).run(title, sessionId);
    }
    /**
     * Record the mandatory review acknowledgement (§7.2 Layer 2). Nothing may be
     * generated, exported, or published for a session where this is null.
     */
    acknowledgeRedaction(sessionId) {
        const at = new Date().toISOString();
        (0, db_1.getDb)().prepare(`UPDATE sessions SET redaction_ack_at = ?, status = 'reviewed' WHERE id = ?`).run(at, sessionId);
        return at;
    }
    isRedactionAcknowledged(sessionId) {
        const row = (0, db_1.getDb)().prepare(`SELECT redaction_ack_at FROM sessions WHERE id = ?`).get(sessionId);
        return !!row?.redaction_ack_at;
    }
    /**
     * Any edit to a session's content after acknowledgement re-opens the gate. A Maker
     * who adds a step or un-drops one must look at it again before it can ship.
     */
    invalidateAcknowledgement(sessionId) {
        (0, db_1.getDb)().prepare(`UPDATE sessions SET redaction_ack_at = NULL, status = 'stopped' WHERE id = ?`).run(sessionId);
    }
    /**
     * The first kept screenshot in a recording, as a store-relative path — the library's tile.
     *
     * SQL rather than `steps()`: the grid asks for one of these per visible card on every refresh,
     * and deserialising every step of every recording to read one filename is the shape of query
     * `GuideStore.list` already learned not to write.
     */
    posterPath(sessionId) {
        const row = (0, db_1.getDb)()
            .prepare(`SELECT screenshot FROM session_steps
          WHERE session_id = ? AND dropped = 0 AND screenshot IS NOT NULL AND screenshot != ''
          ORDER BY seq LIMIT 1`)
            .get(sessionId);
        return row?.screenshot ?? null;
    }
    list() {
        const rows = (0, db_1.getDb)()
            .prepare(`SELECT s.*,
                (SELECT COUNT(*) FROM session_steps st WHERE st.session_id = s.id AND st.dropped = 0) AS step_count,
                (SELECT COUNT(*) FROM session_steps st WHERE st.session_id = s.id AND st.dropped = 0 AND st.warnings != '[]') AS warning_count
           FROM sessions s
          ORDER BY s.started_at DESC`)
            .all();
        return rows.map((r) => ({
            id: r.id,
            title: r.title,
            status: r.status,
            source: toSource(r.source),
            targetWindow: r.target_window ?? '',
            startedAt: r.started_at,
            stoppedAt: r.stopped_at,
            redactionAckAt: r.redaction_ack_at,
            prompt: r.prompt,
            audience: r.audience,
            customize: (0, customize_1.normalizeCustomize)(parseJson(r.customize, {})),
            captureMode: toCaptureMode(r.capture_mode),
            mediaState: r.media_state ?? '',
            stepCount: r.step_count,
            warningCount: r.warning_count,
        }));
    }
    get(sessionId) {
        const row = (0, db_1.getDb)().prepare(`SELECT * FROM sessions WHERE id = ?`).get(sessionId);
        if (!row)
            return null;
        const steps = this.steps(sessionId);
        return {
            id: row.id,
            title: row.title,
            status: row.status,
            source: toSource(row.source),
            targetWindow: row.target_window ?? '',
            startedAt: row.started_at,
            stoppedAt: row.stopped_at,
            redactionAckAt: row.redaction_ack_at,
            prompt: row.prompt,
            audience: row.audience,
            customize: (0, customize_1.normalizeCustomize)(parseJson(row.customize, {})),
            captureMode: toCaptureMode(row.capture_mode),
            mediaState: row.media_state ?? '',
            stepCount: steps.filter((s) => !s.dropped).length,
            warningCount: steps.filter((s) => !s.dropped && s.warnings.length > 0).length,
            steps,
        };
    }
    steps(sessionId, includeDropped = true) {
        const rows = (0, db_1.getDb)()
            .prepare(includeDropped
            ? `SELECT * FROM session_steps WHERE session_id = ? ORDER BY seq`
            : `SELECT * FROM session_steps WHERE session_id = ? AND dropped = 0 ORDER BY seq`)
            .all(sessionId);
        return rows.map(toStoredStep);
    }
    step(stepId) {
        const row = (0, db_1.getDb)().prepare(`SELECT * FROM session_steps WHERE id = ?`).get(stepId);
        return row ? toStoredStep(row) : null;
    }
    loadAnnotationProject(sessionId, stepId) {
        const step = this.step(stepId);
        if (!step || step.sessionId !== sessionId)
            throw new Error('step does not belong to session');
        if (!step.annotationProject)
            return null;
        const stored = (0, AnnotationProject_1.parseStoredAnnotationProject)(ScreenshotStore_1.screenshotStore.readJson(step.annotationProject));
        const baseDataUri = ScreenshotStore_1.screenshotStore.readDataUri(stored.sourceScreenshot);
        if (!baseDataUri)
            throw new Error('the source screenshot for this annotation project is missing');
        return { project: stored.project, baseDataUri };
    }
    /** Save a rendered review image while keeping its current redacted source reversible. */
    saveAnnotationProject(sessionId, stepId, projectValue, renderedDataUri) {
        if (renderedDataUri.length > 48 * 1024 * 1024)
            throw new Error('rendered annotation image is too large');
        const project = (0, AnnotationProject_1.parseAnnotationProject)(projectValue);
        const step = this.step(stepId);
        if (!step || step.sessionId !== sessionId)
            throw new Error('step does not belong to session');
        if (!step.screenshot)
            throw new Error('step has no screenshot');
        const previousOutput = step.screenshot;
        const previousProjectPath = step.annotationProject;
        const previousStored = previousProjectPath
            ? (0, AnnotationProject_1.parseStoredAnnotationProject)(ScreenshotStore_1.screenshotStore.readJson(previousProjectPath))
            : null;
        const sourceScreenshot = previousStored?.sourceScreenshot ?? previousOutput;
        const directory = sourceScreenshot.split('/')[0];
        if (!directory)
            throw new Error('invalid source screenshot path');
        const screenshot = ScreenshotStore_1.screenshotStore.writeDataUri(directory, renderedDataUri, 'review-annotated');
        if (!screenshot)
            throw new Error('the editor did not produce a PNG');
        let projectPath;
        try {
            projectPath = ScreenshotStore_1.screenshotStore.writeJson(directory, { sourceScreenshot, project }, 'review-annotation-project');
        }
        catch (error) {
            ScreenshotStore_1.screenshotStore.delete(screenshot);
            throw error;
        }
        (0, db_1.getDb)()
            .prepare(`UPDATE session_steps SET screenshot = ?, annotation_project = ? WHERE id = ? AND session_id = ?`)
            .run(screenshot, projectPath, stepId, sessionId);
        this.invalidateAcknowledgement(sessionId);
        if (previousOutput !== sourceScreenshot && previousOutput !== screenshot)
            ScreenshotStore_1.screenshotStore.delete(previousOutput);
        if (previousProjectPath && previousProjectPath !== projectPath)
            ScreenshotStore_1.screenshotStore.delete(previousProjectPath);
        return { screenshot, projectPath };
    }
    /**
     * A later destructive paint/crop makes the editable base unsafe because it does not contain
     * the new redaction. Delete that base and sidecar, leaving only the flattened current PNG.
     */
    flattenAnnotationProject(stepId) {
        const step = this.step(stepId);
        if (!step?.annotationProject)
            return;
        const stored = (0, AnnotationProject_1.parseStoredAnnotationProject)(ScreenshotStore_1.screenshotStore.readJson(step.annotationProject));
        if (stored.sourceScreenshot !== step.screenshot)
            ScreenshotStore_1.screenshotStore.delete(stored.sourceScreenshot);
        ScreenshotStore_1.screenshotStore.delete(step.annotationProject);
        (0, db_1.getDb)().prepare(`UPDATE session_steps SET annotation_project = NULL WHERE id = ?`).run(stepId);
    }
    setDropped(stepId, dropped) {
        (0, db_1.getDb)().prepare(`UPDATE session_steps SET dropped = ? WHERE id = ?`).run(dropped ? 1 : 0, stepId);
    }
    /** Used by the crop path, which changes the frame the rect is expressed against. */
    setTargetRect(stepId, rect) {
        const safe = sanitizeRect(rect);
        (0, db_1.getDb)()
            .prepare(`UPDATE session_steps SET target_rect = ? WHERE id = ?`)
            .run(safe ? JSON.stringify(safe) : null, stepId);
    }
    /**
     * Note that a destructive pixel edit was applied to this step's screenshot. Idempotent — the
     * column is a set, so painting the same frame four times records one 'paint'.
     */
    recordPixelEdit(stepId, kind) {
        const db = (0, db_1.getDb)();
        const row = db.prepare(`SELECT pixel_edits FROM session_steps WHERE id = ?`).get(stepId);
        if (!row)
            return;
        let applied;
        try {
            const parsed = JSON.parse(row.pixel_edits);
            applied = Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : [];
        }
        catch {
            applied = [];
        }
        if (applied.includes(kind))
            return;
        applied.push(kind);
        db.prepare(`UPDATE session_steps SET pixel_edits = ? WHERE id = ?`).run(JSON.stringify(applied), stepId);
    }
    setStepValue(stepId, value, masked, placeholder) {
        (0, db_1.getDb)()
            .prepare(`UPDATE session_steps SET value = ?, value_masked = ?, placeholder = ? WHERE id = ?`)
            .run(value, masked ? 1 : 0, placeholder, stepId);
    }
    setStepWarnings(stepId, warnings) {
        (0, db_1.getDb)().prepare(`UPDATE session_steps SET warnings = ? WHERE id = ?`).run(JSON.stringify(warnings), stepId);
    }
    setStepOutputs(stepId, outputs) {
        (0, db_1.getDb)().prepare(`UPDATE session_steps SET outputs = ? WHERE id = ?`).run(JSON.stringify(outputs), stepId);
    }
    /** Empty string clears the chapter, which is how a step rejoins the previous group. */
    setStepChapter(stepId, chapter) {
        (0, db_1.getDb)().prepare(`UPDATE session_steps SET chapter = ? WHERE id = ?`).run(chapter.trim().slice(0, 80), stepId);
    }
    setStepBranches(stepId, branches) {
        (0, db_1.getDb)().prepare(`UPDATE session_steps SET branches = ? WHERE id = ?`).run(JSON.stringify(branches), stepId);
    }
    setStepAltSelectors(stepId, altSelectors) {
        (0, db_1.getDb)().prepare(`UPDATE session_steps SET alt_selectors = ? WHERE id = ?`).run(JSON.stringify(altSelectors.slice(0, 12)), stepId);
    }
    setAssessments(sessionId, assessments) {
        const parsed = schema_1.ChapterAssessmentSchema.array().max(24).safeParse(assessments ?? []);
        if (!parsed.success)
            throw new Error('Those chapter checks could not be saved.');
        (0, db_1.getDb)().prepare(`UPDATE sessions SET assessments = ? WHERE id = ?`).run(JSON.stringify(parsed.data), sessionId);
    }
    assessments(sessionId) {
        const row = (0, db_1.getDb)().prepare(`SELECT assessments FROM sessions WHERE id = ?`).get(sessionId);
        if (!row)
            return [];
        try {
            const parsed = JSON.parse(row.assessments);
            return Array.isArray(parsed) ? parsed : [];
        }
        catch {
            return [];
        }
    }
    setStepKeystrokes(stepId, value) {
        const keystrokes = sanitizeKeystrokes(value);
        if (!Array.isArray(value) || keystrokes.length !== value.length || value.length > 64) {
            throw new Error('invalid keystroke action list');
        }
        (0, db_1.getDb)().prepare(`UPDATE session_steps SET keystrokes = ? WHERE id = ?`).run(JSON.stringify(keystrokes), stepId);
        return keystrokes;
    }
    delete(sessionId) {
        // Refused before anything is touched: this id fans out into two recursive deletes.
        if (!/^[a-z0-9-]{8,64}$/i.test(sessionId))
            throw new Error('invalid session id');
        (0, db_1.getDb)().prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
        ScreenshotStore_1.screenshotStore.deleteSession(sessionId);
        /**
         * The recorded footage goes with the recording. Deleting a session used to leave its
         * `.machine/<id>` directory — gigabytes of raw screen capture — sitting on disk until the
         * seven-day sweep noticed, on a machine whose owner just said "delete this".
         */
        const mediaDir = path_1.default.join(electron_1.app.getPath('userData'), 'showcasetool', '.machine', sessionId);
        if (fs_1.default.existsSync(mediaDir))
            fs_1.default.rmSync(mediaDir, { recursive: true, force: true });
        /** Where it was filed and what it was tagged go with it, same as the guide store does. */
        (0, db_1.getDb)().prepare(`DELETE FROM library_folder_items WHERE item_kind = 'session' AND item_id = ?`).run(sessionId);
        (0, db_1.getDb)().prepare(`DELETE FROM library_tag_items WHERE item_kind = 'session' AND item_id = ?`).run(sessionId);
    }
}
exports.GuideSessionStore = GuideSessionStore;
exports.guideSessionStore = new GuideSessionStore();
//# sourceMappingURL=GuideSessionStore.js.map