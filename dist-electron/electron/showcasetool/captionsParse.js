"use strict";
/**
 * Import SRT / WebVTT as the studio's word-level caption list.
 *
 * On-device file transcription is a macOS Speech Recognition feature. Windows and Linux get
 * an honest import instead of a cloud recognizer. Words inside a cue share the cue's span
 * equally — the inspector can then nudge them. Pure, so `verify:core` can exercise it.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseCaptionFile = parseCaptionFile;
exports.parseSrt = parseSrt;
exports.parseVtt = parseVtt;
function parseCaptionFile(text, filename = '') {
    const body = text.replace(/^\uFEFF/, '').trim();
    if (!body)
        return [];
    if (filename.toLowerCase().endsWith('.vtt') || /^WEBVTT/i.test(body))
        return parseVtt(body);
    return parseSrt(body);
}
function parseSrt(text) {
    const blocks = text.replace(/\r/g, '').split(/\n\n+/);
    const words = [];
    for (const block of blocks) {
        const lines = block.split('\n').filter((line) => line.trim().length > 0);
        if (lines.length < 2)
            continue;
        const stamp = lines[0].includes('-->') ? lines[0] : lines[1];
        const range = parseStamp(stamp);
        if (!range)
            continue;
        const payload = lines.slice(lines[0].includes('-->') ? 1 : 2).join(' ');
        words.push(...splitCue(payload, range.from, range.to));
    }
    return words;
}
function parseVtt(text) {
    const stripped = text.replace(/\r/g, '').replace(/^WEBVTT[^\n]*\n/, '');
    const blocks = stripped.split(/\n\n+/);
    const words = [];
    for (const block of blocks) {
        const lines = block.split('\n').filter((line) => line.trim().length > 0 && !line.startsWith('NOTE'));
        if (lines.length < 2)
            continue;
        const stamp = lines.find((line) => line.includes('-->'));
        if (!stamp)
            continue;
        const range = parseStamp(stamp);
        if (!range)
            continue;
        const payload = lines
            .slice(lines.indexOf(stamp) + 1)
            .join(' ')
            .replace(/<[^>]+>/g, '');
        words.push(...splitCue(payload, range.from, range.to));
    }
    return words;
}
function parseStamp(line) {
    const match = /(\d{1,2}:)?(\d{1,2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d{1,2}:)?(\d{1,2}):(\d{2})[.,](\d{1,3})/.exec(line);
    if (!match)
        return null;
    const from = toMs(match[1], match[2], match[3], match[4]);
    const to = toMs(match[5], match[6], match[7], match[8]);
    if (!(to > from))
        return null;
    return { from, to };
}
function toMs(hours, minutes, seconds, frac) {
    const h = hours ? Number(hours.replace(':', '')) : 0;
    const milli = Number((frac + '000').slice(0, 3));
    return ((h * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000 + milli;
}
function splitCue(text, from, to) {
    const tokens = text
        .replace(/\{[^}]+\}/g, '')
        .split(/\s+/)
        .map((token) => token.trim())
        .filter(Boolean)
        .slice(0, 80);
    if (!tokens.length)
        return [];
    const span = Math.max(40, to - from);
    const each = Math.max(40, Math.round(span / tokens.length));
    return tokens.map((word, i) => ({
        word: word.slice(0, 40),
        tMs: from + i * each,
        dMs: i === tokens.length - 1 ? Math.max(40, to - (from + i * each)) : each,
    }));
}
//# sourceMappingURL=captionsParse.js.map