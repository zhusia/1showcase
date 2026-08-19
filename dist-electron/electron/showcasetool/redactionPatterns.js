"use strict";
/**
 * Credential detection shared by Layer 1 (capture time, in the content script) and
 * Layer 2 (the review pass, here in the desktop app).
 *
 * DUPLICATED ON PURPOSE in extension-showcasetool/src/shared/redactionPatterns.ts —
 * the extension and the main process are separate TS projects with no shared module
 * graph, and a content script must not import from electron/. Keep the two copies in
 * sync; the extension copy is the one that runs before bytes leave the page.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ENTROPY_THRESHOLD_BITS = exports.ENTROPY_MIN_LENGTH = exports.CREDENTIAL_SHAPES = exports.NEVER_STORE_AUTOCOMPLETE_RE = exports.NEVER_STORE_INPUT_TYPES = exports.SENSITIVE_FIELD_RE = void 0;
exports.shannonEntropy = shannonEntropy;
exports.looksHighEntropy = looksHighEntropy;
exports.detectSecrets = detectSecrets;
exports.isSensitiveFieldName = isSensitiveFieldName;
exports.scrubText = scrubText;
/** Field name / id / label patterns whose *values* are never stored. */
exports.SENSITIVE_FIELD_RE = /secret|token|key|password|passwd|apikey|client_secret|private_key/i;
/** Input types and autocomplete hints whose values are never stored. */
exports.NEVER_STORE_INPUT_TYPES = ['password'];
exports.NEVER_STORE_AUTOCOMPLETE_RE = /^(cc-|one-time-code$)/i;
/** Recognized credential prefixes. Ordered most-specific first. */
exports.CREDENTIAL_SHAPES = [
    { rule: 'auto:private-key-block', label: 'PEM private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
    { rule: 'auto:private-key-header', label: 'PEM private key header', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
    { rule: 'auto:key-prefix', label: 'OpenAI-style key', re: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
    { rule: 'auto:key-prefix', label: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
    { rule: 'auto:key-prefix', label: 'Google API key', re: /\bAIza[A-Za-z0-9_-]{20,}\b/g },
    { rule: 'auto:key-prefix', label: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
    { rule: 'auto:key-prefix', label: 'AWS access key id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
    { rule: 'auto:key-prefix', label: 'Stripe key', re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
    { rule: 'auto:jwt', label: 'JWT', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
];
/** Length at which an opaque high-entropy blob is treated as a probable secret. */
exports.ENTROPY_MIN_LENGTH = 24;
exports.ENTROPY_THRESHOLD_BITS = 3.4;
/** Shannon entropy in bits per character. */
function shannonEntropy(value) {
    if (!value.length)
        return 0;
    const counts = new Map();
    for (const ch of value)
        counts.set(ch, (counts.get(ch) ?? 0) + 1);
    let bits = 0;
    for (const count of counts.values()) {
        const p = count / value.length;
        bits -= p * Math.log2(p);
    }
    return bits;
}
/**
 * True for long opaque strings that look generated rather than written. Deliberately
 * conservative: this feeds *warnings* in the review pass, and a false positive that
 * makes a human look at a field is cheap, while a miss is what Layer 2 exists to catch.
 */
function looksHighEntropy(value) {
    const trimmed = value.trim();
    if (trimmed.length < exports.ENTROPY_MIN_LENGTH)
        return false;
    if (/\s/.test(trimmed))
        return false;
    if (!/[A-Za-z]/.test(trimmed) || !/[0-9]/.test(trimmed))
        return false;
    return shannonEntropy(trimmed) >= exports.ENTROPY_THRESHOLD_BITS;
}
/** Every recognized-shape credential in a block of text, with positions. */
function detectSecrets(text) {
    const found = [];
    for (const shape of exports.CREDENTIAL_SHAPES) {
        const re = new RegExp(shape.re.source, shape.re.flags);
        let match;
        while ((match = re.exec(text)) !== null) {
            found.push({ rule: shape.rule, label: shape.label, start: match.index, end: match.index + match[0].length, text: match[0] });
            if (match[0].length === 0)
                re.lastIndex += 1;
        }
    }
    // Collapse overlaps, keeping the earliest and longest match.
    found.sort((a, b) => a.start - b.start || b.end - a.end);
    const merged = [];
    for (const item of found) {
        const prev = merged[merged.length - 1];
        if (prev && item.start < prev.end)
            continue;
        merged.push(item);
    }
    return merged;
}
/** True when a field's name/id/label means its value must never be stored. */
function isSensitiveFieldName(...parts) {
    return parts.some((p) => !!p && exports.SENSITIVE_FIELD_RE.test(p));
}
/** Replace every recognized credential with a typed placeholder. */
function scrubText(text) {
    const hits = detectSecrets(text);
    if (!hits.length)
        return { text, rules: [] };
    let out = '';
    let cursor = 0;
    for (const hit of hits) {
        out += text.slice(cursor, hit.start) + `<REDACTED:${hit.label.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}>`;
        cursor = hit.end;
    }
    out += text.slice(cursor);
    return { text: out, rules: Array.from(new Set(hits.map((h) => h.rule))) };
}
//# sourceMappingURL=redactionPatterns.js.map