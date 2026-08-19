"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.updateEntitled = updateEntitled;
exports.getUpdateStatusSnapshot = getUpdateStatusSnapshot;
exports.formatUpdaterError = formatUpdaterError;
exports.setupUpdater = setupUpdater;
exports.checkForUpdates = checkForUpdates;
exports.downloadUpdate = downloadUpdate;
exports.installUpdate = installUpdate;
exports.getAppVersion = getAppVersion;
exports.checkForUpdatesInBackground = checkForUpdatesInBackground;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const electron_1 = require("electron");
const electron_updater_1 = require("electron-updater");
const channels_1 = require("./ipc/channels");
let configured = false;
let getLicenseInfoFn = null;
const DOWNLOAD_RETRY_DELAYS_MS = [30_000, 60_000, 120_000, 300_000, 600_000];
let downloadInFlight = false;
let retryTimer = null;
let retryAttempts = 0;
let retryVersion = null;
/** Version already handed to the platform installer this process — do not re-stage. */
let downloadedVersion = null;
let installHandoffPending = false;
let lastStatus = { status: 'idle' };
let lastInfo;
let lastProgress;
/**
 * Free installs always get updates. A licensed install past its paid updates window
 * does not, unless the release is marked security-critical on the manifest.
 */
function updateEntitled(info, update) {
    if (!info || !info.isLicensed)
        return true;
    if (update.securityCritical === true)
        return true;
    return info.canUpdate;
}
function getUpdateStatusSnapshot() {
    return {
        ...lastStatus,
        info: lastStatus.info ?? lastInfo,
        progress: lastStatus.progress ?? lastProgress,
    };
}
function clearDownloadRetry() {
    if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
    }
}
function scheduleDownloadRetry() {
    if (retryAttempts >= DOWNLOAD_RETRY_DELAYS_MS.length)
        return false;
    const delay = DOWNLOAD_RETRY_DELAYS_MS[retryAttempts];
    retryAttempts += 1;
    clearDownloadRetry();
    retryTimer = setTimeout(() => {
        retryTimer = null;
        electron_updater_1.autoUpdater.checkForUpdates().catch(() => { });
    }, delay);
    retryTimer.unref?.();
    return true;
}
function createUpdaterLogger() {
    const logDir = path_1.default.join(electron_1.app.getPath('userData'), 'logs');
    const logFile = path_1.default.join(logDir, 'updater.log');
    const write = (level, ...args) => {
        const text = args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ');
        const line = `[${new Date().toISOString()}] [${level}] ${text}\n`;
        try {
            fs_1.default.mkdirSync(logDir, { recursive: true });
            fs_1.default.appendFileSync(logFile, line);
        }
        catch {
            // Logging must never crash the updater.
        }
        console.log(`[updater] ${level}:`, ...args);
    };
    return {
        info: (...args) => write('info', ...args),
        warn: (...args) => write('warn', ...args),
        error: (...args) => write('error', ...args),
        debug: (...args) => write('debug', ...args),
    };
}
function formatUpdaterError(error) {
    const message = error?.message ?? String(error);
    if (/app-update\.yml|dev-app-update\.yml/i.test(message)) {
        return 'Updates are only available in packaged release builds.';
    }
    if (/ERR_UPDATER_NO_FILES_PROVIDED|reading 'info'/i.test(message)) {
        return 'No update package is available for this platform yet.';
    }
    if (/sha512|sha256|checksum/i.test(message)) {
        return 'Update verification failed. Please try again later.';
    }
    if (/net::|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ECONNRESET/i.test(message)) {
        return 'Could not reach the update server. Check your connection and try again.';
    }
    return message;
}
function broadcast(status) {
    for (const window of electron_1.BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
            try {
                window.webContents.send(channels_1.CHANNELS.events.updateStatus, status);
            }
            catch {
                // Window disposed mid-send.
            }
        }
    }
}
function sendUpdateStatus(status) {
    lastStatus = status;
    if (status.info)
        lastInfo = status.info;
    if (status.progress)
        lastProgress = status.progress;
    if (status.status === 'not-available') {
        lastInfo = status.info;
        lastProgress = undefined;
    }
    broadcast(status);
}
function maybeAutoDownload(info) {
    if (!updateEntitled(getLicenseInfoFn?.(), info))
        return;
    downloadInFlight = true;
    electron_updater_1.autoUpdater.downloadUpdate().catch(() => {
        // 'error' event owns the status update.
    });
}
function setupUpdater(deps = {}) {
    if (deps.getLicenseInfo)
        getLicenseInfoFn = deps.getLicenseInfo;
    if (configured)
        return;
    configured = true;
    electron_updater_1.autoUpdater.autoDownload = false;
    electron_updater_1.autoUpdater.autoInstallOnAppQuit = true;
    electron_updater_1.autoUpdater.logger = createUpdaterLogger();
    if (process.platform === 'win32') {
        electron_updater_1.autoUpdater.channel = 'latest-windows';
    }
    electron_updater_1.autoUpdater.on('checking-for-update', () => sendUpdateStatus({ status: 'checking' }));
    electron_updater_1.autoUpdater.on('update-available', (info) => {
        if (retryVersion !== info.version) {
            clearDownloadRetry();
            retryVersion = info.version;
            retryAttempts = 0;
            downloadedVersion = null;
        }
        if (downloadedVersion === info.version) {
            sendUpdateStatus({ status: 'downloaded', info });
            return;
        }
        sendUpdateStatus({ status: 'available', info });
        maybeAutoDownload(info);
    });
    electron_updater_1.autoUpdater.on('update-not-available', (info) => {
        sendUpdateStatus({ status: 'not-available', info });
    });
    electron_updater_1.autoUpdater.on('download-progress', (progress) => {
        downloadInFlight = true;
        sendUpdateStatus({ status: 'downloading', progress, info: lastInfo });
    });
    electron_updater_1.autoUpdater.on('update-downloaded', (info) => {
        downloadInFlight = false;
        clearDownloadRetry();
        retryAttempts = 0;
        downloadedVersion = info.version;
        sendUpdateStatus({ status: 'downloaded', info });
    });
    electron_updater_1.autoUpdater.on('error', (error) => {
        const wasDownloading = downloadInFlight;
        downloadInFlight = false;
        const retryScheduled = wasDownloading ? scheduleDownloadRetry() : false;
        sendUpdateStatus({ status: 'error', error: formatUpdaterError(error), retryScheduled, info: lastInfo });
    });
}
async function checkForUpdates() {
    const result = await electron_updater_1.autoUpdater.checkForUpdates();
    if (result == null) {
        throw new Error('Updates are only available in packaged release builds.');
    }
    return { updateInfo: result.updateInfo };
}
async function downloadUpdate() {
    if (downloadedVersion != null && lastInfo?.version === downloadedVersion) {
        sendUpdateStatus({ status: 'downloaded', info: lastInfo });
        return;
    }
    downloadInFlight = true;
    await electron_updater_1.autoUpdater.downloadUpdate();
}
async function installUpdate() {
    if (installHandoffPending)
        return;
    installHandoffPending = true;
    try {
        electron_updater_1.autoUpdater.quitAndInstall(false, true);
    }
    catch (error) {
        installHandoffPending = false;
        throw error;
    }
    // macOS Squirrel sometimes only minimizes; hard exit lets ShipIt finish the swap.
    if (electron_1.app.isPackaged) {
        setTimeout(() => electron_1.app.exit(0), 3000);
    }
}
function getAppVersion() {
    return electron_1.app.getVersion();
}
/** Fire-and-forget post-launch check. Quiet in dev (no app-update.yml). */
function checkForUpdatesInBackground() {
    electron_updater_1.autoUpdater.checkForUpdates().catch((error) => {
        electron_updater_1.autoUpdater.logger?.error?.(`Background update check failed: ${String(error)}`);
    });
}
//# sourceMappingURL=updater.js.map