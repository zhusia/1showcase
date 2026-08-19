"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const path_1 = __importDefault(require("path"));
const db_1 = require("./db");
const devInstance_1 = require("./devInstance");
const devServer_1 = require("./devServer");
const registerHandlers_1 = require("./ipc/registerHandlers");
const registerRelayRoutes_1 = require("./showcasetool/registerRelayRoutes");
const ExtensionRelayService_1 = require("./services/ExtensionRelayService");
const MachineRecorderService_1 = require("./showcasetool/MachineRecorderService");
const mediaProtocol_1 = require("./showcasetool/mediaProtocol");
const StudioService_1 = require("./showcasetool/StudioService");
const SceneAssetService_1 = require("./showcasetool/SceneAssetService");
const GuideSessionStore_1 = require("./showcasetool/GuideSessionStore");
const LicenseService_1 = require("./services/LicenseService");
const channels_1 = require("./ipc/channels");
const updater_1 = require("./updater");
const analytics_1 = require("./analytics");
const isDev = !electron_1.app.isPackaged;
function builtRendererPath() {
    return path_1.default.join(__dirname, '../../dist-renderer/index.html');
}
/**
 * Prefer the Vite dev server when there is one that is actually ours, and fall back to the built
 * renderer when there is not. Running `electron .` without `vite` otherwise yields a blank window
 * with no clue why, which is a confusing way to lose ten minutes.
 *
 * The port is discovered rather than assumed — see `devServer.ts` for why, and for what happens
 * when something else is squatting on it. The resolution runs once here and is cached, so the HUD
 * and the region overlay inherit the same answer instead of probing again mid-capture.
 */
async function loadRenderer(window) {
    if (isDev) {
        await (0, devServer_1.resolveDevServer)();
        const url = (0, devServer_1.devServerUrl)();
        if (url) {
            await window.loadURL(url);
            return;
        }
        /**
         * Loud, because the window that comes up looks fine and is not. It is the last build, so
         * source edits do nothing and there is no HMR — a state that reads as "my change had no
         * effect" rather than as "the renderer you are looking at is stale".
         */
        for (const line of (0, devServer_1.devServerWarning)())
            console.warn(line);
    }
    await window.loadFile(builtRendererPath());
}
/**
 * The title-bar and taskbar icon on Windows and Linux. macOS reads the .icns from the bundle
 * and ignores this, and passing a path that does not exist there would be a silent no-op — so
 * the platform check is what keeps a packaging mistake visible on the platforms that use it.
 */
function windowIcon() {
    if (process.platform === 'darwin')
        return undefined;
    return path_1.default.join(__dirname, '../../assets/brand/window-icon-256.png');
}
function createWindow() {
    const window = new electron_1.BrowserWindow({
        width: 1280,
        height: 860,
        minWidth: 960,
        minHeight: 640,
        icon: windowIcon(),
        /**
         * Matches --bg in src/styles/00-tokens.css. Hardcoded because it is painted before any
         * stylesheet loads; if the token moves, this moves with it or the window flashes the old
         * colour on every launch.
         */
        backgroundColor: '#0b0e14',
        titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
        webPreferences: {
            preload: path_1.default.join(__dirname, 'preload.js'),
            // The renderer never touches Node, the DB, or credentials.
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });
    void loadRenderer(window);
    // External links open in the user's browser, never inside the app shell.
    window.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('https://'))
            void electron_1.shell.openExternal(url);
        return { action: 'deny' };
    });
    return window;
}
/**
 * The last line between one bad event and losing the Maker's work.
 *
 * Node's default for an uncaught exception — and, since Node 15, for an unhandled rejection — is
 * to exit the process. In the main process that is the *whole app*: every window closes, an
 * in-progress recording is abandoned mid-take, and because it is a clean `exit(1)` rather than a
 * signal, macOS files no crash report. The symptom is an app that simply vanishes and leaves
 * nothing behind to debug, which is how this went unexplained for as long as it did.
 *
 * Almost none of what can throw up here deserves that. A helper's pipe breaking, a stray
 * rejection from a fire-and-forget `void` call, a window destroyed a beat before something wrote
 * to it — the app is entirely capable of carrying on. So the exception is logged loudly and the
 * process lives.
 *
 * This weakens no gate. Every safety check — `assertAcknowledged`, `studioExportRefusal` — is
 * re-evaluated inside the call that depends on it, in main, so surviving an unrelated throw
 * cannot carry a stale acknowledgement into an export.
 */
process.on('uncaughtException', (err) => {
    console.error('[showcasetool] uncaught exception in the main process:', err);
});
process.on('unhandledRejection', (reason) => {
    console.error('[showcasetool] unhandled promise rejection in the main process:', reason);
});
/**
 * Must happen before the app is ready — Electron accepts a privileged scheme at no other point,
 * and registering it late fails silently, leaving the studio editor with a video element that
 * never loads. See mediaProtocol.ts for why footage cannot travel over `file://`.
 */
