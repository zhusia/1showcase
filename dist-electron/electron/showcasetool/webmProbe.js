"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.probeWebm = probeWebm;
exports.parseWebmInfo = parseWebmInfo;
const fs_1 = __importDefault(require("fs"));
function probeWebm(file) {
    let fd;
    try {
        fd = fs_1.default.openSync(file, 'r');
    }
    catch {
        return null;
    }
    try {
        const size = fs_1.default.fstatSync(fd).size;
        if (size < 16)
            return null;
        const buf = Buffer.alloc(Math.min(256 * 1024, size));
        fs_1.default.readSync(fd, buf, 0, buf.length, 0);
        return parseWebmInfo(buf);
    }
    catch {
        return null;
    }
    finally {
        fs_1.default.closeSync(fd);
    }
}
function parseWebmInfo(buf) {
    if (buf.length < 8)
        return null;
    // EBML header starts 1A 45 DF A3; a file that is not a WebM is not a take.
    if (buf[0] !== 0x1a || buf[1] !== 0x45 || buf[2] !== 0xdf || buf[3] !== 0xa3)
        return null;
    let duration = 0;
    let timecodeScale = 1_000_000;
    let width = 0;
    let height = 0;
    walk(buf, 0, buf.length, (id, payload) => {
        if (id === 0x2ad7b1)
            timecodeScale = readUnsigned(payload) || timecodeScale;
        else if (id === 0x4489)
            duration = readFloat(payload);
        else if (id === 0xb0)
            width = readUnsigned(payload);
        else if (id === 0xba)
            height = readUnsigned(payload);
    });
    const durationMs = duration > 0 ? Math.round((duration * timecodeScale) / 1_000_000) : 0;
    if (durationMs <= 0 && width <= 0)
        return null;
    return { durationMs, width, height };
}
function walk(buf, start, end, visit) {
    let i = start;
    let guard = 0;
    while (i + 2 < end && guard++ < 4000) {
        const id = readVint(buf, i);
        if (!id)
            break;
        const size = readVint(buf, id.next);
        if (!size)
            break;
        const from = size.next;
        const to = size.value === -1 ? end : Math.min(end, from + size.value);
        if (from > end)
            break;
        visit(id.value, buf.subarray(from, to));
        // Recurse into known container ids so Duration inside Info is found.
        if (id.value === 0x18538067 || id.value === 0x1549a966 || id.value === 0x1654ae6b || id.value === 0xae) {
            walk(buf, from, to, visit);
        }
        i = to;
    }
}
function readVint(buf, at) {
    if (at >= buf.length)
        return null;
    const first = buf[at];
    let width = 1;
    let mask = 0x80;
    while (width <= 8 && (first & mask) === 0) {
        width += 1;
        mask >>= 1;
    }
    if (width > 8 || at + width > buf.length)
        return null;
    // All-ones is the "unknown size" marker.
    let allOnes = (first & (mask - 1)) === mask - 1;
    let value = first & (mask - 1);
    for (let i = 1; i < width; i += 1) {
        if (buf[at + i] !== 0xff)
            allOnes = false;
        value = value * 256 + buf[at + i];
    }
    return { value: allOnes ? -1 : value, next: at + width };
}
function readUnsigned(buf) {
    let value = 0;
    for (let i = 0; i < buf.length && i < 8; i += 1)
        value = value * 256 + buf[i];
    return value;
}
function readFloat(buf) {
    if (buf.length === 4)
        return buf.readFloatBE(0);
    if (buf.length === 8)
        return buf.readDoubleBE(0);
    return 0;
}
//# sourceMappingURL=webmProbe.js.map