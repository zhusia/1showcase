"use strict";
/**
 * Tiny WAV read/write and RMS, used by the Chromium studio path on Windows and Linux.
 *
 * Pure Node: `verify:core` imports it from `dist-electron/` without booting an app. No FFmpeg,
 * no native addon. 16-bit PCM only — that is what the capture window writes.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.writeWav = writeWav;
exports.parseWav = parseWav;
exports.toMono = toMono;
exports.rmsBuckets = rmsBuckets;
exports.sliceAndRate = sliceAndRate;
exports.concatFloat32 = concatFloat32;
exports.applyGain = applyGain;
exports.applyNoiseGate = applyNoiseGate;
function writeWav(samples, sampleRate, channels = 1) {
    const frames = Math.floor(samples.length / channels);
    const dataSize = frames * channels * 2;
    const out = Buffer.alloc(44 + dataSize);
    out.write('RIFF', 0);
    out.writeUInt32LE(36 + dataSize, 4);
    out.write('WAVE', 8);
    out.write('fmt ', 12);
    out.writeUInt32LE(16, 16);
    out.writeUInt16LE(1, 20);
    out.writeUInt16LE(channels, 22);
    out.writeUInt32LE(sampleRate, 24);
    out.writeUInt32LE(sampleRate * channels * 2, 28);
    out.writeUInt16LE(channels * 2, 32);
    out.writeUInt16LE(16, 34);
    out.write('data', 36);
    out.writeUInt32LE(dataSize, 40);
    let o = 44;
    for (let i = 0; i < frames * channels; i += 1) {
        const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
        out.writeInt16LE(s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), o);
        o += 2;
    }
    return out;
}
function parseWav(buf) {
    if (buf.length < 44)
        return null;
    if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE')
        return null;
    let offset = 12;
    let sampleRate = 0;
    let channels = 0;
    let bits = 0;
    let data = null;
    while (offset + 8 <= buf.length) {
        const id = buf.toString('ascii', offset, offset + 4);
        const size = buf.readUInt32LE(offset + 4);
        const start = offset + 8;
        if (start + size > buf.length)
            break;
        if (id === 'fmt ') {
            const format = buf.readUInt16LE(start);
            if (format !== 1 && format !== 3)
                return null;
            channels = buf.readUInt16LE(start + 2);
            sampleRate = buf.readUInt32LE(start + 4);
            bits = buf.readUInt16LE(start + 14);
            if (format === 3 && bits !== 32)
                return null;
            if (format === 1 && bits !== 16 && bits !== 8)
                return null;
        }
        else if (id === 'data') {
            data = buf.subarray(start, start + size);
        }
        offset = start + size + (size % 2);
    }
    if (!data || !sampleRate || !channels)
        return null;
    const samples = new Float32Array(Math.floor(data.length / (bits === 8 ? 1 : bits === 16 ? 2 : 4)));
    if (bits === 16) {
        for (let i = 0; i < samples.length; i += 1)
            samples[i] = data.readInt16LE(i * 2) / 0x8000;
    }
    else if (bits === 8) {
        for (let i = 0; i < samples.length; i += 1)
            samples[i] = (data[i] - 128) / 128;
    }
    else {
        for (let i = 0; i < samples.length; i += 1)
            samples[i] = data.readFloatLE(i * 4);
    }
    return { sampleRate, channels, samples };
}
/** Downmix to mono. */
function toMono(wav) {
    if (wav.channels <= 1)
        return wav.samples;
    const frames = Math.floor(wav.samples.length / wav.channels);
    const out = new Float32Array(frames);
    for (let i = 0; i < frames; i += 1) {
        let sum = 0;
        for (let c = 0; c < wav.channels; c += 1)
            sum += wav.samples[i * wav.channels + c];
        out[i] = sum / wav.channels;
    }
    return out;
}
function rmsBuckets(samples, sampleRate, bucketMs = 50) {
    const bucketSamples = Math.max(1, Math.round((sampleRate * bucketMs) / 1000));
    const buckets = [];
    for (let i = 0; i < samples.length; i += bucketSamples) {
        const end = Math.min(samples.length, i + bucketSamples);
        let acc = 0;
        for (let s = i; s < end; s += 1)
            acc += samples[s] * samples[s];
        buckets.push(Math.sqrt(acc / Math.max(1, end - i)));
    }
    return { buckets, bucketMs };
}
/**
 * Slice `fromMs..toMs` of a mono buffer, then stretch or squeeze by `rate` (1 = identity).
 * Rate > 1 is faster (fewer samples), matching a clip's playback rate.
 */
function sliceAndRate(samples, sampleRate, fromMs, toMs, rate) {
    const start = Math.max(0, Math.min(samples.length, Math.round((fromMs / 1000) * sampleRate)));
    const end = Math.max(start, Math.min(samples.length, Math.round((toMs / 1000) * sampleRate)));
    const src = samples.subarray(start, end);
    const safeRate = Number.isFinite(rate) && rate > 0 ? Math.max(0.25, Math.min(4, rate)) : 1;
    if (Math.abs(safeRate - 1) < 1e-6)
        return Float32Array.from(src);
    const outLen = Math.max(1, Math.round(src.length / safeRate));
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i += 1) {
        const at = i * safeRate;
        const i0 = Math.floor(at);
        const i1 = Math.min(src.length - 1, i0 + 1);
        const t = at - i0;
        out[i] = (src[i0] ?? 0) * (1 - t) + (src[i1] ?? 0) * t;
    }
    return out;
}
function concatFloat32(parts) {
    const total = parts.reduce((sum, one) => sum + one.length, 0);
    const out = new Float32Array(total);
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
}
function applyGain(samples, gain) {
    const g = Number.isFinite(gain) ? Math.max(0, Math.min(8, gain)) : 1;
    if (g === 1)
        return;
    for (let i = 0; i < samples.length; i += 1)
        samples[i] = Math.max(-1, Math.min(1, samples[i] * g));
}
/** A simple noise gate: below `floor` the sample is silenced. */
function applyNoiseGate(samples, floor = 0.012) {
    for (let i = 0; i < samples.length; i += 1) {
        if (Math.abs(samples[i]) < floor)
            samples[i] = 0;
    }
}
//# sourceMappingURL=wavAudio.js.map