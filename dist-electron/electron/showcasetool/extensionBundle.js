"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.EXTENSION_EXPORT_FOLDER = void 0;
exports.installDir = installDir;
exports.bundledSourcePath = bundledSourcePath;
exports.syncInstallCopy = syncInstallCopy;
exports.getExtensionInfo = getExtensionInfo;
exports.openInstallFolder = openInstallFolder;
exports.exportExtensionFolder = exportExtensionFolder;
/**
 * The browser extension is bundled with the app (~132 KB) so a Maker never has to clone the
 * repo just to record. Chrome cannot load an extension from inside an asar (or auto-install one
 * from a desktop app), so every install path here is: copy the built folder somewhere real,
 * then the Maker loads it unpacked.
 *
 * The stable install path lives under userData — not inside the .app — so an app update does
 * not move the folder Chrome already has loaded. "Open install folder" re-syncs from the
 * bundled build first, so the copy stays current without a second click.
 */
const electron_1 = require("electron");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
/** Folder name written next to wherever the Maker picks for Export. */
exports.EXTENSION_EXPORT_FOLDER = '1ShowcaseTool-extension';
/** Where Chrome is expected to load from — stable across app updates. */
function installDir() {
    return path_1.default.join(electron_1.app.getPath('userData'), 'showcasetool', 'extension');
}
/**
 * Built extension as shipped with this process. Packaged builds keep it inside the asar (fine
 * for our copy source; Chrome never sees that path). Dev resolves next to the repo root.
 */
function bundledSourcePath() {
    const candidates = electron_1.app.isPackaged
        ? [
            path_1.default.join(electron_1.app.getAppPath(), 'dist-extension-showcasetool'),
            // If a future packaging pass lifts it into extraResources (outside the asar).
            path_1.default.join(process.resourcesPath, 'dist-extension-showcasetool'),
        ]
        : [
            // dist-electron/electron/showcasetool → repo root
            path_1.default.join(__dirname, '..', '..', '..', 'dist-extension-showcasetool'),
            path_1.default.join(process.cwd(), 'dist-extension-showcasetool'),
        ];
    for (const candidate of candidates) {
        if (fs_1.default.existsSync(path_1.default.join(candidate, 'manifest.json')))
            return candidate;
    }
    return null;
}
function hasManifest(dir) {
    return fs_1.default.existsSync(path_1.default.join(dir, 'manifest.json'));
}
/**
 * Wipe-and-replace the userData copy from the bundled build. 132 KB; no need to diff.
 * Throws when the package never included the extension.
 */
function syncInstallCopy() {
    const source = bundledSourcePath();
    if (!source) {
        throw new Error('The browser extension is not bundled with this build. Run npm run build:extension, then restart the app.');
    }
    const dest = installDir();
    fs_1.default.rmSync(dest, { recursive: true, force: true });
    fs_1.default.mkdirSync(path_1.default.dirname(dest), { recursive: true });
    fs_1.default.cpSync(source, dest, { recursive: true });
    return dest;
}
function getExtensionInfo() {
    const available = bundledSourcePath() !== null || hasManifest(installDir());
    const installPath = hasManifest(installDir()) ? installDir() : null;
    return {
        available,
        installPath,
        exportFolderName: exports.EXTENSION_EXPORT_FOLDER,
    };
}
/** Sync the stable copy and select it in the system file browser so Load unpacked is one hop away. */
function openInstallFolder() {
    const dest = syncInstallCopy();
    // Point at a real file so Finder/Explorer selects the folder's contents rather than its parent.
    void electron_1.shell.showItemInFolder(path_1.default.join(dest, 'manifest.json'));
    return dest;
}
/**
 * Copy the extension into a Maker-chosen parent directory as `1ShowcaseTool-extension/`.
 * Returns the absolute path of the new folder, or null if they cancelled.
 */
async function exportExtensionFolder() {
    const source = bundledSourcePath();
    if (!source) {
        throw new Error('The browser extension is not bundled with this build. Run npm run build:extension, then restart the app.');
    }
    const window = electron_1.BrowserWindow.getFocusedWindow() ?? electron_1.BrowserWindow.getAllWindows()[0];
    const picked = await electron_1.dialog.showOpenDialog(window, {
        title: 'Choose where to export the extension folder',
        properties: ['openDirectory', 'createDirectory'],
    });
    if (picked.canceled || !picked.filePaths[0])
        return null;
    const dest = path_1.default.join(picked.filePaths[0], exports.EXTENSION_EXPORT_FOLDER);
    fs_1.default.rmSync(dest, { recursive: true, force: true });
    fs_1.default.cpSync(source, dest, { recursive: true });
    // Keep the stable install path in sync too — same bytes, and the next "Open" is already done.
    try {
        syncInstallCopy();
    }
    catch {
        // Export already succeeded; a userData write failure must not undo it.
    }
    void electron_1.shell.showItemInFolder(path_1.default.join(dest, 'manifest.json'));
    return dest;
}
//# sourceMappingURL=extensionBundle.js.map