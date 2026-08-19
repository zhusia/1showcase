"use strict";
/**
 * The entitlement gate's decision core.
 *
 * Pro is granted by the cryptographic verifier, not by a boolean somebody can edit. This module is
 * the PURE decision — every input injected, no clock, disk, env or crypto — so the whole
 * grant/deny/grace matrix is testable. The IO wrapper (entitlementGate.ts) reads the cache,
 * computes the device hash, verifies, and persists the grace bookkeeping.
 *
 * The prime directive: **a paying customer is never wrongly downgraded.** The only three paths to
 * `pro: false` for someone holding a plausible key are
 *   (a) a cryptographically signed `proEnabled: false` blob — a refund or a disable,
 *   (b) a DEFINITIVE server rejection of a real exchange — refunded / not_found / product_mismatch,
 *   (c) grace fully expired — fourteen days of nothing but transient failures.
 * Every other uncertainty — no cache yet, a 5xx, offline, an unreadable hardware id, a swapped
 * motherboard, an unstamped build — keeps Pro. That asymmetry is the whole design.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.GRACE_NOTICE_MS = exports.GRACE_WINDOW_MS = void 0;
exports.classifyExchange = classifyExchange;
exports.decideEntitlement = decideEntitlement;
/** Fourteen days of honouring a plausible key while we cannot verify it. */
exports.GRACE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
/** Only surface the "couldn't verify" hint in the last stretch, so it reads as news. */
exports.GRACE_NOTICE_MS = 3 * 24 * 60 * 60 * 1000;
/**
 * Exchange error codes that mean "the server understood, and this is permanent".
 *
 * Everything NOT in this set — `device_mismatch` / `device_limit` / `invalid_instance` from a
 * hardware change or a wiped activation, `inactive`, `busy`, `signing_unavailable`, any 5xx,
 * timeout or network error — is treated as transient, so a legitimate customer is never dropped
 * for a recoverable reason. Grace is what bounds the narrow abuse cases that hides.
 */
const DEFINITIVE_EXCHANGE_CODES = new Set([
    'refunded',
    'disabled',
    'not_found',
    'product_mismatch',
    'unknown_product',
    'invalid_fields',
    'missing_fields',
    'invalid_body',
    'body_too_large',
]);
/**
 * Classify the refresh runner's last outcome for the gate.
 *
 * The runner tags an outcome by HTTP status, but a 403 covers both permanent (`refunded`) and
 * recoverable (`device_mismatch`) cases — which need opposite treatment — so the code embedded in
 * `detail` ("403 device_mismatch") is what actually decides here.
 */
function classifyExchange(stage, detail) {
    if (stage === 'verified')
        return 'success';
    if (stage === 'exchange-definitive' || stage === 'exchange-transient') {
        const code = extractErrorCode(detail);
        return code && DEFINITIVE_EXCHANGE_CODES.has(code) ? 'definitive-negative' : 'transient';
    }
    // no-license / device-unavailable / disabled / undefined → nothing was exchanged.
    return 'none';
}
/** Pull the error code out of a `"<status> <code>"` detail string. */
function extractErrorCode(detail) {
    if (!detail)
        return null;
    const parts = detail.trim().split(/\s+/);
    // "403 refunded" → "refunded"; "TimeoutError" → itself.
    const tail = parts.length > 1 ? parts[parts.length - 1] : parts[0];
    return tail || null;
}
function decision(partial) {
    return {
        notice: null,
        windowEndedAt: null,
        graceUntil: null,
        definitive: false,
        graceStartedAt: null,
        ...partial,
    };
}
/**
 * Decide the Pro grant. Pure — see the module header for the safety contract. The wrapper applies
 * the session latch (never downgrade mid-session) on top of this.
 */
function decideEntitlement(input) {
    const graceWindowMs = input.graceWindowMs ?? exports.GRACE_WINDOW_MS;
    const graceNoticeMs = input.graceNoticeMs ?? exports.GRACE_NOTICE_MS;
    // 0. Gate disabled (kill switch) → the stored boolean, verbatim.
    if (!input.gateEnabled) {
        return decision({ pro: input.legacyLicensed, source: 'legacy-fallback', reason: 'gate-disabled' });
    }
    /**
     * 0b. Hardware id unreadable. We cannot produce a trustworthy negative, so we must not
     * manufacture one — a locked-down environment or a VM never loses Pro over a machine id.
     */
    if (!input.deviceHashAvailable) {
        return decision({ pro: input.legacyLicensed, source: 'legacy-fallback', reason: 'device-unavailable' });
    }
    // 1. A cached signed entitlement we can verify locally, offline, right up to its notAfter.
    if (input.cacheVerify) {
        if (input.cacheVerify.ok) {
            return decision({ pro: true, source: 'entitlement', reason: 'verified' });
        }
        switch (input.cacheVerify.reason) {
            case 'pro-not-enabled':
                // A signed blob that says NO — a refund or a disable. Permanent.
                return decision({ pro: false, source: 'free', reason: 'revoked', definitive: true });
            case 'build-outside-updates-window':
                /**
                 * A legitimate customer whose paid window does not cover this build. Free on THIS build —
                 * not an error, just the model. Offer a renewal; do not accuse anyone of anything.
                 */
                return decision({
                    pro: false,
                    source: 'free',
                    reason: 'window-ended',
                    notice: 'window-ended',
                    windowEndedAt: input.cacheExpiresAt,
                });
            // device-mismatch (hardware changed), entitlement-expired (cache past notAfter),
            // clock-rolled-back, bad-signature, malformed-* → the cache is unusable but says nothing
            // definitive, so fall through to grace.
        }
    }
    /**
     * 2. No usable cache and no plausible key. This is the hand-edited `isLicensed: true` case:
     * there is nothing to exchange and nothing to shelter.
     */
    if (!input.hasPlausibleKey) {
        return decision({ pro: false, source: 'free', reason: 'no-license' });
    }
    // 3. Plausible key, no usable cache. A definitive rejection ends it now; anything recoverable
    //    falls into the bounded grace window.
    if (input.lastExchange === 'definitive-negative') {
        return decision({ pro: false, source: 'free', reason: 'exchange-rejected', definitive: true });
    }
    const started = input.graceStartedAt ?? input.now;
    const graceEndsMs = started.getTime() + graceWindowMs;
    const graceUntil = new Date(graceEndsMs).toISOString();
    if (input.now.getTime() < graceEndsMs) {
        const nearingEnd = graceEndsMs - input.now.getTime() < graceNoticeMs;
        return decision({
            pro: true,
            source: 'grace',
            reason: 'grace',
            graceUntil,
            graceStartedAt: started,
            notice: nearingEnd ? 'verify-failed' : null,
        });
    }
    // Grace exhausted: fourteen days of only-transient failures. Now, and only now, drop.
    return decision({ pro: false, source: 'free', reason: 'grace-expired', notice: 'verify-failed' });
}
//# sourceMappingURL=gate.js.map