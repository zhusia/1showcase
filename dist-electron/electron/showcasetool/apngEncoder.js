"use strict";
/**
 * Animated PNG assembly (docs/competitor-features.md §2.4).
 *
 * Scribe sells GIF export. GIF is the wrong format to hand-roll here: it needs palette
 * quantisation and LZW, both of which are real algorithms with real ways to be subtly wrong,
 * and it would throw away 24-bit screenshots to fit 256 colours. APNG does the same job — an
 * animated image you can paste into Slack, GitHub, or a wiki — and is *assembly* rather than
 * compression: the frames are already PNGs, so this reuses their IDAT bytes untouched.
 *
 * Everything here is pure Buffer arithmetic so `verify:core` can import it from
 * `dist-electron/` without booting an app, the same reason `machinePolicy.ts` stays importable.
 *
 * Spec: https://wiki.mozilla.org/APNG_Specification
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.APNG_TARGET_FPS = void 0;
exports.crc32 = crc32;
exports.chunk = chunk;
exports.parsePng = parsePng;
exports.buildApng = buildApng;
exports.pickFrames = pickFrames;
exports.frameDelayMs = frameDelayMs;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Standard PNG CRC-32, table built once. */
const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1)
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();
function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i += 1)
        c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}
/** length | type | data | crc(type+data) */
function chunk(type, data) {
    const typeBuf = Buffer.from(type, 'ascii');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([length, typeBuf, data, crc]);
}
/**
 * Pull the header and the concatenated image data out of a PNG.
 *
 * Ancillary chunks (gAMA, pHYs, text the encoder felt like adding) are dropped on purpose —
 * they are not needed to render and carrying them would mean reasoning about which are safe to
 * duplicate across frames.
 */
function parsePng(buf) {
    if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE))
        throw new Error('not a PNG');
    let offset = 8;
    let ihdr = null;
    const idats = [];
    let width = 0;
    let height = 0;
    while (offset + 8 <= buf.length) {
        const length = buf.readUInt32BE(offset);
        const type = buf.toString('ascii', offset + 4, offset + 8);
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;
        if (dataEnd > buf.length)
            break;
        if (type === 'IHDR') {
            ihdr = buf.subarray(dataStart, dataEnd);
            width = buf.readUInt32BE(dataStart);
            height = buf.readUInt32BE(dataStart + 4);
        }
        else if (type === 'IDAT') {
            idats.push(buf.subarray(dataStart, dataEnd));
        }
        else if (type === 'IEND') {
            break;
        }
        offset = dataEnd + 4; // + CRC
    }
    if (!ihdr)
        throw new Error('PNG has no IHDR');
    if (!idats.length)
        throw new Error('PNG has no IDAT');
    return { ihdr, idat: Buffer.concat(idats), width, height };
}
/** Animation control. Must precede the first IDAT, or decoders render a still image. */
function acTL(frameCount, loops) {
    const data = Buffer.alloc(8);
    data.writeUInt32BE(frameCount, 0);
    data.writeUInt32BE(loops, 4);
    return chunk('acTL', data);
}
/**
 * Frame control. `delayDen` is 1000 so delays are plain milliseconds — the more common 100
 * loses precision at the frame rates a walkthrough uses.
 */
function fcTL(sequence, width, height, delayMs) {
    const data = Buffer.alloc(26);
    data.writeUInt32BE(sequence, 0);
    data.writeUInt32BE(width, 4);
    data.writeUInt32BE(height, 8);
    data.writeUInt32BE(0, 12); // x offset — every frame is full size
    data.writeUInt32BE(0, 16); // y offset
    data.writeUInt16BE(Math.max(1, Math.round(delayMs)), 20);
    data.writeUInt16BE(1000, 22);
    data.writeUInt8(0, 24); // dispose: none
    data.writeUInt8(0, 25); // blend: source — frames are opaque and complete
    return chunk('fcTL', data);
}
/** Frame data: a sequence number then the frame's IDAT bytes verbatim. */
function fdAT(sequence, idat) {
    const seq = Buffer.alloc(4);
    seq.writeUInt32BE(sequence, 0);
    return chunk('fdAT', Buffer.concat([seq, idat]));
}
/**
 * Assemble frames into one animated PNG.
 *
 * Every frame must share the first frame's dimensions — they come off one render at a fixed
 * size, so a mismatch means something upstream is wrong and is worth failing on rather than
 * producing an image that renders as garbage.
 */
function buildApng(frames, options) {
    if (!frames.length)
        throw new Error('no frames to animate');
    const parsed = frames.map(parsePng);
    const { width, height } = parsed[0];
    for (const frame of parsed) {
        if (frame.width !== width || frame.height !== height) {
            throw new Error(`frame size changed mid-animation (${frame.width}x${frame.height} after ${width}x${height})`);
        }
    }
    const out = [PNG_SIGNATURE, chunk('IHDR', parsed[0].ihdr), acTL(parsed.length, options.loops ?? 0)];
    let sequence = 0;
    parsed.forEach((frame, index) => {
        out.push(fcTL(sequence, width, height, options.delayMs));
        sequence += 1;
        if (index === 0) {
            // The first frame is the still image a non-APNG decoder shows, so it stays an IDAT.
            out.push(chunk('IDAT', frame.idat));
        }
        else {
            out.push(fdAT(sequence, frame.idat));
            sequence += 1;
        }
    });
    out.push(chunk('IEND', Buffer.alloc(0)));
    return Buffer.concat(out);
}
/**
 * Pick which frames to keep.
 *
 * A 60-second walkthrough at 30fps is 1800 full-size PNGs; concatenating those is a file
 * nobody can paste anywhere. Sampling to a low frame rate is what makes the format usable, and
 * a walkthrough of still screenshots survives it — there is no real motion to lose beyond the
 * transitions.
 */
function pickFrames(frames, sourceFps, targetFps) {
    if (frames.length <= 1)
        return frames.slice();
    const stride = Math.max(1, Math.round(sourceFps / Math.max(1, targetFps)));
    const out = [];
    for (let i = 0; i < frames.length; i += stride)
        out.push(frames[i]);
    // Always end on the last frame, so the animation does not stop early.
    if (out[out.length - 1] !== frames[frames.length - 1])
        out.push(frames[frames.length - 1]);
    return out;
}
/** What the sampled animation actually plays at, in milliseconds per frame. */
function frameDelayMs(sourceFps, targetFps) {
    const stride = Math.max(1, Math.round(sourceFps / Math.max(1, targetFps)));
    return Math.round((stride / sourceFps) * 1000);
}
exports.APNG_TARGET_FPS = 10;
//# sourceMappingURL=apngEncoder.js.map