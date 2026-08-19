"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.screenshotStore = exports.ScreenshotStore = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const crypto_1 = require("crypto");
const electron_1 = require("electron");
const db_1 = require("../db");
/**
 * Screenshots live on disk, not in SQLite — they are the bulk of a session and the
 * redaction editor overwrites them in place.
 */
/** One path segment, same shape the gtmedia:// handler enforces. Never a separator or a dot-dot. */
function assertSafeSegment(id) {
    if (!/^[a-z0-9-]{8,64}$/i.test(id))
        throw new Error('invalid session id');
}
class ScreenshotStore {
    dirFor(sessionId) {
        assertSafeSegment(sessionId);
        const dir = path_1.default.join((0, db_1.screenshotDir)(), sessionId);
        if (!fs_1.default.existsSync(dir))
            fs_1.default.mkdirSync(dir, { recursive: true });
        return dir;
    }
    /** Decode a PNG data URI to disk. Returns the store-relative path. */
    writeDataUri(sessionId, dataUri, hint = 'step') {
        const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUri.trim());
        if (!match)
            return null;
        const name = `${hint}-${(0, crypto_1.randomUUID)().slice(0, 8)}.png`;
        fs_1.default.writeFileSync(path_1.default.join(this.dirFor(sessionId), name), Buffer.from(match[1], 'base64'));
        return `${sessionId}/${name}`;
    }
    /** Write bounded structured sidecar data beside a screenshot. */
    writeJson(sessionId, value, hint = 'project') {
        const json = JSON.stringify(value);
        if (Buffer.byteLength(json, 'utf8') > 48 * 1024 * 1024)
            throw new Error('annotation project is too large');
        const name = `${hint}-${(0, crypto_1.randomUUID)().slice(0, 8)}.json`;
        fs_1.default.writeFileSync(path_1.default.join(this.dirFor(sessionId), name), json, 'utf8');
        return `${sessionId}/${name}`;
    }
    readJson(relative) {
        const abs = this.absolutePath(relative);
        if (!fs_1.default.existsSync(abs))
            return null;
        const size = fs_1.default.statSync(abs).size;
        if (size > 48 * 1024 * 1024)
            throw new Error('annotation project is too large');
        return JSON.parse(fs_1.default.readFileSync(abs, 'utf8'));
    }
    /**
     * Resolve-then-contain, the same guard `gtmedia://` runs. The relative path arrives over IPC
     * and a bare join would read or overwrite any file the renderer names — the sandbox exists
     * precisely so that a compromised renderer cannot do that.
     */
    absolutePath(relative) {
        const root = (0, db_1.screenshotDir)();
        const resolved = path_1.default.resolve(root, relative);
        if (resolved !== root && !resolved.startsWith(root + path_1.default.sep))
            throw new Error('invalid screenshot path');
        return resolved;
    }
    exists(relative) {
        return fs_1.default.existsSync(this.absolutePath(relative));
    }
    readDataUri(relative) {
        const abs = this.absolutePath(relative);
        if (!fs_1.default.existsSync(abs))
            return null;
        return `data:image/png;base64,${fs_1.default.readFileSync(abs).toString('base64')}`;
    }
    /**
     * A downscaled JPEG of a stored screenshot, for the library's grid tiles.
     *
     * Derived on demand and never written anywhere. The stored bitmap is the one file redaction
     * overwrites (§7.2 guarantee 1), so a thumbnail cached beside it would be a pre-redaction copy
     * of pixels the destructive pass believes it destroyed. Re-reading the file every time keeps
     * it the only copy there is.
     *
     * JPEG rather than the source PNG: a tile is decoration, and shipping a screenshot-sized PNG
     * data URI per row over IPC is the cost this exists to avoid.
     */
    readThumbnailDataUri(relative, width = 480) {
        const abs = this.absolutePath(relative);
        if (!fs_1.default.existsSync(abs))
            return null;
        const image = electron_1.nativeImage.createFromPath(abs);
        if (image.isEmpty())
            return null;
        // Only ever downscale. A step captured on a small viewport must not be blown up to fill a tile.
        const scaled = image.getSize().width > width ? image.resize({ width, quality: 'good' }) : image;
        const jpeg = scaled.toJPEG(72);
        if (!jpeg.length)
            return null;
        return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
    }
    /**
     * Overwrite the stored bitmap with the redaction editor's output.
     *
     * This is what makes redaction destructive (§7.2 guarantee 1): the painted pixels
     * replace the file, so there is no original underneath and no "unredact". Written
     * via a temp file + rename so a crash mid-write cannot leave a half-redacted image
     * that still shows the secret.
     */
    overwrite(relative, dataUri) {
        const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUri.trim());
        if (!match)
            return false;
        const abs = this.absolutePath(relative);
        if (!fs_1.default.existsSync(abs))
            return false;
        const tmp = `${abs}.redacting`;
        fs_1.default.writeFileSync(tmp, Buffer.from(match[1], 'base64'));
        fs_1.default.renameSync(tmp, abs);
        return true;
    }
    deleteSession(sessionId) {
        assertSafeSegment(sessionId);
        const dir = path_1.default.join((0, db_1.screenshotDir)(), sessionId);
        if (fs_1.default.existsSync(dir))
            fs_1.default.rmSync(dir, { recursive: true, force: true });
    }
    delete(relative) {
        const abs = this.absolutePath(relative);
        if (fs_1.default.existsSync(abs))
            fs_1.default.rmSync(abs, { force: true });
    }
}
exports.ScreenshotStore = ScreenshotStore;
exports.screenshotStore = new ScreenshotStore();
//# sourceMappingURL=ScreenshotStore.js.map