(0, mediaProtocol_1.registerMediaScheme)();
/**
 * Single instance: two processes on one userData share a SQLite file and two relays fight
 * over the same port. The packaged app stays one-instance — a second click focuses the first.
 *
 * Unpackaged is different. The lock is keyed to the **userData directory, not the source
 * tree**, so a shipped build (or another checkout) sitting on Application Support/1ShowcaseTool
 * makes `npm run dev` exit 0 and `concurrently -k` tear Vite down with it. Vite already walks
 * off 5273 when that port is taken; the same move here is a sibling userData folder. The
 * shipped library is left alone, the isolated instance gets its own database, and the relay
 * already walks 47821–47825.
 *
 * Aptabase is initialized after the path is settled — it writes under userData, and doing so
 * before a fallback would put its files in a folder another process already owns. It still
 * has to run before `app.whenReady()`; the SDK refuses later.
 */
function claimSingleInstance() {
    if (electron_1.app.requestSingleInstanceLock())
        return true;
    // An explicit --user-data-dir is a choice; do not walk away from it.
    if (electron_1.app.isPackaged || electron_1.app.commandLine.hasSwitch('user-data-dir'))
        return false;
    const shipped = electron_1.app.getPath('userData');
    electron_1.app.releaseSingleInstanceLock();
    for (const candidate of (0, devInstance_1.isolatedUserDataCandidates)(shipped)) {
        electron_1.app.setPath('userData', candidate);
        if (electron_1.app.requestSingleInstanceLock()) {
            console.warn(`[showcasetool] ${shipped} is already running; this instance uses ${candidate}.`);
            return true;
        }
        electron_1.app.releaseSingleInstanceLock();
    }
    return false;
}
const defaultUserData = electron_1.app.getPath('userData');
const claimed = claimSingleInstance();
if (!claimed) {
    const isolated = (0, devInstance_1.isolatedUserDataCandidates)(defaultUserData)
        .map((p) => path_1.default.basename(p))
        .join(', ');
    console.error(`[showcasetool] another instance already holds the single-instance lock on ${defaultUserData}.\n` +
        (electron_1.app.isPackaged
            ? '[showcasetool] Quit it and start again — a build running from a different directory counts, ' +
                'because the lock follows the userData path rather than the source tree.'
            : `[showcasetool] Isolated userData folders (${isolated}) were also taken. Quit the other 1ShowcaseTool windows and start again.`));
    electron_1.app.quit();
}
else {
    /**
     * Aptabase SDK refuses to initialize after `app.isReady()`, so this must run before any
     * `app.whenReady()` below. Tracking is still gated on the user's opt-in; initialize only
     * loads the SDK.
     */
    (0, analytics_1.initAnalytics)();
    electron_1.app.on('second-instance', () => {
        const [existing] = electron_1.BrowserWindow.getAllWindows();
        if (existing) {
            if (existing.isMinimized())
                existing.restore();
            existing.focus();
        }
    });
    void electron_1.app.whenReady().then(async () => {
        /**
         * A throw in here used to leave the worst failure mode an app has: a live process with no
         * window, no dialog and no console anyone is watching — a Dock icon that does nothing.
         * A corrupt database is the realistic cause, so the error box names the file to move.
         */
        try {
            (0, db_1.getDb)();
            (0, mediaProtocol_1.serveMedia)();
            /**
             * Before the handlers, not after: the licence mirror is loaded from the keychain, which is
             * async, and a renderer that asked first would be told "free" by an install that is paid for.
             */
            await LicenseService_1.licenseService.init(electron_1.app.getVersion());
            /**
             * Before registerHandlers so a mid-boot check cannot push status with no listener path.
             * getLicenseInfo gates auto-download for Pro installs past their paid updates window.
             */
            (0, updater_1.setupUpdater)({ getLicenseInfo: () => LicenseService_1.licenseService.getLicenseInfo() });
            (0, registerHandlers_1.registerHandlers)();
            (0, registerRelayRoutes_1.registerRelayRoutes)();
        }
        catch (err) {
            electron_1.dialog.showErrorBox('1ShowcaseTool could not start', `${err.message}\n\nIf this repeats, the database may be damaged — move the showcasetool folder out of ${electron_1.app.getPath('userData')} and start again.`);
            electron_1.app.exit(1);
            return;
        }
        // The window first: the relay walks candidate ports and every failed bind would otherwise
        // sit between launch and first paint. The renderer learns the port from relay.status().
        createWindow();
        void ExtensionRelayService_1.extensionRelay
            .start()
            .then((port) => console.log(`[showcasetool] relay listening on 127.0.0.1:${port}`))
            // The app is still useful without the extension — review, generate, export all work.
            .catch((err) => console.error(`[showcasetool] relay failed to start: ${err.message}`));
        // Overdue raw footage, orphaned imported scenes and stranded export scratch files go at
        // start, not the next time their respective feature happens to run.
        MachineRecorderService_1.machineRecorder.sweepOnBoot();
        (0, StudioService_1.sweepRenderStash)();
        const usedSceneIds = GuideSessionStore_1.guideSessionStore.studioSceneAssetIds();
        if (usedSceneIds) {
            const removed = (0, SceneAssetService_1.sweepScenes)(usedSceneIds);
            if (removed)
                console.log(`[showcasetool] swept ${removed} orphaned imported scene${removed === 1 ? '' : 's'}`);
        }
        else {
            console.warn('[showcasetool] imported-scene sweep skipped because a stored studio project could not be audited');
        }
        /**
         * A recording the last run did not live to finish is closed out here — and any capture
         * process that outlived it is ended. Otherwise the store keeps a session marked 'recording'
         * forever, and both recorders refuse to start over it.
         */
        MachineRecorderService_1.machineRecorder.reconcileOnBoot();
        /**
         * The licence refresh runs on its own clock (boot + 15s, then daily), so a verdict can change
         * under a window nobody is touching. Push it rather than making the renderer poll — and push
         * the whole info object, so the Settings card and any Pro hint cannot disagree about it.
         */
        LicenseService_1.licenseService.onChange(() => {
            const info = LicenseService_1.licenseService.getLicenseInfo();
            for (const window of electron_1.BrowserWindow.getAllWindows()) {
                if (!window.isDestroyed())
                    window.webContents.send(channels_1.CHANNELS.events.licenseChanged, info);
            }
        });
        LicenseService_1.licenseService.startRefresh();
        // Quiet in unpackaged dev builds (no app-update.yml). Delay so first paint is not competing.
        if (electron_1.app.isPackaged) {
            setTimeout(() => (0, updater_1.checkForUpdatesInBackground)(), 8_000);
        }
        // Aggregate only — version / platform / arch. Never paths, titles, or content.
        (0, analytics_1.trackEvent)('app_started', {
            version: electron_1.app.getVersion(),
            platform: process.platform,
            arch: process.arch,
        });
        /**
         * Name the subprocess that died, because the visible symptom never does.
         *
         * A GPU process lost during a studio export takes `VideoEncoder` with it, and a renderer lost
         * mid-recording leaves a window that is blank rather than gone. Both read to the Maker as
         * "the app broke" with nothing in the terminal to say which part, and the encode path is the
         * one under most strain — `verify:video` exercises it, a real 4K take does so much harder.
         */
        electron_1.app.on('child-process-gone', (_event, details) => {
            console.error(`[showcasetool] ${details.type} process gone: ${details.reason} (exit ${details.exitCode})`);
        });
        /**
         * A crashed renderer leaves a window that is blank but present, which reads as a hang.
         * Reload it once per minute-window — once, because a crash loop reloading at full speed is
         * strictly worse than a blank window with an error box.
         */
        let lastRendererRevival = 0;
        electron_1.app.on('render-process-gone', (_event, contents, details) => {
            console.error(`[showcasetool] renderer gone: ${details.reason} (exit ${details.exitCode})`);
            if (details.reason === 'clean-exit' || contents.isDestroyed())
                return;
            const now = Date.now();
            if (now - lastRendererRevival > 60_000) {
                lastRendererRevival = now;
                contents.reload();
            }
            else {
                electron_1.dialog.showErrorBox('1ShowcaseTool keeps crashing', `The window crashed twice in a minute (${details.reason}). Please relaunch the app; your recordings are safe on disk.`);
            }
        });
        electron_1.app.on('activate', () => {
            if (electron_1.BrowserWindow.getAllWindows().length === 0)
                createWindow();
        });
    });
    electron_1.app.on('window-all-closed', () => {
        if (process.platform !== 'darwin')
            electron_1.app.quit();
    });
    /**
     * Quit waits for the recorder. `dispose()` used to fire the helper's stop and return, and
     * the process exited before the movie finalised — the helper was orphaned still capturing,
     * and the take had no moov atom: unopenable, gigabytes of nothing. One preventDefault, one
     * awaited shutdown (with its own deadline and a hard kill behind it), then a real quit.
     */
    let quitting = false;
    electron_1.app.on('before-quit', (event) => {
        if (quitting)
            return;
        quitting = true;
        event.preventDefault();
        (0, analytics_1.trackEvent)('app_quit');
        void MachineRecorderService_1.machineRecorder
            .shutdown()
            .catch(() => undefined)
            .then(() => {
            ExtensionRelayService_1.extensionRelay.stop();
            (0, db_1.closeDb)();
            electron_1.app.quit();
        });
    });
    electron_1.app.on('will-quit', () => electron_1.globalShortcut.unregisterAll());
}
//# sourceMappingURL=main.js.map