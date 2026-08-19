"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.screenPermission = screenPermission;
exports.openPermissionSettings = openPermissionSettings;
exports.listWindows = listWindows;
exports.listCaptureSources = listCaptureSources;
exports.captureWindow = captureWindow;
const electron_1 = require("electron");
const machinePolicy_1 = require("./machinePolicy");
/**
 * Bound on capture resolution. A window cannot be larger than the display it is on, so the
 * largest display in device pixels is the natural cap — but a wall of 6K monitors would make
 * every step a 100 MB PNG, so it is clamped as well.
 */
const MAX_CAPTURE_EDGE = 3840;
function captureCap() {
    let width = 1920;
    let height = 1080;
    for (const display of electron_1.screen.getAllDisplays()) {
        const scale = display.scaleFactor || 1;
        width = Math.max(width, Math.round(display.size.width * scale));
        height = Math.max(height, Math.round(display.size.height * scale));
    }
    const overshoot = Math.max(width / MAX_CAPTURE_EDGE, height / MAX_CAPTURE_EDGE, 1);
    return { width: Math.round(width / overshoot), height: Math.round(height / overshoot) };
}
/**
 * Whether we may capture at all.
 *
 * macOS will not let an app prompt for Screen Recording the way it prompts for the camera —
 * the system raises its own dialog on the first real capture attempt, and the grant does not
 * take effect until the app restarts. Both of those read as bugs unless the UI says them out
 * loud, so they are returned as a hint rather than left for the Maker to work out.
 */
function screenPermission() {
    if (process.platform !== 'darwin') {
        return { status: 'granted', usable: true, hint: null, canOpenSettings: false };
    }
    let status = 'unknown';
    try {
        status = electron_1.systemPreferences.getMediaAccessStatus('screen');
    }
    catch {
        status = 'unknown';
    }
    switch (status) {
        case 'granted':
            return { status, usable: true, hint: null, canOpenSettings: true };
        case 'denied':
        case 'restricted':
            return {
                status,
                usable: false,
                hint: 'macOS is blocking screen recording for 1ShowcaseTool. Turn it on in System Settings → Privacy & Security → Screen Recording, then restart the app.',
                canOpenSettings: true,
            };
        default:
            return {
                status,
                usable: true,
                hint: 'macOS has not been asked yet. Starting a recording raises the system prompt — you may have to restart 1ShowcaseTool once after allowing it.',
                canOpenSettings: true,
            };
    }
}
const MAC_PERMISSION_SETTINGS = {
    screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    camera: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
    microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
    accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
};
/** Open the exact macOS privacy pane needed for a denied recording capability. */
async function openPermissionSettings(target = 'screen') {
    if (process.platform !== 'darwin')
        return false;
    const url = MAC_PERMISSION_SETTINGS[target];
    if (!url)
        throw new Error(`unknown permission settings target: ${String(target)}`);
    await electron_1.shell.openExternal(url);
    return true;
}
/**
 * The windows the Maker can pick as a target. Thumbnails are small on purpose — this is a
 * picker, not a capture, and asking for full-resolution frames of every open window to draw a
 * grid of 320px tiles would be a large and pointless allocation.
 *
 * Blocked windows are returned rather than hidden, carrying the reason, so the Maker sees
 * that the refusal is deliberate instead of wondering where the window went.
 */
async function listWindows() {
    const sources = await electron_1.desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: { width: 320, height: 200 },
        fetchWindowIcons: false,
    });
    return sources
        .filter((source) => source.name.trim().length > 0)
        .map((source) => ({
        id: source.id,
        name: source.name,
        thumbnail: source.thumbnail.isEmpty() ? '' : source.thumbnail.toDataURL(),
        blockedReason: (0, machinePolicy_1.blockedWindowReason)(source.name),
    }));
}
/**
 * Thumbnails for the studio picker: every window *and* every display, in one batched call.
 *
 * Bigger tiles than the still-capture picker's, because a display thumbnail has to be legible
 * enough to tell two monitors apart — but still a picker, not a capture.
 */
async function listCaptureSources() {
    const sources = await electron_1.desktopCapturer.getSources({
        types: ['window', 'screen'],
        thumbnailSize: { width: 480, height: 300 },
        fetchWindowIcons: false,
    });
    return sources
        .map((source) => {
        // 'window:37779:0' / 'screen:1:0'. A shape that ever changes should degrade to "no
        // thumbnail" rather than mis-joining onto the wrong window.
        const [kind, rawId] = source.id.split(':');
        const nativeId = Number(rawId);
        if (!Number.isFinite(nativeId))
            return null;
        if (kind !== 'window' && kind !== 'screen')
            return null;
        const mapped = {
            kind: kind === 'screen' ? 'display' : 'window',
            nativeId,
            sourceId: source.id,
            name: source.name,
            thumbnail: source.thumbnail.isEmpty() ? '' : source.thumbnail.toDataURL(),
        };
        if (source.display_id)
            mapped.displayId = source.display_id;
        return mapped;
    })
        .filter((source) => source !== null);
}
/**
 * Capture one window at native resolution.
 *
 * `thumbnailSize` is the capture size, not a hint, and the image is scaled to *fit inside* it
 * with the aspect ratio preserved. Passing the largest display's device-pixel size therefore
 * yields the window's real pixels for any window that fits on screen, which is every window.
 * Getting this wrong is not a subtle bug — it is every exported screenshot being a soft
 * upscale, discovered at export time.
 *
 * `getSources` has no per-source size, so this does enumerate every window at that size. At
 * one call per user-triggered step, seconds apart, that is an acceptable cost; it is the
 * reason captures are serialised in MachineRecorderService rather than fired in parallel.
 */
async function captureWindow(sourceId) {
    const sources = await electron_1.desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: captureCap(),
        fetchWindowIcons: false,
    });
    const match = sources.find((source) => source.id === sourceId);
    if (!match) {
        return { ok: false, error: 'That window has closed, so there was nothing to capture. Stop the recording or reopen it.' };
    }
    /**
     * The blocklist is re-checked here, not only at start. A window's title changes — a browser
     * tab switches to a password manager's web vault, an editor opens a credentials file — and
     * the check that only ran minutes ago would not have seen it.
     */
    const blocked = (0, machinePolicy_1.blockedWindowReason)(match.name);
    if (blocked)
        return { ok: false, error: blocked };
    if (match.thumbnail.isEmpty()) {
        return { ok: false, error: 'The window returned an empty frame. It may be minimised or on another desktop.' };
    }
    const size = match.thumbnail.getSize();
    return { ok: true, dataUri: match.thumbnail.toDataURL(), name: match.name, width: size.width, height: size.height };
}
//# sourceMappingURL=machineCapture.js.map