"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseMoov = parseMoov;
exports.probeMovie = probeMovie;
const fs_1 = __importDefault(require("fs"));
const HEADER = 8;
/** A `moov` for a long take is a few megabytes of sample tables; nothing legitimate is near this. */
const MAX_MOOV_BYTES = 256 * 1024 * 1024;
function readBoxes(buffer, from, to) {
    const boxes = [];
    let at = from;
    while (at + HEADER <= to) {
        const size = buffer.readUInt32BE(at);
        const type = buffer.toString('latin1', at + 4, at + 8);
        let body = at + HEADER;
        let end;
        if (size === 1) {
            if (at + 16 > to)
                break;
            // 64-bit sizes only matter for `mdat`; a moov box past 2^53 bytes is not a thing.
            end = at + Number(buffer.readBigUInt64BE(at + 8));
            body = at + 16;
        }
        else if (size === 0) {
            end = to;
        }
        else {
            end = at + size;
        }
        if (end <= at || end > to) {
            // A truncated final box is normal in a file whose writer was killed: keep what parsed.
            boxes.push({ type, start: at, end: to, body });
            break;
        }
        boxes.push({ type, start: at, end, body });
        at = end;
    }
    return boxes;
}
function find(boxes, type) {
    return boxes.find((box) => box.type === type);
}
function children(buffer, box) {
    return box ? readBoxes(buffer, box.body, box.end) : [];
}
/** `version(1) flags(3)`, then fields whose width depends on that version. */
function version(buffer, box) {
    return buffer.readUInt8(box.body);
}
function mvhdDuration(buffer, box) {
    const at = box.body + 4;
    if (version(buffer, box) === 1) {
        if (at + 28 > box.end)
            return 0;
        const timescale = buffer.readUInt32BE(at + 16);
        const duration = Number(buffer.readBigUInt64BE(at + 20));
        return timescale > 0 ? (duration / timescale) * 1000 : 0;
    }
    if (at + 16 > box.end)
        return 0;
    const timescale = buffer.readUInt32BE(at + 8);
    const duration = buffer.readUInt32BE(at + 12);
    return timescale > 0 ? (duration / timescale) * 1000 : 0;
}
/** The presented size, as 16.16 fixed point at the tail of `tkhd`. */
function tkhdSize(buffer, box) {
    const fixed = version(buffer, box) === 1 ? box.body + 4 + 32 : box.body + 4 + 20;
    // reserved(8) layer(2) altGroup(2) volume(2) reserved(2) matrix(36), then width and height.
    const at = fixed + 8 + 2 + 2 + 2 + 2 + 36;
    if (at + 8 > box.end)
        return { width: 0, height: 0 };
    return {
        width: Math.round(buffer.readUInt32BE(at) / 65536),
        height: Math.round(buffer.readUInt32BE(at + 4) / 65536),
    };
}
function mdhdSeconds(buffer, box) {
    const at = box.body + 4;
    if (version(buffer, box) === 1) {
        if (at + 28 > box.end)
            return 0;
        const timescale = buffer.readUInt32BE(at + 16);
        const duration = Number(buffer.readBigUInt64BE(at + 20));
        return timescale > 0 ? duration / timescale : 0;
    }
    if (at + 16 > box.end)
        return 0;
    const timescale = buffer.readUInt32BE(at + 8);
    const duration = buffer.readUInt32BE(at + 12);
    return timescale > 0 ? duration / timescale : 0;
}
/** Every frame is one sample, so the time-to-sample table is the frame count. */
function sampleCount(buffer, stts) {
    const at = stts.body + 4;
    if (at + 4 > stts.end)
        return 0;
    const entries = buffer.readUInt32BE(at);
    let total = 0;
    for (let i = 0; i < entries; i += 1) {
        const entry = at + 4 + i * 8;
        if (entry + 8 > stts.end)
            break;
        total += buffer.readUInt32BE(entry);
    }
    return total;
}
/**
 * Parse a `moov` box that is already in memory. Split from the file reading so `verify:core` can
 * hand it a container it built itself rather than needing a recorded movie in the repo.
 */
