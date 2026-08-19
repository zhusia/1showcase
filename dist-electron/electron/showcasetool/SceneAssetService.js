"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.scenesRoot = scenesRoot;
exports.sceneFile = sceneFile;
exports.imageDimensions = imageDimensions;
exports.importScene = importScene;
exports.sceneExists = sceneExists;
exports.sweepScenes = sweepScenes;
exports.newAssetId = newAssetId;
const crypto_1 = require("crypto");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const electron_1 = require("electron");
const electron_2 = require("electron");
/**
 * Custom mockup import (cinematic_video.md §4.4).
 *
 * Main-process only: the dialog, the decode, the write. Identified by magic bytes, not
 * extension. Re-encoded (EXIF stripped). Stored under userData/showcasetool/scenes/ as
 * an id the project names — never a URL.
 */
const MAX_BYTES = 12 * 1024 * 1024;
const MAX_EDGE = 4096;
/** Bound the decode before Chromium allocates the bitmap, not after it has already done so. */
const MAX_DECODE_PIXELS = 40_000_000;
const MAX_DECODE_EDGE = 32_768;
const STALE_TEMP_MS = 24 * 60 * 60 * 1000;
function scenesRoot() {
    const dir = path_1.default.join(electron_1.app.getPath('userData'), 'showcasetool', 'scenes');
    fs_1.default.mkdirSync(dir, { recursive: true });
    return dir;
}
function sceneFile(id) {
    if (!/^[a-z0-9-]{8,80}$/i.test(id))
        return null;
    const resolved = path_1.default.resolve(scenesRoot(), `${id}.jpg`);
    const base = scenesRoot() + path_1.default.sep;
    return resolved.startsWith(base) ? resolved : null;
}
function magicKind(buf) {
    if (buf.length >= 8 &&
        buf[0] === 0x89 &&
        buf[1] === 0x50 &&
        buf[2] === 0x4e &&
        buf[3] === 0x47 &&
        buf[4] === 0x0d &&
        buf[5] === 0x0a &&
        buf[6] === 0x1a &&
        buf[7] === 0x0a)
        return 'png';
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)
        return 'jpeg';
    if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP')
        return 'webp';
    return null;
}
/**
 * Read only the container header needed to put a ceiling on decode work. A compressed image can
 * fit under the byte cap and still claim a bitmap large enough to exhaust the process; asking
 * nativeImage to decode before checking dimensions would make the limit decorative.
 */
