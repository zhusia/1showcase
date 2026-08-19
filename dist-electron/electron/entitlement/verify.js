"use strict";
/**
 * The signed-entitlement verifier.
 *
 * ⚠️ CROSS-REPO MIRROR of the verification contract in stoicsoft-store. The seven checks and
 * their order are the contract; the store's `scripts/entitlement-roundtrip-test.ts` asserts a
 * signer/verifier round trip against exactly this logic.
 *
 * PURE FUNCTION: every input is INJECTED via `opts` — no ambient clock, no env, no disk, no key
 * material read here. That is what makes the model unit-testable, and it is why the app trusts
 * the SIGNATURE rather than the transport or the server.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_CLOCK_SKEW_MS = void 0;
exports.verifyEntitlement = verifyEntitlement;
const node_crypto_1 = require("node:crypto");
const canonicalize_1 = require("./canonicalize");
const clockGuard_1 = require("./clockGuard");
/** Tolerance for the clock-rollback guard. 24h absorbs NTP jitter and timezone quirks. */
exports.DEFAULT_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;
function fail(reason) {
    return { ok: false, reason };
}
function isNonEmptyString(v) {
    return typeof v === 'string' && v.length > 0;
}
function parseDate(v) {
    if (typeof v !== 'string')
        return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
}
/** Reject payloads that are not a well-formed entitlement before touching crypto. */
function validateShape(ent) {
    if (!ent || typeof ent !== 'object')
        return false;
    const e = ent;
    return (typeof e.v === 'number' &&
        isNonEmptyString(e.product) &&
        isNonEmptyString(e.licenseKey) &&
        isNonEmptyString(e.instanceId) &&
        isNonEmptyString(e.deviceHash) &&
        isNonEmptyString(e.expiresAt) &&
        typeof e.proEnabled === 'boolean' &&
        isNonEmptyString(e.issuedAt) &&
        isNonEmptyString(e.notAfter));
}
/**
 * Verify a signed entitlement. Grants Pro only when every condition holds. Any failure returns
 * `{ ok: false, reason }` naming the check that failed — the gate branches on that reason, so
 * the strings are part of the interface rather than debug text.
 */
function verifyEntitlement(signed, opts) {
    // --- Structural gate (missing signature / truncated / garbage payload) ---
    if (!signed || typeof signed !== 'object')
        return fail('malformed-payload');
    const { entitlement, signature } = signed;
    if (!isNonEmptyString(signature))
        return fail('missing-signature');
    if (!validateShape(entitlement))
        return fail('malformed-entitlement');
    const ent = entitlement;
    // --- 1. Signature valid over CANONICAL bytes (the identical bytes the signer hashed) ---
    let sigValid = false;
    try {
        sigValid = (0, node_crypto_1.verify)(null, (0, canonicalize_1.canonicalBytes)(ent), opts.publicKey, Buffer.from(signature, 'base64'));
    }
    catch {
        // A wrong-length or non-Ed25519 signature throws rather than returning false.
        return fail('bad-signature');
    }
    if (!sigValid)
        return fail('bad-signature');
    // --- 2. Product scope: no replaying a 1DevTool entitlement into this app ---
    if (ent.product !== opts.expectedProduct)
        return fail('product-mismatch');
    // --- 3. Device binding, against a hash recomputed from hardware right now ---
    if (ent.deviceHash !== opts.currentDeviceHash)
        return fail('device-mismatch');
    // --- 4. Pro actually enabled (false once refunded / revoked / disabled) ---
    if (ent.proEnabled !== true)
        return fail('pro-not-enabled');
    // --- 5. Not past the entitlement TTL — this is the offline window and the revocation horizon ---
    const notAfter = parseDate(ent.notAfter);
    if (!notAfter)
        return fail('malformed-notAfter');
    if (opts.now.getTime() >= notAfter.getTime())
        return fail('entitlement-expired');
    // --- 6. Clock-rollback guard ---
    const skew = opts.clockSkewMs ?? exports.DEFAULT_CLOCK_SKEW_MS;
    if ((0, clockGuard_1.isClockRolledBack)(opts.now, opts.maxSeenTimestamp, skew))
        return fail('clock-rolled-back');
    // --- 7. The whole one-year model in a line: the paid window has to cover THIS build ---
    const expiresAt = parseDate(ent.expiresAt);
    if (!expiresAt)
        return fail('malformed-expiresAt');
    if (expiresAt.getTime() < opts.buildReleaseDate.getTime()) {
        return fail('build-outside-updates-window');
    }
    return { ok: true, proEnabled: ent.proEnabled };
}
//# sourceMappingURL=verify.js.map