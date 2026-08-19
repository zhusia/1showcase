"use strict";
/**
 * Monotonic max-seen-timestamp helper.
 *
 * Closes the combined bypass: get a valid entitlement, set the system clock back to 2020, block
 * the store's domain, and `notAfter` never passes — Pro forever, offline. Either half alone is
 * survivable; together they are a complete hole.
 *
 * The defence is to persist the GREATEST timestamp ever observed (each entitlement's `issuedAt`,
 * each successful refresh, and `now` on every pass) and refuse to verify when `now` sits
 * meaningfully behind it.
 *
 * This module is PURE — the caller owns storage, so the prior maximum comes in as an argument
 * and the new maximum comes back as a return value.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.advanceMaxSeen = advanceMaxSeen;
exports.isClockRolledBack = isClockRolledBack;
/**
 * Fold observed timestamps into the running maximum. Ignores null/undefined and unparseable
 * values. Accepts `Date`, an ISO string, or epoch milliseconds.
 */
function advanceMaxSeen(prior, ...observed) {
    let max = prior;
    for (const candidate of observed) {
        if (candidate == null)
            continue;
        const d = candidate instanceof Date ? candidate : new Date(candidate);
        const ms = d.getTime();
        if (Number.isNaN(ms))
            continue;
        if (max === null || ms > max.getTime())
            max = d;
    }
    return max;
}
/**
 * True when `now` sits more than `skewMs` behind the greatest timestamp ever seen — the clock has
 * plausibly been rolled back. `skewMs` absorbs legitimate skew (NTP jitter, timezone quirks).
 * With no prior maximum there is nothing to compare against, so nothing is rolled back.
 */
function isClockRolledBack(now, maxSeen, skewMs) {
    if (maxSeen === null)
        return false;
    return now.getTime() < maxSeen.getTime() - skewMs;
}
//# sourceMappingURL=clockGuard.js.map