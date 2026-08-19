"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.bakeAnnotatedScreenshots = bakeAnnotatedScreenshots;
exports.pngSize = pngSize;
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const crypto_1 = require("crypto");
const electron_1 = require("electron");
const annotations_1 = require("./annotations");
const ScreenshotStore_1 = require("./ScreenshotStore");
/**
 * Baking annotations into exported image copies.
 *
 * Markdown cannot overlay anything on an image, so the marks have to be in the pixels for
 * that export to carry them. This composites them offscreen and returns new bytes — it never
 * writes back to the screenshot store. That distinction is the whole point: the stored
 * bitmap stays exactly what the redaction pass left behind (§7.2), and every annotation stays
 * reversible by re-exporting. The HTML and video exports keep drawing marks as data instead.
 */
/** Chromium will not give us a usefully larger viewport than this, and no export needs one. */
const MAX_EDGE = 2560;
async function bakeAnnotatedScreenshots(guide) {
    const targets = guide.steps.filter((step) => step.screenshot && step.annotations.length > 0);
    if (!targets.length)
        return new Map();
    const baked = new Map();
    const dir = tempRoot();
    let win = null;
    try {
        for (const step of targets) {
            const source = ScreenshotStore_1.screenshotStore.absolutePath(step.screenshot);
            if (!fs_1.default.existsSync(source))
                continue;
            const bytes = fs_1.default.readFileSync(source);
            const size = pngSize(bytes);
            // Without real dimensions the overlay cannot be placed, and a guessed size would put
            // the arrow somewhere arbitrary — skip the step and export the plain screenshot.
            if (!size)
                continue;
            const scale = Math.min(1, MAX_EDGE / Math.max(size.width, size.height));
            const width = Math.max(1, Math.round(size.width * scale));
            const height = Math.max(1, Math.round(size.height * scale));
            const html = shotDocument(`data:image/png;base64,${bytes.toString('base64')}`, width, height, (0, annotations_1.annotationOverlayMarkup)(step.annotations));
            const file = path_1.default.join(dir, `${step.id.replace(/[^a-z0-9_-]/gi, '_')}.html`);
            fs_1.default.writeFileSync(file, html, 'utf8');
            if (!win)
                win = createWindow(width, height);
            else
                win.setContentSize(width, height);
            await win.loadFile(file);
            await win.webContents
                .executeJavaScript(`Promise.all(Array.from(document.images).map(function(img){
             return img.complete ? true : new Promise(function(r){ img.addEventListener('load', r); img.addEventListener('error', r); });
           })).then(function(){ if (window.__gtDrawAnnotations) window.__gtDrawAnnotations(); return true; })`)
                .catch(() => undefined);
            let image = await win.webContents.capturePage();
            const captured = image.getSize();
            if (captured.width !== width || captured.height !== height)
                image = image.resize({ width, height, quality: 'best' });
            baked.set(step.id, image.toPNG());
        }
    }
    finally {
        if (win && !win.isDestroyed())
            win.destroy();
        await fs_1.default.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
    return baked;
}
function createWindow(width, height) {
    return new electron_1.BrowserWindow({
        width,
        height,
        useContentSize: true,
        show: false,
        frame: false,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
}
/** The image at exactly the viewport size, so the capture is the picture and nothing else. */
function shotDocument(dataUri, width, height, overlay) {
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
${annotations_1.ANNOTATION_CSS}
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${width}px; height: ${height}px; overflow: hidden; background: #0b0e14; }
  .gt-shot { width: ${width}px; height: ${height}px; }
  .gt-shot img { display: block; width: ${width}px; height: ${height}px; }
</style>
</head>
<body>
<span class="gt-shot"><img src="${dataUri}" alt="" />${overlay}</span>
${annotations_1.ANNOTATION_SCRIPT}
</body>
</html>`;
}
/**
 * Read the dimensions straight out of the PNG header rather than decoding the image. The
 * store only ever writes PNGs, and IHDR is the first chunk of every one of them.
 */
function pngSize(buffer) {
    if (buffer.length < 24)
        return null;
    if (buffer.readUInt32BE(0) !== 0x89504e47 || buffer.readUInt32BE(4) !== 0x0d0a1a0a)
        return null;
    if (buffer.toString('ascii', 12, 16) !== 'IHDR')
        return null;
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    return width > 0 && height > 0 ? { width, height } : null;
}
function tempRoot() {
    const base = electron_1.app.isReady() ? electron_1.app.getPath('userData') : os_1.default.tmpdir();
    const dir = path_1.default.join(base, 'showcasetool', '.bake', (0, crypto_1.randomUUID)());
    fs_1.default.mkdirSync(dir, { recursive: true });
    return dir;
}
//# sourceMappingURL=annotationBake.js.map