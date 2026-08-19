"use strict";
/**
 * Deterministic JSON canonicalisation. The signature is over canonical (stable-key-order) JSON
 * bytes, so signer and verifier must serialise identically or verification is a coin flip.
 *
 * ⚠️ CROSS-REPO MIRROR of `lib/entitlement/canonicalize.ts` in stoicsoft-store. Behaviour here
 * is the contract; changing it invalidates every entitlement in the field.
 *
 * Guarantees, for any value with the same logical content:
 *   - object keys are emitted in sorted (Unicode code-unit) order, recursively, so `{a,b}` and
 *     `{b,a}` produce byte-identical output;
 *   - `undefined`-valued object properties are dropped (JSON has no undefined);
 *   - arrays keep their order, because order is semantically meaningful;
 *   - primitives go through JSON.stringify, so string escaping matches the parser.
 *
 * It deliberately REJECTS values JSON cannot round-trip losslessly (non-finite numbers, bigint,
 * functions, symbols) rather than coercing them — a coercion is exactly how the two sides would
 * silently disagree.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.canonicalize = canonicalize;
exports.canonicalBytes = canonicalBytes;
function serialize(value) {
    if (value === null)
        return 'null';
    const t = typeof value;
    if (t === 'string' || t === 'boolean')
        return JSON.stringify(value);
    if (t === 'number') {
        if (!Number.isFinite(value)) {
            throw new Error('canonicalize: cannot serialize non-finite number');
        }
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return '[' + value.map((item) => serialize(item)).join(',') + ']';
    }
    if (t === 'object') {
        const obj = value;
        const keys = Object.keys(obj)
            .filter((k) => obj[k] !== undefined)
            .sort();
        const body = keys.map((k) => JSON.stringify(k) + ':' + serialize(obj[k])).join(',');
        return '{' + body + '}';
    }
    throw new Error(`canonicalize: cannot serialize value of type ${t}`);
}
/** Deterministic string form of `value` (stable key order, recursive). */
function canonicalize(value) {
    return serialize(value);
}
/** UTF-8 bytes of the canonical form — the exact bytes that get signed and verified. */
function canonicalBytes(value) {
    return Buffer.from(canonicalize(value), 'utf8');
}
//# sourceMappingURL=canonicalize.js.map