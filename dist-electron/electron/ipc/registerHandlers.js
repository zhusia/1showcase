"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerHandlers = registerHandlers;
const electron_1 = require("electron");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const channels_1 = require("./channels");
const GuideSessionStore_1 = require("../showcasetool/GuideSessionStore");
const GuideStore_1 = require("../showcasetool/GuideStore");
const RedactionService_1 = require("../showcasetool/RedactionService");
const ScreenshotStore_1 = require("../showcasetool/ScreenshotStore");
const GeneratorService_1 = require("../showcasetool/GeneratorService");
const annotationBake_1 = require("../showcasetool/annotationBake");
const VideoRenderService_1 = require("../showcasetool/VideoRenderService");
const videoExport_1 = require("../showcasetool/videoExport");
const MachineRecorderService_1 = require("../showcasetool/MachineRecorderService");
const machineCapture_1 = require("../showcasetool/machineCapture");
const StudioService_1 = require("../showcasetool/StudioService");
const regionSelect_1 = require("../showcasetool/regionSelect");
const ChromiumRecorder_1 = require("../showcasetool/ChromiumRecorder");
const pptx_1 = require("../showcasetool/pptx");
const exporters_1 = require("../showcasetool/exporters");
const scorm_1 = require("../showcasetool/scorm");
const personalize_1 = require("../showcasetool/personalize");
const guideNarration_1 = require("../showcasetool/guideNarration");
const SceneAssetService_1 = require("../showcasetool/SceneAssetService");
const pdfExport_1 = require("../showcasetool/pdfExport");
const CollectionStore_1 = require("../showcasetool/CollectionStore");
const LibraryOrganizationStore_1 = require("../showcasetool/LibraryOrganizationStore");
const exporters_2 = require("../showcasetool/exporters");
const TtsService_1 = require("../showcasetool/TtsService");
const HarvestDestinations_1 = require("../showcasetool/HarvestDestinations");
const AiProviderService_1 = require("../services/AiProviderService");
const CredentialVault_1 = require("../services/CredentialVault");
const ExtensionRelayService_1 = require("../services/ExtensionRelayService");
const LicenseService_1 = require("../services/LicenseService");
const extensionBundle_1 = require("../showcasetool/extensionBundle");
const lemonsqueezy_1 = require("../config/lemonsqueezy");
const links_1 = require("../config/links");
const updater_1 = require("../updater");
const analytics_1 = require("../analytics");
const AnnotationShareService_1 = require("../showcasetool/AnnotationShareService");
const AnnotationProject_1 = require("../showcasetool/AnnotationProject");
function ok(data) {
    return { ok: true, data };
}
function pngBytes(dataUri) {
    if (typeof dataUri !== 'string' || dataUri.length > 48 * 1024 * 1024)
        return null;
    const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUri.trim());
    return match ? Buffer.from(match[1], 'base64') : null;
}
function safePngName(value) {
    const stem = String(value || 'annotated-screenshot')
        .replace(/\.png$/i, '')
        .replace(/[^a-z0-9 _.-]+/gi, '-')
        .trim()
        .slice(0, 100) || 'annotated-screenshot';
    return `${stem}.png`;
}
function safeProjectName(value) {
    const stem = String(value || 'annotation-project')
        .replace(/(?:\.1showcase)?\.json$/i, '')
        .replace(/[^a-z0-9 _.-]+/gi, '-')
        .trim()
        .slice(0, 100) || 'annotation-project';
    return `${stem}.1showcase.json`;
}
function pinnedImageHtml(src) {
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
    <style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#0b0e14;color:#e6edf3;font:12px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif}body{display:grid;grid-template-rows:1fr 34px}.stage{min-height:0;display:grid;place-items:center}.stage img{display:block;max-width:100%;max-height:100%;object-fit:contain}.controls{display:flex;align-items:center;gap:8px;padding:0 10px;background:#131a24;border-top:1px solid #1e2733}.controls input{flex:1;accent-color:#22b8d6}</style>
    </head><body><div class="stage"><img id="shot" src="${src}" alt="Pinned screenshot"></div><label class="controls">Opacity <input aria-label="Image opacity" type="range" min="15" max="100" value="100" oninput="document.getElementById('shot').style.opacity=this.value/100"><span>always on top</span></label></body></html>`;
}
/**
 * The most tiles one poster request will decode. The library pages at eight rows a group and
 * shows at most three groups, so this is well clear of a real screen — it is here because the
 * list arrives from the renderer, and a bound on work someone else asks for is not optional.
 */
const POSTER_BATCH_CAP = 64;
/** In-flight video renders, so a second request or a Cancel press can stop the first. */
const videoRenders = new Map();
/** Wrap a handler so a thrown error becomes a typed failure instead of an unhandled reject. */
function handle(channel, fn) {
    electron_1.ipcMain.handle(channel, async (_event, ...args) => {
        try {
            return ok(await fn(...args));
        }
        catch (err) {
            // Coerced, not cast: a thrown string or a rejected non-Error otherwise reaches the
            // renderer as `error: undefined`, which unwrap() renders as the useless "undefined".
            const message = err instanceof Error ? err.message : String(err);
            return { ok: false, error: message || 'unknown error' };
        }
    });
}
function registerHandlers() {
    // Renderer → main, so it is an `ipcMain.on` rather than a `handle`. Wired once here because
    // listeners accumulate: registering per call would answer one drag ten times over.
    (0, regionSelect_1.registerRegionSelect)();
    (0, ChromiumRecorder_1.registerChromiumRecorder)();
    // Drag-out has to be a send event: Chromium starts the native drag synchronously from the
    // originating pointer gesture. A promise-returning invoke loses that gesture on macOS.
    electron_1.ipcMain.on(channels_1.CHANNELS.annotations.startDrag, (event, dataUri, suggestedName) => {
        const png = pngBytes(dataUri);
        if (!png)
            return;
        const dir = path_1.default.join(electron_1.app.getPath('temp'), '1showcasetool-drag');
        fs_1.default.mkdirSync(dir, { recursive: true });
        const file = path_1.default.join(dir, safePngName(suggestedName));
        fs_1.default.writeFileSync(file, png);
        const source = electron_1.nativeImage.createFromBuffer(png);
        const icon = source.isEmpty() ? electron_1.nativeImage.createEmpty() : source.resize({ width: 96, quality: 'good' });
        event.sender.startDrag({ file, icon });
    });
    // ---------------------------------------------------------------- sessions
    handle(channels_1.CHANNELS.sessions.list, () => GuideSessionStore_1.guideSessionStore.list());
    handle(channels_1.CHANNELS.sessions.get, (sessionId) => GuideSessionStore_1.guideSessionStore.get(sessionId));
    handle(channels_1.CHANNELS.sessions.rename, (sessionId, title) => {
        GuideSessionStore_1.guideSessionStore.rename(sessionId, title);
        return true;
    });
    handle(channels_1.CHANNELS.sessions.delete, (sessionId) => {
        GuideSessionStore_1.guideSessionStore.delete(sessionId);
        const usedSceneIds = GuideSessionStore_1.guideSessionStore.studioSceneAssetIds();
        if (usedSceneIds)
            (0, SceneAssetService_1.sweepScenes)(usedSceneIds);
        return true;
    });
    handle(channels_1.CHANNELS.sessions.setPrompt, (sessionId, prompt, audience) => {
        GuideSessionStore_1.guideSessionStore.setPrompt(sessionId, prompt, audience);
        return true;
    });
    /** Presentation config, so it does not re-open the redaction gate the way a content edit does. */
    handle(channels_1.CHANNELS.sessions.setCustomize, (sessionId, customize) => GuideSessionStore_1.guideSessionStore.setCustomize(sessionId, customize));
    // ---------------------------------------------------------------- redaction
    /**
     * Opening the review screen re-derives warnings against current content and applies any
     * saved project rules, so the Maker sees what is still outstanding rather than what was
     * true at capture time.
     */
    handle(channels_1.CHANNELS.redaction.review, (sessionId) => {
        RedactionService_1.redactionService.applyProjectRules(sessionId);
        const warningCount = RedactionService_1.redactionService.recomputeWarnings(sessionId);
        const session = GuideSessionStore_1.guideSessionStore.get(sessionId);
        if (!session)
            throw new Error('session not found');
        /**
         * The take these steps were cut from, when there still is one. It rides on the review payload
         * rather than being asked for separately so the screen knows on its first paint whether the
         * crossing to the editor exists — a button that appears a beat late reads as a glitch, and one
         * that appears for a recording with no footage is a dead end.
         */
        return {
            session,
            warningCount,
            rules: RedactionService_1.redactionService.listRules(),
            footage: StudioService_1.studioService.footage(sessionId),
            assessments: GuideSessionStore_1.guideSessionStore.assessments(sessionId),
        };
    });
    /**
     * The gate (§7.2 Layer 2). `viewedStepIds` matters only for a machine recording: that
     * source has no Layer 1, so nothing was redacted automatically and the Maker's own eyes
     * over every screenshot *are* the first layer. Enforced here rather than in the renderer,
     * because a renderer bug must not be able to skip the pass.
     *
     * `force` is the Maker overriding that precondition, and it is a separate argument rather than
     * a relaxation of the check: the default still refuses, so every existing caller keeps the
     * stricter behaviour and a bypass has to be asked for in as many words. What it skips is
     * "has every frame been opened", never the acknowledgement itself — nothing downstream
     * loses its gate, and an edit afterwards still re-opens this one.
     */
    handle(channels_1.CHANNELS.redaction.acknowledge, (sessionId, viewedStepIds, force) => {
        const session = GuideSessionStore_1.guideSessionStore.get(sessionId);
        if (!session)
            throw new Error('session not found');
        const kept = session.steps.filter((s) => !s.dropped);
        if (!kept.length)
            throw new Error('every step has been dropped — nothing left to generate');
        if (session.source === 'machine' && force !== true) {
            const viewed = new Set(Array.isArray(viewedStepIds) ? viewedStepIds : []);
            const unseen = kept.filter((step) => !viewed.has(step.id));
            if (unseen.length) {
                throw new Error(`This was recorded from a desktop window, so nothing was redacted automatically. Open all ${kept.length} screenshots at full size first — ${unseen.length} still unopened.`);
            }
        }
        return GuideSessionStore_1.guideSessionStore.acknowledgeRedaction(sessionId);
    });
    handle(channels_1.CHANNELS.redaction.maskValue, (sessionId, value, placeholder) => RedactionService_1.redactionService.maskValue(sessionId, value, placeholder));
    handle(channels_1.CHANNELS.redaction.paintScreenshot, (sessionId, stepId, dataUri) => RedactionService_1.redactionService.paintScreenshot(sessionId, stepId, dataUri));
    /** Separate from paint because a crop re-bases the step's measured target rect. */
    handle(channels_1.CHANNELS.redaction.cropScreenshot, (sessionId, stepId, dataUri, crop) => RedactionService_1.redactionService.cropScreenshot(sessionId, stepId, dataUri, crop));
    handle(channels_1.CHANNELS.redaction.dropStep, (sessionId, stepId, dropped) => {
        const step = GuideSessionStore_1.guideSessionStore.step(stepId);
        if (!step || step.sessionId !== sessionId)
            throw new Error('step does not belong to session');
        GuideSessionStore_1.guideSessionStore.setDropped(stepId, dropped);
        GuideSessionStore_1.guideSessionStore.invalidateAcknowledgement(sessionId);
        return true;
    });
    handle(channels_1.CHANNELS.redaction.setStepOutputs, (sessionId, stepId, outputs) => {
        const step = GuideSessionStore_1.guideSessionStore.step(stepId);
        if (!step || step.sessionId !== sessionId)
            throw new Error('step does not belong to session');
        for (const output of outputs) {
            if (!/^connector:[a-z0-9_-]+\/[a-z0-9_-]+$/i.test(output.target)) {
                throw new Error(`invalid target "${output.target}" — expected connector:<name>/<field>`);
            }
            // A declaration carries a selector and a destination. Never a value (§7.6).
            if ('value' in output)
                throw new Error('an output declaration must not contain a value');
        }
        GuideSessionStore_1.guideSessionStore.setStepOutputs(stepId, outputs);
        return true;
    });
    /**
     * Chapter and branch declarations. Structural, so they are Maker-authored here rather than
     * model-authored at generation — the same rule harvest outputs follow.
     *
     * Neither invalidates the redaction acknowledgement: grouping steps and labelling a jump
     * cannot expose anything the review pass already destroyed. Dropping or editing content
     * still does.
     */
    handle(channels_1.CHANNELS.redaction.setStepChapter, (sessionId, stepId, chapter) => {
        const step = GuideSessionStore_1.guideSessionStore.step(stepId);
        if (!step || step.sessionId !== sessionId)
            throw new Error('step does not belong to session');
        GuideSessionStore_1.guideSessionStore.setStepChapter(stepId, typeof chapter === 'string' ? chapter : '');
        return true;
    });
    handle(channels_1.CHANNELS.redaction.setStepBranches, (sessionId, stepId, branches) => {
        const step = GuideSessionStore_1.guideSessionStore.step(stepId);
        if (!step || step.sessionId !== sessionId)
            throw new Error('step does not belong to session');
        const ids = new Set(GuideSessionStore_1.guideSessionStore.steps(sessionId).map((s) => s.id));
        for (const branch of branches) {
            // Same three rules the guide schema enforces, applied at declaration time so the Maker
            // is told immediately rather than at generation.
            if (!branch.label?.trim())
                throw new Error('every branch needs a label');
            if (!ids.has(branch.goto))
                throw new Error(`"${branch.goto}" is not a step in this recording`);
            if (branch.goto === stepId)
                throw new Error('a step cannot branch to itself');
            if ('value' in branch)
                throw new Error('a branch must not contain a value');
        }
        GuideSessionStore_1.guideSessionStore.setStepBranches(stepId, branches);
        return true;
    });
    handle(channels_1.CHANNELS.redaction.setStepAltSelectors, (sessionId, stepId, altSelectors) => {
        const step = GuideSessionStore_1.guideSessionStore.step(stepId);
        if (!step || step.sessionId !== sessionId)
            throw new Error('step does not belong to session');
        const list = Array.isArray(altSelectors) ? altSelectors.filter((one) => typeof one === 'string' && one.trim().length > 0).slice(0, 12) : [];
        GuideSessionStore_1.guideSessionStore.setStepAltSelectors(stepId, list);
        return true;
    });
    handle(channels_1.CHANNELS.redaction.setAssessments, (sessionId, assessments) => {
        GuideSessionStore_1.guideSessionStore.setAssessments(sessionId, assessments);
        return true;
    });
    /** Presentation metadata only: it does not touch pixels or weaken the redaction gate. */
    handle(channels_1.CHANNELS.redaction.setStepKeystrokes, (sessionId, stepId, keystrokes) => {
        const step = GuideSessionStore_1.guideSessionStore.step(stepId);
        if (!step || step.sessionId !== sessionId)
            throw new Error('step does not belong to session');
        return GuideSessionStore_1.guideSessionStore.setStepKeystrokes(stepId, keystrokes);
    });
    handle(channels_1.CHANNELS.redaction.listRules, () => RedactionService_1.redactionService.listRules());
    handle(channels_1.CHANNELS.redaction.addRule, (rule) => RedactionService_1.redactionService.addRule(rule));
    handle(channels_1.CHANNELS.redaction.deleteRule, (id) => {
        RedactionService_1.redactionService.deleteRule(id);
        return true;
    });
    /** The renderer needs pixels to paint on; it gets them as a data URI, not a file path. */
    handle(channels_1.CHANNELS.redaction.screenshotDataUri, (relative) => ScreenshotStore_1.screenshotStore.readDataUri(relative));
    handle(channels_1.CHANNELS.redaction.loadAnnotationProject, (sessionId, stepId) => GuideSessionStore_1.guideSessionStore.loadAnnotationProject(sessionId, stepId));
    handle(channels_1.CHANNELS.redaction.saveAnnotationProject, (sessionId, stepId, project, renderedDataUri) => GuideSessionStore_1.guideSessionStore.saveAnnotationProject(sessionId, stepId, project, renderedDataUri));
    // ---------------------------------------------------------------- generator
    handle(channels_1.CHANNELS.generator.routes, () => GeneratorService_1.generatorService.routes());
    handle(channels_1.CHANNELS.generator.rescan, () => {
        GeneratorService_1.generatorService.rescanTransports();
        return GeneratorService_1.generatorService.routes();
    });
    handle(channels_1.CHANNELS.generator.select, (routeId) => GeneratorService_1.generatorService.selectTransport(routeId));
    /**
     * A second read of the finished prose, on the same transport generation used. Reports only —
     * it never edits the guide, so a misread step costs a dismissable finding, not a rewrite.
     */
    handle(channels_1.CHANNELS.generator.audit, async (guideId) => {
        const result = await GeneratorService_1.generatorService.audit(guideId);
        if (!result.ok)
            throw new Error(result.error);
        return result;
    });
    handle(channels_1.CHANNELS.generator.generate, async (options) => {
        const result = await GeneratorService_1.generatorService.generate(options);
        if (!result.ok)
            throw new Error(result.error);
        return { guide: result.guide, transport: result.transport, variants: result.variants, warnings: result.warnings };
    });
    handle(channels_1.CHANNELS.generator.composeScore, async (request) => {
        const result = await GeneratorService_1.generatorService.composeScore(request);
        if (!result.ok)
            throw new Error(result.error);
        return { score: result.score, transport: result.transport, warning: result.warning };
    });
    // ---------------------------------------------------------------- guides
    handle(channels_1.CHANNELS.guides.list, () => GuideStore_1.guideStore.list());
    handle(channels_1.CHANNELS.guides.get, (id) => {
        const result = GuideStore_1.guideStore.getOrError(id);
        if (!result.ok)
            throw new Error(result.error);
        return result.guide;
    });
    handle(channels_1.CHANNELS.guides.delete, (id) => {
        GuideStore_1.guideStore.delete(id);
        return true;
    });
    handle(channels_1.CHANNELS.guides.clearProgress, (id) => {
        GuideStore_1.guideStore.clearProgress(id);
        return true;
    });
    /** Voices come from the OS, so the panel can only offer what this machine actually has. */
    handle(channels_1.CHANNELS.tts.probe, (force) => TtsService_1.ttsService.probe(!!force));
    // ------------------------------------------------------------- collections
    handle(channels_1.CHANNELS.collections.list, () => CollectionStore_1.collectionStore.list());
    handle(channels_1.CHANNELS.collections.get, (id) => CollectionStore_1.collectionStore.get(id));
    handle(channels_1.CHANNELS.collections.create, (title, intent) => CollectionStore_1.collectionStore.create(title, intent));
    handle(channels_1.CHANNELS.collections.rename, (id, title, intent) => {
        CollectionStore_1.collectionStore.rename(id, title, intent);
        return true;
    });
    handle(channels_1.CHANNELS.collections.delete, (id) => {
        CollectionStore_1.collectionStore.delete(id);
        return true;
    });
    handle(channels_1.CHANNELS.collections.add, (collectionId, guideId) => {
        CollectionStore_1.collectionStore.add(collectionId, guideId);
        return true;
    });
    handle(channels_1.CHANNELS.collections.remove, (collectionId, guideId) => {
        CollectionStore_1.collectionStore.remove(collectionId, guideId);
        return true;
    });
    handle(channels_1.CHANNELS.collections.reorder, (collectionId, guideIds) => {
        CollectionStore_1.collectionStore.reorder(collectionId, guideIds);
        return true;
    });
    handle(channels_1.CHANNELS.collections.export, (id) => exportCollection(id));
    // ----------------------------------------------------- projects, folders, tags
    //
    // Every mutation answers with a fresh snapshot rather than with a bare ok. The tree, the tag
    // chips and the per-row badges are one view of one thing, and a renderer patching its own
    // copy after each call is how a folder count starts disagreeing with the rows beneath it.
    handle(channels_1.CHANNELS.organization.snapshot, () => LibraryOrganizationStore_1.libraryOrganizationStore.snapshot());
    handle(channels_1.CHANNELS.organization.createFolder, (name, parentId) => {
        LibraryOrganizationStore_1.libraryOrganizationStore.createFolder(name, parentId ?? null);
        return LibraryOrganizationStore_1.libraryOrganizationStore.snapshot();
    });
    handle(channels_1.CHANNELS.organization.renameFolder, (id, name, color) => {
        LibraryOrganizationStore_1.libraryOrganizationStore.renameFolder(id, name, color);
        return LibraryOrganizationStore_1.libraryOrganizationStore.snapshot();
    });
    handle(channels_1.CHANNELS.organization.moveFolder, (id, parentId) => {
        LibraryOrganizationStore_1.libraryOrganizationStore.moveFolder(id, parentId ?? null);
        return LibraryOrganizationStore_1.libraryOrganizationStore.snapshot();
    });
    handle(channels_1.CHANNELS.organization.deleteFolder, (id) => {
        const removed = LibraryOrganizationStore_1.libraryOrganizationStore.deleteFolder(id);
        return { ...removed, snapshot: LibraryOrganizationStore_1.libraryOrganizationStore.snapshot() };
    });
    handle(channels_1.CHANNELS.organization.fileItems, (items, folderId) => {
        LibraryOrganizationStore_1.libraryOrganizationStore.fileItems(items ?? [], folderId ?? null);
        return LibraryOrganizationStore_1.libraryOrganizationStore.snapshot();
    });
    handle(channels_1.CHANNELS.organization.ensureTag, (name) => {
        LibraryOrganizationStore_1.libraryOrganizationStore.ensureTag(name);
        return LibraryOrganizationStore_1.libraryOrganizationStore.snapshot();
    });
    handle(channels_1.CHANNELS.organization.renameTag, (id, name, color) => {
        LibraryOrganizationStore_1.libraryOrganizationStore.renameTag(id, name, color);
        return LibraryOrganizationStore_1.libraryOrganizationStore.snapshot();
    });
    handle(channels_1.CHANNELS.organization.deleteTag, (id) => {
        LibraryOrganizationStore_1.libraryOrganizationStore.deleteTag(id);
        return LibraryOrganizationStore_1.libraryOrganizationStore.snapshot();
    });
    handle(channels_1.CHANNELS.organization.tagItems, (items, tagId, on) => {
        LibraryOrganizationStore_1.libraryOrganizationStore.tagItems(items ?? [], tagId, on);
        return LibraryOrganizationStore_1.libraryOrganizationStore.snapshot();
    });
    handle(channels_1.CHANNELS.organization.applyTagInput, (items, raw) => {
        LibraryOrganizationStore_1.libraryOrganizationStore.applyTagInput(items ?? [], raw);
        return LibraryOrganizationStore_1.libraryOrganizationStore.snapshot();
    });
    handle(channels_1.CHANNELS.guides.exportMarkdown, async (id) => exportGuide(id, 'md'));
    handle(channels_1.CHANNELS.guides.exportNarration, async (id) => exportNarration(id));
    handle(channels_1.CHANNELS.guides.exportHtml, async (id, stamp) => exportGuide(id, 'html', stamp));
    handle(channels_1.CHANNELS.guides.exportPdf, async (id) => exportGuide(id, 'pdf'));
    handle(channels_1.CHANNELS.guides.exportScorm, async (id, stamp) => exportGuide(id, 'scorm', stamp));
    handle(channels_1.CHANNELS.guides.exportPptx, async (id) => exportGuide(id, 'pptx'));
    handle(channels_1.CHANNELS.guides.exportBatch, async (ids, format) => exportGuides(ids, format));
    handle(channels_1.CHANNELS.guides.ask, async (id, question) => {
        const result = GuideStore_1.guideStore.getOrError(id);
        if (!result.ok)
            throw new Error(result.error);
        return GeneratorService_1.generatorService.askGuide(result.guide, String(question ?? ''));
    });
    handle(channels_1.CHANNELS.guides.setStepAnnotations, (guideId, stepId, annotations) => GuideStore_1.guideStore.setStepAnnotations(guideId, stepId, annotations));
    handle(channels_1.CHANNELS.guides.setStepCopy, (guideId, stepId, copy) => GuideStore_1.guideStore.setStepCopy(guideId, stepId, copy));
    handle(channels_1.CHANNELS.guides.loadAnnotationProject, (guideId, stepId) => GuideStore_1.guideStore.loadAnnotationProject(guideId, stepId));
    handle(channels_1.CHANNELS.guides.saveAnnotationProject, (guideId, stepId, project, renderedDataUri) => GuideStore_1.guideStore.saveAnnotationProject(guideId, stepId, project, renderedDataUri));
    // ------------------------------------------------------- screenshot annotation utilities
    handle(channels_1.CHANNELS.annotations.exportImage, async (dataUri, suggestedName) => {
        const png = pngBytes(dataUri);
        if (!png)
            throw new Error('the editor did not produce a PNG');
        const chosen = await electron_1.dialog.showSaveDialog({
            title: 'Export annotated image',
            defaultPath: safePngName(suggestedName),
            filters: [{ name: 'PNG image', extensions: ['png'] }],
        });
        if (chosen.canceled || !chosen.filePath)
            return null;
        fs_1.default.writeFileSync(chosen.filePath, png);
        return chosen.filePath;
    });
    handle(channels_1.CHANNELS.annotations.exportProject, async (projectValue, baseDataUri, suggestedName) => {
        const project = (0, AnnotationProject_1.parseAnnotationProject)(projectValue);
        if (!pngBytes(baseDataUri))
            throw new Error('the source screenshot is not a PNG');
        const chosen = await electron_1.dialog.showSaveDialog({
            title: 'Save editable annotation project',
            defaultPath: safeProjectName(suggestedName),
            filters: [{ name: '1ShowcaseTool project', extensions: ['json'] }],
        });
        if (chosen.canceled || !chosen.filePath)
            return null;
        fs_1.default.writeFileSync(chosen.filePath, JSON.stringify({ format: '1showcasetool-annotation', version: 1, project, baseDataUri }, null, 2), 'utf8');
        return chosen.filePath;
    });
    handle(channels_1.CHANNELS.annotations.copyImage, (dataUri) => {
        const png = pngBytes(dataUri);
        if (!png)
            throw new Error('the editor did not produce a PNG');
        const image = electron_1.nativeImage.createFromBuffer(png);
        if (image.isEmpty())
            throw new Error('could not decode the rendered image');
        electron_1.clipboard.writeImage(image);
        return true;
    });
    handle(channels_1.CHANNELS.annotations.pinImage, async (dataUri, title) => {
        const png = pngBytes(dataUri);
        if (!png)
            throw new Error('the editor did not produce a PNG');
        const image = electron_1.nativeImage.createFromBuffer(png);
        const size = image.getSize();
        const scale = Math.min(1, 900 / Math.max(size.width, 1), 700 / Math.max(size.height, 1));
        const win = new electron_1.BrowserWindow({
            width: Math.max(260, Math.round(size.width * scale)),
            height: Math.max(180, Math.round(size.height * scale) + 36),
            minWidth: 180,
            minHeight: 120,
            title: String(title || 'Pinned screenshot').slice(0, 120),
            alwaysOnTop: true,
            resizable: true,
            backgroundColor: '#0b0e14',
            webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
        });
        const html = pinnedImageHtml(`data:image/png;base64,${png.toString('base64')}`);
        await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
        return true;
    });
    handle(channels_1.CHANNELS.annotations.createShare, async (dataUri, options) => {
        const png = pngBytes(dataUri);
        if (!png)
            throw new Error('the editor did not produce a PNG');
        const created = await AnnotationShareService_1.annotationShareService.create(png, {
            password: typeof options?.password === 'string' ? options.password : '',
            expiresMinutes: typeof options?.expiresMinutes === 'number' ? options.expiresMinutes : 60,
            selfDestruct: options?.selfDestruct === true,
        });
        electron_1.clipboard.writeText(created.url);
        return created;
    });
    handle(channels_1.CHANNELS.guides.health, (id) => GuideStore_1.guideStore.health(id));
    handle(channels_1.CHANNELS.guides.pendingRefreshes, (id) => GuideStore_1.guideStore.pendingRefreshes(id));
    handle(channels_1.CHANNELS.guides.applyRefresh, (guideId, stepId) => {
        GuideStore_1.guideStore.applyRefresh(guideId, stepId);
        return true;
    });
    handle(channels_1.CHANNELS.guides.discardRefresh, (guideId, stepId) => {
        GuideStore_1.guideStore.discardRefresh(guideId, stepId);
        return true;
    });
    // ---------------------------------------------------------------- library posters
    /**
     * The grid's tiles, one call for the whole visible page.
     *
     * Batched because a per-card channel would be a dozen round trips on every library refresh,
     * and capped because the request arrives from the renderer: a page is at most a few dozen
     * cards, and a list of ten thousand ids must not turn into ten thousand image decodes.
     *
     * A missing key in the reply is the answer, not an error — a recording whose steps all failed
     * to capture has no frame to show, and the card draws its placeholder instead.
     */
    handle(channels_1.CHANNELS.library.posters, (refs) => {
        const posters = {};
        for (const ref of (Array.isArray(refs) ? refs : []).slice(0, POSTER_BATCH_CAP)) {
            if (!ref || typeof ref.id !== 'string')
                continue;
            if (ref.kind !== 'session' && ref.kind !== 'guide')
                continue;
            try {
                const relative = ref.kind === 'session' ? GuideSessionStore_1.guideSessionStore.posterPath(ref.id) : GuideStore_1.guideStore.posterPath(ref.id);
                if (!relative)
                    continue;
                const thumbnail = ScreenshotStore_1.screenshotStore.readThumbnailDataUri(relative);
                if (thumbnail)
                    posters[`${ref.kind}:${ref.id}`] = thumbnail;
            }
            catch {
                // A poster is decoration. One unreadable file must not fail the other twenty-three.
            }
        }
        return posters;
    });
    // ---------------------------------------------------------------- video
    handle(channels_1.CHANNELS.video.probe, (rescan) => VideoRenderService_1.videoRenderService.probe(rescan === true));
    /**
     * Frame capture takes minutes on a long guide, so the render is cancellable and reports
     * progress on an event channel rather than leaving the window looking hung.
     */
    handle(channels_1.CHANNELS.video.render, async (guideId, overrides) => {
        videoRenders.get(guideId)?.abort();
        const controller = new AbortController();
        videoRenders.set(guideId, controller);
        try {
            return await (0, videoExport_1.renderGuideVideo)(guideId, overrides, (progress) => {
                for (const window of electron_1.BrowserWindow.getAllWindows()) {
                    window.webContents.send(channels_1.CHANNELS.events.videoProgress, { guideId, ...progress });
                }
            }, controller.signal);
        }
        finally {
            if (videoRenders.get(guideId) === controller)
                videoRenders.delete(guideId);
        }
    });
    /** The animated timeline in a throwaway window. Fast enough to need no progress channel. */
    handle(channels_1.CHANNELS.video.preview, (guideId, overrides) => (0, videoExport_1.previewGuideVideo)(guideId, overrides));
    handle(channels_1.CHANNELS.video.cancel, (guideId) => {
        const controller = videoRenders.get(guideId);
        controller?.abort();
        return !!controller;
    });
    // ---------------------------------------------------------------- machine recording
    handle(channels_1.CHANNELS.machine.status, () => MachineRecorderService_1.machineRecorder.status());
    handle(channels_1.CHANNELS.machine.listWindows, () => MachineRecorderService_1.machineRecorder.listWindows());
    handle(channels_1.CHANNELS.machine.openSettings, (target) => (0, machineCapture_1.openPermissionSettings)(target));
    handle(channels_1.CHANNELS.machine.start, (options) => MachineRecorderService_1.machineRecorder.start(options));
    handle(channels_1.CHANNELS.machine.listNativeWindows, () => MachineRecorderService_1.machineRecorder.listNativeWindows());
    handle(channels_1.CHANNELS.machine.captureStep, (note) => MachineRecorderService_1.machineRecorder.captureStep(note));
    handle(channels_1.CHANNELS.machine.setNote, (note) => {
        MachineRecorderService_1.machineRecorder.setNote(note);
        return true;
    });
    handle(channels_1.CHANNELS.machine.stop, () => MachineRecorderService_1.machineRecorder.stop());
    handle(channels_1.CHANNELS.machine.forceStop, (sessionId) => MachineRecorderService_1.machineRecorder.forceStop(sessionId));
    // ---------------------------------------------------------------- studio recording
    handle(channels_1.CHANNELS.machine.capabilities, () => MachineRecorderService_1.machineRecorder.capabilities());
    handle(channels_1.CHANNELS.machine.requestMicrophone, () => MachineRecorderService_1.machineRecorder.requestMicrophone());
    handle(channels_1.CHANNELS.machine.requestAccessibility, () => MachineRecorderService_1.machineRecorder.requestAccessibility());
    handle(channels_1.CHANNELS.machine.listStudioSources, () => MachineRecorderService_1.machineRecorder.listStudioSources());
    handle(channels_1.CHANNELS.machine.startStudio, (options) => MachineRecorderService_1.machineRecorder.startStudio(options));
    handle(channels_1.CHANNELS.machine.requestCamera, () => MachineRecorderService_1.machineRecorder.requestCamera());
    handle(channels_1.CHANNELS.machine.pause, () => MachineRecorderService_1.machineRecorder.pause());
    handle(channels_1.CHANNELS.machine.resume, () => MachineRecorderService_1.machineRecorder.resume());
    handle(channels_1.CHANNELS.machine.selectRegion, () => (0, regionSelect_1.selectRegion)());
    handle(channels_1.CHANNELS.studio.get, (sessionId) => StudioService_1.studioService.get(sessionId));
    handle(channels_1.CHANNELS.studio.save, (payload) => StudioService_1.studioService.save(payload.sessionId, payload.project));
    handle(channels_1.CHANNELS.studio.review, (sessionId) => StudioService_1.studioService.review(sessionId));
    handle(channels_1.CHANNELS.studio.chooseExportPath, (payload) => StudioService_1.studioService.chooseExportPath(payload.sessionId, payload.suggested));
    handle(channels_1.CHANNELS.studio.stashRender, (bytes) => StudioService_1.studioService.stashRender(bytes));
    handle(channels_1.CHANNELS.studio.stashScore, (bytes) => StudioService_1.studioService.stashScore(bytes));
    handle(channels_1.CHANNELS.studio.finishExport, (payload) => StudioService_1.studioService.finishExport(payload));
    handle(channels_1.CHANNELS.studio.speechEnvelope, (sessionId) => StudioService_1.studioService.speechEnvelope(sessionId));
    handle(channels_1.CHANNELS.studio.transcribe, (sessionId) => StudioService_1.studioService.transcribe(sessionId));
    handle(channels_1.CHANNELS.studio.analyzeLoudness, (sessionId) => StudioService_1.studioService.analyzeLoudness(sessionId));
    handle(channels_1.CHANNELS.studio.exportCaptions, (sessionId, format) => StudioService_1.studioService.exportCaptions(sessionId, format));
    handle(channels_1.CHANNELS.studio.importCaptions, (sessionId) => StudioService_1.studioService.importCaptions(sessionId));
    handle(channels_1.CHANNELS.studio.copyExport, (payload) => StudioService_1.studioService.copyExport(payload.sessionId, payload.outPath));
    handle(channels_1.CHANNELS.studio.importScene, () => (0, SceneAssetService_1.importScene)());
    handle(channels_1.CHANNELS.studio.getPrefs, () => StudioService_1.studioService.getPrefs());
    handle(channels_1.CHANNELS.studio.setPrefs, (prefs) => StudioService_1.studioService.setPrefs(prefs));
    handle(channels_1.CHANNELS.studio.revealExport, (payload) => StudioService_1.studioService.revealExport(payload.sessionId, payload.outPath));
    handle(channels_1.CHANNELS.studio.discardMedia, (sessionId) => StudioService_1.studioService.discardMedia(sessionId));
    handle(channels_1.CHANNELS.studio.discardQuarantine, (sessionId) => StudioService_1.studioService.discardQuarantine(sessionId));
    /**
     * The editor's crossing into the guide half of the app: the composited frame under the playhead
     * becomes a step. The bytes are already mask-burned by the compositor that drew them, and this
     * re-opens the redaction gate because a new frame has been through the studio's pass and not the
     * guide's — see `StudioService.captureStep`.
     */
    handle(channels_1.CHANNELS.studio.captureStep, (payload) => StudioService_1.studioService.captureStep(payload));
    handle(channels_1.CHANNELS.studio.saveSnapshot, (payload) => StudioService_1.studioService.saveSnapshot(payload.sessionId, payload.name));
    handle(channels_1.CHANNELS.studio.listSnapshots, (sessionId) => StudioService_1.studioService.listSnapshots(sessionId));
    handle(channels_1.CHANNELS.studio.restoreSnapshot, (payload) => StudioService_1.studioService.restoreSnapshot(payload.sessionId, payload.id));
    handle(channels_1.CHANNELS.studio.listExportPresets, () => StudioService_1.studioService.listExportPresets());
    handle(channels_1.CHANNELS.studio.saveExportPreset, (payload) => StudioService_1.studioService.saveExportPreset(payload.name, payload.settings));
    handle(channels_1.CHANNELS.studio.deleteExportPreset, (id) => StudioService_1.studioService.deleteExportPreset(id));
    handle(channels_1.CHANNELS.studio.saveThumbnail, (payload) => StudioService_1.studioService.saveThumbnail(payload.sessionId, payload.dataUri));
    // ---------------------------------------------------------------- provider
    handle(channels_1.CHANNELS.provider.getConfig, () => AiProviderService_1.aiProviderService.getConfig());
    handle(channels_1.CHANNELS.provider.setConfig, (config) => {
        AiProviderService_1.aiProviderService.setConfig(config);
        return true;
    });
    handle(channels_1.CHANNELS.provider.setApiKey, async (provider, key) => {
        await AiProviderService_1.aiProviderService.setApiKey(provider, key);
        return true;
    });
    handle(channels_1.CHANNELS.provider.clearApiKey, async (provider) => {
        await AiProviderService_1.aiProviderService.clearApiKey(provider);
        return true;
    });
    handle(channels_1.CHANNELS.provider.status, async () => {
        const config = AiProviderService_1.aiProviderService.getConfig();
        return { config, hasKey: config ? await AiProviderService_1.aiProviderService.hasApiKey(config.id) : false };
    });
    // ---------------------------------------------------------------- harvest
    handle(channels_1.CHANNELS.harvest.getDestination, () => (0, HarvestDestinations_1.getDestination)());
    handle(channels_1.CHANNELS.harvest.setDestination, (config) => {
        (0, HarvestDestinations_1.setDestination)(config);
        return true;
    });
    /** Key names only — the vault never hands values to the renderer. */
    handle(channels_1.CHANNELS.harvest.listVaultKeys, () => CredentialVault_1.credentialVault.listKeys());
    // ---------------------------------------------------------------- relay
    handle(channels_1.CHANNELS.relay.status, () => ({
        port: ExtensionRelayService_1.extensionRelay.activePort(),
        pendingPairOrigin: ExtensionRelayService_1.extensionRelay.pendingPairOrigin(),
    }));
    handle(channels_1.CHANNELS.relay.rotateToken, () => {
        ExtensionRelayService_1.extensionRelay.rotateToken();
        return true;
    });
    handle(channels_1.CHANNELS.relay.resolvePairing, (approved) => ExtensionRelayService_1.extensionRelay.resolvePairRequest(approved));
    // ---------------------------------------------------------------- extension (bundled MV3)
    handle(channels_1.CHANNELS.extension.info, () => (0, extensionBundle_1.getExtensionInfo)());
    handle(channels_1.CHANNELS.extension.openInstallFolder, () => (0, extensionBundle_1.openInstallFolder)());
    handle(channels_1.CHANNELS.extension.exportFolder, () => (0, extensionBundle_1.exportExtensionFolder)());
    // ---------------------------------------------------------------- license
    handle(channels_1.CHANNELS.license.status, () => ({
        info: LicenseService_1.licenseService.getLicenseInfo(),
        diagnostics: LicenseService_1.licenseService.getDiagnostics(),
    }));
    handle(channels_1.CHANNELS.license.activate, (key) => LicenseService_1.licenseService.activate(key));
    handle(channels_1.CHANNELS.license.validate, () => LicenseService_1.licenseService.validate());
    handle(channels_1.CHANNELS.license.deactivate, () => LicenseService_1.licenseService.deactivate());
    handle(channels_1.CHANNELS.license.refresh, async () => {
        await LicenseService_1.licenseService.refreshNow();
        return LicenseService_1.licenseService.getLicenseInfo();
    });
    handle(channels_1.CHANNELS.license.pricing, () => lemonsqueezy_1.PRICING);
    /**
     * Main opens the checkout, rather than the renderer being handed a URL to open. The window's
     * `setWindowOpenHandler` already refuses anything that is not https, and keeping the three
     * purchasable URLs in main means a model-authored fragment rendered in the app can never talk
     * this into opening one of its own.
     */
    handle(channels_1.CHANNELS.license.openCheckout, async (variant) => {
        const url = lemonsqueezy_1.LEMONSQUEEZY_CONFIG.checkoutUrls[variant];
        if (!url)
            throw new Error(`unknown checkout variant: ${String(variant)}`);
        await electron_1.shell.openExternal(url);
        return true;
    });
    // ---------------------------------------------------------------- support links
    /**
     * An id, never a URL — see the note on openCheckout above, which this follows. It also
     * carries `mailto:`, which `setWindowOpenHandler` cannot: that guard passes `https:` only,
     * so an <a href="mailto:…"> in the renderer silently does nothing.
     */
    handle(channels_1.CHANNELS.links.open, async (id) => {
        const url = links_1.EXTERNAL_LINKS[id];
        if (!url)
            throw new Error(`unknown link: ${String(id)}`);
        await electron_1.shell.openExternal(url);
        return true;
    });
    // ---------------------------------------------------------------- updates (electron-updater)
    handle(channels_1.CHANNELS.updates.getVersion, () => (0, updater_1.getAppVersion)());
    handle(channels_1.CHANNELS.updates.getStatus, () => (0, updater_1.getUpdateStatusSnapshot)());
    handle(channels_1.CHANNELS.updates.check, async () => {
        try {
            const result = await (0, updater_1.checkForUpdates)();
            return result.updateInfo ?? null;
        }
        catch (err) {
            const message = (0, updater_1.formatUpdaterError)(err instanceof Error ? err : new Error(String(err)));
            throw new Error(message);
        }
    });
    handle(channels_1.CHANNELS.updates.download, async () => {
        try {
            await (0, updater_1.downloadUpdate)();
            return true;
        }
        catch (err) {
            throw new Error((0, updater_1.formatUpdaterError)(err instanceof Error ? err : new Error(String(err))));
        }
    });
    handle(channels_1.CHANNELS.updates.install, async () => {
        try {
            await (0, updater_1.installUpdate)();
            return true;
        }
        catch (err) {
            throw new Error(err instanceof Error ? err.message : String(err));
        }
    });
    // ---------------------------------------------------------------- analytics (opt-in Aptabase)
    handle(channels_1.CHANNELS.analytics.get, () => (0, analytics_1.getAnalyticsPrefs)());
    handle(channels_1.CHANNELS.analytics.set, (prefs) => (0, analytics_1.setAnalyticsPrefs)(prefs ?? {}));
}
/**
 * A collection exports as a folder: one self-contained HTML per guide plus an index that links
 * them relatively. Nothing here reaches the network, so the folder can be zipped, emailed or
 * committed and still works — the same property a single guide already has.
 */
async function exportCollection(id) {
    const detail = CollectionStore_1.collectionStore.get(id);
    if (!detail)
        throw new Error('collection not found');
    const guides = CollectionStore_1.collectionStore.guidesIn(id);
    if (!guides.length)
        throw new Error('this collection has no guides in it yet');
    /**
     * Resolved once, at export time — not stamped on the guide. Buying a licence has to make the
     * next export clean, and letting it lapse has to make the next export marked.
     */
    const exportOptions = { watermark: LicenseService_1.licenseService.watermark() };
    const window = electron_1.BrowserWindow.getFocusedWindow() ?? electron_1.BrowserWindow.getAllWindows()[0];
    const picked = await electron_1.dialog.showOpenDialog(window, {
        title: 'Choose where to write the collection folder',
        properties: ['openDirectory', 'createDirectory'],
    });
    if (picked.canceled || !picked.filePaths[0])
        return null;
    const slug = (detail.title || 'collection').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'collection';
    const dir = path_1.default.join(picked.filePaths[0], slug);
    fs_1.default.mkdirSync(dir, { recursive: true });
    const entries = guides.map((guide) => {
        // Index-prefixed so the folder reads in collection order in a file browser too.
        const file = `${String(guides.indexOf(guide) + 1).padStart(2, '0')}-${guide.id || 'guide'}.html`;
        fs_1.default.writeFileSync(path_1.default.join(dir, file), (0, exporters_1.toSelfContainedHtml)(guide, exportOptions), 'utf8');
        return { file, guide };
    });
    const indexPath = path_1.default.join(dir, 'index.html');
    fs_1.default.writeFileSync(indexPath, (0, exporters_2.toCollectionIndexHtml)(detail, entries, exportOptions), 'utf8');
    void electron_1.shell.showItemInFolder(indexPath);
    return indexPath;
}
const EXPORT_DIALOG = {
    md: { title: 'Export markdown', filter: { name: 'Markdown', extensions: ['md'] } },
    html: { title: 'Export self-contained HTML', filter: { name: 'HTML', extensions: ['html'] } },
    pdf: { title: 'Export PDF', filter: { name: 'PDF', extensions: ['pdf'] } },
    scorm: { title: 'Export SCORM 1.2 package', filter: { name: 'SCORM zip', extensions: ['zip'] } },
    pptx: { title: 'Export PowerPoint', filter: { name: 'PowerPoint', extensions: ['pptx'] } },
};
const EXPORT_EXT = {
    md: 'md',
    html: 'html',
    pdf: 'pdf',
    scorm: 'zip',
    pptx: 'pptx',
};
async function exportGuide(id, format, stamp) {
    const result = GuideStore_1.guideStore.getOrError(id);
    if (!result.ok)
        throw new Error(result.error);
    const handover = stamp && typeof stamp === 'object' ? stamp : undefined;
    const guide = (0, personalize_1.stampGuide)(result.guide, handover ?? {});
    const exportOptions = { watermark: LicenseService_1.licenseService.watermark() };
    // Export is downstream of the gate: a guide only exists for an acknowledged session.
    const filename = `${guide.id || 'guide'}.${EXPORT_EXT[format]}`;
    const window = electron_1.BrowserWindow.getFocusedWindow() ?? electron_1.BrowserWindow.getAllWindows()[0];
    const dialogSpec = EXPORT_DIALOG[format];
    const picked = await electron_1.dialog.showSaveDialog(window, {
        title: dialogSpec.title,
        defaultPath: filename,
        filters: [dialogSpec.filter],
    });
    if (picked.canceled || !picked.filePath)
        return null;
    await writeGuideFile(guide, format, picked.filePath, exportOptions);
    void electron_1.shell.showItemInFolder(picked.filePath);
    return picked.filePath;
}
async function exportNarration(id) {
    const result = GuideStore_1.guideStore.getOrError(id);
    if (!result.ok)
        throw new Error(result.error);
    const body = (0, guideNarration_1.narrationScript)({
        title: result.guide.title,
        steps: result.guide.steps.map((step) => ({
            title: step.title,
            body: step.body,
            why: step.why,
            chapter: step.chapter,
        })),
    });
    const window = electron_1.BrowserWindow.getFocusedWindow() ?? electron_1.BrowserWindow.getAllWindows()[0];
    const picked = await electron_1.dialog.showSaveDialog(window, {
        title: 'Export narration script',
        defaultPath: `${result.guide.title || 'narration'}.md`,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (picked.canceled || !picked.filePath)
        return null;
    await fs_1.default.promises.writeFile(picked.filePath, body, 'utf8');
    void electron_1.shell.showItemInFolder(picked.filePath);
    return picked.filePath;
}
async function exportGuides(ids, format) {
    const wanted = (ids ?? []).filter((id) => typeof id === 'string' && id.length > 0).slice(0, 80);
    if (!wanted.length)
        throw new Error('Select at least one guide to export.');
    if (!EXPORT_EXT[format])
        throw new Error('That export format is not available.');
    const window = electron_1.BrowserWindow.getFocusedWindow() ?? electron_1.BrowserWindow.getAllWindows()[0];
    const picked = await electron_1.dialog.showOpenDialog(window, {
        title: 'Export selected guides',
        properties: ['openDirectory', 'createDirectory'],
    });
    if (picked.canceled || !picked.filePaths[0])
        return null;
    const folder = picked.filePaths[0];
    const exportOptions = { watermark: LicenseService_1.licenseService.watermark() };
    let written = 0;
    let failed = 0;
    const used = new Set();
    for (const id of wanted) {
        const result = GuideStore_1.guideStore.getOrError(id);
        if (!result.ok) {
            failed += 1;
            continue;
        }
        const base = safeExportName(result.guide.title || result.guide.id);
        let name = `${base}.${EXPORT_EXT[format]}`;
        let n = 2;
        while (used.has(name) || fs_1.default.existsSync(path_1.default.join(folder, name))) {
            name = `${base}-${n}.${EXPORT_EXT[format]}`;
            n += 1;
        }
        used.add(name);
        try {
            await writeGuideFile(result.guide, format, path_1.default.join(folder, name), exportOptions);
            written += 1;
        }
        catch {
            failed += 1;
        }
    }
    void electron_1.shell.showItemInFolder(folder);
    return { written, failed, folder };
}
function safeExportName(title) {
    const cleaned = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').trim().slice(0, 80);
    return cleaned || 'guide';
}
async function writeGuideFile(guide, format, filePath, exportOptions) {
    if (format === 'pdf') {
        fs_1.default.writeFileSync(filePath, await (0, pdfExport_1.renderGuideToPdf)(guide, exportOptions));
        return;
    }
    if (format === 'scorm') {
        fs_1.default.writeFileSync(filePath, (0, scorm_1.toScormZip)(guide, exportOptions));
        return;
    }
    if (format === 'pptx') {
        fs_1.default.writeFileSync(filePath, (0, pptx_1.toPptxZip)(guide, await (0, pptx_1.collectPptxImages)(guide)));
        return;
    }
    const contents = format === 'md' ? (0, exporters_1.toMarkdown)(guide, exportOptions) : (0, exporters_1.toSelfContainedHtml)(guide, exportOptions);
    fs_1.default.writeFileSync(filePath, contents, 'utf8');
    if (format !== 'md')
        return;
    const assetDir = path_1.default.join(path_1.default.dirname(filePath), 'steps');
    const baked = await (0, annotationBake_1.bakeAnnotatedScreenshots)(guide);
    for (const step of guide.steps) {
        if (!step.screenshot)
            continue;
        const destination = path_1.default.join(assetDir, path_1.default.basename(step.screenshot));
        const marked = baked.get(step.id);
        if (!marked) {
            const source = ScreenshotStore_1.screenshotStore.absolutePath(step.screenshot);
            if (!fs_1.default.existsSync(source))
                continue;
            if (!fs_1.default.existsSync(assetDir))
                fs_1.default.mkdirSync(assetDir, { recursive: true });
            fs_1.default.copyFileSync(source, destination);
            continue;
        }
        if (!fs_1.default.existsSync(assetDir))
            fs_1.default.mkdirSync(assetDir, { recursive: true });
        fs_1.default.writeFileSync(destination, marked);
    }
}
//# sourceMappingURL=registerHandlers.js.map