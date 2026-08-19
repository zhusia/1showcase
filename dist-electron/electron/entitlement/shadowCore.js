"use strict";
/**
 * Pure decision and formatting helpers for the entitlement refresh pass.
 *
 * Everything here is free of IO so it can be exercised without booting Electron; the glue —
 * fetch, timers, persistence — lives in ./shadow.ts. The name "shadow" is inherited from the
 * sibling apps, where this ran observe-only for a release before the gate was allowed to rule.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isDefinitiveExchangeStatus = isDefinitiveExchangeStatus;
exports.maskLicenseKey = maskLicenseKey;
exports.isPlausibleLicenseKey = isPlausibleLicenseKey;
exports.computeShadowPro = computeShadowPro;
exports.computeAgrees = computeAgrees;
exports.buildLogLine = buildLogLine;
/** HTTP statuses that mean "the server understood and said no" — do not retry. */
function isDefinitiveExchangeStatus(status) {
    return status >= 400 && status < 500 && status !== 408 && status !== 429;
}
/** `FC92E921…` — enough to correlate a support report, never the whole key. */
function maskLicenseKey(key) {
    if (!key)
        return '(none)';
    return key.length <= 8 ? `${key}…` : `${key.slice(0, 8)}…`;
}
/**
 * A key worth attempting to exchange. Grace and exchange are for plausible keys only: an
 * `isLicensed: true` with no key behind it gets neither.
 */
function isPlausibleLicenseKey(key) {
    return typeof key === 'string' && key.trim().length >= 8;
}
function computeShadowPro(outcome) {
    if (outcome.stage === 'verified')
        return outcome.verify?.ok === true;
    if (outcome.stage === 'no-license')
        return false;
    if (outcome.stage === 'exchange-definitive')
        return false;
    // transient / device-unavailable / disabled → no verdict; the gate falls back to the cached
    // entitlement or to the grace window.
    return null;
}
function computeAgrees(shadowPro, legacyPro) {
    if (shadowPro === null)
        return null;
    return shadowPro === legacyPro;
}
/** A single greppable log line. No full licence key, no signature. */
function buildLogLine(outcome, maskedKey) {
    return JSON.stringify({
        at: outcome.at,
        trigger: outcome.trigger,
        stage: outcome.stage,
        verify: outcome.verify ?? null,
        detail: outcome.detail ?? null,
        shadowPro: outcome.shadowPro,
        legacyPro: outcome.legacyPro,
        agrees: outcome.agrees,
        latencyMs: outcome.latencyMs ?? null,
        notAfter: outcome.notAfter ?? null,
        licenseKey: maskedKey,
    });
}
//# sourceMappingURL=shadowCore.js.map