function imageDimensions(buf, kind) {
    if (kind === 'png') {
        if (buf.length < 24 || buf.toString('ascii', 12, 16) !== 'IHDR')
            return null;
        return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (kind === 'jpeg') {
        const frames = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
        let offset = 2;
        while (offset + 3 < buf.length) {
            if (buf[offset] !== 0xff) {
                offset += 1;
                continue;
            }
            while (offset < buf.length && buf[offset] === 0xff)
                offset += 1;
            const marker = buf[offset++];
            if (marker === 0x01 || marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7))
                continue;
            if (marker === 0xda || offset + 2 > buf.length)
                return null;
            const length = buf.readUInt16BE(offset);
            if (length < 2 || offset + length > buf.length)
                return null;
            if (frames.has(marker) && length >= 7) {
                return { width: buf.readUInt16BE(offset + 5), height: buf.readUInt16BE(offset + 3) };
            }
            offset += length;
        }
        return null;
    }
    let offset = 12;
    while (offset + 8 <= buf.length) {
        const fourcc = buf.toString('ascii', offset, offset + 4);
        const length = buf.readUInt32LE(offset + 4);
        const payload = offset + 8;
        if (payload + length > buf.length)
            return null;
        if (fourcc === 'VP8X' && length >= 10) {
            return {
                width: 1 + readUInt24LE(buf, payload + 4),
                height: 1 + readUInt24LE(buf, payload + 7),
            };
        }
        if (fourcc === 'VP8L' && length >= 5 && buf[payload] === 0x2f) {
            const bits = buf.readUInt32LE(payload + 1);
            return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
        }
        if (fourcc === 'VP8 ' &&
            length >= 10 &&
            buf[payload + 3] === 0x9d &&
            buf[payload + 4] === 0x01 &&
            buf[payload + 5] === 0x2a) {
            return {
                width: buf.readUInt16LE(payload + 6) & 0x3fff,
                height: buf.readUInt16LE(payload + 8) & 0x3fff,
            };
        }
        offset = payload + length + (length % 2);
    }
    return null;
}
function readUInt24LE(buf, offset) {
    return buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16);
}
function safeDecodeSize(size) {
    return (Number.isInteger(size.width) &&
        Number.isInteger(size.height) &&
        size.width > 0 &&
        size.height > 0 &&
        size.width <= MAX_DECODE_EDGE &&
        size.height <= MAX_DECODE_EDGE &&
        size.width * size.height <= MAX_DECODE_PIXELS);
}
async function writeSceneAtomic(dest, jpeg, id) {
    if (fs_1.default.existsSync(dest)) {
        const existing = await fs_1.default.promises.readFile(dest);
        if (existing.equals(jpeg))
            return;
        throw new Error('An imported mockup already exists under that content id. Nothing was overwritten.');
    }
    const temp = path_1.default.join(scenesRoot(), `.${id}.${newAssetId()}.tmp`);
    try {
        await fs_1.default.promises.writeFile(temp, jpeg, { flag: 'wx' });
        await fs_1.default.promises.rename(temp, dest);
    }
    catch (error) {
        // Two simultaneous imports of the same bytes are the same asset. Windows refuses to rename
        // over the winner; accept it only after proving its bytes are identical.
        if (fs_1.default.existsSync(dest)) {
            const existing = await fs_1.default.promises.readFile(dest);
            if (existing.equals(jpeg))
                return;
        }
        throw error;
    }
    finally {
        await fs_1.default.promises.rm(temp, { force: true }).catch(() => undefined);
    }
}
async function importScene() {
    const picked = await electron_1.dialog.showOpenDialog({
        title: 'Use my own mockup',
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
        properties: ['openFile'],
    });
    if (picked.canceled || !picked.filePaths[0])
        return null;
    const bytes = await fs_1.default.promises.readFile(picked.filePaths[0]);
    if (bytes.length > MAX_BYTES)
        throw new Error('That image is too large to import (12 MB limit).');
    const kind = magicKind(bytes);
    if (!kind)
        throw new Error('That file is not a PNG, JPEG or WebP.');
    const header = imageDimensions(bytes, kind);
    if (!header)
        throw new Error('That image has an invalid or unsupported header.');
    if (!safeDecodeSize(header))
        throw new Error('That image has too many pixels to import safely.');
    const image = electron_2.nativeImage.createFromBuffer(bytes);
    if (image.isEmpty())
        throw new Error('That image could not be decoded.');
    const size = image.getSize();
    if (!safeDecodeSize(size))
        throw new Error('That image decoded beyond the safe pixel limit.');
    const long = Math.max(size.width, size.height);
    const ratio = long > MAX_EDGE ? MAX_EDGE / long : 1;
    const scaled = ratio < 1
        ? image.resize({ width: Math.max(1, Math.round(size.width * ratio)), height: Math.max(1, Math.round(size.height * ratio)), quality: 'best' })
        : image;
    const jpeg = scaled.toJPEG(88);
    if (!jpeg.length)
        throw new Error('That image could not be re-encoded safely.');
    const id = (0, crypto_1.createHash)('sha256').update(jpeg).digest('hex');
    const dest = sceneFile(id);
    if (!dest)
        throw new Error('Could not name the imported mockup.');
    await writeSceneAtomic(dest, jpeg, id);
    const out = electron_2.nativeImage.createFromBuffer(jpeg).getSize();
    return { id, width: out.width, height: out.height };
}
function sceneExists(id) {
    const file = sceneFile(id);
    return Boolean(file && fs_1.default.existsSync(file));
}
function sweepScenes(usedIds) {
    let root;
    let entries;
    try {
        root = scenesRoot();
        entries = fs_1.default.readdirSync(root, { withFileTypes: true });
    }
    catch {
        // Cleanup is best-effort. A scene-directory problem will be surfaced if the Maker imports or
        // opens one; it must not turn a completed session deletion into an IPC failure after the fact.
        return 0;
    }
    let removed = 0;
    const cutoff = Date.now() - STALE_TEMP_MS;
    for (const entry of entries) {
        if (!entry.isFile())
            continue;
        const final = /^([a-z0-9-]{8,80})\.jpg$/i.exec(entry.name);
        const file = path_1.default.join(root, entry.name);
        if (final && usedIds.has(final[1]))
            continue;
        try {
            const staleTemp = /^\.[a-f0-9]{64}\.[a-f0-9]{20}\.tmp$/i.test(entry.name) && fs_1.default.statSync(file).mtimeMs < cutoff;
            if (!final && !staleTemp)
                continue;
            fs_1.default.rmSync(file, { force: true });
            removed += 1;
        }
        catch {
            /* leave it for the next sweep */
        }
    }
    return removed;
}
function newAssetId() {
    return (0, crypto_1.randomUUID)().replace(/-/g, '').slice(0, 20);
}
//# sourceMappingURL=SceneAssetService.js.map