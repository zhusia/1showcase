"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerRegionSelect = registerRegionSelect;
exports.selectRegion = selectRegion;
const path_1 = __importDefault(require("path"));
const electron_1 = require("electron");
const channels_1 = require("../ipc/channels");
const devServer_1 = require("../devServer");
let pending = null;
function rendererFile() {
    // __dirname is dist-electron/electron/showcasetool once compiled.
    return path_1.default.join(__dirname, '../../../dist-renderer/index.html');
}
/** Tear down every overlay and answer the caller exactly once. */
function settle(result) {
    const current = pending;
    if (!current || current.done)
        return;
    current.done = true;
    pending = null;
    for (const window of current.windows) {
        if (!window.isDestroyed())
            window.destroy();
    }
    current.resolve(result);
}
/**
 * Wired once at startup rather than per call, because `ipcMain.on` accumulates listeners and a
 * Maker who opens the picker ten times would otherwise get ten replies to one drag.
 */
function registerRegionSelect() {
    electron_1.ipcMain.on(channels_1.CHANNELS.events.regionPicked, (_event, payload) => {
        if (!payload || !payload.rect)
            return settle(null);
        const display = electron_1.screen.getAllDisplays().find((item) => item.id === payload.displayId);
        if (!display)
            return settle(null);
        // The overlay reports in its own window's CSS pixels, which are display-local. The helper
        // wants global points, so the display's own origin is added back on here — one place,
        // rather than in a renderer that has no reason to know about display topology.
        const rect = {
            x: Math.round(display.bounds.x + payload.rect.x),
            y: Math.round(display.bounds.y + payload.rect.y),
            width: Math.round(payload.rect.width),
            height: Math.round(payload.rect.height),
        };
        // A stray click is a 1×1 rect, not a region. Treating it as one would start a recording of
        // nothing, which reads as a crash.
        if (rect.width < 16 || rect.height < 16)
            return settle(null);
        settle({ displayId: payload.displayId, rect });
    });
}
/** Resolves with the chosen region, or null if the Maker pressed Escape or clicked without dragging. */
function selectRegion() {
    // A second picker over the first would leave two sets of overlays fighting for the drag.
    if (pending)
        settle(null);
    return new Promise((resolve) => {
        const windows = [];
        pending = { windows, resolve, done: false };
        for (const display of electron_1.screen.getAllDisplays()) {
            const overlay = new electron_1.BrowserWindow({
                x: display.bounds.x,
                y: display.bounds.y,
                width: display.bounds.width,
                height: display.bounds.height,
                frame: false,
                transparent: true,
                backgroundColor: '#00000000',
                hasShadow: false,
                resizable: false,
                movable: false,
                minimizable: false,
                maximizable: false,
                fullscreenable: false,
                skipTaskbar: true,
                alwaysOnTop: true,
                // Without this the overlay steals focus back from whatever the Maker is about to record
                // when it closes, which on macOS also flashes the app to the front.
                acceptFirstMouse: true,
                webPreferences: {
                    preload: path_1.default.join(__dirname, '../preload.js'),
                    contextIsolation: true,
                    nodeIntegration: false,
                    sandbox: true,
                },
            });
            overlay.setAlwaysOnTop(true, 'screen-saver');
            overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
            overlay.setContentProtection(true);
            const hash = `region?display=${display.id}`;
            // The dev port is whichever one Vite could get, resolved once at startup — never assumed here.
            const devUrl = (0, devServer_1.devServerUrl)(hash);
            if (devUrl) {
                void overlay.loadURL(devUrl).catch(() => void overlay.loadFile(rendererFile(), { hash }));
            }
            else {
                void overlay.loadFile(rendererFile(), { hash });
            }
            // Closing any overlay — by Escape, or by the window manager — cancels the whole picker.
            overlay.on('closed', () => settle(null));
            windows.push(overlay);
        }
        if (!windows.length)
            settle(null);
    });
}
//# sourceMappingURL=regionSelect.js.map