function parseMoov(moov) {
    const top = readBoxes(moov, 0, moov.length);
    const root = find(top, 'moov');
    const boxes = root ? children(moov, root) : top;
    if (!boxes.length)
        return null;
    const header = find(boxes, 'mvhd');
    let durationMs = header ? mvhdDuration(moov, header) : 0;
    let width = 0;
    let height = 0;
    let hasAudio = false;
    let fps = 0;
    for (const trak of boxes.filter((box) => box.type === 'trak')) {
        const parts = children(moov, trak);
        const mdia = find(parts, 'mdia');
        const mdiaParts = children(moov, mdia);
        const hdlr = find(mdiaParts, 'hdlr');
        // `hdlr` is version+flags(4), predefined(4), then the four-character handler type.
        const kind = hdlr && hdlr.body + 12 <= hdlr.end ? moov.toString('latin1', hdlr.body + 8, hdlr.body + 12) : '';
        if (kind === 'soun') {
            hasAudio = true;
            continue;
        }
        if (kind !== 'vide')
            continue;
        const tkhd = find(parts, 'tkhd');
        if (tkhd) {
            const size = tkhdSize(moov, tkhd);
            if (size.width > 0 && size.height > 0) {
                width = size.width;
                height = size.height;
            }
        }
        const mdhd = find(mdiaParts, 'mdhd');
        const seconds = mdhd ? mdhdSeconds(moov, mdhd) : 0;
        // A track longer than the movie header claims means the header is the stale one — a writer
        // killed mid-file updates `mvhd` last. Trust whichever is longer, or a recovered take is cut.
        if (seconds * 1000 > durationMs)
            durationMs = seconds * 1000;
        const stbl = find(children(moov, find(mdiaParts, 'minf')), 'stbl');
        const stts = find(children(moov, stbl), 'stts');
        const samples = stts ? sampleCount(moov, stts) : 0;
        if (samples > 1 && seconds > 0)
            fps = samples / seconds;
    }
    if (durationMs <= 0 && width <= 0 && height <= 0 && !hasAudio)
        return null;
    return { durationMs: Math.round(durationMs), width, height, hasAudio, fps: Math.round(fps * 100) / 100 };
}
/**
 * Probe a movie on disk. Walks the top-level boxes reading only their headers, so a two-gigabyte
 * `mdat` costs one seek rather than two gigabytes of I/O, and reads the `moov` whole once found.
 *
 * Returns null for a file with no `moov` at all — which is exactly what a segment killed before
 * it finalised looks like, and the caller has to be able to tell that apart from a short take.
 */
function probeMovie(file) {
    let fd;
    try {
        fd = fs_1.default.openSync(file, 'r');
    }
    catch {
        return null;
    }
    try {
        const size = fs_1.default.fstatSync(fd).size;
        const header = Buffer.alloc(16);
        let at = 0;
        while (at + HEADER <= size) {
            const read = fs_1.default.readSync(fd, header, 0, 16, at);
            if (read < HEADER)
                break;
            const boxSize = header.readUInt32BE(0);
            const type = header.toString('latin1', 4, 8);
            let length;
            let body = at + HEADER;
            if (boxSize === 1) {
                if (read < 16)
                    break;
                length = Number(header.readBigUInt64BE(8));
                body = at + 16;
            }
            else if (boxSize === 0) {
                length = size - at;
            }
            else {
                length = boxSize;
            }
            if (length < HEADER)
                break;
            if (type === 'moov') {
                const end = Math.min(at + length, size);
                if (end - body > MAX_MOOV_BYTES)
                    return null;
                const moov = Buffer.alloc(end - body);
                fs_1.default.readSync(fd, moov, 0, moov.length, body);
                return parseMoov(moov);
            }
            at += length;
        }
        return null;
    }
    catch {
        return null;
    }
    finally {
        fs_1.default.closeSync(fd);
    }
}
//# sourceMappingURL=movProbe.js.map