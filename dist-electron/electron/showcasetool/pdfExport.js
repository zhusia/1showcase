"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.renderGuideToPdf = renderGuideToPdf;
const electron_1 = require("electron");
const crypto_1 = require("crypto");
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const exporters_1 = require("./exporters");
/**
 * Wide screenshots are the normal case for a recorded browser flow, and A4 portrait at default
 * margins crops them hard. Narrow margins buy roughly 3 cm of usable width and cost nothing —
 * this is a reference document, not a letter.
 */
const MARGIN_INCHES = 0.4;
async function renderGuideToPdf(guide, options = {}) {
    // Same document as the HTML export, so a PDF and an HTML of one guide cannot disagree — which
    // includes carrying the same watermark when one is owed.
    const html = (0, exporters_1.toSelfContainedHtml)(guide, options);
    const base = electron_1.app.isReady() ? electron_1.app.getPath('userData') : os_1.default.tmpdir();
    const dir = path_1.default.join(base, 'showcasetool', '.pdf', (0, crypto_1.randomUUID)());
    await fs_1.default.promises.mkdir(dir, { recursive: true });
    /**
     * Loaded from a real file rather than a data: URL. A data URL gets an opaque origin, which
     * has bitten this codebase before (see the VideoEncoder note in CLAUDE.md) and would also
     * make the inlined images subject to a different fetch path than the one the HTML export
     * is actually opened under.
     */
    const htmlFile = path_1.default.join(dir, 'guide.html');
    await fs_1.default.promises.writeFile(htmlFile, html, 'utf8');
    const win = new electron_1.BrowserWindow({
        show: false,
        webPreferences: {
            // Same posture as the video renderer: our document, but it carries model-authored prose
            // and screenshot bytes, so it gets no Node and no preload.
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            backgroundThrottling: false,
        },
    });
    try {
        await win.loadFile(htmlFile);
        /**
         * Two things the print stylesheet cannot do on its own.
         *
         * `open` on every <details>: on paper nobody can click, so an unopened disclosure means the
         * step's reasoning is simply missing from the PDF.
         *
         * Waiting on fonts and images: printToPDF does not wait, and a screenshot that has not
         * decoded yet prints as a blank box. Same failure the video renderer guards against.
         */
        await win.webContents.executeJavaScript(`(async () => {
         document.querySelectorAll('details').forEach((d) => d.setAttribute('open', ''));
         if (document.fonts && document.fonts.ready) await document.fonts.ready;
         const images = Array.from(document.images);
         await Promise.all(images.map((img) => img.complete ? null : new Promise((resolve) => {
           img.addEventListener('load', resolve, { once: true });
           img.addEventListener('error', resolve, { once: true });
         })));
         return true;
       })()`, true);
        return await win.webContents.printToPDF({
            pageSize: options.pageSize ?? 'A4',
            landscape: options.landscape ?? false,
            // Screenshots and the accent-coloured step numerals are the content, not decoration.
            printBackground: true,
            preferCSSPageSize: false,
            margins: { top: MARGIN_INCHES, bottom: MARGIN_INCHES, left: MARGIN_INCHES, right: MARGIN_INCHES },
        });
    }
    finally {
        if (!win.isDestroyed())
            win.destroy();
        await fs_1.default.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
}
//# sourceMappingURL=pdfExport.js.map