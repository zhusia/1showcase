"use strict";
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};

// dist-electron/electron/ipc/channels.js
var require_channels = __commonJS({
  "dist-electron/electron/ipc/channels.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.CHANNELS = void 0;
    exports2.CHANNELS = {
      sessions: {
        list: "sessions:list",
        get: "sessions:get",
        rename: "sessions:rename",
        delete: "sessions:delete",
        setPrompt: "sessions:set-prompt",
        setCustomize: "sessions:set-customize"
      },
      redaction: {
        review: "redaction:review",
        acknowledge: "redaction:acknowledge",
        maskValue: "redaction:mask-value",
        paintScreenshot: "redaction:paint-screenshot",
        cropScreenshot: "redaction:crop-screenshot",
        dropStep: "redaction:drop-step",
        setStepOutputs: "redaction:set-step-outputs",
        setStepChapter: "redaction:set-step-chapter",
        setStepBranches: "redaction:set-step-branches",
        setStepAltSelectors: "redaction:set-step-alt-selectors",
        setAssessments: "redaction:set-assessments",
        setStepKeystrokes: "redaction:set-step-keystrokes",
        listRules: "redaction:list-rules",
        addRule: "redaction:add-rule",
        deleteRule: "redaction:delete-rule",
        screenshotDataUri: "redaction:screenshot-data-uri",
        loadAnnotationProject: "redaction:load-annotation-project",
        saveAnnotationProject: "redaction:save-annotation-project"
      },
      generator: {
        routes: "generator:routes",
        rescan: "generator:rescan",
        select: "generator:select",
        generate: "generator:generate",
        audit: "generator:audit",
        composeScore: "generator:compose-score"
      },
      tts: {
        probe: "tts:probe"
      },
      collections: {
        list: "collections:list",
        get: "collections:get",
        create: "collections:create",
        rename: "collections:rename",
        delete: "collections:delete",
        add: "collections:add",
        remove: "collections:remove",
        reorder: "collections:reorder",
        export: "collections:export"
      },
      /**
       * Projects, folders and tags. Distinct from `collections` on purpose: a collection is an
       * *ordered* set of guides that exports as one handover folder, while this is how the Maker
       * keeps their own library. One is an artifact, the other is a filing cabinet.
       */
      organization: {
        snapshot: "organization:snapshot",
        createFolder: "organization:create-folder",
        renameFolder: "organization:rename-folder",
        moveFolder: "organization:move-folder",
        deleteFolder: "organization:delete-folder",
        fileItems: "organization:file-items",
        ensureTag: "organization:ensure-tag",
        renameTag: "organization:rename-tag",
        deleteTag: "organization:delete-tag",
        tagItems: "organization:tag-items",
        applyTagInput: "organization:apply-tag-input"
      },
      guides: {
        list: "guides:list",
        get: "guides:get",
        delete: "guides:delete",
        exportMarkdown: "guides:export-markdown",
        exportNarration: "guides:export-narration",
        exportHtml: "guides:export-html",
        exportPdf: "guides:export-pdf",
        exportScorm: "guides:export-scorm",
        exportPptx: "guides:export-pptx",
        exportBatch: "guides:export-batch",
        ask: "guides:ask",
        clearProgress: "guides:clear-progress",
        setStepAnnotations: "guides:set-step-annotations",
        setStepCopy: "guides:set-step-copy",
        loadAnnotationProject: "guides:load-annotation-project",
        saveAnnotationProject: "guides:save-annotation-project",
        /** The latest check-run report: which steps' anchors still resolved on the live site. */
        health: "guides:health",
        /** Re-shot screenshots awaiting review — the proposal, the approval, and the refusal. */
        pendingRefreshes: "guides:pending-refreshes",
        applyRefresh: "guides:apply-refresh",
        discardRefresh: "guides:discard-refresh"
      },
      annotations: {
        exportImage: "annotations:export-image",
        exportProject: "annotations:export-project",
        copyImage: "annotations:copy-image",
        pinImage: "annotations:pin-image",
        createShare: "annotations:create-share",
        startDrag: "annotations:start-drag"
      },
      /**
       * The library's grid tiles. One batched call per visible page rather than one per card, and
       * derived from the stored screenshots on demand — nothing about a poster is persisted.
       */
      library: {
        posters: "library:posters"
      },
      video: {
        probe: "video:probe",
        render: "video:render",
        preview: "video:preview",
        cancel: "video:cancel"
      },
      /** Desktop recording. See docs/machine-record-plan.md and docs/real-recorder-plan.md. */
      machine: {
        status: "machine:status",
        listWindows: "machine:list-windows",
        openSettings: "machine:open-settings",
        start: "machine:start",
        listNativeWindows: "machine:list-native-windows",
        captureStep: "machine:capture-step",
        setNote: "machine:set-note",
        stop: "machine:stop",
        /** Close out a session left marked 'recording' by a crash, and kill any orphaned capture. */
        forceStop: "machine:force-stop",
        /** What this machine's recorder can actually do — video, microphone, region, pause. */
        capabilities: "machine:capabilities",
        requestMicrophone: "machine:request-microphone",
        /** Raise the macOS Accessibility prompt for the opt-in keyboard-shortcut overlay. */
        requestAccessibility: "machine:request-accessibility",
        /** Displays, windows and audio inputs, in one answer. */
        listStudioSources: "machine:list-studio-sources",
        startStudio: "machine:start-studio",
        requestCamera: "machine:request-camera",
        pause: "machine:pause",
        resume: "machine:resume",
        /** Opens the drag-out overlay on every display and resolves with the chosen rectangle. */
        selectRegion: "machine:select-region"
      },
      /** The studio editor over a recorded take. See electron/showcasetool/studio.ts. */
      studio: {
        get: "studio:get",
        save: "studio:save",
        review: "studio:review",
        chooseExportPath: "studio:choose-export-path",
        /** The renderer hands over the encoded bytes; main puts them somewhere it can name. */
        stashRender: "studio:stash-render",
        stashScore: "studio:stash-score",
        finishExport: "studio:finish-export",
        speechEnvelope: "studio:speech-envelope",
        transcribe: "studio:transcribe",
        analyzeLoudness: "studio:analyze-loudness",
        exportCaptions: "studio:export-captions",
        importCaptions: "studio:import-captions",
        copyExport: "studio:copy-export",
        importScene: "studio:import-scene",
        getPrefs: "studio:get-prefs",
        setPrefs: "studio:set-prefs",
        revealExport: "studio:reveal-export",
        discardMedia: "studio:discard-media",
        discardQuarantine: "studio:discard-quarantine",
        /** Turn the frame under the editor's playhead into a guide step for the same recording. */
        captureStep: "studio:capture-step",
        saveSnapshot: "studio:save-snapshot",
        listSnapshots: "studio:list-snapshots",
        restoreSnapshot: "studio:restore-snapshot",
        listExportPresets: "studio:list-export-presets",
        saveExportPreset: "studio:save-export-preset",
        deleteExportPreset: "studio:delete-export-preset",
        saveThumbnail: "studio:save-thumbnail"
      },
      provider: {
        getConfig: "provider:get-config",
        setConfig: "provider:set-config",
        setApiKey: "provider:set-api-key",
        clearApiKey: "provider:clear-api-key",
        status: "provider:status"
      },
      harvest: {
        getDestination: "harvest:get-destination",
        setDestination: "harvest:set-destination",
        listVaultKeys: "harvest:list-vault-keys"
      },
      relay: {
        status: "relay:status",
        rotateToken: "relay:rotate-token",
        resolvePairing: "relay:resolve-pairing"
      },
      /**
       * The bundled browser extension. Chrome cannot auto-install it, so the app only ever
       * exposes a real folder (stable userData copy or a Maker-chosen export) for Load unpacked.
       */
      extension: {
        info: "extension:info",
        openInstallFolder: "extension:open-install-folder",
        exportFolder: "extension:export-folder"
      },
      /** Pro licensing. See electron/services/LicenseService.ts and electron/entitlement/. */
      license: {
        status: "license:status",
        activate: "license:activate",
        validate: "license:validate",
        deactivate: "license:deactivate",
        /** Re-run the entitlement exchange now, rather than waiting for the daily pass. */
        refresh: "license:refresh",
        /** Opens a Lemon Squeezy checkout in the user's browser. */
        openCheckout: "license:open-checkout",
        pricing: "license:pricing"
      },
      /**
       * Support and release links. The renderer names an id, never a URL — main owns the table.
       * See electron/config/links.ts.
       */
      links: {
        open: "links:open"
      },
      /** electron-updater. Packaged builds only — quiet in dev. See electron/updater.ts. */
      updates: {
        check: "updates:check",
        download: "updates:download",
        install: "updates:install",
        getVersion: "updates:get-version",
        getStatus: "updates:get-status"
      },
      /**
       * Opt-in anonymous usage analytics (Aptabase). Consent is stored in the settings
       * table; nothing is sent until both consentShown and enabled are true.
       */
      analytics: {
        get: "analytics:get",
        set: "analytics:set"
      },
      events: {
        /** Main → renderer. The relay is asking a human to approve an extension. */
        pairRequest: "showcasetool:pair-request",
        /** Main → renderer. A recording changed; refresh the library. */
        sessionsChanged: "showcasetool:sessions-changed",
        /** Main → renderer. A check run finished and a guide has a fresh health report. */
        guideHealthChanged: "showcasetool:guide-health-changed",
        /** Main → renderer. A re-shot screenshot arrived and waits for review. */
        guideRefreshChanged: "showcasetool:guide-refresh-changed",
        /** Main → renderer. A video render advanced — frame capture takes minutes, not seconds. */
        videoProgress: "showcasetool:video-progress",
        /** Main → renderer and → the capture HUD. The machine recorder's state moved. */
        machineChanged: "showcasetool:machine-changed",
        /**
         * Main → renderer. The licence verdict changed — an activation, a deactivation, or a daily
         * refresh that upgraded this install. Pushed rather than polled: the refresh lands on a timer
         * nobody in the renderer knows about.
         */
        licenseChanged: "showcasetool:license-changed",
        /** Main → renderer. Auto-updater status (checking / available / downloading / ready). */
        updateStatus: "showcasetool:update-status",
        /**
         * Renderer → main, and the one channel in this map that travels that way. The region
         * overlay reports the rectangle the Maker dragged; `selectRegion` is waiting on it.
         */
        regionPicked: "showcasetool:region-picked"
      },
      /**
       * Hidden `#capture` window ↔ main. Not a product API — the Chromium studio recorder's
       * pipe. Commands go main → window; events come back the other way.
       */
      capture: {
        command: "capture:command",
        event: "capture:event"
      }
    };
  }
});

