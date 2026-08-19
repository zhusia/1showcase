"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.guideStore = exports.GuideStore = exports.MAX_RESHOOT_BYTES = void 0;
const db_1 = require("../db");
const LibraryOrganizationStore_1 = require("./LibraryOrganizationStore");
const annotations_1 = require("./annotations");
const ScreenshotStore_1 = require("./ScreenshotStore");
const schema_1 = require("./schema");
const AnnotationProject_1 = require("./AnnotationProject");
/** Bounds the relay's reshoot payload: a data URI bigger than this is not a screenshot. */
exports.MAX_RESHOOT_BYTES = 12 * 1024 * 1024;
/**
 * The replay guard (docs/machine-record-plan.md §8).
 *
 * A machine recording yields pixel coordinates, and pixel coordinates cannot anchor an
 * overlay on a page whose layout moves — the PRD's own reason for ruling desktop recording
 * out of replay (§5). So a guide generated from one is never offered to the extension.
 *
 * Stored on the guide row rather than derived from the session at read time: deleting the
 * recording must not be able to turn a machine guide back into a replayable one.
 */
function replayableForSession(sessionId) {
    if (!sessionId)
        return true;
    const row = (0, db_1.getDb)().prepare(`SELECT source FROM sessions WHERE id = ?`).get(sessionId);
    return row?.source !== 'machine';
}
/**
 * The app-managed store is canonical, per open question #1 — Standalone mode has no repo
 * to live in, so a guide has to have a home that does not assume one. In-repo sync becomes
 * a Linked-mode option later rather than the only shape.
 */
