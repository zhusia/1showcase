"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MEDIA_SCHEME = void 0;
exports.mediaRoot = mediaRoot;
exports.registerMediaScheme = registerMediaScheme;
exports.resolveMediaPath = resolveMediaPath;
exports.parseByteRange = parseByteRange;
exports.serveMedia = serveMedia;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const stream_1 = require("stream");
const electron_1 = require("electron");
/**
 * `gtmedia://` — the only way the renderer can see recorded footage.
 *
 * The studio editor has to play a multi-gigabyte movie, scrub it, and seek it frame by frame.
 * Nothing else in the app moves bytes that way: screenshots are small enough to travel as data
 * URIs over IPC, but a data URI of a ten-minute 4K capture is not a thing that can exist.
 *
 * A `file://` URL would be the obvious answer and is not available. The renderer is sandboxed
 * and loads from `http://localhost` in development, so a `file://` media source is blocked as a
 * cross-origin request — and relaxing `webSecurity` to allow it would hand the same privilege to
 * every model-authored fragment the app renders. A custom scheme keeps the grant narrow: it
 * serves one directory, resolves nothing outside it, and exists only while the app is running.
 *
 * ## What it will not serve
 *
 * Path traversal is refused after resolution, not by inspecting the string — `..` is only one
 * of the ways to leave a directory, and a check that pattern-matches on it will eventually miss
 * one. The resolved path must sit inside the recordings root or the request 404s.
 *
 * This is a *read* path for footage the Maker recorded on this machine. It is not a way to
 * export: an exported file is written by the burn, which composites the masks into new frames.
 * Serving raw footage to the editor is exactly what the editor is for — looking at it in order
 * to decide what to mask.
 */
exports.MEDIA_SCHEME = 'gtmedia';
/** The parent of every recording directory. One place to resolve against, one place to guard. */
function mediaRoot() {
    return path_1.default.join(electron_1.app.getPath('userData'), 'showcasetool', '.machine');
}
/**
 * Must be called before `app.whenReady`, which is the only time Electron accepts it. Marking the
 * scheme `stream: true` is what lets the handler answer with a body that arrives in pieces —
 * without it a `<video>` element cannot seek, and the editor's entire timeline stops working.
 * The privilege is necessary and not sufficient: `serveMedia` still has to answer the range
 * request itself. See the note there.
 */
function registerMediaScheme() {
    electron_1.protocol.registerSchemesAsPrivileged([
        {
            scheme: exports.MEDIA_SCHEME,
            privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false },
        },
    ]);
}
/**
 * Resolve `gtmedia://<sessionId>/<file>` to a path inside the recordings root, or null.
 *
 * Exported for `verify:core`, which asserts that a traversal cannot escape — the assertion is
 * worth more against the real function than against a copy of its logic.
 */
function resolveMediaPath(root, url, scenesDir) {
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        return null;
    }
    if (parsed.protocol !== `${exports.MEDIA_SCHEME}:`)
        return null;
    // `gtmedia://<host>/<path>` — the session id is the host, so a request can never name a
    // sibling directory by walking up out of the path component.
    const sessionId = decodeURIComponent(parsed.hostname || '');
    const relative = decodeURIComponent(parsed.pathname || '').replace(/^\/+/, '');
    if (!sessionId || !relative)
        return null;
    /**
     * One reserved host: `scenes`. An imported mockup lives here, never next to a take. Any
     * other non-UUID host is refused — the verify:core traversal assertion covers both roots.
     */
    if (sessionId === 'scenes') {
        if (!scenesDir)
            return null;
        if (relative.includes('/') || relative.includes('\\'))
            return null;
        if (!/^[a-z0-9-]{8,80}\.(jpg|jpeg|png|webp)$/i.test(relative))
            return null;
        const resolved = path_1.default.resolve(scenesDir, relative);
        const base = path_1.default.resolve(scenesDir) + path_1.default.sep;
        if (!resolved.startsWith(base))
            return null;
        return resolved;
    }
    // A session id is a UUID. Anything else is not a recording, whatever it resolves to.
    if (!/^[a-z0-9-]{8,64}$/i.test(sessionId))
        return null;
    const resolved = path_1.default.resolve(root, sessionId, relative);
    const base = path_1.default.resolve(root, sessionId) + path_1.default.sep;
    // Resolve first, then compare. `..` is only one of the ways out of a directory and a check
    // that pattern-matches on the string will eventually miss one.
    if (!resolved.startsWith(base))
        return null;
    return resolved;
}
/** What a `.machine` directory can hand the renderer, and nothing else. */
const MEDIA_TYPES = {
    '.mov': 'video/quicktime',
    '.mp4': 'video/mp4',
    '.m4v': 'video/mp4',
    '.webm': 'video/webm',
    '.wav': 'audio/wav',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
};
/**
 * A `Range: bytes=…` header as an inclusive byte interval, or null for "the whole file".
 *
 * `'unsatisfiable'` is a third answer rather than a null, because a range that starts past the end
 * of the file has to be refused with a 416 — answering it with the whole file would hand the media
 * stack bytes it did not ask for at an offset it did not ask for, which is worse than an error.
 * Only the single-range form is understood; a multipart range is not something a media element
 * asks for, and answering one badly is worse than not offering it.
 */
