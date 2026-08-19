"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CHANNELS = void 0;
/**
 * The channel map. A renderer↔main API change touches four files in lockstep, and missing
 * one fails at runtime rather than at compile time:
 *
 *   channels.ts (here) → registerHandlers.ts → preload.ts → src/types/app.ts
 */
exports.CHANNELS = {
    sessions: {
        list: 'sessions:list',
        get: 'sessions:get',
        rename: 'sessions:rename',
        delete: 'sessions:delete',
        setPrompt: 'sessions:set-prompt',
        setCustomize: 'sessions:set-customize',
    },
    redaction: {
        review: 'redaction:review',
        acknowledge: 'redaction:acknowledge',
        maskValue: 'redaction:mask-value',
        paintScreenshot: 'redaction:paint-screenshot',
        cropScreenshot: 'redaction:crop-screenshot',
        dropStep: 'redaction:drop-step',
        setStepOutputs: 'redaction:set-step-outputs',
        setStepChapter: 'redaction:set-step-chapter',
        setStepBranches: 'redaction:set-step-branches',
        setStepAltSelectors: 'redaction:set-step-alt-selectors',
        setAssessments: 'redaction:set-assessments',
        setStepKeystrokes: 'redaction:set-step-keystrokes',
        listRules: 'redaction:list-rules',
        addRule: 'redaction:add-rule',
        deleteRule: 'redaction:delete-rule',
        screenshotDataUri: 'redaction:screenshot-data-uri',
        loadAnnotationProject: 'redaction:load-annotation-project',
        saveAnnotationProject: 'redaction:save-annotation-project',
    },
    generator: {
        routes: 'generator:routes',
        rescan: 'generator:rescan',
        select: 'generator:select',
        generate: 'generator:generate',
        audit: 'generator:audit',
        composeScore: 'generator:compose-score',
    },
    tts: {
        probe: 'tts:probe',
    },
    collections: {
        list: 'collections:list',
        get: 'collections:get',
        create: 'collections:create',
        rename: 'collections:rename',
        delete: 'collections:delete',
        add: 'collections:add',
        remove: 'collections:remove',
        reorder: 'collections:reorder',
        export: 'collections:export',
    },
    /**
     * Projects, folders and tags. Distinct from `collections` on purpose: a collection is an
     * *ordered* set of guides that exports as one handover folder, while this is how the Maker
     * keeps their own library. One is an artifact, the other is a filing cabinet.
     */
    organization: {
        snapshot: 'organization:snapshot',
        createFolder: 'organization:create-folder',
        renameFolder: 'organization:rename-folder',
        moveFolder: 'organization:move-folder',
        deleteFolder: 'organization:delete-folder',
        fileItems: 'organization:file-items',
        ensureTag: 'organization:ensure-tag',
        renameTag: 'organization:rename-tag',
        deleteTag: 'organization:delete-tag',
        tagItems: 'organization:tag-items',
        applyTagInput: 'organization:apply-tag-input',
    },
    guides: {
        list: 'guides:list',
        get: 'guides:get',
        delete: 'guides:delete',
        exportMarkdown: 'guides:export-markdown',
        exportNarration: 'guides:export-narration',
        exportHtml: 'guides:export-html',
        exportPdf: 'guides:export-pdf',
        exportScorm: 'guides:export-scorm',
        exportPptx: 'guides:export-pptx',
        exportBatch: 'guides:export-batch',
        ask: 'guides:ask',
        clearProgress: 'guides:clear-progress',
        setStepAnnotations: 'guides:set-step-annotations',
        setStepCopy: 'guides:set-step-copy',
        loadAnnotationProject: 'guides:load-annotation-project',
        saveAnnotationProject: 'guides:save-annotation-project',
        /** The latest check-run report: which steps' anchors still resolved on the live site. */
        health: 'guides:health',
        /** Re-shot screenshots awaiting review — the proposal, the approval, and the refusal. */
        pendingRefreshes: 'guides:pending-refreshes',
        applyRefresh: 'guides:apply-refresh',
        discardRefresh: 'guides:discard-refresh',
    },
    annotations: {
        exportImage: 'annotations:export-image',
        exportProject: 'annotations:export-project',
        copyImage: 'annotations:copy-image',
        pinImage: 'annotations:pin-image',
        createShare: 'annotations:create-share',
        startDrag: 'annotations:start-drag',
    },
    /**
     * The library's grid tiles. One batched call per visible page rather than one per card, and
     * derived from the stored screenshots on demand — nothing about a poster is persisted.
     */
    library: {
        posters: 'library:posters',
    },
    video: {
        probe: 'video:probe',
        render: 'video:render',
        preview: 'video:preview',
        cancel: 'video:cancel',
    },
    /** Desktop recording. See docs/machine-record-plan.md and docs/real-recorder-plan.md. */
    machine: {
        status: 'machine:status',
        listWindows: 'machine:list-windows',
        openSettings: 'machine:open-settings',
        start: 'machine:start',
        listNativeWindows: 'machine:list-native-windows',
        captureStep: 'machine:capture-step',
        setNote: 'machine:set-note',
        stop: 'machine:stop',
        /** Close out a session left marked 'recording' by a crash, and kill any orphaned capture. */
        forceStop: 'machine:force-stop',
        /** What this machine's recorder can actually do — video, microphone, region, pause. */
        capabilities: 'machine:capabilities',
        requestMicrophone: 'machine:request-microphone',
        /** Raise the macOS Accessibility prompt for the opt-in keyboard-shortcut overlay. */
        requestAccessibility: 'machine:request-accessibility',
        /** Displays, windows and audio inputs, in one answer. */
        listStudioSources: 'machine:list-studio-sources',
        startStudio: 'machine:start-studio',
        requestCamera: 'machine:request-camera',
        pause: 'machine:pause',
        resume: 'machine:resume',
        /** Opens the drag-out overlay on every display and resolves with the chosen rectangle. */
        selectRegion: 'machine:select-region',
    },
    /** The studio editor over a recorded take. See electron/showcasetool/studio.ts. */
    studio: {
        get: 'studio:get',
        save: 'studio:save',
        review: 'studio:review',
        chooseExportPath: 'studio:choose-export-path',
        /** The renderer hands over the encoded bytes; main puts them somewhere it can name. */
        stashRender: 'studio:stash-render',
        stashScore: 'studio:stash-score',
        finishExport: 'studio:finish-export',
        speechEnvelope: 'studio:speech-envelope',
        transcribe: 'studio:transcribe',
        analyzeLoudness: 'studio:analyze-loudness',
        exportCaptions: 'studio:export-captions',
        importCaptions: 'studio:import-captions',
        copyExport: 'studio:copy-export',
        importScene: 'studio:import-scene',
        getPrefs: 'studio:get-prefs',
        setPrefs: 'studio:set-prefs',
        revealExport: 'studio:reveal-export',
        discardMedia: 'studio:discard-media',
        discardQuarantine: 'studio:discard-quarantine',
        /** Turn the frame under the editor's playhead into a guide step for the same recording. */
        captureStep: 'studio:capture-step',
        saveSnapshot: 'studio:save-snapshot',
        listSnapshots: 'studio:list-snapshots',
        restoreSnapshot: 'studio:restore-snapshot',
        listExportPresets: 'studio:list-export-presets',
        saveExportPreset: 'studio:save-export-preset',
        deleteExportPreset: 'studio:delete-export-preset',
        saveThumbnail: 'studio:save-thumbnail',
    },
    provider: {
        getConfig: 'provider:get-config',
        setConfig: 'provider:set-config',
        setApiKey: 'provider:set-api-key',
        clearApiKey: 'provider:clear-api-key',
        status: 'provider:status',
    },
    harvest: {
        getDestination: 'harvest:get-destination',
        setDestination: 'harvest:set-destination',
        listVaultKeys: 'harvest:list-vault-keys',
    },
    relay: {
        status: 'relay:status',
        rotateToken: 'relay:rotate-token',
        resolvePairing: 'relay:resolve-pairing',
    },
    /**
     * The bundled browser extension. Chrome cannot auto-install it, so the app only ever
     * exposes a real folder (stable userData copy or a Maker-chosen export) for Load unpacked.
     */
    extension: {
        info: 'extension:info',
        openInstallFolder: 'extension:open-install-folder',
        exportFolder: 'extension:export-folder',
    },
    /** Pro licensing. See electron/services/LicenseService.ts and electron/entitlement/. */
    license: {
        status: 'license:status',
        activate: 'license:activate',
        validate: 'license:validate',
        deactivate: 'license:deactivate',
        /** Re-run the entitlement exchange now, rather than waiting for the daily pass. */
        refresh: 'license:refresh',
        /** Opens a Lemon Squeezy checkout in the user's browser. */
        openCheckout: 'license:open-checkout',
        pricing: 'license:pricing',
    },
    /**
     * Support and release links. The renderer names an id, never a URL — main owns the table.
     * See electron/config/links.ts.
     */
    links: {
        open: 'links:open',
    },
    /** electron-updater. Packaged builds only — quiet in dev. See electron/updater.ts. */
    updates: {
        check: 'updates:check',
        download: 'updates:download',
        install: 'updates:install',
        getVersion: 'updates:get-version',
        getStatus: 'updates:get-status',
    },
    /**
     * Opt-in anonymous usage analytics (Aptabase). Consent is stored in the settings
     * table; nothing is sent until both consentShown and enabled are true.
     */
    analytics: {
        get: 'analytics:get',
        set: 'analytics:set',
    },
    events: {
        /** Main → renderer. The relay is asking a human to approve an extension. */
        pairRequest: 'showcasetool:pair-request',
        /** Main → renderer. A recording changed; refresh the library. */
        sessionsChanged: 'showcasetool:sessions-changed',
        /** Main → renderer. A check run finished and a guide has a fresh health report. */
        guideHealthChanged: 'showcasetool:guide-health-changed',
        /** Main → renderer. A re-shot screenshot arrived and waits for review. */
        guideRefreshChanged: 'showcasetool:guide-refresh-changed',
        /** Main → renderer. A video render advanced — frame capture takes minutes, not seconds. */
        videoProgress: 'showcasetool:video-progress',
        /** Main → renderer and → the capture HUD. The machine recorder's state moved. */
        machineChanged: 'showcasetool:machine-changed',
        /**
         * Main → renderer. The licence verdict changed — an activation, a deactivation, or a daily
         * refresh that upgraded this install. Pushed rather than polled: the refresh lands on a timer
         * nobody in the renderer knows about.
         */
        licenseChanged: 'showcasetool:license-changed',
        /** Main → renderer. Auto-updater status (checking / available / downloading / ready). */
        updateStatus: 'showcasetool:update-status',
        /**
         * Renderer → main, and the one channel in this map that travels that way. The region
         * overlay reports the rectangle the Maker dragged; `selectRegion` is waiting on it.
         */
        regionPicked: 'showcasetool:region-picked',
    },
    /**
     * Hidden `#capture` window ↔ main. Not a product API — the Chromium studio recorder's
     * pipe. Commands go main → window; events come back the other way.
     */
    capture: {
        command: 'capture:command',
        event: 'capture:event',
    },
};
//# sourceMappingURL=channels.js.map