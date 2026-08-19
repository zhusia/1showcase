"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.surfaceAppWindow = surfaceAppWindow;
const electron_1 = require("electron");
/**
 * Bring the app's window forward, for the moment a recording ends.
 *
 * No recorder is stopped from this window: the machine recorders are stopped on the floating
 * bar, which destroys itself, and the browser recorder is stopped in the extension popup with
 * Chrome in front. Either way the screen the finished take routes to is one nobody is looking
 * at, and the app appears to have done nothing with what was just recorded.
 *
 * One definition rather than a copy per stop path, because where a take lands has to look the
 * same however it was recorded. Never call it on the way out — a window snapping to the front
 * for a moment as the app quits is the one time this is noise.
 */
function surfaceAppWindow() {
    const window = electron_1.BrowserWindow.getFocusedWindow() ?? electron_1.BrowserWindow.getAllWindows()[0];
    if (!window || window.isDestroyed())
        return;
    if (window.isMinimized())
        window.restore();
    window.show();
    // macOS is the only platform that reads `steal`; elsewhere the show above has done the work.
    electron_1.app.focus({ steal: true });
}
//# sourceMappingURL=appWindow.js.map