function parseByteRange(header, size) {
    if (!header)
        return null;
    const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!match || (!match[1] && !match[2]))
        return null;
    if (size <= 0)
        return 'unsatisfiable';
    // `bytes=-500` is the *last* 500 bytes, which is how an MP4 with its index at the end is opened.
    if (!match[1]) {
        const length = Number(match[2]);
        if (!Number.isFinite(length) || length <= 0)
            return 'unsatisfiable';
        return { start: Math.max(0, size - length), end: size - 1 };
    }
    const start = Number(match[1]);
    if (!Number.isFinite(start) || start >= size)
        return 'unsatisfiable';
    const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    if (!Number.isFinite(end) || end < start)
        return 'unsatisfiable';
    return { start, end };
}
/**
 * Call once, after the app is ready.
 *
 * ## Why this answers the range request by hand
 *
 * A `<video>` can only seek a resource the media stack believes is randomly accessible, and the
 * only thing it goes on is whether a request carrying `Range:` comes back `206` with a
 * `Content-Range`. Neither `net.fetch` over a `file://` URL nor forwarding the renderer's headers
 * to it produces one — the file loader answers `200` with the whole body either way. The element
 * then reports an **empty `seekable` range**, and the media element's seek algorithm *silently
 * abandons* every seek: `currentTime = x` reads back as the old value, no `seeking` event is
 * fired, and nothing anywhere throws.
 *
 * That failure is invisible at the call site and reads as an unrelated bug at the other end of the
 * app. The editor opens a take, seeks to the first clip's start, gets nothing, and plays the file
 * from the top while the playhead sits pinned where the clip begins — so Space appears to do
 * nothing at all. The frame-by-frame export loop is the same seek, so it would render the opening
 * frame for the length of the film.
 *
 * So the handler reads the interval itself. `fs.createReadStream` takes the inclusive bounds the
 * header uses, and the body is handed over as a stream rather than a buffer because a take is
 * measured in gigabytes and the point of a range request is not to have to hold one.
 */
function serveMedia() {
    const root = mediaRoot();
    const scenesDir = path_1.default.join(electron_1.app.getPath('userData'), 'showcasetool', 'scenes');
    const missing = () => new Response('Not found', { status: 404 });
    electron_1.protocol.handle(exports.MEDIA_SCHEME, async (request) => {
        const file = resolveMediaPath(root, request.url, scenesDir);
        if (!file)
            return missing();
        let stat;
        try {
            stat = await fs_1.default.promises.stat(file);
        }
        catch {
            return missing();
        }
        if (!stat.isFile())
            return missing();
        const type = MEDIA_TYPES[path_1.default.extname(file).toLowerCase()] ?? 'application/octet-stream';
        const range = parseByteRange(request.headers.get('range'), stat.size);
        if (range === 'unsatisfiable') {
            return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}`, 'Accept-Ranges': 'bytes' } });
        }
        const start = range ? range.start : 0;
        const end = range ? range.end : Math.max(0, stat.size - 1);
        const headers = {
            'Content-Type': type,
            'Content-Length': String(stat.size === 0 ? 0 : end - start + 1),
            // Advertised on every answer, not only on the ranged one: the media stack asks the first
            // question without a `Range` header and decides from this whether it may ask a second.
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-store',
        };
        if (range)
            headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
        // A HEAD is how the stack asks for the size alone. Answering it with a body is legal and
        // wasteful; on a 4K take it is several gigabytes of waste.
        if (request.method === 'HEAD' || stat.size === 0)
            return new Response(null, { status: range ? 206 : 200, headers });
        const stream = stream_1.Readable.toWeb(fs_1.default.createReadStream(file, { start, end }));
        return new Response(stream, { status: range ? 206 : 200, headers });
    });
}
//# sourceMappingURL=mediaProtocol.js.map