class GuideStore {
    save(guide, sessionId) {
        /**
         * Asked before the upsert, because afterwards the row exists either way. A guide inherits
         * its recording's project and tags *once*, at birth — re-generating a guide the Maker has
         * since filed somewhere deliberately must not drag it back to wherever the session sits.
         */
        const isNew = !(0, db_1.getDb)().prepare(`SELECT 1 FROM guides WHERE id = ?`).get(guide.id);
        (0, db_1.getDb)()
            .prepare(`INSERT INTO guides (id, session_id, title, mode, schema_version, json, transport, replayable, generated_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           session_id = excluded.session_id,
           title      = excluded.title,
           mode       = excluded.mode,
           json       = excluded.json,
           transport  = excluded.transport,
           replayable = excluded.replayable,
           generated_at = excluded.generated_at,
           updated_at = datetime('now')`)
            .run(guide.id, sessionId, guide.title, guide.mode, guide.schemaVersion, JSON.stringify(guide), guide.transport, replayableForSession(sessionId) ? 1 : 0, guide.generatedAt);
        if (isNew && sessionId)
            LibraryOrganizationStore_1.libraryOrganizationStore.inheritFromSession(guide.id, sessionId);
    }
    list() {
        /**
         * The three JSON-derived fields come from SQLite's own json functions rather than from
         * parsing every guide in JS. This list runs on every library refresh, and a full
         * `parseGuide` (zod, all steps) per row made the most-called query in the app scale with
         * the total size of every guide ever generated.
         */
        const rows = (0, db_1.getDb)()
            .prepare(`SELECT g.id, g.session_id, g.title, g.mode, g.transport, g.replayable, g.generated_at, g.updated_at,
                json_array_length(g.json, '$.steps') AS step_count,
                json_extract(g.json, '$.language') AS language,
                json_extract(g.json, '$.translationOf') AS translation_of,
                h.checked_at AS last_checked_at
         FROM guides g
         LEFT JOIN guide_health h ON h.guide_id = g.id
         ORDER BY g.updated_at DESC`)
            .all();
        return rows.map((row) => ({
            id: row.id,
            sessionId: row.session_id,
            title: row.title,
            mode: (row.mode === 'linked' ? 'linked' : 'standalone'),
            stepCount: row.step_count ?? 0,
            replayable: row.replayable !== 0,
            transport: row.transport,
            language: row.language ?? 'en',
            translationOf: row.translation_of ?? null,
            generatedAt: row.generated_at,
            updatedAt: row.updated_at,
            lastCheckedAt: row.last_checked_at,
        }));
    }
    /**
     * The first step screenshot in a guide, as a store-relative path — the library's tile.
     *
     * `json_each` walks the steps array in order inside SQLite, for the same reason `list` reads
     * its three derived fields with json functions: a full `parseGuide` per visible card would
     * make the library's cheapest decoration its most expensive query.
     */
    posterPath(id) {
        const row = (0, db_1.getDb)()
            .prepare(`SELECT json_extract(step.value, '$.screenshot') AS shot
           FROM guides, json_each(guides.json, '$.steps') AS step
          WHERE guides.id = ? AND json_extract(step.value, '$.screenshot') IS NOT NULL
          LIMIT 1`)
            .get(id);
        return row?.shot || null;
    }
    /**
     * Whether the overlay may drive this guide. The relay calls this before handing a guide to
     * the extension — an unknown id answers false, because "not found" and "not replayable"
     * both end the same way and defaulting to permissive here would be the wrong mistake.
     */
    isReplayable(id) {
        const row = (0, db_1.getDb)().prepare(`SELECT replayable FROM guides WHERE id = ?`).get(id);
        return !!row && row.replayable !== 0;
    }
    /** Which recording a guide came from, for the checks that are keyed on the session. */
    sessionIdOf(id) {
        const row = (0, db_1.getDb)().prepare(`SELECT session_id FROM guides WHERE id = ?`).get(id);
        return row?.session_id ?? null;
    }
    get(id) {
        const row = (0, db_1.getDb)().prepare(`SELECT json FROM guides WHERE id = ?`).get(id);
        if (!row)
            return null;
        const parsed = (0, schema_1.parseGuide)(safeJson(row.json));
        return parsed.ok ? parsed.guide : null;
    }
    /** Surfaces the validation error instead of swallowing it — used by the loader UI. */
    getOrError(id) {
        const row = (0, db_1.getDb)().prepare(`SELECT json FROM guides WHERE id = ?`).get(id);
        if (!row)
            return { ok: false, error: 'guide not found' };
        return (0, schema_1.parseGuide)(safeJson(row.json));
    }
    delete(id) {
        // Pending re-shot files go with the guide; the rows follow below.
        for (const pending of this.pendingRefreshes(id))
            ScreenshotStore_1.screenshotStore.delete(pending.newScreenshot);
        (0, db_1.getDb)().prepare(`DELETE FROM guides WHERE id = ?`).run(id);
        (0, db_1.getDb)().prepare(`DELETE FROM guide_progress WHERE guide_id = ?`).run(id);
        (0, db_1.getDb)().prepare(`DELETE FROM guide_health WHERE guide_id = ?`).run(id);
        (0, db_1.getDb)().prepare(`DELETE FROM guide_refreshes WHERE guide_id = ?`).run(id);
        /**
         * Collection membership goes with it. Done in raw SQL rather than through CollectionStore
         * because that store already imports this one, and a mutual import would be a cycle for
         * one DELETE. The reverse direction — pruning a dangling row on read — lives there.
         */
        (0, db_1.getDb)().prepare(`DELETE FROM guide_collection_items WHERE guide_id = ?`).run(id);
        /**
         * Filing and tags go the same way, and for the same reason a dangling collection row is
         * pruned: a folder whose count includes a guide that no longer exists is a folder the
         * Maker cannot empty. Raw SQL here rather than through LibraryOrganizationStore, matching
         * the line above — that store has no business being imported for two DELETEs.
         */
        (0, db_1.getDb)().prepare(`DELETE FROM library_folder_items WHERE item_kind = 'guide' AND item_id = ?`).run(id);
        (0, db_1.getDb)().prepare(`DELETE FROM library_tag_items WHERE item_kind = 'guide' AND item_id = ?`).run(id);
    }
    /**
     * Move, resize or clear the marks on one step. Marks are pure presentation — nothing
     * downstream of the redaction gate changes, because they never touch the stored pixels (§7.2).
     */
    setStepAnnotations(guideId, stepId, annotations) {
        const result = this.getOrError(guideId);
        if (!result.ok)
            throw new Error(result.error);
        const parsed = schema_1.AnnotationSchema.array().max(16).safeParse(annotations ?? []);
        if (!parsed.success)
            throw new Error(`invalid annotation: ${parsed.error.issues[0]?.message ?? 'unknown error'}`);
        const step = result.guide.steps.find((s) => s.id === stepId);
        if (!step)
            throw new Error('step not found in this guide');
        step.annotations = parsed.data;
        this.save(result.guide, this.sessionIdOf(guideId));
        return parsed.data;
    }
    /**
     * Rewrite the model-authored prose on one step. Selectors, URL patterns and stored pixels
     * stay put — a typo in the title is not a reason to re-open the redaction gate.
     */
    setStepCopy(guideId, stepId, copy) {
        const result = this.getOrError(guideId);
        if (!result.ok)
            throw new Error(result.error);
        const step = result.guide.steps.find((s) => s.id === stepId);
        if (!step)
            throw new Error('step not found in this guide');
        if (copy.title !== undefined) {
            const title = copy.title.trim();
            if (!title)
                throw new Error('a step needs a title');
            if (title.length > 240)
                throw new Error('title is too long');
            step.title = title;
        }
        if (copy.body !== undefined) {
            if (copy.body.length > 8000)
                throw new Error('body is too long');
            step.body = copy.body;
        }
        if (copy.why !== undefined) {
            const why = (copy.why ?? '').trim();
            if (why.length > 4000)
                throw new Error('why is too long');
            step.why = why || undefined;
        }
        this.save(result.guide, this.sessionIdOf(guideId));
        return { title: step.title, body: step.body, why: step.why };
    }
    /** Load the source bitmap and reversible editor document, never the already-rendered copy. */
    loadAnnotationProject(guideId, stepId) {
        const result = this.getOrError(guideId);
        if (!result.ok)
            throw new Error(result.error);
        const step = result.guide.steps.find((candidate) => candidate.id === stepId);
        if (!step)
            throw new Error('step not found in this guide');
        if (!step.annotationProject)
            return null;
        const stored = (0, AnnotationProject_1.parseStoredAnnotationProject)(ScreenshotStore_1.screenshotStore.readJson(step.annotationProject));
        const baseDataUri = ScreenshotStore_1.screenshotStore.readDataUri(stored.sourceScreenshot);
        if (!baseDataUri)
            throw new Error('the source screenshot for this annotation project is missing');
        return { project: stored.project, baseDataUri };
    }
    /**
     * Save a new rendered PNG and the editable sidecar, then atomically repoint the guide step.
     * The reviewed source bitmap is never overwritten. Re-editing replaces only prior derived
     * output, so removing an arrow next week is still possible without keeping duplicate sources.
     */
    saveAnnotationProject(guideId, stepId, projectValue, renderedDataUri) {
        if (renderedDataUri.length > 48 * 1024 * 1024)
            throw new Error('rendered annotation image is too large');
        const project = (0, AnnotationProject_1.parseAnnotationProject)(projectValue);
        const result = this.getOrError(guideId);
        if (!result.ok)
            throw new Error(result.error);
        const step = result.guide.steps.find((candidate) => candidate.id === stepId);
        if (!step || !step.screenshot)
            throw new Error('this step has no screenshot to annotate');
        const previousOutput = step.screenshot;
        const previousProjectPath = step.annotationProject;
        const previousStored = previousProjectPath
            ? (0, AnnotationProject_1.parseStoredAnnotationProject)(ScreenshotStore_1.screenshotStore.readJson(previousProjectPath))
            : null;
        const sourceScreenshot = previousStored?.sourceScreenshot ?? previousOutput;
        const directory = sourceScreenshot.split('/')[0];
        if (!directory)
            throw new Error('invalid source screenshot path');
        const screenshot = ScreenshotStore_1.screenshotStore.writeDataUri(directory, renderedDataUri, 'annotated');
        if (!screenshot)
            throw new Error('the editor did not produce a PNG');
        let projectPath;
        try {
            projectPath = ScreenshotStore_1.screenshotStore.writeJson(directory, { sourceScreenshot, project }, 'annotation-project');
        }
        catch (error) {
            ScreenshotStore_1.screenshotStore.delete(screenshot);
            throw error;
        }
        step.screenshot = screenshot;
        step.annotationProject = projectPath;
        // Legacy semantic marks were imported into the project by the renderer and are now pixels.
        step.annotations = [];
        this.save(result.guide, this.sessionIdOf(guideId));
        if (previousOutput !== sourceScreenshot && previousOutput !== screenshot)
            ScreenshotStore_1.screenshotStore.delete(previousOutput);
        if (previousProjectPath && previousProjectPath !== projectPath)
            ScreenshotStore_1.screenshotStore.delete(previousProjectPath);
        return { screenshot, projectPath };
    }
    /** Remember the last video preset used, so re-rendering does not mean re-choosing. */
    setVideoPreset(guideId, video) {
        const result = this.getOrError(guideId);
        if (!result.ok)
            throw new Error(result.error);
        result.guide.video = video;
        this.save(result.guide, this.sessionIdOf(guideId));
    }
    // ---------------------------------------------------------------- health
    /**
     * Store the latest check-run report (docs/competitor-features.md §14). Report-only, the
     * same rule as the guide audit: a health check may say a step is broken; it may never
     * change the step. A stepId that names no step in the guide is dropped rather than stored —
     * the same fate as a hallucinated audit finding.
     */
    saveHealth(guideId, steps) {
        const result = this.getOrError(guideId);
        if (!result.ok)
            throw new Error(result.error);
        const known = new Set(result.guide.steps.map((s) => s.id));
        const clean = (Array.isArray(steps) ? steps : [])
            .filter((raw) => !!raw && typeof raw === 'object')
            .map((raw) => ({
            stepId: typeof raw.stepId === 'string' ? raw.stepId : '',
            via: raw.via === 'selector' || raw.via === 'a11y' || raw.via === 'ai' ? raw.via : 'none',
            selectorIndex: typeof raw.selectorIndex === 'number' && Number.isInteger(raw.selectorIndex) ? raw.selectorIndex : -1,
            urlMatched: raw.urlMatched !== false,
            repaired: raw.repaired === true,
        }))
            .filter((entry) => known.has(entry.stepId));
        if (!clean.length)
            throw new Error('the report names no step in this guide');
        const health = { checkedAt: new Date().toISOString(), steps: clean };
        (0, db_1.getDb)()
            .prepare(`INSERT INTO guide_health (guide_id, checked_at, report) VALUES (?, ?, ?)
         ON CONFLICT(guide_id) DO UPDATE SET checked_at = excluded.checked_at, report = excluded.report`)
            .run(guideId, health.checkedAt, JSON.stringify(clean));
        return health;
    }
    health(guideId) {
        const row = (0, db_1.getDb)().prepare(`SELECT checked_at, report FROM guide_health WHERE guide_id = ?`).get(guideId);
        if (!row)
            return null;
        const steps = safeJson(row.report);
        return Array.isArray(steps) ? { checkedAt: row.checked_at, steps: steps } : null;
    }
    // ---------------------------------------------------------------- refreshes
    /**
     * Stash a re-shot screenshot as a pending proposal (the stale-step refresh).
     *
     * The guide is deliberately not touched here. A pending refresh lives in its own table and
     * its own file; every export reads the guide, so the new pixels are unreachable from any
     * export path until `applyRefresh` — which is the Maker's review — swaps the pointer. This
     * is the same shape as the studio's burn gate: the unreviewed thing has no path out.
     */
    stashRefresh(guideId, stepId, dataUri, targetRect) {
        const result = this.getOrError(guideId);
        if (!result.ok)
            throw new Error(result.error);
        const step = result.guide.steps.find((s) => s.id === stepId);
        if (!step)
            throw new Error('step not found in this guide');
        if (dataUri.length > exports.MAX_RESHOOT_BYTES)
            throw new Error('screenshot too large');
        /**
         * The new file lives beside the step's existing screenshot, in the same store directory,
         * so one sweep covers both. A step that never had a screenshot borrows a sibling's home;
         * a guide with no screenshots at all has nowhere sensible to put pixels and says so.
         */
        const anchor = step.screenshot ?? result.guide.steps.find((s) => s.screenshot)?.screenshot;
        if (!anchor)
            throw new Error('this guide has no screenshots to refresh');
        const dir = anchor.split('/')[0];
        const written = ScreenshotStore_1.screenshotStore.writeDataUri(dir, dataUri, 'refresh');
        if (!written)
            throw new Error('not a PNG screenshot');
        // A second re-shoot of the same step replaces the first proposal, file and all.
        const previous = (0, db_1.getDb)()
            .prepare(`SELECT new_screenshot FROM guide_refreshes WHERE guide_id = ? AND step_id = ?`)
            .get(guideId, stepId);
        if (previous)
            ScreenshotStore_1.screenshotStore.delete(previous.new_screenshot);
        (0, db_1.getDb)()
            .prepare(`INSERT INTO guide_refreshes (guide_id, step_id, old_screenshot, new_screenshot, target_rect, created_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(guide_id, step_id) DO UPDATE SET
           old_screenshot = excluded.old_screenshot,
           new_screenshot = excluded.new_screenshot,
           target_rect    = excluded.target_rect,
           created_at     = excluded.created_at`)
            .run(guideId, stepId, step.screenshot ?? '', written, targetRect ? JSON.stringify(targetRect) : null);
    }
    pendingRefreshes(guideId) {
        const rows = (0, db_1.getDb)()
            .prepare(`SELECT step_id, old_screenshot, new_screenshot, target_rect, created_at FROM guide_refreshes WHERE guide_id = ?`)
            .all(guideId);
        return rows.map((row) => ({
            stepId: row.step_id,
            oldScreenshot: row.old_screenshot,
            newScreenshot: row.new_screenshot,
            targetRect: row.target_rect ? (safeJson(row.target_rect) ?? null) : null,
            createdAt: row.created_at,
        }));
    }
    /**
     * The approval — the review this capture path gets, so it only ever runs from an explicit
     * click on the reviewed image. Swaps the step's screenshot to the re-shot file and
     * re-derives the step's marks from the freshly measured target rect, reconstructing the
     * annotation style from the marks already on the step so the guide keeps its look. The old
     * file is left in place: the recording session may still reference it.
     */
    applyRefresh(guideId, stepId) {
        const pending = this.pendingRefreshes(guideId).find((p) => p.stepId === stepId);
        if (!pending)
            throw new Error('nothing pending for this step');
        const result = this.getOrError(guideId);
        if (!result.ok)
            throw new Error(result.error);
        const index = result.guide.steps.findIndex((s) => s.id === stepId);
        if (index < 0)
            throw new Error('step not found in this guide');
        const step = result.guide.steps[index];
        step.screenshot = pending.newScreenshot;
        if (step.annotations.length) {
            const hasBox = step.annotations.some((a) => a.kind === 'box');
            const hasArrow = step.annotations.some((a) => a.kind === 'arrow');
            const settings = {
                enabled: true,
                style: hasBox && hasArrow ? 'arrow-box' : hasBox ? 'box' : 'arrow',
                color: step.annotations.find((a) => a.color)?.color ?? '#e8453f',
                numbered: step.annotations.some((a) => a.kind === 'badge'),
                callouts: step.annotations.some((a) => a.kind === 'arrow' && !!a.label),
            };
            step.annotations = (0, annotations_1.deriveAnnotations)(pending.targetRect ?? undefined, index, settings, step.title);
        }
        this.save(result.guide, this.sessionIdOf(guideId));
        (0, db_1.getDb)().prepare(`DELETE FROM guide_refreshes WHERE guide_id = ? AND step_id = ?`).run(guideId, stepId);
    }
    /** The other verdict. The proposed file is deleted; the guide was never touched. */
    discardRefresh(guideId, stepId) {
        const pending = this.pendingRefreshes(guideId).find((p) => p.stepId === stepId);
        if (!pending)
            return;
        ScreenshotStore_1.screenshotStore.delete(pending.newScreenshot);
        (0, db_1.getDb)().prepare(`DELETE FROM guide_refreshes WHERE guide_id = ? AND step_id = ?`).run(guideId, stepId);
    }
    // ---------------------------------------------------------------- progress
    /** Progress is per guide and resumable across sessions (§7.6). */
    setProgress(guideId, stepId, state) {
        (0, db_1.getDb)()
            .prepare(`INSERT INTO guide_progress (guide_id, step_id, state, updated_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(guide_id, step_id) DO UPDATE SET state = excluded.state, updated_at = datetime('now')`)
            .run(guideId, stepId, state);
    }
    progress(guideId) {
        const rows = (0, db_1.getDb)().prepare(`SELECT step_id, state FROM guide_progress WHERE guide_id = ?`).all(guideId);
        return Object.fromEntries(rows.map((r) => [r.step_id, r.state]));
    }
    clearProgress(guideId) {
        (0, db_1.getDb)().prepare(`DELETE FROM guide_progress WHERE guide_id = ?`).run(guideId);
    }
}
exports.GuideStore = GuideStore;
function safeJson(raw) {
    try {
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
exports.guideStore = new GuideStore();
//# sourceMappingURL=GuideStore.js.map