// dist-electron/electron/preload.js
Object.defineProperty(exports, "__esModule", { value: true });
var electron_1 = require("electron");
var channels_1 = require_channels();
var api = {
  sessions: {
    list: () => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.sessions.list),
    get: (sessionId) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.sessions.get, sessionId),
    rename: (sessionId, title) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.sessions.rename, sessionId, title),
    delete: (sessionId) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.sessions.delete, sessionId),
    setPrompt: (sessionId, prompt, audience) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.sessions.setPrompt, sessionId, prompt, audience),
    setCustomize: (sessionId, customize) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.sessions.setCustomize, sessionId, customize)
  },
  redaction: {
    review: (sessionId) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.redaction.review, sessionId),
    acknowledge: (sessionId, viewedStepIds, force) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.redaction.acknowledge, sessionId, viewedStepIds ?? [], force === true),
    maskValue: (sessionId, value, placeholder) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.redaction.maskValue, sessionId, value, placeholder),
    paintScreenshot: (sessionId, stepId, dataUri) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.redaction.paintScreenshot, sessionId, stepId, dataUri),
    cropScreenshot: (sessionId, stepId, dataUri, crop) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.redaction.cropScreenshot, sessionId, stepId, dataUri, crop),
    dropStep: (sessionId, stepId, dropped) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.redaction.dropStep, sessionId, stepId, dropped),
    setStepOutputs: (sessionId, stepId, outputs) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.redaction.setStepOutputs, sessionId, stepId, outputs),
    setStepChapter: (sessionId, stepId, chapter) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.redaction.setStepChapter, sessionId, stepId, chapter),
    setStepBranches: (sessionId, stepId, branches) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.redaction.setStepBranches, sessionId, stepId, branches),
    setStepAltSelectors: (sessionId, stepId, altSelectors) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.redaction.setStepAltSelectors, sessionId, stepId, altSelectors),
    setAssessments: (sessionId, assessments) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.redaction.setAssessments, sessionId, assessments),
    setStepKeystrokes: (sessionId, stepId, keystrokes) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.redaction.setStepKeystrokes, sessionId, stepId, keystrokes),
    listRules: () => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.redaction.listRules),
    addRule: (rule) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.redaction.addRule, rule),
    deleteRule: (id) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.redaction.deleteRule, id),
    screenshotDataUri: (relative) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.redaction.screenshotDataUri, relative),
    loadAnnotationProject: (sessionId, stepId) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.redaction.loadAnnotationProject, sessionId, stepId),
    saveAnnotationProject: (sessionId, stepId, project, renderedDataUri) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.redaction.saveAnnotationProject, sessionId, stepId, project, renderedDataUri)
  },
  generator: {
    routes: () => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.generator.routes),
    rescan: () => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.generator.rescan),
    select: (routeId) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.generator.select, routeId),
    generate: (options) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.generator.generate, options),
    audit: (guideId) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.generator.audit, guideId),
    composeScore: (request) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.generator.composeScore, request)
  },
  tts: {
    probe: (force) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.tts.probe, force)
  },
  collections: {
    list: () => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.collections.list),
    get: (id) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.collections.get, id),
    create: (title, intent) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.collections.create, title, intent),
    rename: (id, title, intent) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.collections.rename, id, title, intent),
    delete: (id) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.collections.delete, id),
    add: (collectionId, guideId) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.collections.add, collectionId, guideId),
    remove: (collectionId, guideId) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.collections.remove, collectionId, guideId),
    reorder: (collectionId, guideIds) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.collections.reorder, collectionId, guideIds),
    export: (id) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.collections.export, id)
  },
  organization: {
    snapshot: () => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.organization.snapshot),
    createFolder: (name, parentId) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.organization.createFolder, name, parentId),
    renameFolder: (id, name, color) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.organization.renameFolder, id, name, color),
    moveFolder: (id, parentId) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.organization.moveFolder, id, parentId),
    deleteFolder: (id) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.organization.deleteFolder, id),
    fileItems: (items, folderId) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.organization.fileItems, items, folderId),
    ensureTag: (name) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.organization.ensureTag, name),
    renameTag: (id, name, color) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.organization.renameTag, id, name, color),
    deleteTag: (id) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.organization.deleteTag, id),
    tagItems: (items, tagId, on) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.organization.tagItems, items, tagId, on),
    applyTagInput: (items, raw) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.organization.applyTagInput, items, raw)
  },
  guides: {
    list: () => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.guides.list),
    get: (id) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.guides.get, id),
    delete: (id) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.guides.delete, id),
    exportMarkdown: (id) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.guides.exportMarkdown, id),
    exportNarration: (id) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.guides.exportNarration, id),
    exportHtml: (id) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.guides.exportHtml, id),
    exportPdf: (id) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.guides.exportPdf, id),
    exportScorm: (id, stamp) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.guides.exportScorm, id, stamp),
    exportPptx: (id) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.guides.exportPptx, id),
    exportBatch: (ids, format) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.guides.exportBatch, ids, format),
    ask: (id, question) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.guides.ask, id, question),
    clearProgress: (id) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.guides.clearProgress, id),
    setStepAnnotations: (guideId, stepId, annotations) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.guides.setStepAnnotations, guideId, stepId, annotations),
    setStepCopy: (guideId, stepId, copy) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.guides.setStepCopy, guideId, stepId, copy),
    loadAnnotationProject: (guideId, stepId) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.guides.loadAnnotationProject, guideId, stepId),
    saveAnnotationProject: (guideId, stepId, project, renderedDataUri) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.guides.saveAnnotationProject, guideId, stepId, project, renderedDataUri),
    health: (id) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.guides.health, id),
    pendingRefreshes: (id) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.guides.pendingRefreshes, id),
    applyRefresh: (guideId, stepId) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.guides.applyRefresh, guideId, stepId),
    discardRefresh: (guideId, stepId) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.guides.discardRefresh, guideId, stepId)
  },
  annotations: {
    exportImage: (dataUri, suggestedName) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.annotations.exportImage, dataUri, suggestedName),
    exportProject: (project, baseDataUri, suggestedName) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.annotations.exportProject, project, baseDataUri, suggestedName),
    copyImage: (dataUri) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.annotations.copyImage, dataUri),
    pinImage: (dataUri, title) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.annotations.pinImage, dataUri, title),
    createShare: (dataUri, options) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.annotations.createShare, dataUri, options),
    startDrag: (dataUri, suggestedName) => electron_1.ipcRenderer.send(channels_1.CHANNELS.annotations.startDrag, dataUri, suggestedName)
  },
  library: {
    posters: (refs) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.library.posters, refs)
  },
  video: {
    probe: (rescan) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.video.probe, rescan === true),
    render: (guideId, overrides) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.video.render, guideId, overrides),
    preview: (guideId, overrides) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.video.preview, guideId, overrides),
    cancel: (guideId) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.video.cancel, guideId)
  },
  machine: {
    status: () => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.machine.status),
    listWindows: () => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.machine.listWindows),
    openSettings: (target = "screen") => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.machine.openSettings, target),
    start: (options) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.machine.start, options),
    listNativeWindows: () => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.machine.listNativeWindows),
    captureStep: (note) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.machine.captureStep, note ?? ""),
    setNote: (note) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.machine.setNote, note),
    stop: () => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.machine.stop),
    forceStop: (sessionId) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.machine.forceStop, sessionId),
    capabilities: () => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.machine.capabilities),
    requestMicrophone: () => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.machine.requestMicrophone),
    requestAccessibility: () => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.machine.requestAccessibility),
    listStudioSources: () => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.machine.listStudioSources),
    startStudio: (options) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.machine.startStudio, options),
    requestCamera: () => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.machine.requestCamera),
    pause: () => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.machine.pause),
    resume: () => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.machine.resume),
    selectRegion: () => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.machine.selectRegion)
  },
  studio: {
    get: (sessionId) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.studio.get, sessionId),
    save: (sessionId, project) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.studio.save, { sessionId, project }),
    review: (sessionId) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.studio.review, sessionId),
    chooseExportPath: (sessionId, suggested) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.studio.chooseExportPath, { sessionId, suggested }),
    stashRender: (bytes) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.studio.stashRender, bytes),
    stashScore: (bytes) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.studio.stashScore, bytes),
    finishExport: (payload) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.studio.finishExport, payload),
    speechEnvelope: (sessionId) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.studio.speechEnvelope, sessionId),
    transcribe: (sessionId) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.studio.transcribe, sessionId),
    analyzeLoudness: (sessionId) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.studio.analyzeLoudness, sessionId),
    exportCaptions: (sessionId, format) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.studio.exportCaptions, sessionId, format),
    importCaptions: (sessionId) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.studio.importCaptions, sessionId),
    copyExport: (payload) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.studio.copyExport, payload),
    importScene: () => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.studio.importScene),
    getPrefs: () => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.studio.getPrefs),
    setPrefs: (prefs) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.studio.setPrefs, prefs),
    revealExport: (payload) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.studio.revealExport, payload),
    discardMedia: (sessionId) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.studio.discardMedia, sessionId),
    discardQuarantine: (sessionId) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.studio.discardQuarantine, sessionId),
    captureStep: (payload) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.studio.captureStep, payload),
    saveSnapshot: (sessionId, name) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.studio.saveSnapshot, { sessionId, name }),
    listSnapshots: (sessionId) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.studio.listSnapshots, sessionId),
    restoreSnapshot: (sessionId, id) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.studio.restoreSnapshot, { sessionId, id }),
    listExportPresets: () => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.studio.listExportPresets),
    saveExportPreset: (name, settings) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.studio.saveExportPreset, { name, settings }),
    deleteExportPreset: (id) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.studio.deleteExportPreset, id),
    saveThumbnail: (sessionId, dataUri) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.studio.saveThumbnail, { sessionId, dataUri })
  },
  provider: {
    getConfig: () => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.provider.getConfig),
    setConfig: (config) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.provider.setConfig, config),
    setApiKey: (provider, key) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.provider.setApiKey, provider, key),
    clearApiKey: (provider) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.provider.clearApiKey, provider),
    status: () => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.provider.status)
  },
  harvest: {
    getDestination: () => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.harvest.getDestination),
    setDestination: (config) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.harvest.setDestination, config),
    listVaultKeys: () => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.harvest.listVaultKeys)
  },
  relay: {
    status: () => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.relay.status),
    rotateToken: () => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.relay.rotateToken),
    resolvePairing: (approved) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.relay.resolvePairing, approved)
  },
  extension: {
    info: () => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.extension.info),
    openInstallFolder: () => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.extension.openInstallFolder),
    exportFolder: () => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.extension.exportFolder)
  },
  license: {
    status: () => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.license.status),
    activate: (key) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.license.activate, key),
    validate: () => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.license.validate),
    deactivate: () => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.license.deactivate),
    refresh: () => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.license.refresh),
    pricing: () => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.license.pricing),
    openCheckout: (variant) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.license.openCheckout, variant)
  },
  links: {
    open: (id) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.links.open, id)
  },
  updates: {
    check: () => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.updates.check),
    download: () => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.updates.download),
    install: () => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.updates.install),
    getVersion: () => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.updates.getVersion),
    getStatus: () => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.updates.getStatus)
  },
  analytics: {
    get: () => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.analytics.get),
    set: (prefs) => electron_1.ipcRenderer.invoke(channels_1.CHANNELS.analytics.set, prefs)
  },
  capture: {
    onCommand: (callback) => {
      const listener = (_event, payload) => callback(payload);
      electron_1.ipcRenderer.on(channels_1.CHANNELS.capture.command, listener);
      return () => electron_1.ipcRenderer.removeListener(channels_1.CHANNELS.capture.command, listener);
    },
    send: (payload) => electron_1.ipcRenderer.send(channels_1.CHANNELS.capture.event, payload)
  },
  events: {
    /** Subscriptions return an unsubscribe function, per the repo's channel convention. */
    onPairRequest: (callback) => {
      const listener = (_event, payload) => callback(payload);
      electron_1.ipcRenderer.on(channels_1.CHANNELS.events.pairRequest, listener);
      return () => electron_1.ipcRenderer.removeListener(channels_1.CHANNELS.events.pairRequest, listener);
    },
    onSessionsChanged: (callback) => {
      const listener = () => callback();
      electron_1.ipcRenderer.on(channels_1.CHANNELS.events.sessionsChanged, listener);
      return () => electron_1.ipcRenderer.removeListener(channels_1.CHANNELS.events.sessionsChanged, listener);
    },
    onGuideHealthChanged: (callback) => {
      const listener = (_event, payload) => callback(payload);
      electron_1.ipcRenderer.on(channels_1.CHANNELS.events.guideHealthChanged, listener);
      return () => electron_1.ipcRenderer.removeListener(channels_1.CHANNELS.events.guideHealthChanged, listener);
    },
    onGuideRefreshChanged: (callback) => {
      const listener = (_event, payload) => callback(payload);
      electron_1.ipcRenderer.on(channels_1.CHANNELS.events.guideRefreshChanged, listener);
      return () => electron_1.ipcRenderer.removeListener(channels_1.CHANNELS.events.guideRefreshChanged, listener);
    },
    onVideoProgress: (callback) => {
      const listener = (_event, payload) => callback(payload);
      electron_1.ipcRenderer.on(channels_1.CHANNELS.events.videoProgress, listener);
      return () => electron_1.ipcRenderer.removeListener(channels_1.CHANNELS.events.videoProgress, listener);
    },
    /** Both the app window and the capture HUD render from this, so they cannot disagree. */
    onMachineChanged: (callback) => {
      const listener = (_event, payload) => callback(payload);
      electron_1.ipcRenderer.on(channels_1.CHANNELS.events.machineChanged, listener);
      return () => electron_1.ipcRenderer.removeListener(channels_1.CHANNELS.events.machineChanged, listener);
    },
    onLicenseChanged: (callback) => {
      const listener = (_event, payload) => callback(payload);
      electron_1.ipcRenderer.on(channels_1.CHANNELS.events.licenseChanged, listener);
      return () => electron_1.ipcRenderer.removeListener(channels_1.CHANNELS.events.licenseChanged, listener);
    },
    onUpdateStatus: (callback) => {
      const listener = (_event, payload) => callback(payload);
      electron_1.ipcRenderer.on(channels_1.CHANNELS.events.updateStatus, listener);
      return () => electron_1.ipcRenderer.removeListener(channels_1.CHANNELS.events.updateStatus, listener);
    },
    /**
     * The one renderer → main message in the API, sent by the region overlay when a drag
     * finishes. `send`, not `invoke`: the overlay is answering a question main already asked,
     * and it has nothing to wait for — main tears the overlay down as its reply.
     */
    pickRegion: (payload) => {
      electron_1.ipcRenderer.send(channels_1.CHANNELS.events.regionPicked, payload);
    }
  }
};
electron_1.contextBridge.exposeInMainWorld("api", api);
